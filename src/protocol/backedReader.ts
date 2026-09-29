import { ByteReader } from './byteReader'
import { ETCrypto } from './crypto'
import { MAX_PROTO_LENGTH, PACKET_HEADER_SIZE } from './constants'
import { RecoveredPackets } from './messages'

export interface ETPacket {
    header: number
    payload: Buffer
}

export class BackedReader {
    /** Number of packets received, including those handed to us by revive(). */
    sequenceNumber = 0

    /**
     * Packets recovered during reconnect, still encrypted, oldest first: one
     * batch for every recovery, and how far into it we have read.
     */
    private localBuffer: { packets: Buffer[]|RecoveredPackets, next: number }[] = []
    private reader: ByteReader|null = null

    constructor (private crypto: ETCrypto) {}

    attach (reader: ByteReader): void {
        this.reader = reader
    }

    /**
     * Queue recovered packets and account for them immediately.
     *
     * ET does `sequenceNumber += newLocalEntries.size()` inside revive(), BEFORE the
     * entries are decrypted. We must do the same: if a second disconnect happens while
     * the queue is still draining, our SequenceHeader has to claim we already have them,
     * or the server replays them a second time and the nonce counters desynchronise.
     */
    revive (reader: ByteReader, recovered: Buffer[]|RecoveredPackets): void {
        this.reader = reader
        // Kept as it came, and never spread into a call. A replay is as long
        // as the outage was busy, and spreading one overflows the stack
        // somewhere past a hundred thousand packets - on every attempt, so that
        // the session could never be resumed at all.
        if (recovered.length) {
            this.localBuffer.push({ packets: recovered, next: 0 })
        }
        this.sequenceNumber += recovered.length
    }

    /** There are recovered packets still to be read: the next one is not from the socket. */
    get replaying (): boolean {
        return this.localBuffer.length > 0
    }

    /** The next packet of those that were recovered. There is one. */
    private recovered (): ETPacket {
        const batch = this.localBuffer[0]
        const serialized = Array.isArray(batch.packets) ? batch.packets[batch.next] : batch.packets.at(batch.next)!
        batch.next++
        if (batch.next >= batch.packets.length) {
            this.localBuffer.shift()
        }
        // NOTE: no sequenceNumber++ here - revive() already counted it.
        return this.parse(serialized)
    }

    /**
     * The next packet if all of it is here, and null if it is not: read() is
     * to be asked then, and will wait for it, or say what is wrong with it.
     */
    poll (): ETPacket|null {
        if (this.localBuffer.length) {
            return this.recovered()
        }
        const prefix = this.reader?.peek(4)
        if (!prefix) {
            return null
        }
        const length = prefix.readInt32BE(0)
        if (length < PACKET_HEADER_SIZE || length > MAX_PROTO_LENGTH) {
            return null
        }
        const frame = this.reader!.takeNow(4 + length)
        if (!frame) {
            return null
        }
        this.sequenceNumber++
        return this.parse(frame.subarray(4))
    }

    /** Read one packet: recovery queue first, then the socket. */
    async read (): Promise<ETPacket> {
        if (this.localBuffer.length) {
            return this.recovered()
        }
        if (!this.reader) {
            throw new Error('BackedReader has no socket')
        }
        const lengthBytes = await this.reader.read(4)
        const length = lengthBytes.readInt32BE(0)
        if (length < PACKET_HEADER_SIZE || length > MAX_PROTO_LENGTH) {
            throw new Error(`Invalid ET packet length ${length}`)
        }
        const serialized = await this.reader.read(length)
        this.sequenceNumber++
        return this.parse(serialized)
    }

    private parse (serialized: Buffer): ETPacket {
        const encrypted = serialized[0]
        const header = serialized[1]
        const payload = serialized.subarray(PACKET_HEADER_SIZE)
        if (!encrypted) {
            throw new Error('Received an unencrypted ET packet on the encrypted stream')
        }
        return { header, payload: this.crypto.decrypt(payload) }
    }
}
