'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const shellQuote = require('shell-quote')

const { createLoader, createLogger, Subject } = require('./support/load.cjs')

const ssh = { sessions: [], start: async () => {}, openExecChannel: null, linked: [] }
class SSHSession {
    constructor (_injector, profile) {
        this.profile = profile
        this.destroyed = false
        ssh.sessions.push(this)
    }

    start () {
        return ssh.start()
    }

    async openExecChannel () {
        if (ssh.openExecChannel) {
            return ssh.openExecChannel()
        }
        return { data$: new Subject(), extendedData$: new Subject(), closed$: new Subject(), eof$: new Subject() }
    }

    async destroy () {
        this.destroyed = true
    }
}

const load = createLoader({
    'tabby-ssh': { PortForwardType: { Local: 'Local', Remote: 'Remote' }, SSHSession },
})
const { ETBootstrap } = load('src/session/bootstrap.ts')
const core = load.modules['tabby-core']

function createBootstrap (options = {}, globals = {}) {
    const services = new Map([
        [core.LogService, { create: () => createLogger() }],
        [core.ConfigService, { store: { et: { defaultEtterminalPath: null, ...globals } } }],
        [core.ProfilesService, {
            getConfigProxyForProfile: profile => profile,
            getProfiles: async () => JSON.parse(JSON.stringify(ssh.linked)),
        }],
    ])
    return new ETBootstrap({ get: token => services.get(token) }, {
        options: {
            host: 'example.com',
            user: 'tester',
            sshPort: 22,
            sshProfile: null,
            etterminalPath: null,
            serverFifo: null,
            killOtherSessions: false,
            verbose: 0,
            bootstrapCaptureLimit: null,
            ...options,
        },
    })
}

/** What the remote shell will run, as argv, without the credentials piped into it. */
function commandFor (options, globals) {
    const command = createBootstrap(options, globals).buildCommand('tester')
    return shellQuote.parse(command.replace(/^echo '[^']*' \| /, '')).join(' ')
}

test('a cleared etterminal path falls through to the next default', () => {
    assert.equal(commandFor({ etterminalPath: '' }), 'etterminal --verbose=0')
    assert.equal(commandFor({ etterminalPath: '   ' }), 'etterminal --verbose=0')
    assert.equal(commandFor({ etterminalPath: '' }, { defaultEtterminalPath: '' }), 'etterminal --verbose=0')
    assert.equal(
        commandFor({ etterminalPath: '' }, { defaultEtterminalPath: '/opt/et/etterminal' }),
        '/opt/et/etterminal --verbose=0',
    )
    assert.equal(
        commandFor({ etterminalPath: ' /usr/local/bin/etterminal ' }, { defaultEtterminalPath: '/opt/et/etterminal' }),
        '/usr/local/bin/etterminal --verbose=0',
    )
})

test('a cleared verbosity field is sent as a number etterminal can parse', () => {
    for (const verbose of [null, undefined, '', 'loud', NaN]) {
        assert.equal(commandFor({ verbose }), 'etterminal --verbose=0')
    }
    assert.equal(commandFor({ verbose: 3 }), 'etterminal --verbose=3')
    assert.equal(commandFor({ verbose: '4' }), 'etterminal --verbose=4')
    assert.equal(commandFor({ verbose: 12 }), 'etterminal --verbose=9')
    assert.equal(commandFor({ verbose: -1 }), 'etterminal --verbose=0')
    assert.equal(commandFor({ verbose: 2.7 }), 'etterminal --verbose=2')
})

test('a blank server fifo adds no --serverfifo argument', () => {
    assert.equal(commandFor({ serverFifo: '   ' }), 'etterminal --verbose=0')
    assert.equal(commandFor({ serverFifo: ' /run/et.fifo ' }), 'etterminal --verbose=0 --serverfifo=/run/et.fifo')
})

test('cancelling a bootstrap settles run() and disconnects its SSH session', async () => {
    ssh.sessions = []
    ssh.start = () => new Promise(() => {}) // parked on a prompt, forever
    const bootstrap = createBootstrap()
    const running = bootstrap.run()
    running.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ssh.sessions.length, 1)

    bootstrap.cancel()

    await assert.rejects(running, /cancelled/)
    assert.equal(ssh.sessions[0].destroyed, true)
    // A cancelled bootstrap stays cancelled: the jump-host leg must not start.
    await assert.rejects(bootstrap.run(), /cancelled/)
    assert.equal(ssh.sessions.length, 1)
})

const armedTimers = () => process.getActiveResourcesInfo().filter(x => x === 'Timeout').length
const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

test('cancelling a bootstrap leaves no timer behind', async () => {
    for (const channel of ['never opens', 'opens and stays silent']) {
        ssh.sessions = []
        ssh.start = async () => {}
        ssh.openExecChannel = channel === 'never opens' ? () => new Promise(() => {}) : null
        const before = armedTimers()
        const bootstrap = createBootstrap()
        const running = bootstrap.run()
        running.catch(() => {})
        await settle(20)
        assert.equal(armedTimers(), before + 1, 'the capture timeout was never armed')

        bootstrap.cancel()

        await assert.rejects(running, /cancelled/)
        assert.equal(armedTimers(), before, `a timer outlived a bootstrap whose channel ${channel}`)
    }
    ssh.openExecChannel = null
})

test('the bootstrap is given the host that the probe reached', async () => {
    ssh.linked = []
    let profile = await createBootstrap({ host: '  example.com  ', user: ' tester ' }).resolveSSHProfile('destination')
    assert.equal(profile.options.host, 'example.com')
    assert.equal(profile.options.user, 'tester')

    profile = await createBootstrap({ host: 'example.com', jumpHost: ' jump.example.com\t', jumpSshPort: 2222 })
        .resolveSSHProfile('jump')
    assert.equal(profile.options.host, 'jump.example.com')
    assert.equal(profile.options.port, 2222)

    // Blank asks every time. Unset is left for the SSH defaults to fill in.
    profile = await createBootstrap({ host: 'example.com', user: '   ' }).resolveSSHProfile('destination')
    assert.equal(profile.options.user, '')
    profile = await createBootstrap({ host: 'example.com', user: undefined }).resolveSSHProfile('destination')
    assert.equal(profile.options.user, undefined)

    // A linked SSH profile keeps its own settings, and takes the ET host.
    ssh.linked = [{ id: 'ssh:linked', type: 'ssh', name: 'linked', options: { host: 'bastion', user: 'root', port: 22 } }]
    profile = await createBootstrap({ host: ' example.com ', user: '   ', sshProfile: 'ssh:linked' })
        .resolveSSHProfile('destination')
    assert.equal(profile.options.host, 'example.com')
    assert.equal(profile.options.user, 'root', 'a blank user replaced the linked profile\'s user')
    ssh.linked = []
})
