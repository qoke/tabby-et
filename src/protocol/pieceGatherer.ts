/** A piece of at least this many bytes is kept as it came. */
const SMALL_PIECE_BYTES = 4096

/**
 * Keeps a queue of buffers from costing more than the bytes in it.
 *
 * Data that is waiting is kept in the pieces that it came in, and a piece is
 * a buffer: an object or two and an allocation, some two hundred bytes of
 * them, whatever it holds. A megabyte that came a byte at a time is two
 * hundred megabytes of pieces, and whoever sends it decides how it comes. A
 * limit on the bytes that are waiting is no limit on that at all.
 *
 * So a small piece that joins others is copied to the end of a block of
 * memory, next to the one before it, and the two are one piece from then on.
 * A piece with nothing in front of it is kept as it came: data that is read
 * as fast as it arrives is never copied.
 */
export class PieceGatherer {
    private block: Buffer|null = null
    /** How much of the block has been given to pieces. */
    private used = 0

    constructor (private blockBytes = 64 * 1024) {}

    /**
     * Put `piece` at the end of `pieces`.
     *
     * Nothing is ever written over a piece that this has made, wherever it
     * has got to since: a block is filled once, from its start to its end,
     * and what a piece of it shows does not change.
     */
    add (pieces: Buffer[], piece: Buffer): void {
        if (!pieces.length || piece.length >= SMALL_PIECE_BYTES) {
            pieces.push(piece)
            return
        }
        if (!this.block || this.block.length - this.used < piece.length) {
            // Memory of its own. What Buffer.allocUnsafe gives out is cut
            // from a slab that it shares out to everyone, and lives for as
            // long as any other piece of that slab does.
            this.block = Buffer.allocUnsafeSlow(this.blockBytes)
            this.used = 0
        }
        const block = this.block
        const start = this.used
        piece.copy(block, start)
        this.used += piece.length

        const last = pieces[pieces.length - 1]
        if (last.buffer === block.buffer && last.byteOffset + last.length === block.byteOffset + start) {
            // The piece before it ends where this one starts.
            pieces[pieces.length - 1] = block.subarray(last.byteOffset - block.byteOffset, this.used)
        } else {
            pieces.push(block.subarray(start, this.used))
        }
    }
}
