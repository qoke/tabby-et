/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
import { Socket } from 'net'
import { Observable, Subject } from 'rxjs'
import { Logger } from 'tabby-core'

import { BackedReader, ETPacket } from './backedReader'
import { BackedWriter } from './backedWriter'
import { ByteReader } from './byteReader'
import { ETCrypto } from './crypto'
import { UnrecoverableSessionError } from './errors'
import {
    CLIENT_SERVER_NONCE_MSB, CONNECT_TIMEOUT, ETConnectStatus, HANDSHAKE_TIMEOUT, JUMP_REGISTRATION_RETRY,
    MAX_HANDSHAKE_PROTO_LENGTH, MAX_PROTO_LENGTH, PROTOCOL_VERSION, READ_SLICE_MS,
    RECONNECT_INTERVAL, SERVER_CLIENT_NONCE_MSB, WRITE_HIGH_WATER_MARK,
} from './constants'
import {
    decodeCatchupPackets, decodeConnectResponse, decodeSequenceHeader,
    encodeCatchupBuffer, encodeConnectRequest, encodeSequenceHeader,
} from './messages'

/** How long shutdown() lets what is already queued go out before it hangs up. */
const SHUTDOWN_FLUSH_TIMEOUT = 2000

export type ETConnectionState = 'connecting'|'connected'|'reconnecting'|'ended'

/** What can be seen of how our data is leaving a connection. */
export interface ETOutbound {
    /** Which connection this is about: it changes with every resume. */
    connection: number
    /** Bytes that the socket has been given and the kernel has not taken. */
    held: number
    /** Rises as the kernel takes more. Only differences mean anything. */
    taken: number
}

/**
 * How much of what a socket was given has been taken by the kernel.
 *
 * Node reports a write when all of it has been taken, and hands the kernel
 * everything that is waiting in one write: megabytes, on a link that is
 * carrying less than it is given. Of how such a write is coming along it says
 * nothing in public. It keeps count all the same, for its own timeouts, and
 * that count is read here. Without it, a write is only seen once it is over.
 */
function outboundOf (socket: Socket): { held: number, taken: number } {
    const internals = socket as unknown as { _handle?: { writeQueueSize?: unknown }|null, _bytesDispatched?: unknown }
    const dispatched = internals._bytesDispatched
    const queued = internals._handle?.writeQueueSize
    const written = socket.bytesWritten || 0
    const taken = typeof dispatched === 'number' && typeof queued === 'number'
        ? dispatched - queued
        : written - (socket.writableLength || 0)
    return { held: Math.max(written - taken, 0), taken }
}

/** Let everything else that is waiting for a turn have one. */
function turn (): Promise<void> {
    return new Promise(resolve => {
        if (typeof setImmediate === 'function') {
            setImmediate(resolve)
        } else {
            setTimeout(resolve, 0)
        }
    })
}

export interface ETConnectionOptions {
    host: string
    port: number
    id: string
    passkey: string
    /** 0 = retry forever, matching the reference client. */
    maxReconnectAttempts: number
    /**
     * For how long, in ms, a first connection that is told its key is not
     * known asks again. For a server that may not have been told the key yet.
     */
    registrationGrace?: number
    /**
     * Receives one line per packet (direction, header, byte count, sequence
     * number) when debugProtocol is on. MUST only ever receive metadata -
     * payload bytes contain keystrokes and would leak passwords into logs.
     */
    debug?: (line: string) => void
}

export class ETClientConnection {
    get state$ (): Observable<ETConnectionState> { return this.stateSubject }
    get packet$ (): Observable<ETPacket> { return this.packetSubject }
    /** Emits once with a human-readable reason, then completes. */
    get ended$ (): Observable<string> { return this.endedSubject }
    /** Emits when writers that held back because we were `congested` may carry on. */
    get drained$ (): Observable<void> { return this.drainedSubject }

    state: ETConnectionState = 'connecting'

    private stateSubject = new Subject<ETConnectionState>()
    private packetSubject = new Subject<ETPacket>()
    private endedSubject = new Subject<string>()
    private drainedSubject = new Subject<void>()

    private socket: Socket|null = null
    private byteReader: ByteReader|null = null
    private reader: BackedReader
    private writer: BackedWriter
    private shuttingDown = false
    private reconnectAttempts = 0
    /**
     * True while connect() owns a socket that is not yet reachable through
     * `this.socket`. Nothing may start a competing handshake during that window.
     */
    private handshakeInFlight = false
    /**
     * The socket/reader of the handshake currently in flight, if any. They are
     * NOT reachable through `this.socket` until attach() runs, so shutdown()
     * needs this reference to tear them down.
     */
    private pendingHandshake: { socket: Socket, byteReader: ByteReader }|null = null
    /**
     * The socket whose TCP connect is still in flight, if any. It is older still
     * than `pendingHandshake`: shutdown() needs it to abandon a connect that may
     * otherwise sit in the kernel until CONNECT_TIMEOUT.
     */
    private connectingSocket: Socket|null = null
    /** Counts the read loops that were started. Only the last one is to go on. */
    private readLoop = 0
    /** Counts the sockets that were attached. */
    private attached = 0

    constructor (
        private options: ETConnectionOptions,
        private logger: Logger,
    ) {
        this.reader = new BackedReader(new ETCrypto(options.passkey, SERVER_CLIENT_NONCE_MSB))
        this.writer = new BackedWriter(new ETCrypto(options.passkey, CLIENT_SERVER_NONCE_MSB))
    }

    // ---- lifecycle --------------------------------------------------------

    /** Initial connection. Throws on a fatal handshake failure. */
    async connect (): Promise<void> {
        if (this.shuttingDown) {
            throw new Error('Cannot connect: the session has already ended')
        }
        if (this.handshakeInFlight) {
            throw new Error('Cannot connect twice: a handshake is already in flight')
        }
        this.setState('connecting')
        this.handshakeInFlight = true
        let socket: Socket|null = null
        let byteReader: ByteReader|null = null
        const askUntil = Date.now() + (this.options.registrationGrace ?? 0)
        try {
            let status = 0
            for (;;) {
                socket = await this.openSocket()
                byteReader = new ByteReader(socket)
                // shutdown() could not see this socket while it was connecting, so it
                // has to be checked for here. Every later await is covered by
                // pendingHandshake, but is re-checked all the same: nothing may be
                // attached, and no state may be announced, once the session is over.
                this.throwIfShutDown()
                // Published so shutdown() can reach the socket while the handshake is
                // still in flight - it is NOT reachable through this.socket yet.
                this.pendingHandshake = { socket, byteReader }
                status = await this.sendConnectRequest(socket, byteReader)
                this.throwIfShutDown()
                if (status !== ETConnectStatus.INVALID_KEY || Date.now() >= askUntil) {
                    break
                }
                // Not known yet, or not known at all. Time will tell which.
                socket.destroy()
                byteReader.dispose()
                socket = null
                byteReader = null
                this.pendingHandshake = null
                await new Promise(resolve => setTimeout(resolve, JUMP_REGISTRATION_RETRY))
                this.throwIfShutDown()
            }

            if (status === ETConnectStatus.RETURNING_CLIENT) {
                // A live session for our id still exists on the server (e.g. the
                // protocol harness re-run, or a recovered tab racing a teardown).
                // Run the recovery exchange; a fresh process cannot serve the
                // replay range the server will request, so this fails loudly
                // instead of desynchronising the nonce counters.
                try {
                    await this.recover(socket, byteReader)
                } catch (err) {
                    throw new Error(
                        'The ET server still holds a session for these credentials, but it cannot be resumed '
                        + 'from a new process. Enable "kill other sessions" in the profile, or terminate the '
                        + `orphaned etterminal on the remote host. Underlying error: ${err}`,
                    )
                }
            } else if (status !== ETConnectStatus.NEW_CLIENT) {
                throw new Error(this.describeStatus(status))
            }
            // Only now does the socket change hands. Up to this point the catch
            // below owns it, so every failure above destroys it.
            this.attach(socket, byteReader)
            socket = null
            byteReader = null
            this.setState('connected')
            this.runReadLoop()
        } catch (err) {
            // Nothing after openSocket() may leak the socket: a handshake read
            // timeout or a malformed frame must destroy it, or a server that
            // accepts TCP but stalls leaks one socket per attempt.
            socket?.destroy()
            byteReader?.dispose()
            throw err
        } finally {
            // Cleared only once attach() has published the socket (or the attempt
            // has failed outright), so the window this guards is exactly the one
            // where a reconnect could not see what connect() is holding.
            this.handshakeInFlight = false
            this.pendingHandshake = null
        }
    }

    /**
     * Send an encrypted packet. Buffers while disconnected.
     * Returns false if the packet had to be dropped (too much is waiting
     * already). `urgent` marks a control message, for which room is kept.
     */
    writePacket (header: number, payload: Buffer, urgent = false): boolean {
        if (this.shuttingDown) {
            return true
        }
        const written = this.writer.write(header, payload, urgent)
        if (!written) {
            this.logger.warn('ET write buffer is full; dropping a packet')
        }
        this.options.debug?.(`-> header=${header} bytes=${payload.length} seq=${this.writer.sequenceNumber}${written ? '' : ' DROPPED'}`)
        return written
    }

    /**
     * True while more is waiting to go out than it makes sense to add to.
     *
     * Packets are accepted regardless - writePacket() never blocks and terminal
     * input must not be held up - but whoever is producing data in bulk should
     * stop until drained$ says otherwise.
     */
    get congested (): boolean {
        return !this.shuttingDown && this.writer.backlog >= WRITE_HIGH_WATER_MARK
    }

    /** What can be seen of how our data is leaving, or null while there is no connection. */
    get outbound (): ETOutbound|null {
        return this.socket && !this.shuttingDown
            ? { connection: this.attached, ...outboundOf(this.socket) }
            : null
    }

    /** The server was sent a catch-up on this connection, and has not answered since. */
    get awaitsConfirmation (): boolean {
        return this.writer.awaitsConfirmation
    }

    /** 'IPv4' or 'IPv6': what the server was reached over. */
    get remoteFamily (): string|undefined {
        return this.socket?.remoteFamily
    }

    /** Deliberately drop the TCP connection to exercise recovery. */
    forceReconnect (): void {
        this.logger.info('Forcing an ET reconnect')
        this.dropSocketAndReconnect()
    }

    shutdown (): void {
        this.shuttingDown = true
        // An attempt in flight owns a socket that shutdown() cannot see through
        // this.socket - kill it explicitly, or it lingers until CONNECT_TIMEOUT.
        this.connectingSocket?.destroy()
        this.connectingSocket = null
        this.pendingHandshake?.socket.destroy()
        this.pendingHandshake?.byteReader.dispose()
        this.pendingHandshake = null
        this.hangUp(this.socket)
        this.socket = null
        this.byteReader?.dispose()
        this.byteReader = null
        this.writer.detach()
        this.setState('ended')
        this.endedSubject.complete()
        this.packetSubject.complete()
        this.stateSubject.complete()
        this.drainedSubject.complete()
    }

    // ---- internals --------------------------------------------------------

    /**
     * Close a socket that the session is done with.
     *
     * Not at once, if something is still queued on it: the last things a
     * session writes say which of its tunnels are over, and a server that
     * never reads them keeps those connections open - to a database, say - for
     * as long as the remote session lives, which can be a very long time
     * after the tab is gone. So what is queued is given a moment to go out.
     */
    private hangUp (socket: Socket|null): void {
        if (!socket || socket.destroyed) {
            return
        }
        // Whether or not anything is queued here. What has left our queue may
        // still be with the kernel, and the kernel drops what it has not sent
        // when a socket is closed over input that was never read: it resets
        // the connection instead of closing it.
        const timer: any = setTimeout(() => socket.destroy(), SHUTDOWN_FLUSH_TIMEOUT)
        timer.unref?.()
        socket.once('close', () => clearTimeout(timer))
        // Nothing reads from it any more, and a socket that is not read from
        // never sees the other side hang up.
        socket.resume()
        socket.end()
    }

    /**
     * shutdown() can run during any await. Whatever resumes afterwards must stop
     * here rather than attach a socket to a session that has already ended.
     */
    private throwIfShutDown (): void {
        if (this.shuttingDown) {
            throw new Error('Connection shut down during the handshake')
        }
    }

    private setState (state: ETConnectionState): void {
        if (this.state === state) {
            return
        }
        this.state = state
        this.stateSubject.next(state)
    }

    private attach (socket: Socket, byteReader: ByteReader): void {
        this.byteReader?.dispose()
        this.socket = socket
        this.byteReader = byteReader
        this.attached++
        this.writer.attach(socket)
        this.reader.attach(byteReader)
        // An attempt that sent a catch-up has worked when the server has
        // taken it, which shows when it answers: see runReadLoop().
        if (!this.writer.awaitsConfirmation) {
            this.reconnectAttempts = 0
        }
        socket.on('drain', () => {
            if (this.socket === socket) {
                this.drainedSubject.next()
            }
        })
        // Whoever held back while there was no socket at all is waiting too.
        // If the replay has left this one congested, its 'drain' will follow.
        if (!this.congested) {
            this.drainedSubject.next()
        }
    }

    private openSocket (): Promise<Socket> {
        return new Promise((resolve, reject) => {
            const socket = new Socket()
            socket.setNoDelay(true)
            let settled = false
            const settle = (): boolean => {
                if (settled) {
                    return false
                }
                settled = true
                clearTimeout(timer)
                socket.removeListener('error', fail)
                socket.removeListener('close', onClose)
                if (this.connectingSocket === socket) {
                    this.connectingSocket = null
                }
                return true
            }
            const fail = (err: Error) => {
                if (settle()) {
                    socket.destroy()
                    reject(err)
                }
            }
            // destroy() emits 'close' with no 'error', which is how shutdown()
            // abandons a connect that is still in flight.
            const onClose = () => fail(new Error(`Connection to ${this.options.host}:${this.options.port} closed while connecting`))
            const timer = setTimeout(
                () => fail(new Error(`Timed out connecting to ${this.options.host}:${this.options.port}`)),
                CONNECT_TIMEOUT,
            )
            socket.once('error', fail)
            socket.once('close', onClose)
            this.connectingSocket = socket
            try {
                socket.connect(this.options.port, this.options.host, () => {
                    if (settle()) {
                        resolve(socket)
                    }
                })
            } catch (err) {
                // connect() validates its arguments before it does anything
                // else, and throws rather than emitting 'error'.
                fail(err as Error)
            }
        })
    }

    /** Framing A: 8-byte little-endian length + protobuf. */
    private async writeProto (socket: Socket, message: Buffer): Promise<void> {
        const header = Buffer.allocUnsafe(8)
        header.writeBigInt64LE(BigInt(message.length), 0)
        socket.write(header)
        if (message.length) {
            socket.write(message)
        }
    }

    /**
     * Framing A for a message that may be long: settles when the socket has
     * taken all of it.
     *
     * The reference client's writes block, so it is not connected again before
     * its catch-up has left it. Ours return at once. A session that called
     * itself resumed from there on would have its keepalive running, and new
     * input queuing up, behind megabytes that the server needs before it can
     * answer anything at all.
     *
     * How long it takes says nothing: a catch-up is as long as the outage was
     * busy, and the link is as slow as it is. What counts is that it moves.
     */
    private writeProtoToTheEnd (socket: Socket, message: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false
            let timer: any = null
            const finish = (err?: Error|null) => {
                if (settled) {
                    return
                }
                settled = true
                clearInterval(timer)
                socket.removeListener('close', onClose)
                socket.removeListener('drain', onDrain)
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
            }
            const onClose = () => finish(new Error('Connection closed while the catch-up was being sent'))
            const onDrain = () => finish()
            socket.once('close', onClose)

            const header = Buffer.allocUnsafe(8)
            header.writeBigInt64LE(BigInt(message.length), 0)
            let taking = socket.write(header)
            if (message.length) {
                taking = socket.write(message)
            }
            // A socket that is holding nothing back says so at once. One that
            // is says when it has let go of all of it.
            if (taking) {
                finish()
                return
            }
            socket.once('drain', onDrain)

            let taken = outboundOf(socket).taken
            let moved = Date.now()
            timer = setInterval(() => {
                const now = outboundOf(socket).taken
                if (now !== taken) {
                    taken = now
                    moved = Date.now()
                } else if (Date.now() - moved >= HANDSHAKE_TIMEOUT) {
                    finish(new Error('Timed out sending the catch-up: the connection carries nothing'))
                }
            }, 1000)
            timer.unref?.()
        })
    }

    private async readProto (reader: ByteReader, maxLength = MAX_PROTO_LENGTH): Promise<Buffer> {
        const header = await reader.read(8, HANDSHAKE_TIMEOUT)
        const length = Number(header.readBigInt64LE(0))
        if (length < 0 || length > maxLength) {
            throw new Error(`Invalid ET handshake message length ${length}`)
        }
        // A zero-length frame is legal and means "default-constructed message".
        return length === 0 ? Buffer.alloc(0) : reader.read(length, HANDSHAKE_TIMEOUT)
    }

    private async sendConnectRequest (socket: Socket, reader: ByteReader): Promise<number> {
        await this.writeProto(socket, encodeConnectRequest(this.options.id, PROTOCOL_VERSION))
        const response = decodeConnectResponse(await this.readProto(reader, MAX_HANDSHAKE_PROTO_LENGTH))
        if (response.error) {
            this.logger.info(`etserver said: ${response.error}`)
        }
        return response.status ?? 0
    }

    private describeStatus (status: number): string {
        switch (status) {
            case ETConnectStatus.INVALID_KEY:
                return 'The ET server rejected our session key. The remote session has ended.'
            case ETConnectStatus.MISMATCHED_PROTOCOL:
                return `Protocol version mismatch: Tabby speaks ET protocol ${PROTOCOL_VERSION}. Upgrade or downgrade the remote etserver so both sides match.`
            default:
                return `The ET server refused the connection (status ${status})`
        }
    }

    private async runReadLoop (): Promise<void> {
        // A loop that is reading what a resume brought back does not wait on
        // the socket, and so does not end when the socket does. It may still be
        // at it when the next resume starts a loop of its own.
        const loop = ++this.readLoop
        let since = Date.now()
        try {
            for (;;) {
                const replayed = this.reader.replaying
                const asked = Date.now()
                // Without waiting, and without a promise, for as long as
                // there are packets that have arrived.
                const packet = this.reader.poll() ?? await this.reader.read()
                const now = Date.now()
                if (!replayed) {
                    // Off the socket: the server is past the exchange, which
                    // it cannot be without having our catch-up.
                    this.writer.confirm()
                    this.reconnectAttempts = 0
                }
                this.options.debug?.(`<- header=${packet.header} bytes=${packet.payload.length} seq=${this.reader.sequenceNumber}`)
                this.packetSubject.next(packet)
                if (loop !== this.readLoop) {
                    return
                }
                if (now - asked > 1) {
                    // It had to be waited for, and everything else had its turn.
                    since = now
                } else if (now - since >= READ_SLICE_MS) {
                    await turn()
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- both can change during any await
                    if (loop !== this.readLoop || this.shuttingDown) {
                        return
                    }
                    since = Date.now()
                }
            }
        } catch (err) {
            if (this.shuttingDown || loop !== this.readLoop) {
                return
            }
            if (err instanceof UnrecoverableSessionError) {
                // A Poly1305 failure, not a socket failure. Reconnecting cannot
                // recover the packet and, if the counters are genuinely out of
                // step, would reconnect-and-fail on every subsequent packet
                // forever (each success resets reconnectAttempts, so the attempt
                // cap never trips). Stop, and say why.
                this.logger.error(`ET stream integrity failure: ${err.message}`)
                this.end(`The encrypted session stream failed its integrity check: ${err.message}`)
                return
            }
            this.logger.info(`ET read loop stopped: ${err}`)
            this.dropSocketAndReconnect()
        }
    }

    private dropSocketAndReconnect (): void {
        if (this.shuttingDown || this.state === 'reconnecting') {
            return
        }
        if (this.handshakeInFlight) {
            // connect() is mid-handshake on a socket we cannot see yet. Starting
            // a reconnect now would run a SECOND concurrent handshake for the
            // same session id: both would attach, and the two nonce streams would
            // diverge immediately. The in-flight handshake has its own timeout.
            this.logger.info('Ignoring a reconnect request made during the initial handshake')
            return
        }
        this.socket?.destroy()
        this.socket = null
        this.byteReader?.dispose()
        this.byteReader = null
        this.writer.detach()
        this.setState('reconnecting')
        void this.reconnectLoop()
    }

    private async reconnectLoop (): Promise<void> {
        for (;;) {
            if (this.shuttingDown) {
                return
            }
            await new Promise(resolve => setTimeout(resolve, RECONNECT_INTERVAL))
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (this.shuttingDown) {
                return
            }
            this.reconnectAttempts++
            let socket: Socket|null = null
            let byteReader: ByteReader|null = null
            // EVERY path out of an attempt must release the attempt's socket and
            // reader, or a server that answers but never resumes leaks one file
            // descriptor per second, forever. Registering them as the pending
            // handshake also lets shutdown() reach them mid-attempt.
            const release = () => {
                socket?.destroy()
                byteReader?.dispose()
                socket = null
                byteReader = null
                this.pendingHandshake = null
            }
            try {
                socket = await this.openSocket()
                byteReader = new ByteReader(socket)
                // As in connect(): shutdown() may have run during any of these
                // awaits, and a session that has ended must never be resumed.
                this.throwIfShutDown()
                this.pendingHandshake = { socket, byteReader }
                const status = await this.sendConnectRequest(socket, byteReader)
                this.throwIfShutDown()

                if (status === ETConnectStatus.INVALID_KEY) {
                    // The only way the client learns the remote shell has exited.
                    release()
                    this.end('Session terminated by the server')
                    return
                }
                if (status === ETConnectStatus.MISMATCHED_PROTOCOL) {
                    // The etserver was upgraded or replaced under us. Permanent.
                    release()
                    this.end(this.describeStatus(status))
                    return
                }
                if (status === ETConnectStatus.NEW_CLIENT) {
                    // The server has no memory of our session, so it just created
                    // a blank one with no shell behind it. Our sequence numbers
                    // and nonces are meaningless to it; attaching would desync at
                    // the first packet. Permanent.
                    release()
                    this.end('The ET server no longer has this session. The remote shell has ended or etserver was restarted.')
                    return
                }
                if (status !== ETConnectStatus.RETURNING_CLIENT) {
                    release()
                    this.logger.warn(`Unexpected reconnect status ${status}; retrying`)
                    if (this.options.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.options.maxReconnectAttempts) {
                        this.end(`Could not resume the session after ${this.reconnectAttempts} attempts`)
                        return
                    }
                    continue
                }

                await this.recover(socket, byteReader)
                this.attach(socket, byteReader)
                // No longer a handshake: it is the connection. Left in place,
                // shutdown() would take it for an attempt to abandon, and
                // destroy the socket that it is about to let finish writing.
                this.pendingHandshake = null
                socket = null
                byteReader = null
                this.setState('connected')
                this.runReadLoop()
                return
            } catch (err) {
                release()
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS cannot see shutdown() reassign it across the awaits
                if (this.shuttingDown) {
                    return
                }
                this.logger.debug(`ET reconnect attempt ${this.reconnectAttempts} failed: ${err}`)
                if (err instanceof UnrecoverableSessionError) {
                    // Retrying cannot fix this - the replay range is gone for
                    // good, so every further attempt would fail identically and
                    // leave the tab wedged on "reconnecting" forever.
                    this.end(`The session cannot be resumed: ${err.message}`)
                    return
                }
                if (this.options.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.options.maxReconnectAttempts) {
                    this.end(`Could not resume the session after ${this.reconnectAttempts} attempts`)
                    return
                }
            }
        }
    }

    /**
     * Symmetric catch-up exchange. Order matters and must be:
     *   write SequenceHeader -> read SequenceHeader -> write CatchupBuffer -> read CatchupBuffer
     * Both peers write before reading. That cannot deadlock here: what the
     * server sends is taken off the socket as it arrives, whatever we are
     * waiting for at the time.
     * Every read carries HANDSHAKE_TIMEOUT (via readProto), so a server that
     * stalls mid-recovery rejects instead of wedging us in 'reconnecting'.
     */
    private async recover (socket: Socket, byteReader: ByteReader): Promise<void> {
        await this.writeProto(socket, encodeSequenceHeader(this.reader.sequenceNumber))

        const remoteSequence = decodeSequenceHeader(
            await this.readProto(byteReader, MAX_HANDSHAKE_PROTO_LENGTH),
        )

        const toSend = this.writer.recover(remoteSequence)
        await this.writeProtoToTheEnd(socket, encodeCatchupBuffer(toSend))
        this.throwIfShutDown()

        const recovered = decodeCatchupPackets(await this.readProto(byteReader))
        this.throwIfShutDown()

        this.reader.revive(byteReader, recovered)
        this.writer.attach(socket)

        this.logger.info(`ET session resumed: replayed ${toSend.length} out, ${recovered.length} in`)
    }

    private end (reason: string): void {
        this.shuttingDown = true
        this.socket?.destroy()
        this.socket = null
        this.byteReader?.dispose()
        this.byteReader = null
        this.writer.detach()
        this.setState('ended')
        this.endedSubject.next(reason)
        this.endedSubject.complete()
    }
}
