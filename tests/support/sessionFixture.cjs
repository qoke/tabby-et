'use strict'

// Everything an ETSession needs around it: a scripted SSH bootstrap, an
// injector, a profile, and a fake etserver for it to connect to.

const { createLoader, createLogger, Subject, ReplaySubject } = require('./load.cjs')
const { createFakeEtServer } = require('./fakeEtServer.cjs')

const id = 'RegressionTestId'
const passkey = 'RegressionTestPasskey00000000000'

function createSessionFixture () {
    /**
     * The bootstrap's SSH session, scripted. `behavior.start` lets a test hold
     * the SSH connection open; the exec channel always prints the session key.
     */
    const ssh = { sessions: [], behavior: {}, uniqueIds: false, issued: 0 }
    class SSHSession {
        constructor (_injector, profile) {
            this.profile = profile
            this.serviceMessage$ = new Subject()
            this.keyboardInteractivePrompt$ = new Subject()
            this.willDestroy$ = new Subject()
            this.authUsername = null
            this.started = false
            this.destroyed = false
            ssh.sessions.push(this)
        }

        async start () {
            this.started = true
            await ssh.behavior.start?.(this)
            // tabby-ssh asks for a name when the profile has none.
            this.authUsername = this.profile.options.user || ssh.behavior.prompted || null
        }

        async openExecChannel (command) {
            this.command = command
            // etterminal makes up the id and the key, so no two are alike.
            this.id = ssh.uniqueIds ? `RegressionTest${String(ssh.issued++).padStart(2, '0')}` : id
            const data$ = new ReplaySubject(1)
            data$.next(Buffer.from(`motd noise\nIDPASSKEY:${this.id}/${passkey}\n`))
            return { data$, extendedData$: new Subject(), closed$: new Subject(), eof$: new Subject() }
        }

        async destroy () {
            this.destroyed = true
            this.willDestroy$.next()
            this.willDestroy$.complete()
        }
    }

    const load = createLoader({
        'tabby-ssh': { PortForwardType: { Local: 'Local', Remote: 'Remote' }, SSHSession },
    })
    const core = load.modules['tabby-core']
    const FakeEtServer = createFakeEtServer(load)

    function createInjector () {
        const services = new Map([
            [core.LogService, { create: () => createLogger() }],
            [core.ConfigService, { store: { et: { debugProtocol: false, defaultEtterminalPath: null } } }],
            [core.ProfilesService, { getConfigProxyForProfile: profile => profile, getProfiles: async () => [] }],
        ])
        return { get: token => services.get(token) }
    }

    function createProfile (port, options = {}) {
        return {
            type: 'et',
            name: 'test',
            options: {
                host: '127.0.0.1',
                port,
                user: 'tester',
                sshProfile: null,
                sshPort: 22,
                etterminalPath: null,
                serverFifo: null,
                killOtherSessions: false,
                verbose: 0,
                bootstrapCaptureLimit: null,
                keepaliveInterval: 5,
                maxReconnectAttempts: 0,
                warnOnClose: null,
                forwardedPorts: [],
                forwardAgent: false,
                environmentVariables: {},
                jumpHost: null,
                jumpPort: 2022,
                jumpSshProfile: null,
                jumpSshPort: 22,
                input: {},
                scripts: [],
                ...options,
            },
        }
    }

    async function startServer (options = {}) {
        ssh.sessions = []
        ssh.behavior = {}
        ssh.uniqueIds = !!options.acceptAnyId
        ssh.issued = 0
        const server = new FakeEtServer({ id, passkey, ...options })
        await server.listen()
        return server
    }

    return { load, ssh, createInjector, createProfile, startServer, id, passkey }
}

module.exports = { createSessionFixture }
