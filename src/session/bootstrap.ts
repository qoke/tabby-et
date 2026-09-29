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
import { resolveText, resolveVerbosity } from './options'

const IDPASSKEY_RE = /IDPASSKEY:([A-Za-z0-9]{16})\/([A-Za-z0-9]{32})/
const BOOTSTRAP_TIMEOUT = 30000

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
        const command = this.buildCommand(sshProfile.options.user, options)

        // Redact: on the jump-host path the command embeds the real id/passkey.
        this.logger.debug(`Bootstrap command: ${redactCredentials(command)}`)

        const session = new SSHSession(this.injector, sshProfile)
        this.sshSessionCreated.next(session)
        try {
            await this.orCancelled(session.start())
            const output = await this.orCancelled(
                this.execAndCapture(session, command, getCaptureLimit(this.profile.options.bootstrapCaptureLimit)),
            )
            const match = IDPASSKEY_RE.exec(output.stdout)
            if (!match) {
                throw new Error(this.explainMissingMarker(output))
            }
            return { id: match[1], passkey: match[2] }
        } finally {
            // ET does not need the SSH connection after the bootstrap.
            await session.destroy().catch(() => { /* best effort */ })
        }
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
        const serverFifo = resolveText(this.profile.options.serverFifo)
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

        if (this.profile.options.killOtherSessions) {
            // user can legitimately be empty ("ask every time") - pkill -u with a
            // null username would kill nothing but looks confusing in logs.
            if (user) {
                command = `pkill etterminal -u ${shellQuote.quote([user])}; sleep 0.5; ${command}`
            }
        }
        return command
    }

    private execAndCapture (session: SSHSession, command: string, captureLimit: number): Promise<{ stdout: string, stderr: string }> {
        return new Promise((resolve, reject) => {
            let stdout = ''
            let stderr = ''
            let stdoutBytes = 0
            let stderrBytes = 0
            let settled = false
            let timer: any = null

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
                    resolve({ stdout, stderr })
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
                        if (stdoutBytes < captureLimit) {
                            const chunk = Buffer.from(data).subarray(0, captureLimit - stdoutBytes)
                            stdout += chunk.toString('utf8')
                            stdoutBytes += chunk.length
                        }
                        // Resolve as soon as the marker appears - etterminal daemonises and
                        // the channel may stay open briefly afterwards.
                        if (IDPASSKEY_RE.test(stdout)) {
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
        const user = resolveText(o.user)
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
            if (user) {
                resolved.options.user = user
            }
            return resolved
        }

        const synthetic: PartialProfile<SSHProfile> = {
            type: 'ssh',
            name: `ET bootstrap for ${host}`,
            // A blank user means "ask every time", which is tabby-ssh's to do.
            // No user at all leaves it to the SSH defaults, as it always has.
            options: { host, port, user: user ?? (typeof o.user === 'string' ? '' : undefined) },
        }
        // Route through the profile service so global SSH defaults still apply.
        return this.profiles.getConfigProxyForProfile<SSHProfile>(synthetic)
    }
}
