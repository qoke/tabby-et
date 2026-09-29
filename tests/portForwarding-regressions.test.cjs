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
    const handler = new ETPortForwardHandler(createLogger(), (header, payload) => {
        packets.push({ header, payload })
        hooks.onSend?.(handler, header, payload)
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
