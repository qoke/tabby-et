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
const { BackedWriter } = load('src/protocol/backedWriter.ts')
const { ETCrypto } = load('src/protocol/crypto.ts')
const { decodeTerminalBuffer, encodeTerminalBuffer } = load('src/protocol/messages.ts')
const { ETPortForwardHandler } = load('src/session/portForwarding.ts')
const { ETPacketType, MAX_PROTO_LENGTH, WRITE_HIGH_WATER_MARK } = load('src/protocol/constants.ts')
const { encodeCatchupBuffer } = load('src/protocol/messages.ts')
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
        const data = header === ETPacketType.PORT_FORWARD_DATA ? decodePortForwardData(payload) : null
        if (data?.buffer) {
            sent.bytes += data.buffer.length
            sent.hash.update(data.buffer)
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
        await waitFor(() => sink.received === size || !session.open, 'the upload to arrive', 30000)
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

        await waitFor(() => sink.received === size || !session.open, 'the upload to arrive', 30000)
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

test('the replay buffer keeps whatever the socket has not taken', () => {
    const writer = new BackedWriter(new ETCrypto('RegressionTestPasskey00000000000', 0))
    // A link that carries ten megabytes and then stalls: from there on the
    // socket accepts everything and sends nothing.
    const socket = {
        stalled: false,
        writableLength: 0,
        write (frame) {
            if (this.stalled) {
                this.writableLength += frame.length
            }
            return !this.stalled
        },
    }
    writer.attach(socket)
    const megabyte = Buffer.alloc(MiB)
    for (let i = 0; i < 10; i++) {
        assert.equal(writer.write(ETPacketType.TERMINAL_BUFFER, megabyte), true)
    }
    socket.stalled = true
    for (let i = 0; i < 60; i++) {
        assert.equal(writer.write(ETPacketType.TERMINAL_BUFFER, megabyte), true)
    }
    // Sixty have not left this machine, and how many of the first ten arrived
    // is anyone's guess. Keeping the newest 64 MiB would keep the sixty and
    // only three of the ten, so a server that is missing more could never be
    // caught up.
    writer.detach()
    assert.equal(writer.recover(0).length, 70)

    // Once the socket has taken it, and the server has been seen to have it,
    // the usual limit applies again.
    socket.writableLength = 0
    socket.stalled = false
    writer.attach(socket)
    writer.confirm()
    writer.write(ETPacketType.TERMINAL_BUFFER, megabyte)
    writer.detach()
    assert.throws(() => writer.recover(0), /already been trimmed/)
    assert.equal(writer.recover(71 - 63).length, 63)
})

test('input queued behind a stalled link survives a reconnect', async () => {
    const server = await startServer()
    const session = new ETSession(createInjector(), createProfile(server.port))
    session.messages = []
    session.serviceMessage$.subscribe(message => session.messages.push(message))
    try {
        await session.start()
        await waitFor(() => server.session?.socket, 'the server to attach')
        server.session.socket.pause()

        // A large paste, or a file sent with ZMODEM: Tabby feeds both to the
        // session as fast as it can read them. One chunk more than the replay
        // buffer keeps by size.
        const input = crypto.randomBytes(4097 * 16 * 1024)
        session.feedFromTerminal(input)
        await settle(100)
        server.dropConnection()

        const received = () => server.received
            .filter(x => x.header === ETPacketType.TERMINAL_BUFFER)
            .reduce((total, x) => total + decodeTerminalBuffer(x.payload).length, 0)
        await waitFor(() => received() === input.length || !session.open, 'the input to arrive', 30000)

        assert.equal(session.open, true, session.messages.join(' / '))
        assert.deepEqual(server.failures, [])
        const hash = crypto.createHash('sha256')
        for (const packet of server.received) {
            if (packet.header === ETPacketType.TERMINAL_BUFFER) {
                hash.update(decodeTerminalBuffer(packet.payload))
            }
        }
        assert.equal(hash.digest('hex'), crypto.createHash('sha256').update(input).digest('hex'))
    } finally {
        await session.destroy()
        await server.close()
    }
})

/** A socket on a stalled link: it accepts everything and sends nothing. */
function stalledSocket () {
    return {
        writableLength: 0,
        write (frame) {
            this.writableLength += frame.length
            return false
        },
    }
}

test('what is waiting to be sent always fits in one recovery message', () => {
    const passkey = 'RegressionTestPasskey00000000000'
    const writer = new BackedWriter(new ETCrypto(passkey, 0))
    writer.attach(stalledSocket())
    const chunk = Buffer.alloc(16 * 1024, 0x61)
    let accepted = 0
    for (let i = 0; i < 8192; i++) { // 128 MiB of input
        if (writer.write(ETPacketType.TERMINAL_BUFFER, chunk)) {
            accepted++
        }
    }
    assert.ok(accepted >= 4000, `only ${accepted} chunks were accepted`)
    assert.ok(accepted < 8192, 'input was accepted without limit')
    assert.equal(writer.sequenceNumber, accepted)

    // The server has none of it. A recovery message of more than 128 MiB is
    // refused by etserver on every attempt, so the session could never resume.
    writer.detach()
    const replay = writer.recover(0)
    assert.equal(replay.length, accepted)
    const message = encodeCatchupBuffer(replay)
    assert.ok(message.length <= MAX_PROTO_LENGTH, `the recovery message is ${message.length} bytes`)

    // What was refused took no nonce: what was accepted still decrypts in order.
    const server = new ETCrypto(passkey, 0)
    for (const serialized of replay) {
        assert.deepEqual(server.decrypt(serialized.subarray(2)), chunk)
    }
})

test('what a lost socket had not sent counts against what may wait while disconnected', () => {
    const writer = new BackedWriter(new ETCrypto('RegressionTestPasskey00000000000', 0))
    writer.attach(stalledSocket())
    const megabyte = Buffer.alloc(MiB)
    for (let i = 0; i < 40; i++) {
        assert.equal(writer.write(ETPacketType.TERMINAL_BUFFER, megabyte), true)
    }
    writer.detach()
    let accepted = 0
    for (let i = 0; i < 64; i++) {
        if (writer.write(ETPacketType.TERMINAL_BUFFER, megabyte)) {
            accepted++
        }
    }
    // 64 MiB in all, not 64 MiB on top of the 40 that never left.
    assert.equal(accepted, 23)
    assert.ok(encodeCatchupBuffer(writer.recover(0)).length <= MAX_PROTO_LENGTH)
})

test('input beyond what can be replayed is refused, and the user is told', async () => {
    const server = await startServer()
    const session = new ETSession(createInjector(), createProfile(server.port))
    session.messages = []
    session.serviceMessage$.subscribe(message => session.messages.push(message))
    const states = []
    session.connectionState$.subscribe(state => states.push(state))
    try {
        await session.start()
        await waitFor(() => server.session?.socket, 'the server to attach')
        server.session.socket.pause()

        session.feedFromTerminal(Buffer.alloc(128 * MiB, 0x61))
        await settle(100)
        assert.equal(session.messages.filter(x => /dropped/i.test(x)).length, 1, 'dropped input was not reported, or reported repeatedly')

        server.dropConnection()
        await waitFor(() => states.includes('connected') || !session.open, 'the session to resume', 30000)
        assert.equal(session.open, true, session.messages.join(' / '))
        assert.deepEqual(server.rejections, [])
        assert.deepEqual(server.failures, [])
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('there is always room for a control message', () => {
    const writer = new BackedWriter(new ETCrypto('RegressionTestPasskey00000000000', 0))
    writer.attach(stalledSocket())
    const megabyte = Buffer.alloc(MiB)
    // Until nothing more of each size is accepted. Counted, so that a writer
    // that accepts everything fails this test instead of never finishing it.
    for (const [filler, most] of [[megabyte, 200], [Buffer.alloc(1024), 5000], [Buffer.alloc(64), 100000]]) {
        for (let i = 0; i < most && writer.write(ETPacketType.PORT_FORWARD_DATA, filler); i++) {
            // nothing else to do
        }
    }
    const before = writer.sequenceNumber
    assert.equal(writer.write(ETPacketType.PORT_FORWARD_DATA, Buffer.alloc(64)), false)
    assert.equal(writer.write(ETPacketType.PORT_FORWARD_DATA, Buffer.alloc(64), true), true, 'a control message was refused')
    assert.equal(writer.sequenceNumber, before + 1)

    // The room is for messages, not for data passed off as one, and it is not endless.
    assert.equal(writer.write(ETPacketType.PORT_FORWARD_DATA, megabyte, true), false)
    let accepted = 0
    while (writer.write(ETPacketType.PORT_FORWARD_DATA, Buffer.alloc(64), true) && accepted < 1e6) {
        accepted++
    }
    assert.ok(accepted > 1000, `room for only ${accepted} control messages`)
    assert.ok(accepted < 1e6, 'control messages are accepted without limit')

    writer.detach()
    assert.ok(encodeCatchupBuffer(writer.recover(0)).length <= MAX_PROTO_LENGTH)
})

test('a tunnel that closes while the link is stalled is still closed on the far side', async () => {
    const server = await startServer()
    const sink = serveTunnels(server)
    const { session, client } = await startForwardingSession(server)
    try {
        client.write('hello')
        await waitFor(() => sink.received === 5, 'the tunnel to carry data')
        server.session.socket.pause()
        // As much terminal input as will be taken, to the last byte of room,
        // and then the tunnel closes.
        session.feedFromTerminal(Buffer.alloc(96 * MiB, 0x61))
        const keystroke = encodeTerminalBuffer(Buffer.from('x'))
        for (let i = 0; i < 100000 && session.connection.writePacket(ETPacketType.TERMINAL_BUFFER, keystroke); i++) {
            // until not even this fits
        }
        client.end()
        await settle(200)

        server.session.socket.resume()
        const closes = () => server.received
            .filter(x => x.header === ETPacketType.PORT_FORWARD_DATA)
            .map(x => decodePortForwardData(x.payload))
            .filter(x => x.closed)
        await waitFor(() => closes().length > 0 || !session.open, 'the close to arrive', 30000)
        assert.deepEqual(closes().map(x => x.socketId), [100])
        assert.deepEqual(server.failures, [])
    } finally {
        client.destroy()
        await session.destroy()
        await server.close()
    }
})

test('closing a session tells the server which tunnels are over before it hangs up', async () => {
    const server = await startServer()
    const sink = serveTunnels(server)
    const { session, client } = await startForwardingSession(server)
    try {
        client.write('hello')
        await waitFor(() => sink.received === 5, 'the tunnel to carry data')

        await session.destroy()

        const closes = () => server.received
            .filter(x => x.header === ETPacketType.PORT_FORWARD_DATA)
            .map(x => decodePortForwardData(x.payload))
            .filter(x => x.closed)
        await waitFor(() => server.connections === 0, 'the connection to close', 5000)
        assert.deepEqual(closes().map(x => x.socketId), [100], 'the server was left holding a connection nobody will use')
    } finally {
        client.destroy()
        await session.destroy()
        await server.close()
    }
})

test('a session that has resumed still lets what is queued go out when it closes', async () => {
    const server = await startServer()
    const sink = serveTunnels(server)
    const { session, client } = await startForwardingSession(server)
    try {
        client.write('hello')
        await waitFor(() => sink.received === 5, 'the tunnel to carry data')
        session.forceReconnect()
        await waitFor(
            () => server.handshakes === 2 && session.connection.state === 'connected' && server.session.socket,
            'the session to resume', 8000,
        )

        // The link stalls, input piles up behind it, and the tab is closed.
        const stalled = server.session.socket
        stalled.pause()
        session.feedFromTerminal(Buffer.alloc(8 * MiB, 0x61))
        assert.ok(session.connection.writer.backlog > MiB, 'nothing was waiting to be sent')
        await session.destroy()
        await settle(100)
        stalled.resume()

        const closes = () => server.received
            .filter(x => x.header === ETPacketType.PORT_FORWARD_DATA)
            .map(x => decodePortForwardData(x.payload))
            .filter(x => x.closed)
        await waitFor(() => closes().length > 0 || server.connections === 0, 'the close to arrive, or the connection to go', 5000)
        assert.deepEqual(closes().map(x => x.socketId), [100], 'what was queued when the session closed never went out')
        assert.deepEqual(server.failures, [])
    } finally {
        client.destroy()
        await session.destroy()
        await server.close()
    }
})

test('closing over input that has not been read does not throw away what was sent', async () => {
    // Closing a socket that holds unread input resets the connection, and what
    // the kernel had not yet transmitted is dropped with it. That is decided by
    // what the kernel holds, which the length of our own queue says nothing of.
    const { ProtoWriter } = load('src/protocol/protobuf.ts')
    let serverSocket = null
    let received = 0
    const server = net.createServer(socket => {
        serverSocket = socket
        socket.on('error', () => {})
        socket.on('data', data => { received += data.length })
        const response = new ProtoWriter().int32(1, 1).finish() // NEW_CLIENT
        const header = Buffer.alloc(8)
        header.writeBigInt64LE(BigInt(response.length), 0)
        socket.write(Buffer.concat([header, response]))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const connection = new ETClientConnection({
        host: '127.0.0.1', port: server.address().port, id: 'RegressionTestId0', passkey: 'RegressionTestPasskey00000000000',
        maxReconnectAttempts: 0,
    }, createLogger())
    try {
        await connection.connect()
        await waitFor(() => serverSocket, 'the server to have the connection')
        const socket = connection.socket
        const drained = async () => {
            serverSocket.resume()
            await waitFor(() => socket.writableLength === 0, 'our queue to empty', 5000)
            serverSocket.pause()
            await settle(20)
        }

        // The server stops reading. We write until the kernel takes no more,
        // then let just enough through for our own queue to empty into it.
        serverSocket.pause()
        const chunk = Buffer.alloc(16 * 1024, 0x61)
        for (let i = 0; i < 4096 && socket.writableLength === 0; i++) {
            connection.writePacket(ETPacketType.TERMINAL_BUFFER, chunk)
            await new Promise(resolve => setImmediate(resolve))
        }
        await drained()
        for (let i = 0; i < 40 && socket.writableLength === 0; i++) {
            connection.writePacket(ETPacketType.TERMINAL_BUFFER, chunk)
        }
        if (socket.writableLength) {
            await drained()
        }
        // The last thing a session says.
        connection.writePacket(ETPacketType.PORT_FORWARD_DATA, Buffer.from('this tunnel is over'), true)
        const sent = socket.bytesWritten + socket.writableLength

        // Output is on its way to us, and has arrived, but has not been read.
        serverSocket.write(Buffer.alloc(4096, 0x63))
        const until = Date.now() + 30
        while (Date.now() < until) {
            // the kernel delivers; nothing of ours runs
        }
        connection.shutdown()
        await settle(100)
        serverSocket.resume()

        await waitFor(() => received >= sent || serverSocket.destroyed, 'everything to arrive, or the connection to go', 5000)
        assert.equal(received, sent, 'what had been handed to the kernel was thrown away')
    } finally {
        connection.shutdown()
        serverSocket?.destroy()
        await new Promise(resolve => server.close(resolve))
    }
})
