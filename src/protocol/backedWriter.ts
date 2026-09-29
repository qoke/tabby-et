import { Socket } from 'net'
import { ETCrypto, MAC_BYTES } from './crypto'
import {
    CONTROL_RESERVE_BYTES, DISCONNECT_BUFFER_BYTES, MAX_BACKUP_BYTES, MAX_CONTROL_MESSAGE_BYTES, MAX_PROTO_LENGTH,
    PACKET_HEADER_SIZE,
} from './constants'
import { UnrecoverableSessionError } from './errors'
import { catchupEntrySize } from './messages'
import { PacketQueue } from './packetQueue'

// Re-exported for the existing importers: the type now lives in ./errors so that
// crypto.ts can raise it too without a cycle (backedWriter already imports crypto).
export { UnrecoverableSessionError } from './errors'

/** Framing B puts a 4-byte big-endian length in front of every serialized Packet. */
const FRAME_PREFIX_SIZE = 4

/**
 * A packet as it goes on the wire: [length][encrypted=1][header][ciphertext].
 * The length counts what follows it, not itself.
 */
function framePacket (header: number, encryptedPayload: Buffer): Buffer {
    const length = PACKET_HEADER_SIZE + encryptedPayload.length
    const frame = Buffer.allocUnsafe(FRAME_PREFIX_SIZE + length)
    frame.writeInt32BE(length, 0)
    frame[FRAME_PREFIX_SIZE] = 1
    frame[FRAME_PREFIX_SIZE + 1] = header
    encryptedPayload.copy(frame, FRAME_PREFIX_SIZE + PACKET_HEADER_SIZE)
    return frame
}

/** The serialized Packet inside a frame, which is the form a catch-up carries. */
function serializedPacket (frame: Buffer): Buffer {
    return frame.subarray(FRAME_PREFIX_SIZE)
}

export class BackedWriter {
    /** Number of packets ever written, including while disconnected. */
    sequenceNumber = 0

    /**
     * Everything we may still have to replay, oldest first, as wire frames. A
     * frame that is waiting on the socket is the very buffer that is kept here,
     * so a backlog is held in memory once and not twice.
     */
    private backupBuffer = new PacketQueue()
    /** Serialized bytes in backupBuffer, which is how ET counts them. */
    private backupSize = 0
    /**
     * While there is no socket: the bytes the server cannot have. That is what
     * was written since the last socket was lost, and what that socket was
     * still holding when it was.
     */
    private disconnectedBytes = 0
    private socket: Socket|null = null
    /**
     * What the socket was holding when it was last written to, or when it last
     * ran dry. A socket that has died reports nothing of what it held, so this
     * is what detach() has to go by. It can only err on the high side: between
     * writes, a socket holds less and less.
     */
    private unsent = 0
    /**
     * How much of our stream the peer can account for: every packet up to this
     * sequence number was either written to a socket or offered in a recovery
     * catch-up. Anything past it exists only in the replay buffer.
     */
    private handedOff = 0
    /**
     * A catch-up that the server was sent and has not been seen to have.
     *
     * The server takes a catch-up whole or not at all, and says nothing of it
     * either way: what it has is only known from the number it gives at the
     * next resume, or from its answering anything, which it cannot do before
     * it has all of the catch-up. Until then, that a catch-up has left us means
     * nothing. If the link is lost with it on its way, all of it is to be sent
     * again, and whatever was written after it as well.
     *
     * `from` is how many of our packets the server had when it was sent.
     * `bytes` is what a catch-up of everything since then comes to.
     */
    private unconfirmed: { from: number, bytes: number }|null = null

    constructor (private crypto: ETCrypto) {}

    /**
     * Start writing to `socket`, beginning with whatever nothing has carried yet.
     *
     * recover() sizes the catch-up from the sequence number at that instant, but
     * the exchange then waits on the network and packets keep being written
     * meanwhile. The reference client holds its writer mutex from recover() to
     * revive(), so those writes block and then go out on the new socket. We
     * cannot block, so they are buffered and sent here instead. Skipping them
     * would leave a hole in the stream: the next packet would reach the server
     * under a nonce it does not expect yet, and etserver aborts on a failed
     * MAC check.
     */
    attach (socket: Socket): void {
        this.socket = socket
        this.disconnectedBytes = 0
        // Nothing is trimmed while disconnected, so the newest `pending` entries
        // are exactly the packets in question. Oldest first.
        for (const frame of this.backupBuffer.newest(this.sequenceNumber - this.handedOff)) {
            socket.write(frame)
        }
        this.handedOff = this.sequenceNumber
        this.unsent = socket.writableLength || 0
        // Optional, because what stands in for a socket in a test has no events.
        socket.on?.('drain', () => {
            if (this.socket === socket) {
                this.unsent = 0
            }
        })
    }

    detach (): void {
        if (this.socket) {
            // Of a catch-up that was never seen to arrive, the server has
            // nothing, however much of it the socket had taken.
            this.disconnectedBytes = Math.max(this.unsent, this.unconfirmed?.bytes ?? 0)
        }
        this.socket = null
        this.unsent = 0
    }

    /** A catch-up was sent that the server has not been seen to have. */
    get awaitsConfirmation (): boolean {
        return this.unconfirmed !== null
    }

    /**
     * The server has answered since the last resume, so it has the catch-up
     * that it was sent then, and all that went before.
     */
    confirm (): void {
        this.unconfirmed = null
    }

    /**
     * Bytes we have accepted that the network has not taken yet: queued on the
     * socket, or waiting for there to be a socket.
     */
    get backlog (): number {
        return this.socket ? this.socket.writableLength || 0 : this.disconnectedBytes
    }

    /**
     * Encrypt, buffer, and (if connected) send. Returns false if the packet had to be
     * dropped because too much is waiting to be sent already.
     *
     * ET has this limit for the time it is disconnected, which is the only time
     * its writes do not block. Ours never block, so it holds while connected as
     * well: a link can stall without being lost, and input keeps arriving. What
     * is waiting has to stay small enough to be replayed in ONE catch-up
     * message, because etserver refuses any message of more than 128 MiB, and
     * would refuse it again on every retry.
     *
     * What is waiting is not all that a catch-up may have to carry. After a
     * resume it carries the last catch-up again, for as long as that has not
     * been seen to arrive, so that one is counted too, against the size of the
     * message itself.
     *
     * `urgent` is for a control message, which is let into the room that is
     * kept for them once the rest is full.
     */
    write (header: number, payload: Buffer, urgent = false): boolean {
        // Size the serialized packet WILL have, computed without encrypting.
        // crypto_secretbox appends a MAC_BYTES tag, and serializePacket prepends
        // PACKET_HEADER_SIZE, so this exactly equals the eventual serialized length.
        const serializedLength = PACKET_HEADER_SIZE + MAC_BYTES + payload.length
        const control = urgent && serializedLength <= MAX_CONTROL_MESSAGE_BYTES

        const room = control ? DISCONNECT_BUFFER_BYTES + CONTROL_RESERVE_BYTES : DISCONNECT_BUFFER_BYTES
        const most = control ? MAX_PROTO_LENGTH : MAX_PROTO_LENGTH - CONTROL_RESERVE_BYTES
        const entry = catchupEntrySize(serializedLength)
        if (this.backlog + serializedLength > room || this.unconfirmed && this.unconfirmed.bytes + entry > most) {
            // ET busy-waits here; we drop and let the caller surface a warning.
            // Crucially, the drop decision is made BEFORE encrypting: encrypting advances
            // the per-direction nonce counter, so encrypting a packet we then drop would
            // desync the nonce from sequenceNumber and make every later packet fail the
            // peer's MAC check. Matches BackedWriter.cpp, which returns SKIPPED before
            // packet.encrypt().
            return false
        }

        const frame = framePacket(header, this.crypto.encrypt(payload))

        this.backupBuffer.push(frame)
        this.backupSize += serializedLength
        this.sequenceNumber++
        if (this.unconfirmed) {
            this.unconfirmed.bytes += entry
        }

        if (!this.socket) {
            this.disconnectedBytes += serializedLength
            return true
        }

        this.trim(this.socket)
        this.socket.write(frame)
        this.handedOff = this.sequenceNumber
        this.unsent = this.socket.writableLength || 0
        return true
    }

    /**
     * Forget the oldest packets, down to MAX_BACKUP_BYTES of those the socket
     * has taken.
     *
     * Only while connected: nothing we may still have to replay is discarded.
     * And never a packet that is still waiting on the socket. ET can trim by
     * size alone because its writes block, so whatever it has written has at
     * least reached the kernel. Ours queue without limit, and a packet that
     * has not left this machine has certainly not reached the server, however
     * much newer data is queued behind it. Trimming one would leave a hole that
     * no reconnect could ever replay.
     *
     * Nor a packet of a catch-up that has not been seen to arrive, for the
     * same reason: that it has left this machine says nothing of whether the
     * server has it.
     */
    private trim (socket: Socket): void {
        // Counts the frame prefixes too, which errs on the side of keeping.
        const unsent = socket.writableLength || 0
        const keep = this.unconfirmed ? this.sequenceNumber - this.unconfirmed.from : 0
        while (this.backupSize - unsent > MAX_BACKUP_BYTES && this.backupBuffer.length > keep) {
            this.backupSize -= serializedPacket(this.backupBuffer.shift()!).length
        }
    }

    /** Packets the peer says it never received, oldest first. */
    recover (lastValidSequenceNumber: number): Buffer[] {
        const toRecover = this.sequenceNumber - lastValidSequenceNumber
        if (toRecover < 0) {
            throw new UnrecoverableSessionError(
                'the server has received more packets than we ever sent (we are behind the server)',
            )
        }
        if (toRecover > this.backupBuffer.length) {
            throw new UnrecoverableSessionError(
                'the packets the server is missing have already been trimmed from the replay buffer',
            )
        }
        // The catch-up carries everything written so far. Whatever is written
        // from here on is attach()'s to send.
        this.handedOff = this.sequenceNumber
        const catchup = this.backupBuffer.newest(toRecover).map(serializedPacket)
        let bytes = 0
        for (const packet of catchup) {
            bytes += catchupEntrySize(packet.length)
        }
        // With a socket attached this is a question, not a resume: whatever
        // asks is not going to send a catch-up over a socket that works.
        if (!this.socket) {
            this.unconfirmed = toRecover ? { from: lastValidSequenceNumber, bytes } : null
        }
        return catchup
    }
}
