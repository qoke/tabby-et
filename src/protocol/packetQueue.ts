/**
 * A first-in, first-out queue of packets that stays cheap at any length.
 *
 * Both replay buffers are queues, and both fill up during an outage - which is
 * the one time a session cannot afford to be slow. Array.shift() and unshift()
 * move every element on each call, so a plain array makes filling or draining
 * a few hundred thousand packets take the better part of a minute. Here a
 * removal only advances an index, and the space behind it is reclaimed in bulk.
 */
export class PacketQueue {
    private items: (Buffer|undefined)[] = []
    /** Index of the oldest packet still queued. */
    private head = 0

    get length (): number {
        return this.items.length - this.head
    }

    push (packet: Buffer): void {
        this.items.push(packet)
    }

    /** Remove and return the oldest packet. */
    shift (): Buffer|undefined {
        if (this.head === this.items.length) {
            return undefined
        }
        const packet = this.items[this.head]
        this.items[this.head] = undefined
        this.head++
        if (this.head === this.items.length) {
            this.items = []
            this.head = 0
        } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
            // At least half of the array is dead weight. Copying the live half
            // costs no more than the removals that got us here.
            this.items = this.items.slice(this.head)
            this.head = 0
        }
        return packet
    }

    /** The newest `count` packets, oldest first. */
    newest (count: number): Buffer[] {
        return count > 0 ? this.items.slice(Math.max(this.items.length - count, this.head)) as Buffer[] : []
    }
}
