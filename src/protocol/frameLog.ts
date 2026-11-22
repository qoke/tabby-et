/** Framing B puts a 4-byte big-endian length in front of every serialized Packet. */
export const FRAME_PREFIX_SIZE = 4

/**
 * How much room is made at a time. A frame that is larger than this gets a
 * chunk of exactly its size.
 */
const CHUNK_BYTES = 256 * 1024

interface Chunk {
    bytes: Buffer
    /** Where the oldest frame that is still kept starts. */
    start: number
    /** Where the newest frame ends, and the next one will start. */
    end: number
    /** How many frames are kept between the two. */
    frames: number
}

/**
 * A first-in, first-out queue of wire frames, kept end to end in memory that
 * belongs to nothing else.
 *
 * It holds what a session may have to replay, which is every keepalive and
 * every keystroke of the last 64 MiB: millions of frames of some twenty
 * bytes. A buffer for each of them costs several times what the frame does.
 * Worse, a small buffer is cut from a slab that Node shares out to everyone
 * who asks for one, and the slab lives for as long as any piece of it does.
 * Frames that are made seconds apart end up in a slab each, so that a month
 * of keepalives kept gigabytes alive that nothing counted.
 *
 * Here a frame costs its own bytes and no more. Nothing is kept of where it
 * is, either: every frame starts with its length, so the frames of a chunk
 * are found by walking it.
 *
 * It stays cheap at any length. Adding a frame and removing the oldest take
 * the same time however many there are.
 */
export class FrameLog {
    /** Oldest first, and none of them empty. */
    private chunks: Chunk[] = []
    private frames = 0
    private bytes = 0

    /** How many frames are kept. */
    get length (): number {
        return this.frames
    }

    /**
     * How many bytes they come to, prefixes included: what is held in memory
     * for them, and what a socket counts of them.
     */
    get size (): number {
        return this.bytes
    }

    /**
     * Room for a frame of `length` bytes after its prefix. The prefix is
     * written, and the rest is the caller's to fill in.
     *
     * What is returned is a view of the log's own memory, and is good for as
     * long as anyone holds it: nothing is ever written over a frame, kept or
     * not, since a socket may still be waiting to send it.
     */
    add (length: number): Buffer {
        const size = FRAME_PREFIX_SIZE + length
        let chunk = this.chunks[this.chunks.length - 1]
        if (!chunk || chunk.bytes.length - chunk.end < size) {
            // allocUnsafeSlow, because allocUnsafe is what cuts from the slab.
            chunk = { bytes: Buffer.allocUnsafeSlow(Math.max(CHUNK_BYTES, size)), start: 0, end: 0, frames: 0 }
            this.chunks.push(chunk)
        }
        const frame = chunk.bytes.subarray(chunk.end, chunk.end + size)
        frame.writeInt32BE(length, 0)
        chunk.end += size
        chunk.frames++
        this.frames++
        this.bytes += size
        return frame
    }

    /** Forget the oldest frame. */
    shift (): void {
        const chunk = this.chunks[0]
        if (!chunk) {
            return
        }
        const size = FRAME_PREFIX_SIZE + chunk.bytes.readInt32BE(chunk.start)
        chunk.start += size
        chunk.frames--
        this.frames--
        this.bytes -= size
        if (!chunk.frames) {
            // Even if there is room left in it: whatever still holds one of
            // its frames keeps it alive, and nobody else has to.
            this.chunks.shift()
        }
    }

    /** The newest `count` frames, oldest first, each without its first `skip` bytes. */
    newest (count: number, skip = 0): Buffer[] {
        count = Math.min(count, this.frames)
        if (count <= 0) {
            return []
        }
        // The chunk that the oldest of them is in, and how many of its frames
        // are older still.
        let index = this.chunks.length
        let older = -count
        while (older < 0) {
            older += this.chunks[--index].frames
        }
        const out: Buffer[] = []
        for (; index < this.chunks.length; index++) {
            const { bytes, start, end } = this.chunks[index]
            for (let at = start; at < end;) {
                const next = at + FRAME_PREFIX_SIZE + bytes.readInt32BE(at)
                if (older > 0) {
                    older--
                } else {
                    out.push(bytes.subarray(at + skip, next))
                }
                at = next
            }
        }
        return out
    }
}
