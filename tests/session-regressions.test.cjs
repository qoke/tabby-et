'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { waitFor } = require('./support/load.cjs')
const { createSessionFixture } = require('./support/sessionFixture.cjs')

const { load, ssh, createInjector, createProfile, startServer } = createSessionFixture()
const { ETSession } = load('src/session/etSession.ts')
const { ETPacketType } = load('src/protocol/constants.ts')
const { decodeTerminalBuffer } = load('src/protocol/messages.ts')
const { decodeFields, getRepeatedBytes, getString } = load('src/protocol/protobuf.ts')

async function setup (options) {
    const server = await startServer()
    const session = new ETSession(createInjector(), createProfile(server.port, options))
    return { server, session }
}

/** start(), but fail fast the moment the server would have aborted. */
function startOrFail (session, server) {
    return Promise.race([
        session.start(),
        new Promise((_, reject) => server.once('failure', reason => reject(new Error(`etserver would abort: ${reason}`)))),
    ])
}

function terminalInput (server) {
    return server.received
        .filter(x => x.header === ETPacketType.TERMINAL_BUFFER)
        .map(x => decodeTerminalBuffer(x.payload).toString())
}

test('input typed while connecting never reaches the server ahead of INITIAL_PAYLOAD', async () => {
    const { server, session } = await setup()
    // The ConnectRequest is in flight: the connection exists, its socket does not.
    server.hooks.beforeConnectResponse = async () => {
        session.feedFromTerminal(Buffer.from('typed ahead'))
    }
    try {
        await startOrFail(session, server)
        session.feedFromTerminal(Buffer.from('ls\n'))
        await waitFor(() => terminalInput(server).length > 0 || server.failures.length > 0, 'terminal input')

        assert.deepEqual(server.failures, [])
        assert.equal(server.received[0].header, ETPacketType.INITIAL_PAYLOAD)
        assert.deepEqual(terminalInput(server), ['ls\n'])
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('a profile too large to announce does not start, and nothing is sent in its place', async () => {
    // What the server reads first has to be INITIAL_PAYLOAD. One that is
    // turned away for its size must not be followed by anything.
    const { DISCONNECT_BUFFER_BYTES } = load('src/protocol/constants.ts')
    const { server, session } = await setup({
        environmentVariables: { BIG: 'x'.repeat(DISCONNECT_BUFFER_BYTES + 1024) },
    })
    try {
        let outcome = null
        const starting = session.start().then(() => { outcome = 'started' }, err => { outcome = err })
        await waitFor(() => outcome || session.inputEnabled, 'the start to fail, or input to be taken', 8000)
        session.feedFromTerminal(Buffer.from('ls\n'))
        session.resize(100, 40)
        await starting
        await new Promise(resolve => setTimeout(resolve, 200))

        assert.ok(outcome instanceof Error, 'the session started')
        assert.match(outcome.message, /too large/i)
        assert.deepEqual(server.failures, [])
        assert.deepEqual(server.received.map(x => x.header), [])
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('a session destroyed during the SSH bootstrap never connects', async () => {
    const { server, session } = await setup()
    let finishBootstrap = null
    ssh.behavior.start = () => new Promise(resolve => { finishBootstrap = resolve })
    try {
        const starting = session.start()
        starting.catch(() => {})
        await waitFor(() => ssh.sessions[0]?.started, 'the SSH bootstrap to begin')

        await session.destroy()
        finishBootstrap()

        await assert.rejects(starting)
        // Give a connect that should never happen the chance to happen.
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(server.handshakes, 0, 'the destroyed session still connected to etserver')
        assert.equal(session.open, false)
        assert.equal(session.keepaliveTimer, null, 'the destroyed session left a keepalive timer running')
        assert.equal(ssh.sessions[0].destroyed, true)
    } finally {
        finishBootstrap?.()
        await session.destroy()
        await server.close()
    }
})

test('destroying a session aborts a bootstrap that is waiting on the user', async () => {
    const { server, session } = await setup()
    // An SSH session parked on a password prompt nobody will ever answer.
    ssh.behavior.start = () => new Promise(() => {})
    try {
        const starting = session.start()
        starting.catch(() => {})
        await waitFor(() => ssh.sessions[0]?.started, 'the SSH bootstrap to begin')

        await session.destroy()

        await Promise.race([
            assert.rejects(starting),
            new Promise((_, reject) => setTimeout(() => reject(new Error('start() never settled')), 1000)),
        ])
        assert.equal(ssh.sessions[0].destroyed, true, 'the bootstrap SSH session was left connected')
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('a session destroyed during the handshake never goes live', async () => {
    const { server, session } = await setup()
    server.hooks.beforeConnectResponse = () => session.destroy()
    try {
        await assert.rejects(session.start())
        await waitFor(() => server.connections === 0, 'the server to see the disconnect', 1000)
        assert.equal(session.open, false)
        assert.equal(session.keepaliveTimer, null)
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('a session destroyed while its forwards start never goes live', async () => {
    const { server, session } = await setup({
        forwardedPorts: [{ type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 }],
    })
    const startLocalForwards = session.forwards.startLocalForwards.bind(session.forwards)
    session.forwards.startLocalForwards = async configs => {
        await session.destroy()
        return startLocalForwards(configs)
    }
    try {
        await assert.rejects(session.start())
        assert.equal(session.open, false)
        assert.equal(session.keepaliveTimer, null)
        assert.equal(session.forwards.listeners.length, 0)
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('destroying a session twice is harmless', async () => {
    const { server, session } = await setup()
    try {
        await startOrFail(session, server)
        let destroyed = 0
        session.destroyed$.subscribe(() => destroyed++)
        await session.destroy()
        await session.destroy()
        assert.equal(destroyed, 1)
        assert.equal(session.open, false)
    } finally {
        await server.close()
    }
})

test('a session that fails before connecting still reports that it has ended', async () => {
    const { server, session } = await setup()
    ssh.behavior.start = async () => { throw new Error('Authentication rejected') }
    const states = []
    session.connectionState$.subscribe(state => states.push(state))
    try {
        await assert.rejects(session.start(), /Authentication rejected/)
        await session.destroy()
        assert.deepEqual(states, ['ended'])
        assert.equal(session.connectionState, 'ended')
    } finally {
        await server.close()
    }
})

test('a cleared port field falls back to the default instead of failing in net.connect', async () => {
    const { resolvePort } = load('src/session/options.ts')
    for (const blank of [null, undefined, '']) {
        assert.equal(resolvePort(blank, 2022, 'etserver port'), 2022)
    }
    assert.equal(resolvePort(2023, 2022, 'etserver port'), 2023)
    assert.equal(resolvePort('2023', 2022, 'etserver port'), 2023)
    for (const invalid of [0, -1, 65536, 1.5, NaN, 'ssh', '22x', {}, true]) {
        assert.throws(() => resolvePort(invalid, 2022, 'etserver port'), /etserver port/)
    }
})

test('a profile with its port cleared connects to the default etserver port', async () => {
    const { server, session } = await setup({ port: null })
    const targets = []
    session.ping = async (host, port) => { targets.push({ host, port }) }
    ssh.behavior.start = async () => { throw new Error('stop here') }
    try {
        await assert.rejects(session.start(), /stop here/)
        assert.deepEqual(targets, [{ host: '127.0.0.1', port: 2022 }])
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('environment variables from a hand-edited config are sent as strings', async () => {
    const { server, session } = await setup({
        environmentVariables: { DEBUG: 1, VERBOSE: true, NAME: 'value', EMPTY: '', SKIPPED: null },
    })
    try {
        await startOrFail(session, server)
        const payload = decodeFields(server.received[0].payload)
        const variables = Object.fromEntries(getRepeatedBytes(payload, 3).map(entry => {
            const fields = decodeFields(entry)
            return [getString(fields, 1), getString(fields, 2)]
        }))
        assert.deepEqual(variables, { DEBUG: '1', VERBOSE: 'true', NAME: 'value', EMPTY: '' })
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('a session destroyed during the reachability probe settles at once', async () => {
    // 192.0.2.0/24 is reserved for documentation (RFC 5737): a connect to it
    // either hangs or fails at once, and both must end promptly on destroy.
    const { server, session } = await setup({ host: '192.0.2.1' })
    try {
        const starting = session.start()
        starting.catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 50))

        const started = Date.now()
        await session.destroy()
        await assert.rejects(starting)
        assert.ok(Date.now() - started < 1000, 'start() outlived destroy()')
        assert.equal(ssh.sessions.length, 0)
    } finally {
        await session.destroy()
        await server.close()
    }
})

test('a forward with no bind address is not mistaken for a private one', () => {
    const { isLoopbackBindAddress } = load('src/session/tunnelSpec.ts')
    for (const host of [undefined, null, '', '0.0.0.0', '::', '192.168.1.10']) {
        assert.equal(isLoopbackBindAddress(host), false)
    }
    for (const host of ['127.0.0.1', ' localhost ', '[::1]', '127.8.8.8']) {
        assert.equal(isLoopbackBindAddress(host), true)
    }
})

test('a profile whose forwards are not a list still connects', async () => {
    const forward = { type: 'Local', host: '127.0.0.1', port: 0, targetAddress: 'localhost', targetPort: 80 }
    const cases = [
        { forwardedPorts: null, listeners: 0 },
        { forwardedPorts: undefined, listeners: 0 },
        { forwardedPorts: 'nonsense', listeners: 0 },
        { forwardedPorts: { 0: forward }, listeners: 0 },
        { forwardedPorts: [null, 7, 'x', forward], listeners: 1 },
    ]
    for (const { forwardedPorts, listeners } of cases) {
        const { server, session } = await setup({ forwardedPorts })
        try {
            await startOrFail(session, server)
            assert.equal(session.open, true)
            assert.equal(session.forwards.listeners.length, listeners)
        } finally {
            await session.destroy()
            await server.close()
        }
    }
})

test('a switch is on when it says so, and not for any text at all', () => {
    const { resolveFlag } = load('src/session/options.ts')
    for (const on of [true, 'true', 'True', ' yes ', 'on', 'ON']) {
        assert.equal(resolveFlag(on), true, JSON.stringify(on))
    }
    for (const off of [false, 'false', 'no', 'off', '0', 'False ', '', 'nonsense', 0, 1, null, undefined, {}, []]) {
        assert.equal(resolveFlag(off), false, JSON.stringify(off))
    }
})

test('a profile whose login scripts are not what they should be still gets a session', () => {
    const scripted = scripts => new ETSession(createInjector(), createProfile(1, { scripts })).loginScriptProcessor.scripts
    for (const scripts of [null, undefined, 'nonsense', 7, { expect: 'x', send: 'y' }]) {
        assert.deepEqual(scripted(scripts), [], JSON.stringify(scripts))
    }
    assert.deepEqual(
        scripted([
            null,
            'nonsense',
            { expect: 'login:', send: 'me' },
            { send: 'at once' },
            { expect: 'no answer' },
            { expect: 42, send: 7, optional: 'no', isRegex: true },
        ]),
        [
            { expect: 'login:', send: 'me', isRegex: false, optional: false },
            { expect: '', send: 'at once', isRegex: false, optional: false },
            { expect: '42', send: '7', isRegex: true, optional: false },
        ],
    )
})

test('what Tabby hangs on a map of variables is not sent as variables', () => {
    const { resolveEnvironment } = load('src/session/options.ts')
    // What a map with defaults looks like once Tabby has wrapped it.
    const wrapped = { LANG: 'en_NZ.UTF-8', __nonStructural: true }
    for (const internal of ['__getValue', '__getDefault', '__setDefaults', '__setValue', '__cleanup']) {
        wrapped[internal] = () => {}
    }
    assert.deepEqual({ ...resolveEnvironment(wrapped) }, { LANG: 'en_NZ.UTF-8' })
    // A variable may still be called what it likes.
    const named = resolveEnvironment(JSON.parse('{"__CF_USER_TEXT_ENCODING": "0x1F5", "__proto__": "kept"}'))
    assert.deepEqual(Object.keys(named).sort(), ['__CF_USER_TEXT_ENCODING', '__proto__'])
    assert.equal(named.__proto__, 'kept')
})

test('a map of variables is declared as one, so that Tabby leaves it alone', () => {
    const { ETProfilesService } = load('src/profiles.ts')
    const defaults = new ETProfilesService({ instant: x => x }).configDefaults
    assert.equal(defaults.options.environmentVariables.__nonStructural, true)
})

test('a tunnel bound to an IPv6 address is not asked of a server that was reached over IPv4', async () => {
    const tunnel = (host, port) => ({ type: 'Remote', host, port, targetAddress: 'localhost', targetPort: 80, description: '' })
    const { server, session } = await setup({ forwardedPorts: [tunnel('::1', 9000), tunnel('127.0.0.1', 9001)] })
    const messages = []
    session.serviceMessage$.subscribe(message => messages.push(message))
    try {
        await startOrFail(session, server)
        const tunnels = getRepeatedBytes(decodeFields(server.received[0].payload), 2)
        assert.equal(tunnels.length, 1, 'an etserver without IPv6 would have been asked to bind ::1, and would have aborted')
        assert.equal(messages.filter(x => /Skipping the reverse tunnel ::1:9000/.test(x)).length, 1)
    } finally {
        await session.destroy()
        await server.close()
    }
})
