/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, DoCheck, Input, Output, EventEmitter } from '@angular/core'
import { ForwardedPortConfig, PortForwardType } from 'tabby-ssh'
import { isLoopbackBindAddress, parseTunnelSpec } from '../session/tunnelSpec'

/** Would the form show these two the same? */
function sameForward (a: ForwardedPortConfig, b: ForwardedPortConfig): boolean {
    return a.type === b.type
        && a.host === b.host
        && a.port === b.port
        && a.targetAddress === b.targetAddress
        && a.targetPort === b.targetPort
        && a.description === b.description
}

/** @hidden */
@Component({
    selector: 'et-port-forwarding-config',
    template: require('./etPortForwardingConfig.component.pug'),
})
export class ETPortForwardingConfigComponent implements DoCheck {
    @Input() model: ForwardedPortConfig[]
    @Output() forwardAdded = new EventEmitter<ForwardedPortConfig>()
    @Output() forwardRemoved = new EventEmitter<ForwardedPortConfig>()
    newForward: ForwardedPortConfig
    spec = ''
    specError: string|null = null
    /** ET has no Dynamic forwarding. */
    PortForwardType = PortForwardType

    /**
     * What was submitted last and has not turned up in `model` yet.
     *
     * Adding a forward can fail, and only the host knows whether it did. The
     * profile editor appends to a list, but a live session has to bind the
     * port first, and cannot add a remote forward at all. Nothing is reported
     * back, so the form goes by what it is shown: a forward that was added
     * turns up in `model`, as the object that was submitted, and one that never
     * does is still in the form to be corrected and tried again.
     */
    private pending: { forwards: ForwardedPortConfig[], spec: string|null }|null = null

    constructor () {
        this.reset()
    }

    ngDoCheck (): void {
        this.settle()
    }

    /**
     * A Local forward binding a non-loopback address publishes the tunnel to the
     * whole network - anyone who can reach this machine gets to use it. Only
     * Local forwards bind here; a Remote forward's `host` is bound by etserver.
     */
    exposesToNetwork (fw: ForwardedPortConfig): boolean {
        return fw.type === PortForwardType.Local && !isLoopbackBindAddress(fw.host)
    }

    reset (): void {
        this.newForward = {
            type: PortForwardType.Local,
            host: '127.0.0.1',
            port: 8000,
            targetAddress: 'localhost',
            targetPort: 80,
            description: '',
        }
    }

    addForward (): void {
        this.specError = null
        // The inputs are type=number but the browser happily hands us NaN or
        // out-of-range values; catch them here instead of at net.createServer.
        for (const [name, port] of [['port', this.newForward.port], ['target port', this.newForward.targetPort]] as const) {
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                this.specError = `Invalid ${name} "${port}". Ports must be between 1 and 65535.`
                return
            }
        }
        // A copy, because the form goes on being edited, and what it has
        // handed over is no longer the form's to change.
        const forward = { ...this.newForward }
        this.pending = { forwards: [forward], spec: null }
        this.forwardAdded.emit(forward)
        this.settle()
    }

    remove (fw: ForwardedPortConfig): void {
        this.forwardRemoved.emit(fw)
        // A session may refuse to remove a remote forward. Keep the form from
        // mutating the still-active forward through the same object reference.
        this.newForward = { ...fw }
    }

    importSpec (): void {
        this.specError = null
        let forwards: ForwardedPortConfig[] = []
        try {
            forwards = parseTunnelSpec(this.spec, this.newForward.type)
        } catch (e) {
            this.specError = e.message
            return
        }
        this.pending = { forwards, spec: this.spec }
        for (const fw of forwards) {
            this.forwardAdded.emit(fw)
        }
        this.settle()
    }

    /** Clear from the form whatever has been added since it was submitted. */
    private settle (): void {
        const pending = this.pending
        if (!pending) {
            return
        }
        // `model` is an input: it is not there yet while the form is being built.
        const waiting = pending.forwards.filter(fw => !this.model?.includes(fw))
        if (waiting.length && waiting.length === pending.forwards.length) {
            return
        }
        if (pending.spec === null) {
            // Unless something else has been typed into the form since.
            if (sameForward(this.newForward, pending.forwards[0])) {
                this.reset()
            }
        } else if (this.spec === pending.spec) {
            // Each forward is described by the part of the spec it came from.
            this.spec = [...new Set(waiting.map(fw => fw.description))].join(', ')
            pending.spec = this.spec
        }
        pending.forwards = waiting
        if (!waiting.length) {
            this.pending = null
        }
    }
}
