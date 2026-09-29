import { Socket } from 'net'

/**
 * Flow-control thresholds for the unread backlog. Reads are driven by a single
 * async loop, so a peer that writes faster than we parse would otherwise grow
 * the backlog without bound.
 */
const HIGH_WATER_MARK = 8 * 1024 * 1024
const LOW_WATER_MARK = 2 * 1024 * 1024

interface Waiter {
    size: number
    timeoutMs: number
    timer: any
    resolve: (b: Buffer) => void
    reject: (e: Error) => void
}

/**
 * Pull-based reader over a net.Socket.
 *
 * One ByteReader belongs to exactly one socket. When the socket dies, every pending
 * and future read rejects - which is how the packet read loop learns to stop.
 */
export class ByteReader {
    /**
     * Received but not yet read, oldest first, in the pieces they arrived in.
     * Joining them as they arrive would copy the whole backlog once per piece,
     * which for a single large frame - a catch-up buffer after an outage - adds
     * up to many seconds of copying. They are joined once, when a read needs to.
     */
    private chunks: Buffer[] = []
    /** Total bytes in `chunks`. */
    private buffered = 0
    private waiter: Waiter|null = null
    private failure: Error|null = null
    private paused = false
    private disposed = false

    constructor (private socket: Socket) {
        socket.on('data', data => this.onData(data))
        socket.on('error', err => this.fail(err))
        socket.on('close', () => this.fail(new Error('Connection closed')))
        socket.on('end', () => this.fail(new Error('Connection ended by remote')))
    }

    private onData (data: Buffer): void {
        // The socket may outlive its reader for a moment, to finish writing.
        if (!data.length || this.disposed) {
            return
        }
        this.chunks.push(data)
        this.buffered += data.length
        this.pump()
        this.updateFlow()
    }

    private pump (): void {
        const waiter = this.waiter
        if (!waiter) {
            return
        }
        if (this.buffered >= waiter.size) {
            this.clearTimer()
            this.waiter = null
            waiter.resolve(this.take(waiter.size))
        } else {
            // Not there yet, but the peer is demonstrably still sending.
            this.armTimer(waiter)
        }
    }

    /** Remove the next `size` bytes. The caller has checked that they are there. */
    private take (size: number): Buffer {
        this.buffered -= size
        const first = this.chunks[0]
        if (first.length > size) {
            this.chunks[0] = first.subarray(size)
            return first.subarray(0, size)
        }
        if (first.length === size) {
            this.chunks.shift()
            return first
        }
        const out = Buffer.allocUnsafe(size)
        let filled = 0
        let used = 0
        while (filled < size) {
            const chunk = this.chunks[used]
            const wanted = size - filled
            if (chunk.length > wanted) {
                chunk.copy(out, filled, 0, wanted)
                this.chunks[used] = chunk.subarray(wanted)
                filled = size
            } else {
                chunk.copy(out, filled)
                filled += chunk.length
                used++
            }
        }
        this.chunks.splice(0, used)
        return out
    }

    /**
     * Pause the socket once the unread backlog gets large, resume once it drains.
     *
     * Never pauses while a pending read still needs more bytes than we hold: a
     * legitimate frame (a catch-up buffer, say) may be larger than the high-water
     * mark, and pausing then would deadlock that read against its own timeout.
     */
    private updateFlow (): void {
        if (this.failure) {
            return
        }
        const starved = this.buffered < (this.waiter?.size ?? 0)
        if (!this.paused && !starved && this.buffered >= HIGH_WATER_MARK) {
            this.paused = true
            this.socket.pause()
        } else if (this.paused && (starved || this.buffered <= LOW_WATER_MARK)) {
            this.paused = false
            this.socket.resume()
        }
    }

    private fail (err: Error): void {
        if (this.failure) {
            return
        }
        this.failure = err
        const w = this.waiter
        this.waiter = null
        // The timer must die with the waiter, or it keeps the event loop (and a
        // doomed reject closure) alive for its full duration.
        if (w?.timer) {
            clearTimeout(w.timer)
        }
        w?.reject(err)
    }

    private clearTimer (): void {
        if (this.waiter?.timer) {
            clearTimeout(this.waiter.timer)
            this.waiter.timer = null
        }
    }

    /**
     * (Re)start the clock on a pending read.
     *
     * The timeout is on SILENCE, not on the read as a whole, exactly as in the
     * reference client (SocketHandler::readAll restarts its timer on every
     * byte). A catch-up buffer can be tens of megabytes; on a slow link it
     * cannot arrive within any fixed deadline, and since every retry starts the
     * transfer over, a deadline would make such a session impossible to resume.
     */
    private armTimer (waiter: Waiter): void {
        if (!waiter.timeoutMs) {
            return
        }
        if (waiter.timer) {
            clearTimeout(waiter.timer)
        }
        // A timed-out read does not consume the buffer: the bytes (if any
        // ever arrive) stay available to a later read, and the timeout
        // does not tear the socket down. Callers decide what a timeout
        // means for the connection.
        waiter.timer = setTimeout(() => {
            if (this.waiter === waiter) {
                this.waiter = null
            }
            waiter.reject(new Error(`Timed out waiting for ${waiter.size} bytes from the ET server`))
        }, waiter.timeoutMs)
    }

    /**
     * The next `size` bytes, left where they are, or null if they are not
     * all here.
     */
    peek (size: number): Buffer|null {
        if (this.disposed || this.buffered < size) {
            return null
        }
        if (this.chunks[0].length >= size) {
            return this.chunks[0].subarray(0, size)
        }
        const out = Buffer.allocUnsafe(size)
        let filled = 0
        for (let i = 0; filled < size; i++) {
            filled += this.chunks[i].copy(out, filled, 0, size - filled)
        }
        return out
    }

    /**
     * The next `size` bytes if they are here, and null if they are not. Nothing
     * is waited for, and nothing is promised: a promise is cheap, but not at
     * the rate of one for every packet of a stream that is megabytes long.
     */
    takeNow (size: number): Buffer|null {
        if (this.disposed || this.waiter || this.buffered < size) {
            return null
        }
        const out = this.take(size)
        this.updateFlow()
        return out
    }

    /**
     * Read exactly `size` bytes. Rejects on socket failure, or once the peer has
     * sent nothing at all for `timeoutMs`.
     */
    read (size: number, timeoutMs?: number): Promise<Buffer> {
        if (this.disposed) {
            // dispose() is authoritative: no reads after it, even from data that
            // is still buffered. (A socket FAILURE is different - buffered bytes
            // were genuinely received and stay readable until drained.)
            return Promise.reject(this.failure ?? new Error('Reader disposed'))
        }
        if (size === 0) {
            return Promise.resolve(Buffer.alloc(0))
        }
        if (this.buffered >= size) {
            const out = this.take(size)
            this.updateFlow()
            return Promise.resolve(out)
        }
        if (this.failure) {
            return Promise.reject(this.failure)
        }
        if (this.waiter) {
            return Promise.reject(new Error('ByteReader: concurrent reads are not supported'))
        }
        return new Promise<Buffer>((resolve, reject) => {
            const waiter: Waiter = { size, timeoutMs: timeoutMs ?? 0, timer: null, resolve, reject }
            this.waiter = waiter
            this.armTimer(waiter)
            // This read may need more than the high-water mark (a large catch-up
            // buffer), so re-evaluate flow control now that a waiter exists.
            this.updateFlow()
        })
    }

    dispose (): void {
        this.disposed = true
        this.chunks = []
        this.buffered = 0
        this.fail(new Error('Reader disposed'))
    }
}
