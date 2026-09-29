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

// ---- an SSH session with Tabby's own lifecycle ------------------------------
//
// tabby-ssh creates its client part-way through start(), and its destroy()
// disconnects a client it assumes to exist. It resolves a profile's jump host
// in the SSH tab, not in the session: the session only uses the channel it is
// given. It learns the username during authentication.

function createTabbyLikeSSH () {
    const world = { sessions: [], profiles: [], connect: async () => {}, prompted: null }
    class SSHSession {
        constructor (_injector, profile) {
            this.profile = profile
            this.jumpChannel = null
            this.authUsername = null
            this.disconnects = 0
            this.commands = []
            this.serviceMessage$ = new Subject()
            this.keyboardInteractivePrompt$ = new Subject()
            this.willDestroy$ = new Subject()
            world.sessions.push(this)
        }

        async start () {
            // tabby-ssh sets up whatever forwards its profile has, once it is in.
            this.forwardsAtStart = [...this.profile.options.forwardedPorts ?? []]
            this.via = this.jumpChannel
            this.jumpChannel = null
            await world.connect(this)
            this.ssh = {
                disconnect: () => { this.disconnects++ },
                openTCPForwardChannel: async target => {
                    this.forwardedTo = target
                    return { from: this.profile.options.host, to: target }
                },
            }
            const user = this.profile.options.user || world.prompted
            this.authUsername = user?.startsWith('$') ? process.env[user.slice(1)] ?? user : user
        }

        async openExecChannel (command) {
            this.commands.push(command)
            const data$ = new Subject()
            setImmediate(() => data$.next(Buffer.from('IDPASSKEY:RegressionTestId/RegressionTestPasskey00000000000\n')))
            return { data$, extendedData$: new Subject(), closed$: new Subject(), eof$: new Subject() }
        }

        async destroy () {
            this.willDestroy$.next()
            this.ssh.disconnect()
        }
    }

    const load = createLoader({
        'tabby-ssh': { PortForwardType: { Local: 'Local', Remote: 'Remote' }, SSHSession },
    })
    const bootstrapModule = load('src/session/bootstrap.ts')
    const tabbyCore = load.modules['tabby-core']
    world.create = (options = {}) => {
        const services = new Map([
            [tabbyCore.LogService, { create: () => createLogger() }],
            [tabbyCore.ConfigService, { store: { et: { defaultEtterminalPath: null } } }],
            [tabbyCore.ProfilesService, {
                getConfigProxyForProfile: profile => profile,
                getProfiles: async () => JSON.parse(JSON.stringify(world.profiles)),
            }],
        ])
        return new bootstrapModule.ETBootstrap({ get: token => services.get(token) }, {
            options: {
                host: 'example.com', user: 'tester', sshPort: 22, sshProfile: null, etterminalPath: null,
                serverFifo: null, killOtherSessions: false, verbose: 0, bootstrapCaptureLimit: null, ...options,
            },
        })
    }
    return world
}

test('an SSH connection that completes after a cancelled bootstrap is disconnected', async () => {
    const world = createTabbyLikeSSH()
    let connected = null
    world.connect = () => new Promise(resolve => { connected = resolve })
    const before = armedTimers()
    const bootstrap = world.create()
    const running = bootstrap.run()
    running.catch(() => {})
    await settle(20)

    bootstrap.cancel()
    await assert.rejects(running, /cancelled/)
    assert.equal(world.sessions[0].ssh, undefined, 'the scenario needs a client that does not exist yet')

    connected() // the transport comes up after all
    await settle(300)
    assert.equal(world.sessions[0].disconnects > 0, true, 'the late SSH connection was left open')
    assert.equal(armedTimers(), before, 'watching for the late connection left a timer behind')
})

test('an SSH session that never settles is disconnected as soon as it connects', async () => {
    const world = createTabbyLikeSSH()
    // The transport comes up late, and authentication then waits on a prompt
    // that nobody is left to answer: start() never settles at all.
    let connected = null
    world.connect = session => new Promise(() => {
        connected = () => {
            session.ssh = { disconnect: () => { session.disconnects++ } }
        }
    })
    const before = armedTimers()
    const bootstrap = world.create()
    const running = bootstrap.run()
    running.catch(() => {})
    await settle(20)
    bootstrap.cancel()
    await assert.rejects(running, /cancelled/)

    connected()
    await settle(400)
    assert.equal(world.sessions[0].disconnects > 0, true, 'the late SSH connection was left open')
    assert.equal(armedTimers(), before, 'watching for the late connection left a timer behind')
})

test('other sessions are terminated for the user who logged in', async () => {
    const world = createTabbyLikeSSH()
    world.prompted = 'typed-at-the-prompt'
    await world.create({ user: '', killOtherSessions: true }).run()
    assert.match(world.sessions[0].commands[0], /^pkill etterminal -u typed-at-the-prompt; sleep 0\.5; echo /)

    process.env.ET_TEST_LOGIN = 'from-the-environment'
    try {
        await world.create({ user: '$ET_TEST_LOGIN', killOtherSessions: true }).run()
        assert.match(world.sessions[1].commands[0], /^pkill etterminal -u from-the-environment; /)
    } finally {
        delete process.env.ET_TEST_LOGIN
    }

    await world.create({ user: 'tester', killOtherSessions: true }).run()
    assert.match(world.sessions[2].commands[0], /^pkill etterminal -u tester; /)
    await world.create({ user: 'tester', killOtherSessions: false }).run()
    assert.doesNotMatch(world.sessions[3].commands[0], /pkill/)
})

test('a linked SSH profile is reached through its jump host', async () => {
    const world = createTabbyLikeSSH()
    world.profiles = [
        { id: 'ssh:office', type: 'ssh', name: 'office', options: { host: 'office', user: 'me', port: 2200, jumpHost: 'ssh:bastion' } },
        { id: 'ssh:bastion', type: 'ssh', name: 'bastion', options: { host: 'bastion.example.com', user: 'gate', port: 22 } },
    ]
    const credentials = await world.create({ host: 'et.internal', user: '', sshProfile: 'ssh:office' }).run()
    assert.equal(credentials.id, 'RegressionTestId')

    const [bastion, destination] = world.sessions
    assert.equal(world.sessions.length, 2)
    assert.equal(bastion.profile.options.host, 'bastion.example.com')
    assert.equal(bastion.via, null)
    assert.deepEqual(
        { host: bastion.forwardedTo.addressToConnectTo, port: bastion.forwardedTo.portToConnectTo },
        { host: 'et.internal', port: 2200 },
    )
    assert.equal(destination.profile.options.host, 'et.internal')
    assert.deepEqual(destination.via, { from: 'bastion.example.com', to: bastion.forwardedTo }, 'the destination was dialled directly')
    assert.equal(destination.commands.length, 1)
    assert.equal(bastion.commands.length, 0)
    // Neither connection is needed once the session key is known.
    assert.equal(destination.disconnects > 0, true)
    assert.equal(bastion.disconnects > 0, true, 'the jump host connection was left open')
})

test('jump hosts are followed along the whole chain', async () => {
    const world = createTabbyLikeSSH()
    world.profiles = [
        { id: 'ssh:office', type: 'ssh', name: 'office', options: { host: 'office', user: 'me', jumpHost: 'ssh:inner' } },
        { id: 'ssh:inner', type: 'ssh', name: 'inner', options: { host: 'inner', user: 'me', port: 22, jumpHost: 'ssh:outer' } },
        { id: 'ssh:outer', type: 'ssh', name: 'outer', options: { host: 'outer', user: 'me', port: 22 } },
    ]
    await world.create({ host: 'et.internal', sshProfile: 'ssh:office' }).run()
    assert.deepEqual(world.sessions.map(x => x.profile.options.host), ['outer', 'inner', 'et.internal'])
    assert.equal(world.sessions[0].forwardedTo.addressToConnectTo, 'inner')
    assert.equal(world.sessions[1].forwardedTo.addressToConnectTo, 'et.internal')
    assert.equal(world.sessions[1].forwardedTo.portToConnectTo, 22)
    assert.equal(world.sessions.every(x => x.disconnects > 0), true)
})

test('a jump host that is missing, or that leads back to itself, is an error', async () => {
    const world = createTabbyLikeSSH()
    world.profiles = [
        { id: 'ssh:office', type: 'ssh', name: 'office', options: { host: 'office', user: 'me', jumpHost: 'ssh:gone' } },
    ]
    await assert.rejects(world.create({ sshProfile: 'ssh:office' }).run(), /jump host .*ssh:gone.* (not found|no longer exists)/i)
    assert.equal(world.sessions.length, 0)

    world.profiles = [
        { id: 'ssh:a', type: 'ssh', name: 'a', options: { host: 'a', user: 'me', jumpHost: 'ssh:b' } },
        { id: 'ssh:b', type: 'ssh', name: 'b', options: { host: 'b', user: 'me', jumpHost: 'ssh:a' } },
    ]
    await assert.rejects(world.create({ sshProfile: 'ssh:a' }).run(), /loop/i)
    assert.equal(world.sessions.length, 0)
})

test('a jump host that fails takes nothing down with it but the bootstrap', async () => {
    const world = createTabbyLikeSSH()
    world.profiles = [
        { id: 'ssh:office', type: 'ssh', name: 'office', options: { host: 'office', user: 'me', jumpHost: 'ssh:bastion' } },
        { id: 'ssh:bastion', type: 'ssh', name: 'bastion', options: { host: 'bastion', user: 'gate', port: 22 } },
    ]
    world.connect = async session => {
        if (session.profile.options.host === 'et.internal') {
            throw new Error('Authentication rejected')
        }
    }
    await assert.rejects(world.create({ host: 'et.internal', sshProfile: 'ssh:office' }).run(), /Authentication rejected/)
    assert.equal(world.sessions[0].disconnects > 0, true, 'the jump host connection was left open')
})

test('a linked jump host profile keeps its own user', async () => {
    const world = createTabbyLikeSSH()
    world.profiles = [
        { id: 'ssh:jump', type: 'ssh', name: 'jump', options: { host: 'old-name', user: 'jump-admin', port: 22 } },
        { id: 'ssh:dest', type: 'ssh', name: 'dest', options: { host: 'dest', user: 'someone', port: 22 } },
    ]
    const bootstrap = world.create({
        host: 'dest.example.com', user: 'app-user', jumpHost: 'jump.example.com', jumpSshProfile: 'ssh:jump', sshProfile: 'ssh:dest',
    })
    const jump = await bootstrap.resolveSSHProfile('jump')
    assert.equal(jump.options.user, 'jump-admin', 'the jump host would be logged into as the destination user')
    assert.equal(jump.options.host, 'jump.example.com')

    // For the destination the ET profile's user still wins, so that one SSH
    // profile can serve several ET hosts.
    const destination = await bootstrap.resolveSSHProfile('destination')
    assert.equal(destination.options.user, 'app-user')
    assert.equal(destination.options.host, 'dest.example.com')

    // With no linked profile there is nothing to keep: the one user it is.
    const synthetic = await world.create({ host: 'dest', user: 'app-user', jumpHost: 'jump', jumpSshPort: 2222 }).resolveSSHProfile('jump')
    assert.equal(synthetic.options.user, 'app-user')
})

/** Run the capture against a channel that the test feeds by hand. */
function capture (limit) {
    const data$ = new Subject()
    const extendedData$ = new Subject()
    const channel = { data$, extendedData$, closed$: new Subject(), eof$: new Subject() }
    const session = { openExecChannel: async () => channel }
    const bootstrap = createBootstrap({ bootstrapCaptureLimit: limit })
    return { channel, result: bootstrap.execAndCapture(session, 'test', limit), ready: settle(5) }
}

test('the session key is found however much was printed before it', async () => {
    const marker = 'IDPASSKEY:RegressionTestId/RegressionTestPasskey00000000000'
    for (const pieces of [
        [Buffer.alloc(1024, 0x2e), `${marker}\n`], // the cap is full when it arrives
        [Buffer.alloc(1000, 0x2e), `${marker}\n`], // it straddles the cap
        [Buffer.alloc(5000, 0x2e), marker.slice(0, 20), marker.slice(20, 41), `${marker.slice(41)}\n`], // in pieces, past the cap
        [Buffer.alloc(3000, 0x2e), 'IDPASSKEY:tooShort/x\n', Buffer.alloc(3000, 0x2e), `${marker}\n`], // after a false start
    ]) {
        const { channel, result, ready } = capture(1024)
        await ready
        for (const piece of pieces) {
            channel.data$.next(Buffer.from(piece))
        }
        channel.eof$.next()
        const output = await result
        assert.deepEqual(output.credentials, { id: 'RegressionTestId', passkey: 'RegressionTestPasskey00000000000' })
        assert.ok(Buffer.byteLength(output.stdout) <= 1024, 'more output was kept than the cap allows')
    }
})

test('a bootstrap whose output fills the cap still connects', async () => {
    ssh.sessions = []
    ssh.start = async () => {}
    ssh.openExecChannel = () => {
        const data$ = new Subject()
        setImmediate(() => {
            data$.next(Buffer.alloc(2048, 0x2e))
            data$.next(Buffer.from('IDPASSKEY:RegressionTestId/RegressionTestPasskey00000000000\n'))
        })
        return { data$, extendedData$: new Subject(), closed$: new Subject(), eof$: new Subject() }
    }
    try {
        const credentials = await createBootstrap({ bootstrapCaptureLimit: 1024 }).run()
        assert.deepEqual(credentials, { id: 'RegressionTestId', passkey: 'RegressionTestPasskey00000000000' })
    } finally {
        ssh.openExecChannel = null
    }
})

test('other sessions are terminated when the profile says so, and not when it says no', () => {
    for (const killOtherSessions of [true, 'true', 'yes', 'on']) {
        assert.match(createBootstrap({ killOtherSessions }).buildCommand('tester'), /^pkill etterminal -u tester; /)
    }
    for (const killOtherSessions of [false, 'false', 'no', 'off', '0', null, undefined, 0]) {
        assert.doesNotMatch(
            createBootstrap({ killOtherSessions }).buildCommand('tester'), /pkill/, JSON.stringify(killOtherSessions),
        )
    }
})

test('a user that the file holds as a number is that user, and not root', async () => {
    const world = createTabbyLikeSSH()
    const asked = async user => {
        world.sessions.length = 0
        await world.create({ user, killOtherSessions: true }).run()
        return { user: world.sessions[0].profile.options.user, command: world.sessions[0].commands[0] }
    }
    assert.equal((await asked(1234)).user, '1234')
    assert.match((await asked(1234)).command, /^pkill etterminal -u 1234; /)
    assert.equal((await asked(7)).user, '7')
    // Nothing at all is a user to be asked for, as an empty one is.
    world.prompted = 'typed-at-the-prompt'
    assert.equal((await asked(null)).user, '')
    assert.match((await asked(null)).command, /^pkill etterminal -u typed-at-the-prompt; /)
    assert.equal((await asked(' alice ')).user, 'alice')
})

test("the port forwards of a linked profile are its own, and not the bootstrap's", async () => {
    const world = createTabbyLikeSSH()
    const forward = { type: 'Local', host: '127.0.0.1', port: 8080, targetAddress: 'web.internal', targetPort: 80 }
    world.profiles = [
        { id: 'ssh:office', type: 'ssh', name: 'office', options: { host: 'office', user: 'me', port: 22, jumpHost: 'ssh:bastion', forwardedPorts: [forward] } },
        { id: 'ssh:bastion', type: 'ssh', name: 'bastion', options: { host: 'bastion', user: 'gate', port: 22, forwardedPorts: [forward] } },
    ]
    await world.create({ host: 'et.internal', user: '', sshProfile: 'ssh:office' }).run()
    assert.equal(world.sessions.length, 2)
    for (const session of world.sessions) {
        assert.deepEqual(session.forwardsAtStart, [], `${session.profile.name} set up its port forwards for the bootstrap`)
    }
    // What is saved is what it was.
    assert.deepEqual(world.profiles.map(x => x.options.forwardedPorts), [[forward], [forward]])
})

test("the jump host's etterminal is told of its own fifo, and not of the destination's", () => {
    const jump = { credentials: { id: 'RegressionTestId', passkey: 'RegressionTestPasskey00000000000' }, jumpTo: { host: 'dest.internal', port: 2022 } }
    const argv = (options, to) => shellQuote.parse(
        createBootstrap(options).buildCommand('tester', to).replace(/^echo '[^']*' \| /, ''),
    ).join(' ')

    assert.equal(argv({ serverFifo: '/run/dest.fifo' }), 'etterminal --verbose=0 --serverfifo=/run/dest.fifo')
    assert.equal(
        argv({ serverFifo: '/run/dest.fifo' }, jump),
        'etterminal --verbose=0 --jump --dsthost=dest.internal --dstport=2022',
    )
    assert.equal(
        argv({ serverFifo: '/run/dest.fifo', jumpServerFifo: ' /run/jump.fifo ' }, jump),
        'etterminal --verbose=0 --serverfifo=/run/jump.fifo --jump --dsthost=dest.internal --dstport=2022',
    )
})
