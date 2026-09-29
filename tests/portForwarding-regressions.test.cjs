'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

const { createLoader, createLogger, waitFor } = require('./support/load.cjs')

const load = createLoader()
const { ETPortForwardHandler } = load('src/session/portForwarding.ts')
const { ETPacketType } = load('src/protocol/constants.ts')
const {
    decodePortForwardData, decodePortForwardDestinationRequest, decodePortForwardDestinationResponse,
    encodePortForwardData, encodePortForwardDestinationRequest, encodePortForwardDestinationResponse,
} = load('src/protocol/messages.ts')

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function createHandler (hooks = {}) {
    const packets = []
    const messages = []
    const handler = new ETPortForwardHandler(createLogger(), (header, payload, urgent = false) => {
        packets.push({ header, payload })
        hooks.onSend?.(handler, header, payload, urgent)
        return true
    }, message => messages.push(message))
    /** What we have told the peer about tunnelled sockets, decoded. */
    const sentData = () => packets
        .filter(x => x.header === ETPacketType.PORT_FORWARD_DATA)
        .map(x => decodePortForwardData(x.payload))
    return { handler, packets, messages, sentData }
}

/** A local service that keeps its connections open, EOF or not. */
async function startLocalService () {
    const connections = []
    const server = net.createServer({ allowHalfOpen: true }, socket => {
        socket.on('error', () => {})
        connections.push(socket)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return {
        connections,
        port: server.address().port,
        async close () {
            for (const socket of connections) {
                socket.destroy()
            }
            await new Promise(resolve => server.close(resolve))
        },
    }
}

/** Have the peer open a reverse-tunnel connection to `service`; returns its socket id. */
async function openReverseTunnel (handler, packets, service, fd = 1) {
    handler.buildReverseTunnelRequests({
        forwardedPorts: [{
            type: 'Remote', host: '127.0.0.1', port: 9000, targetAddress: 'localhost', targetPort: service.port,
        }],
        forwardAgent: false,
    })
    handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_REQUEST,
        encodePortForwardDestinationRequest({ destination: { port: service.port }, fd }))
    await waitFor(
        () => packets.some(x => x.header === ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE),
        'the destination response',
    )
    await waitFor(() => service.connections.length === 1, 'the local service to accept')
    const response = packets.find(x => x.header === ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE)
    return decodePortForwardDestinationResponse(response.payload).socketId
}

test('a tunnel the peer has closed sends nothing more and ends with the session', async () => {
    const service = await startLocalService()
    const { handler, packets, sentData } = createHandler()
    try {
        const socketId = await openReverseTunnel(handler, packets, service)
        const socket = handler.destinationSockets.get(socketId)

        handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
            encodePortForwardData({ sourceToDestination: true, socketId, closed: true }))
        // The local service ignores the EOF and keeps talking.
        service.connections[0].write('still here')
        await settle(100)
        assert.deepEqual(sentData(), [], 'packets were sent for a socket the peer no longer has')
        assert.equal(socket.destroyed, false)

        handler.dispose()
        assert.equal(socket.destroyed, true, 'the session left a forwarded socket open')
    } finally {
        handler.dispose()
        await service.close()
    }
})

test('data queued for a tunnel is still delivered after the peer closes it', async () => {
    const service = await startLocalService()
    const { handler, packets } = createHandler()
    try {
        const socketId = await openReverseTunnel(handler, packets, service)
        const received = []
        service.connections[0].on('data', data => received.push(data))
        let ended = false
        service.connections[0].on('end', () => { ended = true })

        const body = Buffer.alloc(256 * 1024, 'x')
        handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
            encodePortForwardData({ sourceToDestination: true, socketId, buffer: body }))
        handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
            encodePortForwardData({ sourceToDestination: true, socketId, closed: true }))

        await waitFor(() => ended, 'the EOF to reach the local service')
        assert.equal(Buffer.concat(received).length, body.length)
    } finally {
        handler.dispose()
        await service.close()
    }
})

test('a local close is reported to the peer exactly once', async () => {
    const service = await startLocalService()
    let socketId = null
    let crossed = false
    const { handler, packets, sentData } = createHandler({
        // Data from the peer that crosses our close on the wire: it arrives
        // while the local socket is between its EOF and its 'close'.
        onSend (handler, header, payload) {
            if (header === ETPacketType.PORT_FORWARD_DATA && decodePortForwardData(payload).closed && !crossed) {
                crossed = true
                handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
                    encodePortForwardData({ sourceToDestination: true, socketId, buffer: Buffer.from('late') }))
            }
        },
    })
    try {
        socketId = await openReverseTunnel(handler, packets, service)

        service.connections[0].end()
        await waitFor(() => crossed, 'the close to be reported')
        await settle(100)

        assert.deepEqual(sentData().map(x => ({ closed: x.closed, error: x.error })), [
            { closed: true, error: undefined },
        ])
    } finally {
        handler.dispose()
        await service.close()
    }
})

test('removing a forward closes its connections on the far side too', async () => {
    const { handler, packets, sentData } = createHandler()
    const config = { type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 }
    await handler.addLocalForward(config)
    const port = handler.listeners[0].server.address().port
    const client = net.connect(port, '127.0.0.1')
    client.on('error', () => {})
    try {
        await waitFor(
            () => packets.some(x => x.header === ETPacketType.PORT_FORWARD_DESTINATION_REQUEST),
            'the destination request',
        )
        handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE,
            encodePortForwardDestinationResponse({ clientFd: 1, socketId: 7, hasError: false }))
        assert.equal(handler.sourceSockets.size, 1)

        handler.removeForward(config)

        assert.deepEqual(sentData(), [{
            sourceToDestination: true, socketId: 7, buffer: undefined, error: undefined, closed: true,
        }])
        assert.equal(handler.sourceSockets.size, 0)
        await new Promise(resolve => client.once('close', resolve))
    } finally {
        client.destroy()
        handler.dispose()
    }
})

test('lingering tunnels still count against the connection cap', async () => {
    const service = await startLocalService()
    const { handler, packets } = createHandler()
    try {
        const socketId = await openReverseTunnel(handler, packets, service)
        handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
            encodePortForwardData({ sourceToDestination: true, socketId, closed: true }))

        // The local service never hangs up, so the socket is still open and has
        // to be accounted for: a hostile peer could otherwise open and close
        // tunnels until the renderer runs out of file descriptors.
        assert.equal(handler.destinationSockets.size, 0)
        assert.equal(handler.openDestinationSockets, 1)
    } finally {
        handler.dispose()
        await service.close()
    }
})

test('the connections a forward carries at once are capped', async () => {
    // A peer that accepts every connection at once: nothing stays pending, so
    // the cap on pending connections never comes into it.
    const messages = []
    const handler = new ETPortForwardHandler(createLogger(), (header, payload) => {
        if (header === ETPacketType.PORT_FORWARD_DESTINATION_REQUEST) {
            const request = decodePortForwardDestinationRequest(payload)
            setImmediate(() => handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE,
                encodePortForwardDestinationResponse({ clientFd: request.fd, socketId: 1000 + request.fd, hasError: false })))
        }
        return true
    }, message => messages.push(message))
    await handler.addLocalForward({ type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 })
    const port = handler.listeners[0].server.address().port
    const clients = []
    const connect = () => {
        const client = net.connect(port, '127.0.0.1')
        client.on('error', () => {})
        client.on('close', () => { client.refused = true })
        clients.push(client)
        return client
    }
    try {
        for (let i = 0; i < 300; i++) {
            connect()
        }
        await waitFor(() => clients.filter(x => x.refused).length === 44, 'the surplus connections to be refused')
        await settle(50)
        assert.equal(handler.sourceSockets.size, 256)
        assert.equal(handler.unassigned.size, 0)
        assert.equal(messages.filter(x => /too many/i.test(x)).length, 1, 'the refusals were not reported, or reported one by one')

        // Room is made by connections ending, not by waiting.
        clients.find(x => !x.refused).destroy()
        await waitFor(() => handler.sourceSockets.size === 255, 'the closed connection to be released')
        const late = connect()
        await waitFor(() => handler.sourceSockets.size === 256, 'a new connection to be accepted')
        assert.equal(late.refused, undefined)
    } finally {
        for (const client of clients) {
            client.destroy()
        }
        handler.dispose()
    }
})

test('a tunnel whose local end has finished sending is still ours to close', async () => {
    // A local service that ends its sending side and then never reads.
    const accepted = []
    const service = net.createServer({ allowHalfOpen: true }, socket => {
        socket.on('error', () => {})
        socket.pause()
        accepted.push(socket)
    })
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
    const { handler, packets, sentData } = createHandler()
    try {
        const socketId = await openReverseTunnel(handler, packets, { port: service.address().port, connections: accepted })
        const socket = handler.destinationSockets.get(socketId)
        for (let i = 0; i < 7 * 16; i++) {
            handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
                encodePortForwardData({ sourceToDestination: true, socketId, buffer: Buffer.alloc(64 * 1024) }))
        }
        accepted[0].end()
        await waitFor(() => sentData().some(x => x.closed), 'the local EOF to be reported')

        // Most of the data is still queued, so the socket is still open.
        assert.ok(socket.writableLength > 0)
        assert.equal(socket.destroyed, false)
        assert.equal(handler.openDestinationSockets, 1, 'an open socket is not counted against the cap')

        handler.dispose()
        assert.equal(socket.destroyed, true, 'the session left a forwarded socket open')
    } finally {
        handler.dispose()
        for (const socket of accepted) {
            socket.destroy()
        }
        await new Promise(resolve => service.close(resolve))
    }
})

// ---- what may be asked of etserver ----------------------------------------------
//
// etserver aborts when it is asked to listen on a port that it is listening on
// already, its own included, and exits when a bind address does not resolve.
// Either way every user of that host loses every session.

const remote = (port, targetPort, host = '127.0.0.1') => (
    { type: 'Remote', host, port, targetAddress: 'localhost', targetPort, description: '' }
)

test('reverse tunnels that would take etserver down are never asked for', () => {
    const { handler, messages } = createHandler()
    const requests = handler.buildReverseTunnelRequests({
        port: 2022,
        forwardAgent: false,
        forwardedPorts: [
            remote(9000, 80),
            remote(9000, 81), // a second listener on a port
            remote(2022, 22), // the port etserver itself is listening on
            remote(9001, 82, 'no such host'), // a bind address that does not resolve
            remote(9002, 83, '0.0.0.0'),
            remote(9003, 84, 'localhost'),
            remote(9004, 85, '::1'),
            remote(9005, 86, '[::1]'),
        ],
    }, { ipv6: true })
    assert.deepEqual(
        requests.map(x => [x.source.name, x.source.port, x.destination.port]),
        [['127.0.0.1', 9000, 80], ['0.0.0.0', 9002, 83], ['localhost', 9003, 84], ['::1', 9004, 85], ['::1', 9005, 86]],
    )
    assert.deepEqual(handler.activeForwards.map(x => x.port), [9000, 9002, 9003, 9004, 9005])
    assert.equal(messages.filter(x => /9000/.test(x) && /twice|already/i.test(x)).length, 1)
    assert.equal(messages.filter(x => /2022/.test(x) && /etserver/i.test(x)).length, 1)
    assert.equal(messages.filter(x => /no such host/.test(x)).length, 1)

    // What was turned away is not honoured when the peer asks for it either.
    handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_REQUEST,
        encodePortForwardDestinationRequest({ destination: { port: 81 }, fd: 1 }))
    assert.equal(handler.openDestinationSockets, 0)
})

test('a bind address that names an interface is not sent for the server to resolve', () => {
    // An address with a zone is an address to Node, and to etserver a name
    // that it looks up: the zone is an interface, of the server's. When there
    // is none of that name the lookup fails, and etserver exits.
    const { handler, messages } = createHandler()
    const requests = handler.buildReverseTunnelRequests({
        port: 2022,
        forwardAgent: false,
        forwardedPorts: [
            remote(9100, 80, 'fe80::1%en0'),
            remote(9101, 81, '::1%lo0'),
            remote(9102, 82, '[fe80::1%12]'),
            remote(9103, 83, 'fe80::1'),
        ],
    }, { ipv6: true })
    assert.deepEqual(requests.map(x => [x.source.name, x.source.port]), [['fe80::1', 9103]])
    assert.equal(messages.filter(x => /Skipping the reverse tunnel/.test(x)).length, 3)
})

test('a reverse tunnel whose target is not text is left out, not sent to fail', () => {
    const { handler, messages } = createHandler()
    const requests = handler.buildReverseTunnelRequests({
        port: 2022,
        forwardAgent: false,
        forwardedPorts: [{ ...remote(9000, 80), targetAddress: 7 }, { ...remote(9001, 81), targetAddress: undefined }, remote(9002, 82)],
    })
    assert.deepEqual(requests.map(x => x.source.port), [9002])
    assert.equal(messages.filter(x => /Skipping the reverse tunnel/.test(x)).length, 2)
})

test('the port etserver listens on is the one in the profile, whatever it is', () => {
    const { handler } = createHandler()
    const ports = options => handler.buildReverseTunnelRequests({ forwardAgent: false, ...options }).map(x => x.source.port)
    assert.deepEqual(ports({ port: 2200, forwardedPorts: [remote(2022, 80), remote(2200, 81)] }), [2022])
    // A port field that was cleared means the default.
    assert.deepEqual(ports({ port: null, forwardedPorts: [remote(2022, 80), remote(2200, 81)] }), [2200])
})

test('a reverse tunnel with no bind address is bound to localhost, not to every interface', () => {
    const { handler } = createHandler()
    const requests = handler.buildReverseTunnelRequests({
        port: 2022, forwardAgent: false, forwardedPorts: [remote(9000, 80, ''), remote(9001, 81, '   ')],
    })
    assert.deepEqual(requests.map(x => x.source.name), ['localhost', 'localhost'])
})

// ---- forwards that were never through the form ------------------------------------

test('a forward is checked before anything is bound for it', async () => {
    const { handler, messages } = createHandler()
    const local = values => ({ type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80, ...values })
    try {
        for (const values of [
            { targetPort: Infinity }, { targetPort: NaN }, { targetPort: 70000 }, { targetPort: 0 }, { targetPort: '80' },
            { targetPort: 80.5 }, { port: -1 }, { port: 65536 }, { port: Infinity }, { port: '8080' }, { host: 7 },
            { targetAddress: 7 }, { targetAddress: null }, { targetAddress: { name: 'localhost' } },
        ]) {
            await assert.rejects(handler.addLocalForward(local(values)), /port|address/i, JSON.stringify(values))
        }
        assert.equal(handler.listeners.length, 0)

        // One bad entry does not cost the profile its other forwards.
        await handler.startLocalForwards([local({ targetPort: Infinity }), local({ targetPort: 8080 })])
        assert.equal(handler.listeners.length, 1)
        assert.equal(messages.filter(x => /Failed to forward/.test(x)).length, 1)
    } finally {
        handler.dispose()
    }
})

// ---- closing, and saying so ---------------------------------------------------------

test('closing the session closes its tunnels on the far side too', async () => {
    const service = await startLocalService()
    const { handler, packets, sentData } = createHandler()
    const config = { type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 }
    await handler.addLocalForward(config)
    const client = net.connect(handler.listeners[0].server.address().port, '127.0.0.1')
    client.on('error', () => {})
    try {
        const destinationId = await openReverseTunnel(handler, packets, service)
        await waitFor(() => handler.unassigned.size === 1, 'the local connection')
        handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE,
            encodePortForwardDestinationResponse({ clientFd: 1, socketId: 7, hasError: false }))
        assert.deepEqual(sentData(), [])

        handler.dispose()

        const closed = sentData().filter(x => x.closed).map(x => [x.sourceToDestination, x.socketId])
        assert.deepEqual(closed.sort(), [[false, destinationId], [true, 7]].sort(), 'the peer was not told that its connections are over')
    } finally {
        client.destroy()
        handler.dispose()
        await service.close()
    }
})

test('a close is reported as urgent, so that a full buffer does not swallow it', async () => {
    const service = await startLocalService()
    const urgent = []
    const { handler, packets } = createHandler({
        onSend (_handler, header, payload, isUrgent) {
            urgent.push({ header, isUrgent, data: header === ETPacketType.PORT_FORWARD_DATA ? decodePortForwardData(payload) : null })
        },
    })
    try {
        const socketId = await openReverseTunnel(handler, packets, service)
        service.connections[0].write('some data')
        await waitFor(() => urgent.some(x => x.data?.buffer), 'the data to be forwarded')
        service.connections[0].end()
        await waitFor(() => urgent.some(x => x.data?.closed), 'the close to be reported')

        assert.equal(urgent.find(x => x.data?.buffer).isUrgent, false, 'bulk data must not be let past the limit')
        assert.equal(urgent.find(x => x.data?.closed).isUrgent, true)
        assert.equal(urgent.find(x => x.header === ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE).isUrgent, true)
        assert.equal(socketId > 0, true)
    } finally {
        handler.dispose()
        await service.close()
    }
})

test('an agent is forwarded when the profile says so, and not when it says no', () => {
    const before = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/regression-test-agent.sock'
    try {
        const agents = forwardAgent => createHandler().handler
            .buildReverseTunnelRequests({ port: 2022, forwardAgent, forwardedPorts: [] })
            .filter(x => x.environmentVariable === 'SSH_AUTH_SOCK').length
        for (const forwardAgent of [true, 'true', 'yes', 'on']) {
            assert.equal(agents(forwardAgent), 1, JSON.stringify(forwardAgent))
        }
        for (const forwardAgent of [false, 'false', 'no', 'off', '0', 'False ', 0, null, undefined]) {
            assert.equal(agents(forwardAgent), 0, `forwarded for ${JSON.stringify(forwardAgent)}`)
        }
    } finally {
        if (before === undefined) {
            delete process.env.SSH_AUTH_SOCK
        } else {
            process.env.SSH_AUTH_SOCK = before
        }
    }
})

test('an IPv6 bind address is only asked of a server that is known to have IPv6', () => {
    // Asked for an IPv6 address and having none, etserver finds nothing to
    // listen on, and aborts.
    const forwardedPorts = [remote(9000, 80, '::1'), remote(9001, 81, '[::]'), remote(9002, 82, '127.0.0.1'), remote(9003, 83, 'localhost')]
    const unknown = createHandler()
    assert.deepEqual(
        unknown.handler.buildReverseTunnelRequests({ port: 2022, forwardAgent: false, forwardedPorts }).map(x => x.source.port),
        [9002, 9003],
    )
    assert.equal(unknown.messages.filter(x => /Skipping the reverse tunnel/.test(x) && /IPv6/.test(x)).length, 2)

    const known = createHandler()
    assert.deepEqual(
        known.handler.buildReverseTunnelRequests({ port: 2022, forwardAgent: false, forwardedPorts }, { ipv6: true })
            .map(x => [x.source.name, x.source.port]),
        [['::1', 9000], ['::', 9001], ['127.0.0.1', 9002], ['localhost', 9003]],
    )
    assert.deepEqual(known.messages, [])
})

test('an attempt on ::1 that goes nowhere is given up for 127.0.0.1', async () => {
    // Where what is sent to ::1 is dropped, and not refused, a connection to
    // it neither succeeds nor fails.
    const connect = net.Socket.prototype.connect
    let held = 0
    net.Socket.prototype.connect = function (...args) {
        if (args[1] === '::1') {
            held++
            return this
        }
        return connect.apply(this, args)
    }
    const service = await startLocalService()
    const { handler, packets } = createHandler()
    try {
        handler.buildReverseTunnelRequests({
            port: 2022, forwardAgent: false, forwardedPorts: [remote(9000, service.port)],
        })
        handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_REQUEST,
            encodePortForwardDestinationRequest({ destination: { port: service.port }, fd: 7 }))
        const answers = () => packets
            .filter(x => x.header === ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE)
            .map(x => decodePortForwardDestinationResponse(x.payload))
        await waitFor(() => answers().length === 1, 'the server to be answered', 6000)
        assert.equal(held, 1)
        assert.equal(answers()[0].hasError, false)
        assert.equal(answers()[0].clientFd, 7)
        assert.equal(service.connections.length, 1)
    } finally {
        net.Socket.prototype.connect = connect
        handler.dispose()
        await service.close()
    }
})
