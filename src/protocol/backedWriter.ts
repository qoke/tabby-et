import { Socket } from 'net'
import { ETCrypto, MAC_BYTES } from './crypto'
import { DISCONNECT_BUFFER_BYTES, MAX_BACKUP_BYTES, PACKET_HEADER_SIZE } from './constants'
import { UnrecoverableSessionError } from './errors'
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
    private disconnectedBytes = 0
    private socket: Socket|null = null
    /**
     * How much of our stream the peer can account for: every packet up to this
     * sequence number was either written to a socket or offered in a recovery
     * catch-up. Anything past it exists only in the replay buffer.
     */
    private handedOff = 0

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
    }

    detach (): void {
        this.socket = null
    }

    /**
     * Bytes we have accepted that the network has not taken yet: queued on the
     * socket, or waiting for there to be a socket.
     */
    get backlog (): number {
        return this.socket ? this.socket.writableLength : this.disconnectedBytes
    }

    /**
     * Encrypt, buffer, and (if connected) send. Returns false if the packet had to be
     * dropped because the disconnect buffer is full.
     */
    write (header: number, payload: Buffer): boolean {
        // Size the serialized packet WILL have, computed without encrypting.
        // crypto_secretbox appends a MAC_BYTES tag, and serializePacket prepends
        // PACKET_HEADER_SIZE, so this exactly equals the eventual serialized length.
        const serializedLength = PACKET_HEADER_SIZE + MAC_BYTES + payload.length

        if (!this.socket && this.disconnectedBytes + serializedLength > DISCONNECT_BUFFER_BYTES) {
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

        if (!this.socket) {
            this.disconnectedBytes += serializedLength
            return true
        }

        this.trim(this.socket)
        this.socket.write(frame)
        this.handedOff = this.sequenceNumber
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
     */
    private trim (socket: Socket): void {
        // Counts the frame prefixes too, which errs on the side of keeping.
        const unsent = socket.writableLength || 0
        while (this.backupSize - unsent > MAX_BACKUP_BYTES) {
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
        return this.backupBuffer.newest(toRecover).map(serializedPacket)
    }
}
