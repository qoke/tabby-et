const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const ts = require('typescript')

// Load the source with only Tabby's runtime imports stubbed. The tunnel and
// protocol codecs, including their real net.Socket behavior, stay under test.
const cache = new Map()
const portTypes = { Local: 1, Remote: 2 }
function load (file) {
    file = path.resolve(__dirname, '..', file)
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }
    cache.set(file, mod)
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
            experimentalDecorators: true,
        },
    }).outputText
    const localRequire = name => {
        if (name.endsWith('.pug')) return ''
        if (name === './components/etProfileSettings.component') return { ETProfileSettingsComponent: class {} }
        if (name === './components/etTab.component') return { ETTabComponent: class {} }
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), `${name}.ts`))
        if (name === 'tabby-ssh') return { PortForwardType: portTypes }
        if (name === 'tabby-core') return { QuickConnectProfileProvider: class {} }
        if (name === 'rxjs') return {
            Subject: class {
                listeners = []
                subscribe (listener) { this.listeners.push(listener) }
                next (value) { for (const listener of this.listeners) listener(value) }
                complete () {}
            },
            ReplaySubject: class {},
        }
        if (name === '@angular/core') return {
            Component: () => target => target,
            Injectable: () => target => target,
            Input: () => () => {},
            Output: () => () => {},
            EventEmitter: class { emit () {} },
        }
        return require(name)
    }
    new Function('require', 'module', 'exports', js)(localRequire, mod, mod.exports)
    return mod.exports
}

const { ETPortForwardHandler } = load('src/session/portForwarding.ts')
const { ETPacketType } = load('src/protocol/constants.ts')
const {
    encodePortForwardDestinationRequest, encodePortForwardDestinationResponse, decodePortForwardData,
} = load('src/protocol/messages.ts')
const { ETPortForwardingConfigComponent } = load('src/components/etPortForwardingConfig.component.ts')
const { ETClientConnection } = load('src/protocol/connection.ts')
const { ETBootstrap } = load('src/session/bootstrap.ts')
const { ETProfilesService } = load('src/profiles.ts')
const { parseQuickConnectQuery } = load('src/quickConnect.ts')
const { parseTunnelSpec } = load('src/session/tunnelSpec.ts')
const logger = { warn () {}, debug () {}, info () {}, error () {} }

test('a dropped destination request closes its local socket', async () => {
    const messages = []
    const handler = new ETPortForwardHandler(logger, () => false, msg => messages.push(msg))
    await handler.addLocalForward({
        type: portTypes.Local, host: '127.0.0.1', port: 0,
        targetAddress: 'localhost', targetPort: 80,
    })
    const port = handler.listeners[0].server.address().port
    const client = net.connect(port, '127.0.0.1')
    client.on('error', () => {})
    try {
        await Promise.race([
            new Promise(resolve => client.once('close', resolve)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('socket remained open')), 1000)),
        ])
        assert.equal(handler.unassigned.size, 0)
        assert.ok(messages.some(x => x.includes('write buffer is full')))
    } finally {
        client.destroy()
        handler.dispose()
    }
})

test('disposing during a destination connect does not resurrect a socket', async () => {
    const server = net.createServer(() => {})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const handler = new ETPortForwardHandler(logger, () => true, () => {})
    handler.buildReverseTunnelRequests({
        forwardedPorts: [{
            type: portTypes.Remote, host: '127.0.0.1', port: 9000,
            targetAddress: 'localhost', targetPort: port,
        }],
        forwardAgent: false,
    })
    try {
        handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_REQUEST,
            encodePortForwardDestinationRequest({ destination: { port }, fd: 1 }))
        assert.equal(handler.pendingDestinations, 1)
        handler.dispose()
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(handler.pendingDestinationSockets.size, 0)
        assert.equal(handler.destinationSockets.size, 0)
        assert.equal(handler.pendingDestinations, 0)
    } finally {
        handler.dispose()
        server.close()
    }
})

test('pending source sockets are bounded while the peer is unresponsive', () => {
    const handler = new ETPortForwardHandler(logger, () => true, () => {})
    const config = { targetAddress: 'localhost', targetPort: 80 }
    const sockets = Array.from({ length: 257 }, () => new net.Socket())
    try {
        for (const socket of sockets) handler.onLocalConnection(config, socket)
        assert.equal(handler.unassigned.size, 256)
        assert.equal(sockets[256].destroyed, true)
    } finally {
        handler.dispose()
        for (const socket of sockets) socket.destroy()
    }
})

test('a late destination response releases the peer socket', () => {
    const packets = []
    const handler = new ETPortForwardHandler(logger, (header, payload) => {
        packets.push({ header, payload })
        return true
    }, () => {})
    handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_RESPONSE,
        encodePortForwardDestinationResponse({ clientFd: 42, socketId: 7, hasError: false }))
    assert.equal(packets.length, 1)
    assert.equal(packets[0].header, ETPacketType.PORT_FORWARD_DATA)
    assert.equal(decodePortForwardData(packets[0].payload).closed, true)
    handler.dispose()
})

test('reusing a refused remote forward does not edit the active forward', () => {
    const component = new ETPortForwardingConfigComponent()
    const active = { type: portTypes.Remote, host: 'localhost', port: 9000, targetPort: 80 }
    component.remove(active)
    component.newForward.port = 9001
    assert.equal(active.port, 9000)
})

test('an unexpected server status still counts toward the reconnect limit', async () => {
    const connection = new ETClientConnection({
        host: 'localhost', port: 2022, id: 'test', passkey: 'x'.repeat(32),
        maxReconnectAttempts: 1,
    }, logger)
    connection.openSocket = async () => new net.Socket()
    connection.sendConnectRequest = async () => 0
    const reasons = []
    connection.ended$.subscribe(reason => reasons.push(reason))
    try {
        await Promise.race([
            connection.reconnectLoop(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect limit ignored')), 2500)),
        ])
        assert.equal(connection.state, 'ended')
        assert.match(reasons[0], /after 1 attempts/)
    } finally {
        connection.shutdown()
    }
})

test('bootstrap capture never exceeds its byte cap', async () => {
    let dataHandler
    let stderrHandler
    let eofHandler
    const channel = {
        data$: { subscribe (fn) { dataHandler = fn } },
        extendedData$: { subscribe (fn) { stderrHandler = fn } },
        closed$: { subscribe () {} },
        eof$: { subscribe (fn) { eofHandler = fn } },
    }
    const session = { openExecChannel: async () => channel }
    const result = ETBootstrap.prototype.execAndCapture.call({}, session, 'test', 10)
    await new Promise(resolve => setImmediate(resolve))
    dataHandler(Buffer.alloc(100, 'a'))
    stderrHandler([1, Buffer.alloc(100, 'b')])
    eofHandler()
    const output = await result
    assert.equal(Buffer.byteLength(output.stdout), 10)
    assert.equal(Buffer.byteLength(output.stderr), 10)
})

test('quick connect round trips IPv6 and rejects malformed port suffixes', () => {
    const provider = new ETProfilesService({ instant: value => value })
    const text = provider.intoQuickConnectString({
        options: { host: '::1', user: 'alice', port: 2023 },
    })
    assert.equal(text, 'alice@[::1]:2023')
    assert.deepEqual(parseQuickConnectQuery(text), { host: '::1', user: 'alice', port: 2023 })
    assert.equal(parseQuickConnectQuery('host:2023garbage').port, 2022)
    assert.throws(() => parseTunnelSpec('123garbage:80', portTypes.Local))
    assert.throws(() => parseTunnelSpec('8000-8001-8002:80-81', portTypes.Local))
})
