'use strict'

// A link that is slow is not a link that is lost, and a catch-up that has been
// sent is not a catch-up that has arrived. These tests hold the session to
// both.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createLogger, waitFor } = require('./support/load.cjs')
const { createSessionFixture } = require('./support/sessionFixture.cjs')

const { load, createInjector, createProfile, startServer, id, passkey } = createSessionFixture()
const { ETSession } = load('src/session/etSession.ts')
const { ETClientConnection } = load('src/protocol/connection.ts')
const { BackedWriter } = load('src/protocol/backedWriter.ts')
const { ETCrypto } = load('src/protocol/crypto.ts')
const { ETPacketType, MAX_PROTO_LENGTH } = load('src/protocol/constants.ts')
const { encodeCatchupBuffer } = load('src/protocol/messages.ts')

const MiB = 1024 * 1024
const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function connectTo (server, options = {}) {
    return new ETClientConnection({
        host: '127.0.0.1', port: server.port, id, passkey, maxReconnectAttempts: 0, ...options,
    }, createLogger())
}

// ---- the keepalive ---------------------------------------------------------

/** A session with its keepalive running against a connection that is scripted. */
function keepalive (t, interval = 1) {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
    const session = new ETSession(createInjector(), createProfile(1, { keepaliveInterval: interval }))
    const connection = {
        state: 'connected',
        probes: 0,
        reconnects: 0,
        /** The other end answers probes, some time before the next interval is over. */
        answers: false,
        unanswered: 0,
        outbound: { connection: 1, held: 0, taken: 0 },
        writePacket (header) {
            if (header === ETPacketType.KEEP_ALIVE) {
                this.probes++
                this.unanswered++
            }
            return true
        },
        forceReconnect () {
            this.reconnects++
        },
        shutdown () {},
    }
    session.connection = connection
    session.startKeepalive()
    // An interval at a time. What the other end answers is here thirty
    // milliseconds after it was asked.
    const tick = (ticks, each = () => {}) => {
        for (let i = 0; i < ticks; i++) {
            each(i)
            t.mock.timers.tick(30)
            for (; connection.answers && connection.unanswered; connection.unanswered--) {
                session.handlePacket(ETPacketType.KEEP_ALIVE, Buffer.alloc(0))
            }
            t.mock.timers.tick(interval * 1000 - 30)
        }
    }
    return { session, connection, tick }
}

test('a link that is taking what it is given is not given up for an answer that is late', t => {
    const { session, connection, tick } = keepalive(t)
    try {
        // Four megabytes are waiting, and the link carries a hundred kilobytes
        // a second. A probe takes forty seconds to get to the other end.
        tick(30, i => {
            connection.outbound = { connection: 1, held: 4 * MiB, taken: i * 100 * 1024 }
        })
        assert.equal(connection.reconnects, 0, 'a link that was carrying our data was given up')
    } finally {
        session.stopKeepalive()
    }
})

test('a link that takes nothing and answers nothing is given up', t => {
    const { session, connection, tick } = keepalive(t)
    try {
        connection.outbound = { connection: 1, held: 4 * MiB, taken: 123456 }
        tick(3)
        assert.equal(connection.reconnects, 1)
    } finally {
        session.stopKeepalive()
    }
})

test('what was written with nothing waiting says nothing of the link', t => {
    // Keys typed into a link that has gone: the kernel takes each of them,
    // for a long time, and none of them arrives anywhere.
    const { session, connection, tick } = keepalive(t)
    try {
        tick(3, i => {
            connection.outbound = { connection: 1, held: 0, taken: i * 25 }
        })
        assert.equal(connection.reconnects, 1, 'typing kept a dead link alive')
    } finally {
        session.stopKeepalive()
    }
})

test('what another connection had taken is not counted for this one', t => {
    const { session, connection, tick } = keepalive(t)
    try {
        connection.outbound = { connection: 1, held: 4 * MiB, taken: 100 }
        tick(1)
        connection.outbound = { connection: 2, held: 4 * MiB, taken: 900 }
        tick(2)
        assert.equal(connection.reconnects, 1)
    } finally {
        session.stopKeepalive()
    }
})

test('an idle link is probed once an interval', t => {
    const { session, connection, tick } = keepalive(t)
    try {
        connection.answers = true
        tick(7)
        assert.equal(connection.probes, 7, 'an answer to a probe put off the probe after it')
        assert.equal(connection.reconnects, 0)
    } finally {
        session.stopKeepalive()
    }
})

test('a link that goes quiet is given up within two intervals', t => {
    const { session, connection, tick } = keepalive(t)
    try {
        connection.answers = true
        tick(4)
        connection.answers = false
        tick(2)
        assert.equal(connection.reconnects, 1)
    } finally {
        session.stopKeepalive()
    }
})

test('a resume asks the server for an answer, and does not wait for it', t => {
    const { session, connection } = keepalive(t)
    try {
        session.open = true
        connection.state = 'reconnecting'
        session.onConnectionState('reconnecting')
        connection.state = 'connected'
        session.onConnectionState('connected')
        assert.equal(connection.probes, 1, 'nothing was asked that the server could answer')
        assert.equal(session.awaitingKeepalive, false)
    } finally {
        session.stopKeepalive()
    }
})

test('a server that has a catch-up to take in is given time to answer', t => {
    const { session, connection, tick } = keepalive(t)
    try {
        session.open = true
        connection.awaitsConfirmation = true
        session.onConnectionState('connected')
        // Nothing arrives, and nothing is seen to leave: it has left already,
        // and is on its way.
        tick(25)
        assert.equal(connection.reconnects, 0, 'given up with the catch-up on its way, to be sent again from its start')
        tick(7)
        assert.equal(connection.reconnects, 1, 'a link that stays silent is given up in the end')
    } finally {
        session.stopKeepalive()
    }
})

test('a server that did not answer in time is given longer the next time', t => {
    const { session, connection, tick } = keepalive(t)
    const resume = () => {
        connection.state = 'reconnecting'
        session.onConnectionState('reconnecting')
        connection.state = 'connected'
        session.onConnectionState('connected')
    }
    try {
        session.open = true
        connection.awaitsConfirmation = true
        resume()
        tick(32)
        assert.equal(connection.reconnects, 1)

        // As long again, and the catch-up would have been given up as early.
        resume()
        tick(55)
        assert.equal(connection.reconnects, 1, 'given no longer than the time that was not enough')
        tick(7)
        assert.equal(connection.reconnects, 2)

        // An answer, and the next catch-up is given what any is given.
        resume()
        session.handlePacket(ETPacketType.TERMINAL_BUFFER, Buffer.alloc(0))
        resume()
        tick(32)
        assert.equal(connection.reconnects, 3)
    } finally {
        session.stopKeepalive()
    }
})

// ---- the catch-up ----------------------------------------------------------

test('how much of a slow write has been taken can be seen as it goes', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        connection.writePacket(ETPacketType.INITIAL_PAYLOAD, Buffer.alloc(0))
        await waitFor(() => server.received.length === 1, 'the first packet')
        assert.equal(connection.outbound.held, 0)

        server.session.socket.pause()
        const chunk = Buffer.alloc(16 * 1024, 0x61)
        for (let i = 0; i < 1024; i++) {
            connection.writePacket(ETPacketType.TERMINAL_BUFFER, chunk)
        }
        await settle(100)
        const stalled = connection.outbound
        assert.ok(stalled.held > MiB, `only ${stalled.held} bytes were seen to be waiting`)

        server.session.socket.resume()
        await waitFor(() => connection.outbound.taken > stalled.taken, 'more to be taken', 5000)
        await waitFor(() => connection.outbound.held === 0, 'all of it to be taken', 10000)
        assert.equal(connection.outbound.taken - stalled.taken, stalled.held)
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('a session is not called resumed while what it has to catch up on is still here', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        connection.writePacket(ETPacketType.INITIAL_PAYLOAD, Buffer.alloc(0))
        await waitFor(() => server.received.length === 1, 'the first packet')

        // The link stalls, 24 MiB pile up behind it, and it is lost.
        server.session.socket.pause()
        const chunk = Buffer.alloc(16 * 1024, 0x61)
        for (let i = 0; i < 1536; i++) {
            connection.writePacket(ETPacketType.TERMINAL_BUFFER, chunk)
        }
        // The next connection is no faster: what the client sends on it
        // stays where it is, for now.
        server.hooks.beforeServerCatchup = async () => {
            for (const socket of server.sockets) {
                socket.pause()
            }
        }
        server.dropConnection()
        await waitFor(() => server.handshakes === 2, 'the client to come back', 8000)
        await settle(1500)
        assert.equal(connection.state, 'reconnecting', 'resumed, with megabytes of its catch-up still to be sent')

        server.hooks.beforeServerCatchup = null
        for (const socket of server.sockets) {
            socket.resume()
        }
        await waitFor(() => connection.state === 'connected', 'the session to resume', 10000)
        await waitFor(() => server.received.length === 1537, 'everything to arrive', 10000)
        assert.deepEqual(server.failures, [])
        assert.deepEqual(server.rejections, [])
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('the first thing that the server says after a resume is what confirms the catch-up', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        connection.writePacket(ETPacketType.INITIAL_PAYLOAD, Buffer.alloc(0))
        await waitFor(() => server.received.length === 1, 'the first packet')

        // Written, and lost with the link before the server had read it.
        server.session.socket.pause()
        connection.writePacket(ETPacketType.TERMINAL_BUFFER, Buffer.from('lost on the way'))
        await settle(50)
        server.dropConnection()
        await waitFor(() => server.handshakes === 2 && connection.state === 'connected', 'the session to resume', 8000)
        await waitFor(() => server.received.length === 2, 'the catch-up to arrive')
        assert.equal(connection.writer.awaitsConfirmation, true, 'a catch-up was taken for delivered when it was sent')

        server.send(ETPacketType.TERMINAL_BUFFER, Buffer.from('anything'))
        await waitFor(() => !connection.writer.awaitsConfirmation, 'the answer to be taken for what it is')
        assert.deepEqual(server.failures, [])
    } finally {
        connection.shutdown()
        await server.close()
    }
})

/** A socket as the writer sees one: it takes everything, or holds everything. */
function stallable () {
    return {
        stalled: false,
        writableLength: 0,
        write (frame) {
            if (this.stalled) {
                this.writableLength += frame.length
            }
            return !this.stalled
        },
    }
}

/** A writer that has sent a catch-up of some 68 MiB, all of which the new socket has taken. */
function afterALongOutage () {
    const writer = new BackedWriter(new ETCrypto(passkey, 0))
    const megabyte = Buffer.alloc(MiB)
    const socket = stallable()
    writer.attach(socket)
    // Four megabytes that left, and never arrived. Then the link stalls, and
    // as much again as will be taken piles up behind it.
    for (let i = 0; i < 4; i++) {
        assert.equal(writer.write(ETPacketType.TERMINAL_BUFFER, megabyte), true)
    }
    socket.stalled = true
    for (let i = 0; i < 200 && writer.write(ETPacketType.TERMINAL_BUFFER, megabyte); i++) {
        // until no more is taken
    }
    writer.detach()
    const catchup = writer.recover(0)
    assert.ok(catchup.length >= 67, `a catch-up of ${catchup.length} packets`)
    writer.attach(stallable())
    return { writer, megabyte, sent: catchup.length }
}

test('a catch-up that was not seen to arrive is kept whole, whatever is written after it', () => {
    const { writer, sent } = afterALongOutage()
    // A key is pressed. Then the link is lost again, with the catch-up on its
    // way and the server holding none of it.
    assert.equal(writer.write(ETPacketType.TERMINAL_BUFFER, Buffer.from('x')), true)
    writer.detach()
    assert.equal(writer.recover(0).length, sent + 1)
})

test('what may have to be sent again always fits in one catch-up', () => {
    const { writer, megabyte } = afterALongOutage()
    writer.detach()
    for (let i = 0; i < 200 && writer.write(ETPacketType.TERMINAL_BUFFER, megabyte); i++) {
        // what is typed and pasted while the link is down
    }
    for (let i = 0; i < 100000 && writer.write(ETPacketType.PORT_FORWARD_DATA, Buffer.alloc(16), true); i++) {
        // and what has to be said of tunnels that closed
    }
    const catchup = encodeCatchupBuffer(writer.recover(0))
    assert.ok(catchup.length <= MAX_PROTO_LENGTH, `a catch-up of ${catchup.length} bytes, which no server accepts`)
})

test('a catch-up that the server has answered is one that it has', () => {
    const { writer, megabyte, sent } = afterALongOutage()
    writer.confirm()
    assert.equal(writer.awaitsConfirmation, false)
    assert.equal(writer.write(ETPacketType.TERMINAL_BUFFER, megabyte), true)
    writer.detach()
    // Back to keeping the newest 64 MiB: the oldest have gone.
    assert.throws(() => writer.recover(0), /already been trimmed/)
    assert.ok(writer.recover(sent + 1 - 63).length === 63)
})

test('a long replay is read a slice at a time, and everything else has its turn', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    const packets = 100000
    let seen = 0
    let turns = 0
    let counting = false
    let turnsTaken = null
    connection.packet$.subscribe(() => {
        seen++
        if (seen === packets + 1) {
            turnsTaken = turns
            counting = false
        }
    })
    const spin = () => {
        if (counting) {
            turns++
            setImmediate(spin)
        }
    }
    try {
        await connection.connect()
        connection.writePacket(ETPacketType.INITIAL_PAYLOAD, Buffer.alloc(0))
        await waitFor(() => seen === 1, 'the answer to the first packet')

        // The link is lost, and the remote goes on printing.
        server.dropConnection()
        const line = Buffer.alloc(300, 0x61)
        for (let i = 0; i < packets; i++) {
            server.send(ETPacketType.TERMINAL_BUFFER, line)
        }
        const revive = connection.reader.revive.bind(connection.reader)
        connection.reader.revive = (...args) => {
            counting = true
            setImmediate(spin)
            return revive(...args)
        }
        await waitFor(() => turnsTaken !== null, 'the replay to be read', 30000)
        assert.ok(turnsTaken >= 10, `nothing else had a turn more than ${turnsTaken} times while ${packets} packets were read`)
        assert.deepEqual(server.failures, [])
    } finally {
        counting = false
        connection.shutdown()
        await server.close()
    }
})

// ---- the jump host ---------------------------------------------------------

test('a jump host that has not heard of the key yet is asked again', async () => {
    const server = await startServer()
    // etterminal has said that it is ready, and has not told the jump host yet.
    server.id = 'NotRegisteredYet'
    const connection = connectTo(server, { registrationGrace: 5000 })
    const timer = setTimeout(() => {
        server.id = id
    }, 600)
    try {
        await connection.connect()
        assert.equal(connection.state, 'connected')
        assert.ok(server.handshakes > 1)
    } finally {
        clearTimeout(timer)
        connection.shutdown()
        await server.close()
    }
})

test('a key that stays unknown is an error, and not before its time', async () => {
    const server = await startServer()
    server.id = 'SomebodyElse0000'
    const direct = connectTo(server)
    const through = connectTo(server, { registrationGrace: 700 })
    try {
        const started = Date.now()
        await assert.rejects(direct.connect(), /rejected our session key/)
        assert.ok(Date.now() - started < 500, 'a server that is not a jump host was asked again')

        const again = Date.now()
        await assert.rejects(through.connect(), /rejected our session key/)
        assert.ok(Date.now() - again >= 700)
    } finally {
        direct.shutdown()
        through.shutdown()
        await server.close()
    }
})

test('a session through a jump host allows for the jump host to learn the key', async () => {
    const server = await startServer()
    server.id = 'NotRegisteredYet'
    const session = new ETSession(createInjector(), createProfile(1, { jumpHost: '127.0.0.1', jumpPort: server.port }))
    const timer = setTimeout(() => {
        server.id = id
    }, 600)
    try {
        await session.start()
        assert.equal(session.open, true)
    } finally {
        clearTimeout(timer)
        await session.destroy()
        await server.close()
    }
})

// ---- the server that these tests are run against ---------------------------

test('the test server sends its catch-up before it has read ours, as etserver does', async () => {
    const server = await startServer()
    const connection = connectTo(server)
    try {
        await connection.connect()
        connection.writePacket(ETPacketType.INITIAL_PAYLOAD, Buffer.alloc(0))
        await waitFor(() => server.received.length === 1, 'the first packet')
        server.send(ETPacketType.TERMINAL_BUFFER, Buffer.from('said while the link was down'))

        // Our catch-up is held back. The server's has to arrive all the same.
        let arrived = false
        const writeProtoToTheEnd = connection.writeProtoToTheEnd.bind(connection)
        connection.writeProtoToTheEnd = async (socket, message) => {
            await waitFor(() => connection.pendingHandshake.byteReader.buffered > 0, "the server's catch-up", 3000)
            arrived = true
            return writeProtoToTheEnd(socket, message)
        }
        server.dropConnection()
        await waitFor(() => connection.state === 'connected' && server.handshakes === 2, 'the session to resume', 8000)
        assert.equal(arrived, true)

        // What arrives in a catch-up is answered like anything else.
        const answers = []
        connection.packet$.subscribe(packet => answers.push(packet.header))
        connection.forceReconnect()
        connection.writePacket(ETPacketType.KEEP_ALIVE, Buffer.alloc(0))
        await waitFor(() => answers.includes(ETPacketType.KEEP_ALIVE), 'the answer to what was in the catch-up', 8000)
        assert.deepEqual(server.failures, [])
    } finally {
        connection.shutdown()
        await server.close()
    }
})

test('the test server aborts on a client that claims more than it was sent, as etserver does', async () => {
    const server = await startServer()
    const connection = connectTo(server, { maxReconnectAttempts: 1 })
    try {
        await connection.connect()
        connection.writePacket(ETPacketType.INITIAL_PAYLOAD, Buffer.alloc(0))
        await waitFor(() => server.received.length === 1, 'the first packet')
        connection.reader.sequenceNumber += 5
        server.dropConnection()
        await waitFor(() => server.failures.length > 0, 'the server to notice', 8000)
        assert.match(server.failures[0], /claims/)
    } finally {
        connection.shutdown()
        await server.close()
    }
})
