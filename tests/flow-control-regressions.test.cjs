'use strict'

// A tunnel reads from a local application that can produce data far faster
// than any network carries it. The reference client blocks when it cannot
// write, which holds the application back; these tests hold us to the same.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const net = require('node:net')

const { createLogger, waitFor } = require('./support/load.cjs')
const { createSessionFixture } = require('./support/sessionFixture.cjs')

const { load, createInjector, createProfile, startServer } = createSessionFixture()
const { ETSession } = load('src/session/etSession.ts')
const { ETClientConnection } = load('src/protocol/connection.ts')
const { ETPortForwardHandler } = load('src/session/portForwarding.ts')
const { ETPacketType, WRITE_HIGH_WATER_MARK } = load('src/protocol/constants.ts')
const {
    decodePortForwardData, decodePortForwardDestinationRequest,
    encodePortForwardDestinationResponse,
} = load('src/protocol/messages.ts')

const MiB = 1024 * 1024
const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Write `size` random bytes to `socket` as fast as it will take them. */
function upload (socket, size) {
    const hash = crypto.createHash('sha256')
    const chunk = crypto.randomBytes(64 * 1024)
    const state = { written: 0, done: false, digest: null }
    const pump = () => {
        while (state.written < size) {
            hash.update(chunk)
            state.written += chunk.length
            if (!socket.write(chunk)) {
                socket.once('drain', pump)
                return
            }
        }
        state.done = true
        state.digest = hash.digest('hex')
    }
    pump()
    return state
}

/** Make the fake server the far end of every tunnel: accept, then collect. */
function serveTunnels (server) {
    const sink = { received: 0, hash: crypto.createHash('sha256') }
    let nextSocketId = 100
    server.on('packet', ({ header, payload }) => {
        if (header === ETPacketType.PORT_FORWARD_DESTINATION_REQUEST) {
            const request = decodePortForwardDestinationRequest(payload)
            server.send(ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE,
                encodePortForwardDestinationResponse({ clientFd: request.fd, socketId: nextSocketId++, hasError: false }))
        } else if (header === ETPacketType.PORT_FORWARD_DATA) {
            const data = decodePortForwardData(payload)
            if (data.buffer) {
                sink.received += data.buffer.length
                sink.hash.update(data.buffer)
            }
        }
    })
    return sink
}

async function startForwardingSession (server) {
    const session = new ETSession(createInjector(), createProfile(server.port, {
        forwardedPorts: [{ type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 }],
    }))
    session.messages = []
    session.serviceMessage$.subscribe(message => session.messages.push(message))
    await session.start()
    const client = net.connect(session.forwards.listeners[0].server.address().port, '127.0.0.1')
    client.on('error', () => {})
    await new Promise(resolve => client.once('connect', resolve))
    return { session, client }
}

test('a connection reports congestion, and its end', async () => {
    const server = await startServer({ strictSession: false })
    const connection = new ETClientConnection({
        host: '127.0.0.1', port: server.port, id: server.id, passkey: server.passkey, maxReconnectAttempts: 0,
    }, createLogger())
    try {
        await connection.connect()
        await waitFor(() => server.session?.socket, 'the server to attach')
        assert.equal(connection.congested, false)
        let drained = 0
        connection.drained$.subscribe(() => drained++)

        // A server that has stopped reading: the kernel takes a few megabytes
        // and everything after that waits with us.
        server.session.socket.pause()
        const payload = Buffer.alloc(16 * 1024)
        for (let sent = 0; sent < 24 * MiB; sent += payload.length) {
            connection.writePacket(ETPacketType.TERMINAL_BUFFER, payload)
        }
        await settle(50)
        assert.equal(connection.congested, true)
        assert.equal(drained, 0)

        server.session.socket.resume()
        await waitFor(() => drained > 0, 'the connection to drain')
        assert.equal(connection.congested, false)
        assert.deepEqual(server.failures, [])
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('a tunnel stops reading while the connection is congested', async () => {
    const sent = { bytes: 0, hash: crypto.createHash('sha256') }
    let congested = false
    const handler = new ETPortForwardHandler(createLogger(), (header, payload) => {
        if (header === ETPacketType.PORT_FORWARD_DATA) {
            const data = decodePortForwardData(payload)
            sent.bytes += data.buffer?.length ?? 0
            sent.hash.update(data.buffer ?? Buffer.alloc(0))
        }
        return true
    }, () => {}, () => congested)
    await handler.addLocalForward({ type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 })
    const client = net.connect(handler.listeners[0].server.address().port, '127.0.0.1')
    client.on('error', () => {})
    try {
        await new Promise(resolve => client.once('connect', resolve))
        await waitFor(() => handler.unassigned.size === 1, 'the connection to be accepted')
        handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE,
            encodePortForwardDestinationResponse({ clientFd: 1, socketId: 7, hasError: false }))

        congested = true
        const size = 32 * MiB
        const state = upload(client, size)
        await settle(200)
        const held = sent.bytes
        assert.ok(held < MiB, `${held} bytes were read from a tunnel that should have been held back`)
        assert.equal(state.done, false, 'the application was never held back')
        await settle(200)
        assert.equal(sent.bytes, held, 'the tunnel kept reading while congested')

        congested = false
        handler.resume()
        await waitFor(() => sent.bytes === size, 'the rest of the upload', 20000)
        assert.equal(sent.hash.digest('hex'), state.digest)
    } finally {
        client.destroy()
        handler.dispose()
    }
})

test('an upload through a tunnel is held back rather than buffered whole', async () => {
    const server = await startServer()
    const sink = serveTunnels(server)
    const { session, client } = await startForwardingSession(server)
    try {
        await waitFor(() => server.session?.socket, 'the server to attach')
        server.session.socket.pause()

        const size = 96 * MiB
        const state = upload(client, size)
        let peak = 0
        for (let i = 0; i < 20; i++) {
            await settle(25)
            peak = Math.max(peak, session.connection.writer.backlog)
        }
        assert.equal(state.done, false, 'the application was never held back')
        assert.ok(peak < 3 * WRITE_HIGH_WATER_MARK, `${(peak / MiB).toFixed(0)} MiB was queued for a server that is not reading`)

        server.session.socket.resume()
        await waitFor(() => sink.received === size || !session.open, 'the upload to arrive', 60000)
        assert.equal(session.open, true, session.messages.join(' / '))
        assert.equal(sink.hash.digest('hex'), state.digest)
        assert.deepEqual(server.failures, [])
    } finally {
        client.destroy()
        await session.destroy()
        await server.close()
    }
})

test('an upload in progress survives an outage', async () => {
    const server = await startServer()
    const sink = serveTunnels(server)
    const { session, client } = await startForwardingSession(server)
    const states = []
    session.connectionState$.subscribe(state => states.push(state))
    try {
        // More than the 64 MiB that may be buffered while disconnected: what
        // does not fit has to wait in the application, not be thrown away
        // along with the connection it belongs to.
        const size = 96 * MiB
        const state = upload(client, size)
        await waitFor(() => sink.received > 4 * MiB, 'the upload to get going')
        server.dropConnection()

        await waitFor(() => sink.received === size || !session.open, 'the upload to arrive', 60000)
        assert.equal(session.open, true, session.messages.join(' / '))
        assert.ok(states.includes('reconnecting'), 'the connection was never lost')
        assert.equal(sink.hash.digest('hex'), state.digest)
        assert.deepEqual(server.failures, [])
        assert.deepEqual(session.messages.filter(x => /Dropped/.test(x)), [])
    } finally {
        client.destroy()
        await session.destroy()
        await server.close()
    }
})
