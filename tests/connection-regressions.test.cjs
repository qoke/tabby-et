'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createLoader, createLogger, waitFor } = require('./support/load.cjs')
const { createFakeEtServer } = require('./support/fakeEtServer.cjs')

const load = createLoader()
const { ETClientConnection } = load('src/protocol/connection.ts')
const { BackedWriter } = load('src/protocol/backedWriter.ts')
const { ETCrypto } = load('src/protocol/crypto.ts')
const FakeEtServer = createFakeEtServer(load)

const id = 'RegressionTestId'
const passkey = 'RegressionTestPasskey00000000000'
const TERMINAL_BUFFER = 1

async function startServer () {
    const server = new FakeEtServer({ id, passkey, strictSession: false })
    await server.listen()
    return server
}

function connectTo (server, options = {}) {
    return new ETClientConnection({
        host: '127.0.0.1', port: server.port, id, passkey, maxReconnectAttempts: 0, ...options,
    }, createLogger())
}

/** Hold openSocket() open after the TCP connect, until the test lets it go. */
function gateOpenSocket (connection) {
    const open = connection.openSocket.bind(connection)
    const gate = { socket: null, entered: false, release: null }
    const released = new Promise(resolve => { gate.release = resolve })
    connection.openSocket = async () => {
        gate.socket = await open()
        gate.entered = true
        await released
        return gate.socket
    }
    return gate
}

/** Run `then` each time the connection has worked out what to replay. */
function afterSizingCatchup (connection, then) {
    const recover = connection.writer.recover.bind(connection.writer)
    connection.writer.recover = (...args) => {
        const catchup = recover(...args)
        then()
        return catchup
    }
}

test('packets written during the recovery exchange reach the server in order', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        connection.writePacket(TERMINAL_BUFFER, Buffer.from('one'))
        await waitFor(() => server.received.length === 1, 'the first packet')

        // Our catch-up has been sized and the exchange is not over: the
        // reference client holds its writer mutex here, so a write issued now
        // goes out on the new socket as soon as the exchange finishes.
        afterSizingCatchup(connection, () => {
            connection.writePacket(TERMINAL_BUFFER, Buffer.from('two'))
        })
        const states = []
        connection.state$.subscribe(state => states.push(state))
        server.dropConnection()
        await waitFor(() => states.includes('connected'), 'the session to resume')

        connection.writePacket(TERMINAL_BUFFER, Buffer.from('three'))
        await waitFor(() => server.received.length === 3 || server.failures.length > 0, 'all three packets')

        assert.deepEqual(server.failures, [])
        assert.deepEqual(server.payloads(TERMINAL_BUFFER), ['one', 'two', 'three'])
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('a failed recovery attempt still replays what was written during it', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        connection.writePacket(TERMINAL_BUFFER, Buffer.from('one'))
        await waitFor(() => server.received.length === 1, 'the first packet')

        // First attempt: take a write mid-exchange, then lose the socket before
        // the exchange completes. Second attempt: run to completion.
        let attempts = 0
        afterSizingCatchup(connection, () => {
            attempts++
            if (attempts === 1) {
                connection.writePacket(TERMINAL_BUFFER, Buffer.from('two'))
                for (const socket of server.sockets) {
                    socket.destroy()
                }
            }
        })
        const states = []
        connection.state$.subscribe(state => states.push(state))
        server.dropConnection()
        await waitFor(() => states.includes('connected'), 'the session to resume', 8000)

        connection.writePacket(TERMINAL_BUFFER, Buffer.from('three'))
        await waitFor(() => server.received.length === 3 || server.failures.length > 0, 'all three packets')

        assert.deepEqual(server.failures, [])
        assert.deepEqual(server.payloads(TERMINAL_BUFFER), ['one', 'two', 'three'])
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('the writer hands a new socket only the packets no recovery covered', () => {
    const frames = []
    const socket = { write: frame => frames.push(frame) }
    const writer = new BackedWriter(new ETCrypto(passkey, 0))

    writer.attach(socket)
    writer.write(TERMINAL_BUFFER, Buffer.from('a'))
    assert.equal(frames.length, 1)

    writer.detach()
    writer.write(TERMINAL_BUFFER, Buffer.from('b')) // disconnected: goes out in the catch-up
    assert.equal(writer.recover(1).length, 1)
    writer.write(TERMINAL_BUFFER, Buffer.from('c')) // mid-recovery: the catch-up missed it

    const replacement = []
    writer.attach({ write: frame => replacement.push(frame) })
    assert.equal(replacement.length, 1, 'exactly the packet the catch-up did not carry')
    assert.equal(replacement[0].readInt32BE(0), replacement[0].length - 4)

    // connection.recover() attaches, and so does connection.attach() after it.
    writer.attach({ write: frame => replacement.push(frame) })
    assert.equal(replacement.length, 1, 'attaching again must not resend')
    assert.equal(writer.sequenceNumber, 3)
})

test('shutting down during the TCP connect closes the socket that arrives late', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    const gate = gateOpenSocket(connection)
    try {
        const connecting = connection.connect()
        connecting.catch(() => {})
        await waitFor(() => gate.entered, 'the TCP connection')

        connection.shutdown()
        gate.release()

        await assert.rejects(connecting)
        await waitFor(() => gate.socket.destroyed, 'the late socket to be destroyed', 1000)
        await waitFor(() => server.connections === 0, 'the server to see the disconnect', 1000)
        assert.equal(connection.state, 'ended')
    } finally {
        connection.shutdown()
        gate.socket?.destroy()
        await server.close()
    }
})

test('shutting down during a reconnect attempt never resumes the session', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        const gate = gateOpenSocket(connection)
        server.dropConnection()
        await waitFor(() => gate.entered, 'the reconnect attempt to open its socket')

        connection.shutdown()
        gate.release()

        await waitFor(() => gate.socket.destroyed, 'the late socket to be destroyed', 1000)
        await waitFor(() => server.connections === 0, 'the server to see the disconnect', 1000)
        assert.equal(connection.state, 'ended')
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('shutting down abandons a TCP connect that is still in flight', async () => {
    // 192.0.2.0/24 is reserved for documentation (RFC 5737): a connect to it
    // either hangs or fails at once, and both must end promptly on shutdown.
    const connection = new ETClientConnection({
        host: '192.0.2.1', port: 2022, id, passkey, maxReconnectAttempts: 0,
    }, createLogger())
    const connecting = connection.connect()
    connecting.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))

    const started = Date.now()
    connection.shutdown()
    await assert.rejects(connecting)
    assert.ok(Date.now() - started < 1000, 'connect() outlived shutdown()')
    assert.equal(connection.state, 'ended')
})

test('a catch-up of empty entries is refused before anything is made of it', async () => {
    const server = await startServer()
    const connection = connectTo(server, { maxReconnectAttempts: 2 })
    const reasons = []
    connection.ended$.subscribe(reason => reasons.push(reason))
    try {
        await connection.connect()
        const hostile = Buffer.alloc(1024 * 1024)
        for (let i = 0; i < hostile.length; i += 2) {
            hostile[i] = 0x0a
        }
        server.hooks.serverCatchup = () => hostile
        const revive = connection.reader.revive.bind(connection.reader)
        let revived = 0
        connection.reader.revive = (...args) => {
            revived++
            return revive(...args)
        }
        server.dropConnection()
        await waitFor(() => reasons.length > 0, 'the attempts to run out', 10000)

        assert.equal(revived, 0, 'a catch-up that holds no packet was accepted')
        assert.match(reasons[0], /after 2 attempts/)
    } finally {
        connection.shutdown()
        await server.close()
    }
})
