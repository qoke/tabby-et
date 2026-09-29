import { Injector } from '@angular/core'
import * as shellQuote from 'shell-quote'
import { Observable, ReplaySubject } from 'rxjs'
import { ConfigService, Logger, LogService, PartialProfile, ProfilesService } from 'tabby-core'
import { SSHProfile, SSHSession } from 'tabby-ssh'

import { ETProfile } from '../api/interfaces'
import { ET_TERM } from '../protocol/constants'
import { generateBootstrapId, generateBootstrapPasskey } from '../protocol/crypto'
import { redactCredentials } from '../redact'
import { getCaptureLimit } from './captureLimit'
import { resolveFlag, resolveText, resolveUser, resolveVerbosity } from './options'

const IDPASSKEY_RE = /IDPASSKEY:([A-Za-z0-9]{16})\/([A-Za-z0-9]{32})/
/** One character short of a whole marker: what may be the start of one. */
const MARKER_WINDOW = 'IDPASSKEY:'.length + 16 + 1 + 32 - 1
const BOOTSTRAP_TIMEOUT = 30000
/** How often an abandoned SSH session is looked at, and for how long at most. */
const ABANDON_POLL_INTERVAL = 100
const ABANDON_POLL_LIMIT = 120000

/**
 * What the bootstrap relies on in tabby-ssh beyond starting a session and
 * running a command in it. tabby-ssh's own tab goes through the same members
 * to set up a jump host, and SSHSession fills in `authUsername` as it
 * authenticates. Spelled out here so that this file says what it depends on.
 */
interface SSHSessionInternals {
    /** Who logged in: the profile's user, or what was typed at the prompt. */
    authUsername?: string|null
    /** A channel through a jump host for start() to connect over. */
    jumpChannel?: unknown
    /** The client. It does not exist until start() has connected. */
    ssh?: {
        openTCPForwardChannel?: (target: {
            addressToConnectTo: string
            portToConnectTo: number
            originatorAddress: string
            originatorPort: number
        }) => Promise<unknown>
    }
}

function internals (session: SSHSession): SSHSessionInternals {
    return session as unknown as SSHSessionInternals
}

/** The options of an SSH profile that decide how it is reached. */
function route (profile: SSHProfile): { host: string, port?: number|null, jumpHost?: string|null } {
    return profile.options as { host: string, port?: number|null, jumpHost?: string|null }
}

export { DEFAULT_CAPTURE_BYTES, MIN_CAPTURE_BYTES, MAX_CAPTURE_BYTES, getCaptureLimit } from './captureLimit'

export interface ETCredentials {
    id: string
    passkey: string
}

export { redactCredentials } from '../redact'

export class ETBootstrap {
    /**
     * Fires as soon as an SSHSession exists, so the caller can forward its service
     * messages and keyboard-interactive prompts to the UI. ReplaySubject(1) so a late
     * subscriber still sees the current session.
     */
    get sshSessionCreated$ (): Observable<SSHSession> { return this.sshSessionCreated }

    private sshSessionCreated = new ReplaySubject<SSHSession>(1)
    private logger: Logger
    private profiles: ProfilesService
    private config: ConfigService
    private cancelled = false
    private rejectOnCancel: (err: Error) => void
    /** Ends the capture that is in flight, if there is one, and its timeout with it. */
    private abortCapture: ((err: Error) => void)|null = null
    /** Rejects when cancel() is called; every wait in run() races against it. */
    private cancellation = new Promise<never>((_, reject) => {
        this.rejectOnCancel = reject
    })

    constructor (
        private injector: Injector,
        private profile: ETProfile,
    ) {
        this.logger = injector.get(LogService).create('et-bootstrap')
        this.profiles = injector.get(ProfilesService)
        this.config = injector.get(ConfigService)
        // Nothing may be waiting when cancel() is called, and that is fine.
        this.cancellation.catch(() => null)
    }

    /**
     * Abandon a bootstrap that is in flight, and refuse to start another.
     *
     * SSHSession.start() can wait on the user indefinitely - a password prompt,
     * an unknown host key - so it cannot be relied on to settle by itself once
     * the tab that would have shown the prompt is gone. run() rejects at once
     * and disconnects the SSH session on its way out.
     */
    cancel (): void {
        if (this.cancelled) {
            return
        }
        this.cancelled = true
        const reason = new Error('The SSH bootstrap was cancelled')
        // run() is released by the race in any case. This is for the capture
        // itself, which would otherwise sit on its timeout until it ran out.
        this.abortCapture?.(reason)
        this.rejectOnCancel(reason)
    }

    private orCancelled <T> (work: Promise<T>): Promise<T> {
        // Listed first on purpose: when both have already settled, race() goes
        // to the earlier entry, and a cancellation must win that tie.
        return Promise.race([this.cancellation, work])
    }

    /**
     * Run `etterminal` on the remote host over SSH and return the credentials it prints.
     * `dst` is set for the jump-host case, where we bootstrap the jump host with the
     * credentials the destination already gave us.
     */
    async run (options?: { credentials?: ETCredentials, jumpTo?: { host: string, port: number } }): Promise<ETCredentials> {
        const sshProfile = await this.orCancelled(this.resolveSSHProfile(options?.jumpTo ? 'jump' : 'destination'))
        /** Every SSH session opened on the way, the furthest jump host first. */
        const sessions: SSHSession[] = []
        try {
            const session = await this.connect(sshProfile, sessions, sshProfile.id ? [sshProfile.id] : [])

            // Built only now, because only now is it known who logged in. A
            // profile with no user asks for one, and one that names an
            // environment variable is resolved by tabby-ssh, both during
            // start(): before it, "terminate other sessions" has no name to
            // go by, or the wrong one.
            const command = this.buildCommand(
                resolveUser(internals(session).authUsername ?? sshProfile.options.user) ?? '', options,
            )
            // Redact: on the jump-host path the command embeds the real id/passkey.
            this.logger.debug(`Bootstrap command: ${redactCredentials(command)}`)

            const output = await this.orCancelled(
                this.execAndCapture(session, command, getCaptureLimit(this.profile.options.bootstrapCaptureLimit)),
            )
            if (!output.credentials) {
                throw new Error(this.explainMissingMarker(output))
            }
            return output.credentials
        } finally {
            // ET does not need the SSH connections after the bootstrap. The
            // destination goes first, since it runs through the others.
            for (const session of sessions.reverse()) {
                await session.destroy().catch(() => { /* best effort */ })
            }
        }
    }

    /**
     * Open an SSH session for `profile`, through its jump hosts if it has any.
     *
     * SSHSession does not look at the profile's jump host: tabby-ssh's tab does,
     * and hands the session a channel to connect over. Without the same being
     * done here, a linked profile that works in an SSH tab would be dialled
     * directly, and fail wherever the jump host is the only way in.
     */
    private async connect (profile: SSHProfile, sessions: SSHSession[], visited: string[]): Promise<SSHSession> {
        let jumpChannel: unknown = null
        const jumpHost = route(profile).jumpHost
        if (jumpHost) {
            if (visited.includes(jumpHost)) {
                throw new Error(`The SSH jump hosts of "${profile.name}" form a loop`)
            }
            const all = await this.orCancelled(this.profiles.getProfiles({ clone: true }))
            const found = all.find(x => x.id === jumpHost && x.type === 'ssh')
            if (!found) {
                throw new Error(`The SSH jump host "${jumpHost}" of "${profile.name}" no longer exists`)
            }
            const jump = await this.connect(
                this.profiles.getConfigProxyForProfile<SSHProfile>(found), sessions, [...visited, jumpHost],
            )
            const client = internals(jump).ssh
            if (!client?.openTCPForwardChannel) {
                throw new Error(`The SSH jump host "${found.name}" cannot forward connections`)
            }
            jumpChannel = await this.orCancelled(client.openTCPForwardChannel({
                addressToConnectTo: route(profile).host,
                portToConnectTo: route(profile).port ?? 22,
                originatorAddress: '127.0.0.1',
                originatorPort: 0,
            }))
        }

        // The session is here to run one command. What else the profile has
        // an SSH session do is not wanted: its port forwards would be bound
        // on every ET connect, for as long as the bootstrap takes, and fail
        // noisily wherever an SSH tab of the same profile holds them.
        profile.options.forwardedPorts = []
        const session = new SSHSession(this.injector, profile)
        if (jumpChannel) {
            internals(session).jumpChannel = jumpChannel
        }
        sessions.push(session)
        this.sshSessionCreated.next(session)
        const starting = session.start()
        try {
            await this.orCancelled(starting)
        } catch (err) {
            if (this.cancelled) {
                this.abandon(session, starting)
            }
            throw err
        }
        return session
    }

    /**
     * See to it that an SSH session we have stopped waiting for is disconnected.
     *
     * SSHSession cannot be cancelled. Its destroy() disconnects a client that
     * start() only creates part-way through: before that it throws, and the
     * connection that start() then goes on to open is nobody's. After that it
     * works, but start() may be waiting on a prompt and never settle at all. So
     * the session is watched for both: for its client to exist, and for
     * start() to settle, whichever comes first.
     */
    private abandon (session: SSHSession, starting: Promise<void>): void {
        let watching = true
        const began = Date.now()
        const disconnect = () => {
            if (watching) {
                watching = false
                clearInterval(timer)
                void session.destroy().catch(() => { /* best effort */ })
            }
        }
        const timer: any = setInterval(() => {
            if (internals(session).ssh) {
                disconnect()
            } else if (Date.now() - began > ABANDON_POLL_LIMIT) {
                watching = false
                clearInterval(timer)
            }
        }, ABANDON_POLL_INTERVAL)
        // Nothing should be kept waiting for this, a process least of all.
        timer.unref?.()
        starting.then(disconnect, disconnect)
    }

    private buildCommand (
        user: string,
        options?: { credentials?: ETCredentials, jumpTo?: { host: string, port: number } },
    ): string {
        // For the destination we send an 'XXX'-prefixed id so etterminal generates its
        // own credentials. For a jump host we must send the REAL credentials the
        // destination gave us, so the jump etserver registers the same key.
        const id = options?.credentials?.id ?? generateBootstrapId()
        const passkey = options?.credentials?.passkey ?? generateBootstrapPasskey()

        // Per-profile path wins, then the global default from Settings (which
        // would otherwise be dead config), then the remote PATH. A path field
        // that was filled in and then cleared holds '', not null: `??` would
        // take it for a path and run `''` as the remote command.
        const binary = resolveText(this.profile.options.etterminalPath)
            ?? resolveText(this.config.store.et.defaultEtterminalPath)
            ?? 'etterminal'
        // Likewise a cleared number field holds null, and `--verbose=null` makes
        // etterminal exit before it prints the session key.
        const args = [`--verbose=${resolveVerbosity(this.profile.options.verbose)}`]
        // The destination's etserver and the jump host's are two servers on
        // two hosts, each with a fifo of its own.
        const serverFifo = resolveText(options?.jumpTo ? this.profile.options.jumpServerFifo : this.profile.options.serverFifo)
        if (serverFifo) {
            args.push(`--serverfifo=${serverFifo}`)
        }
        if (options?.jumpTo) {
            args.push('--jump', `--dsthost=${options.jumpTo.host}`, `--dstport=${options.jumpTo.port}`)
        }

        // TERM must not contain '_': etterminal splits the line on it.
        const line = `${id}/${passkey}_${ET_TERM}`
        const quoted = shellQuote.quote([binary, ...args])
        let command = `echo '${line}' | ${quoted}`

        if (resolveFlag(this.profile.options.killOtherSessions)) {
            // user can legitimately be empty ("ask every time") - pkill -u with a
            // null username would kill nothing but looks confusing in logs.
            if (user) {
                command = `pkill etterminal -u ${shellQuote.quote([user])}; sleep 0.5; ${command}`
            }
        }
        return command
    }

    /**
     * Run `command` and watch its output for the session key.
     *
     * What is kept of the output is for explaining a failure, and is capped.
     * What is looked at is not: the key is looked for in everything that
     * arrives, through a window no longer than the key. A banner that fills
     * the cap does not hide it, and watching for it costs a few dozen bytes.
     */
    private execAndCapture (
        session: SSHSession, command: string, captureLimit: number,
    ): Promise<{ stdout: string, stderr: string, credentials: ETCredentials|null }> {
        return new Promise((resolve, reject) => {
            let stdout = ''
            let stderr = ''
            let stdoutBytes = 0
            let stderrBytes = 0
            let settled = false
            let timer: any = null
            let credentials: ETCredentials|null = null
            /** The end of what has arrived, in case the key is split across two chunks. */
            let window = ''

            const finish = (err?: Error) => {
                if (settled) {
                    return
                }
                settled = true
                this.abortCapture = null
                if (timer) {
                    clearTimeout(timer)
                }
                if (err) {
                    reject(err)
                } else {
                    resolve({ stdout, stderr, credentials })
                }
            }
            this.abortCapture = finish

            timer = setTimeout(
                () => finish(new Error('Timed out waiting for etterminal to start on the remote host')),
                BOOTSTRAP_TIMEOUT,
            )

            void (async () => {
                try {
                    const channel = await session.openExecChannel(command)
                    if (settled) {
                        return
                    }
                    channel.data$.subscribe(data => {
                        if (settled) {
                            return
                        }
                        const received = Buffer.from(data)
                        if (stdoutBytes < captureLimit) {
                            const chunk = received.subarray(0, captureLimit - stdoutBytes)
                            stdout += chunk.toString('utf8')
                            stdoutBytes += chunk.length
                        }
                        // One character a byte: the key is ASCII, and nothing
                        // else in here has to mean anything.
                        window += received.toString('latin1')
                        const match = IDPASSKEY_RE.exec(window)
                        window = window.slice(-MARKER_WINDOW)
                        // Resolve as soon as the marker appears - etterminal daemonises and
                        // the channel may stay open briefly afterwards.
                        if (match) {
                            credentials = { id: match[1], passkey: match[2] }
                            finish()
                        }
                    })
                    channel.extendedData$.subscribe(([, data]) => {
                        if (stderrBytes < captureLimit) {
                            const chunk = Buffer.from(data).subarray(0, captureLimit - stderrBytes)
                            stderr += chunk.toString('utf8')
                            stderrBytes += chunk.length
                        }
                    })
                    channel.closed$.subscribe(() => finish())
                    channel.eof$.subscribe(() => finish())
                } catch (err) {
                    finish(err as Error)
                }
            })()
        })
    }

    private explainMissingMarker (output: { stdout: string, stderr: string }): string {
        const combined = redactCredentials(`${output.stdout}\n${output.stderr}`).trim()
        if (/command not found|No such file or directory|not recognized/i.test(combined)) {
            return 'etterminal was not found on the remote host. Install Eternal Terminal there, '
                + 'or set a custom etterminal path in the profile\'s Advanced tab.'
        }
        if (!combined) {
            return 'The remote host produced no output. Is etterminal installed and is etserver running?'
        }
        return 'Could not read the ET session key from the remote host. Make sure your shell startup '
            + `files do not print anything. Remote output: ${combined.slice(0, 500)}`
    }

    private async resolveSSHProfile (role: 'destination'|'jump'): Promise<SSHProfile> {
        const o = this.profile.options
        const linkedId = role === 'jump' ? o.jumpSshProfile : o.sshProfile
        // Read exactly as ETSession reads them for the probe and the ET
        // connection. SSH must be asked for the host that those will use: the
        // raw text would differ by its stray whitespace, which tabby-ssh trims
        // for a direct connection but not for a proxy or for known hosts.
        const host = resolveText(role === 'jump' ? o.jumpHost : o.host) ?? ''
        const user = resolveUser(o.user)
        const port = role === 'jump' ? o.jumpSshPort : o.sshPort

        if (linkedId) {
            // MUST be cloned: getProfiles() hands back the objects inside
            // config.store.profiles by reference, and a ConfigProxy setter writes
            // straight through to them. Overriding host/user on a live profile
            // would permanently rewrite the user's saved SSH profile - and, since
            // tabby-ssh looks saved passwords up by profile id, would later offer
            // that profile's password to a different host.
            const all = await this.profiles.getProfiles({ clone: true })
            const found = all.find(x => x.id === linkedId && x.type === 'ssh')
            if (!found) {
                throw new Error(`The linked SSH profile "${linkedId}" no longer exists`)
            }
            const resolved = this.profiles.getConfigProxyForProfile<SSHProfile>(found)
            // The ET profile's host/user win when set, so one SSH profile can serve
            // several ET hosts in the same network.
            if (host) {
                resolved.options.host = host
            }
            // The ET profile has one user, and it is the destination's. A jump
            // host is often logged into as somebody else, and its profile is
            // the only place that can say who.
            if (user && role === 'destination') {
                resolved.options.user = user
            }
            return resolved
        }

        const synthetic: PartialProfile<SSHProfile> = {
            type: 'ssh',
            name: `ET bootstrap for ${host}`,
            // A blank user means "ask every time", which is tabby-ssh's to do.
            // No user at all leaves it to the SSH defaults, as it always has.
            options: { host, port, user },
        }
        // Route through the profile service so global SSH defaults still apply.
        return this.profiles.getConfigProxyForProfile<SSHProfile>(synthetic)
    }
}
