import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Injector } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ToastrService } from 'ngx-toastr'
import stripAnsi from 'strip-ansi'
import { Platform } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { KeyboardInteractivePrompt, SSHProfile, SSHSession } from 'tabby-ssh'

import { ETProfile } from '../api/interfaces'
import { ETSession, ETSessionDestroyedError } from '../session/etSession'
import { ETConnectionState } from '../protocol/connection'
import { ETPortForwardingModalComponent } from './etPortForwardingModal.component'

/**
 * From when on a request for a new session, made while one is being set up,
 * is one to start over, in ms. Before that it is the same request twice.
 */
const REPEATED_REQUEST_AFTER = 1000

/** @hidden */
@Component({
    selector: 'et-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./etTab.component.pug')}`,
    styles: [...BaseTerminalTabComponent.styles, require('./etTab.component.scss')],
    animations: BaseTerminalTabComponent.animations,
})
export class ETTabComponent extends ConnectableTerminalTabComponent<ETProfile> {
    Platform = Platform
    session: ETSession|null = null
    connectionState: ETConnectionState = 'connecting'
    activeKIPrompt: KeyboardInteractivePrompt|null = null
    /** The synthesised SSH profile, needed by the keyboard-interactive panel. */
    bootstrapProfile: SSHProfile|null = null

    private disconnectToast: { toastId: number }|null = null
    /** The SSH session that prompts are coming from. */
    private bootstrapSSH: SSHSession|null = null
    /** A replacement session is being set up. */
    private replacing = false
    /** Another one was asked for meanwhile. */
    private askedAgain = false
    /** When the replacement that is being set up was asked for. */
    private replacingSince = 0
    /** The tab is being told that its session has ended. */
    private sessionEnding = false
    /** The tab has been closed, and nothing may be started for it any more. */
    private closed = false

    constructor (
        injector: Injector,
        private ngbModal: NgbModal,
        private toastr: ToastrService,
    ) {
        super(injector)
        this.enableToolbar = true
        this.sessionChanged$.subscribe(() => {
            this.activeKIPrompt = null
        })
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'restart-et-session':
                    this.reconnect()
                    break
                case 'et-force-reconnect':
                    this.session?.forceReconnect()
                    break
            }
        })
        super.ngOnInit()
    }

    /**
     * Start a new session in place of the current one - once.
     *
     * Tabby destroys the current session and then initializes another. But
     * destroying a session tells the tab that its session has ended, and a tab
     * whose profile says to reconnect answers that by reconnecting: two
     * sessions are started, the second replaces the first, and the first goes
     * live with no tab to show it or to close it. A second click does the same.
     *
     * Asked again while a replacement is on its way, that one is given up and
     * another is started in its place, when it has gone. It may be waiting for
     * an answer that is not going to come, and asking again is all that there
     * is to do about it, short of closing the tab. Not when it is asked again
     * at once, which is a button that was clicked twice.
     */
    async reconnect (): Promise<void> {
        if (this.closed) {
            return
        }
        if (this.replacing) {
            // The tab's own answer to the end of the session that is being
            // replaced is not a request, and a second click is not a second one.
            if (!this.sessionEnding && Date.now() - this.replacingSince >= REPEATED_REQUEST_AFTER) {
                this.askedAgain = true
                void this.session?.destroy()
            }
            return
        }
        this.replacing = true
        try {
            do {
                this.askedAgain = false
                this.replacingSince = Date.now()
                await super.reconnect()
            } while (this.askedAgain && !this.closed)
        } finally {
            this.replacing = false
        }
    }

    /**
     * The session that a new one is replacing has not ended, as far as the tab
     * goes. A tab that closes when its session ends would close here, and the
     * new session would be started with no tab to show it or to end it.
     */
    protected shouldTabBeDestroyedOnSessionClose (): boolean {
        if (this.replacing) {
            return false
        }
        return super.shouldTabBeDestroyedOnSessionClose()
    }

    /**
     * Do what changes what the window shows where Angular sees it done.
     *
     * Angular looks again when something was done in its zone. What a session
     * reports, it reports from a socket or from a timer, which is not there,
     * and Tabby itself starts a session from where its terminal says that it
     * is ready, which is not there either. A state that changed, or a prompt
     * that is waiting, would be shown whenever something else made Angular
     * look: a key, the mouse, the cursor blinking in a terminal that has the
     * focus.
     */
    private shown <T> (change: () => T): T {
        return this.zone.run(change)
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        if (this.closed) {
            return
        }

        // Whatever is still here is being replaced, and must not outlive that.
        const replaced = this.session
        let session: ETSession
        try {
            session = new ETSession(this.injector, this.profile)
        } catch (e) {
            // Nothing that a profile may hold should get here. But what does
            // leaves a tab with no session, which shows nothing and says
            // nothing, unless it is said here.
            this.notifications.error(e.message, this.etNotificationTitle)
            void replaced?.destroy()
            return
        }
        this.setSession(session)
        void replaced?.destroy()
        // The previous session, if any, left the indicator on 'ended', and a new
        // one reports nothing until it is connected.
        this.connectionState = 'connecting'

        this.attachSessionHandler(session.serviceMessage$, msg => this.shown(() => {
            this.showServiceToast(msg)
        }))
        this.attachSessionHandler(session.connectionState$, state => this.shown(() => {
            this.onETConnectionState(state)
        }))
        this.attachSessionHandler(session.keyboardInteractivePrompt$, prompt => this.shown(() => {
            // By now tabby-ssh knows who is logging in, which the profile may not
            // say: a profile with no user asks for one.
            if (this.bootstrapSSH) {
                this.bootstrapProfile = this.profileForPrompts(this.bootstrapSSH)
            }
            this.activeKIPrompt = prompt
            setTimeout(() => this.frontend?.scrollToBottom())
        }))
        // The KI panel needs the SSH profile the bootstrap actually used, so it can
        // look up and offer to save the password.
        this.attachSessionHandler(session.bootstrapSession$, s => this.shown(() => {
            this.bootstrapSSH = s
            this.bootstrapProfile = this.profileForPrompts(s)
            // A prompt is only worth showing while something waits for the
            // answer. The bootstrap disconnects once it has the session key, or
            // has failed, and the prompt goes with it.
            this.attachSessionHandler(s.willDestroy$, () => this.shown(() => {
                this.activeKIPrompt = null
            }))
        }))

        this.startSpinner(this.translate.instant(_('Connecting')))
        try {
            // The session itself does its work outside of Angular's zone,
            // wherever it was asked for: what it reads and writes is nothing
            // for Angular to look at, a packet at a time.
            await this.zone.runOutsideAngular(() => session.start())
            session.resize(this.size.columns, this.size.rows)
        } catch (e) {
            // A session that was destroyed while starting did not fail: the tab
            // was closed, a new session was asked for, or the connection ended
            // and has already said why.
            if (!(e instanceof ETSessionDestroyedError)) {
                this.shown(() => this.notifications.error(e.message, this.etNotificationTitle))
            }
            // A session that failed mid-start() never set open=true, so the tab's
            // close path would skip BaseSession.destroy() and leak its timers and
            // local port listeners. Tear it down here instead.
            await session.destroy().catch(() => { /* already down */ })
        } finally {
            // Shown, whatever came of it: a session that is open has a button
            // in the toolbar that one that is not has not.
            this.shown(() => {
                // "New session" starts the next attempt before this one has finished
                // failing; by then the spinner belongs to that attempt.
                if (!this.session || this.session === session) {
                    this.stopSpinner()
                }
            })
        }
    }

    /**
     * The profile for tabby-ssh's prompt panel to file a password under.
     *
     * The panel saves and looks up passwords by the profile's host and user.
     * When the user was asked for, the profile's is empty: nothing is saved to
     * the keychain at all, and the vault files it under no name. A copy, since
     * the profile is the SSH session's own.
     */
    private profileForPrompts (ssh: SSHSession): SSHProfile {
        const user = ssh.authUsername
        if (!user || user === ssh.profile.options.user) {
            return ssh.profile
        }
        return { ...ssh.profile, options: { ...ssh.profile.options, user } }
    }

    async destroy (): Promise<void> {
        this.closed = true
        const session = this.session
        await super.destroy()
        // Tabby destroys a session only once it is open. One that is still
        // bootstrapping or connecting would carry on regardless and go live
        // after its tab is gone, holding a connection to the remote session, a
        // keepalive timer and the profile's local ports until Tabby exits.
        await session?.destroy()
    }

    protected onSessionDestroyed (): void {
        this.dismissDisconnectToast()
        if (this.frontend) {
            this.notifications.info(
                this.translate.instant(_('{host}: session closed'), { host: this.profile.options.host }),
                this.etNotificationTitle,
            )
            this.sessionEnding = true
            try {
                super.onSessionDestroyed()
            } finally {
                this.sessionEnding = false
            }
        }
    }

    ngOnDestroy (): void {
        this.dismissDisconnectToast()
        super.ngOnDestroy()
    }

    private onETConnectionState (state: ETConnectionState): void {
        const wasDisconnected = this.disconnectToast !== null
        this.connectionState = state
        if (state === 'reconnecting') {
            this.ensureDisconnectToast()
            return
        }
        this.dismissDisconnectToast()
        if (state === 'connected' && wasDisconnected) {
            this.toastr.success(
                this.translate.instant(_('Session resumed')),
                this.etNotificationTitle,
            )
        }
    }

    private ensureDisconnectToast (): void {
        if (this.disconnectToast) {
            return
        }
        this.disconnectToast = this.toastr.warning(
            `${this.etNotificationTitle} — ${this.translate.instant(_('Connection lost, attempting to resume the session...'))}`,
            this.translate.instant(_('Disconnected')),
            { disableTimeOut: true, tapToDismiss: false, closeButton: false },
        )
    }

    private dismissDisconnectToast (): void {
        if (this.disconnectToast) {
            this.toastr.clear(this.disconnectToast.toastId)
        }
        this.disconnectToast = null
    }

    private showServiceToast (msg: string): void {
        const text = stripAnsi(msg).replace(/\s+/g, ' ').trim()
        if (!text) {
            return
        }
        const title = this.etNotificationTitle
        if (text.startsWith('X ') || this.isErrorServiceMessage(text)) {
            this.notifications.error(text, title)
        } else if (text.startsWith('~ ') || /dropped/i.test(text)) {
            this.toastr.warning(text, title)
        } else {
            this.notifications.info(text, title)
        }
    }

    private isErrorServiceMessage (text: string): boolean {
        return /fail|refus|could not|rejected|terminated|too far|mismatch|error/i.test(text)
    }

    private get etNotificationTitle (): string {
        const o = this.profile?.options as Partial<ETProfile['options']>|null|undefined
        return `${String(o?.user ?? '')}@${String(o?.host ?? '')}:${String(o?.port ?? '')}`
    }

    showPortForwarding (): void {
        if (!this.session) {
            return
        }
        const modal = this.ngbModal.open(ETPortForwardingModalComponent)
            .componentInstance as ETPortForwardingModalComponent
        modal.session = this.session
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
            return true
        }
        if (!(this.profile.options.warnOnClose ?? this.config.store.et.warnOnClose)) {
            return true
        }
        return (await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant(
                _('Detach from {host}? The remote session will keep running.'),
                this.profile.options,
            ),
            buttons: [this.translate.instant(_('Detach')), this.translate.instant(_('Do not close'))],
            defaultId: 0,
            cancelId: 1,
        })).response === 0
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated()
            || this.recentInputs.charCodeAt(this.recentInputs.length - 1) === 4
            || this.recentInputs.endsWith('exit\r')
    }
}
