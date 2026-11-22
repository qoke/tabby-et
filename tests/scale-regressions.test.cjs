'use strict'

// A session exists to survive outages, and an outage is exactly when traffic
// piles up: the server keeps up to 64 MiB of output to replay, and so do we.
// These tests hold the protocol layer to what that implies.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const path = require('node:path')

const { createLoader } = require('./support/load.cjs')

const load = createLoader()
const { ByteReader } = load('src/protocol/byteReader.ts')
const { BackedReader } = load('src/protocol/backedReader.ts')
const { BackedWriter } = load('src/protocol/backedWriter.ts')
const { ETCrypto } = load('src/protocol/crypto.ts')
const { decodeFields } = load('src/protocol/protobuf.ts')

const passkey = 'RegressionTestPasskey00000000000'

function createSocket () {
    const socket = new EventEmitter()
    socket.paused = false
    socket.pause = () => { socket.paused = true }
    socket.resume = () => { socket.paused = false }
    return socket
}

const elapsed = started => Number(process.hrtime.bigint() - started) / 1e6

/** Serialized packets as the server would replay them, oldest first. */
function serverPackets (count) {
    const crypto = new ETCrypto(passkey, 1)
    return Array.from({ length: count }, (_, i) => {
        const payload = Buffer.alloc(4)
        payload.writeUInt32BE(i)
        return Buffer.concat([Buffer.from([1, 1]), crypto.encrypt(payload)])
    })
}

test('a replay of more packets than a call can take arguments is still revived', async () => {
    // Spreading the replay into push() overflows the stack somewhere past
    // 100 000 entries, and every retry would overflow the same way.
    const count = 200000
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    reader.revive(new ByteReader(createSocket()), serverPackets(count))
    assert.equal(reader.sequenceNumber, count)

    for (let i = 0; i < count; i++) {
        const packet = await reader.read()
        if (packet.payload.readUInt32BE(0) !== i) {
            assert.fail(`packet ${i} came out of order`)
        }
    }
})

test('a frame log stays cheap at any length, and gives back what was put in', () => {
    const { FrameLog } = load('src/protocol/frameLog.ts')
    const log = new FrameLog()
    /** A frame as it should read: its length, then `length` bytes that say which frame it is. */
    const expected = (index, length) => {
        const frame = Buffer.alloc(4 + length, index % 251)
        frame.writeInt32BE(length, 0)
        return frame
    }
    const add = (index, length) => log.add(length).fill(index % 251, 4)

    const count = 1000000
    const started = process.hrtime.bigint()
    for (let i = 0; i < count; i++) {
        add(i, i % 40)
    }
    assert.equal(log.length, count)
    assert.deepEqual(log.newest(2), [expected(count - 2, (count - 2) % 40), expected(count - 1, (count - 1) % 40)])
    let size = log.size
    for (let i = 0; i < count; i++) {
        log.shift()
        size -= 4 + i % 40
        if (log.length !== count - i - 1 || log.size !== size) {
            assert.fail(`the log miscounted after ${i + 1} removals`)
        }
    }
    // Array.shift() alone takes about a minute for this many.
    assert.ok(elapsed(started) < 10000, `${count} frames took ${elapsed(started).toFixed(0)} ms`)
    assert.equal(log.size, 0)
    log.shift()
    assert.equal(log.length, 0)
    assert.deepEqual(log.newest(1), [])

    // Interleaved, as the replay buffer is used while connected, and with
    // frames of every size up to more than a chunk holds: checked against a
    // plain array, which is slow but obviously right.
    const model = []
    const handedOut = []
    for (let i = 0; i < 6000; i++) {
        const length = i % 500 === 499 ? 300 * 1024 + i : i * 7919 % 3000
        const frame = add(i, length)
        model.push(expected(i, length))
        handedOut.push({ frame, index: i, length })
        if (i % 3 === 2) {
            log.shift()
            model.shift()
        }
        if (i % 97 === 0) {
            const some = 1 + i % 400
            assert.deepEqual(log.newest(some), model.slice(-some))
        }
        assert.equal(log.length, model.length)
    }
    assert.deepEqual(log.newest(model.length + 10), model)
    // Without the prefix, which is how a catch-up carries them.
    assert.deepEqual(log.newest(3, 4), model.slice(-3).map(frame => frame.subarray(4)))
    assert.equal(log.size, model.reduce((sum, frame) => sum + frame.length, 0))

    // A frame that was handed out may be waiting on a socket long after it
    // was forgotten here, and nothing that came after it was written over it.
    for (const { frame, index, length } of handedOut) {
        if (!frame.equals(expected(index, length))) {
            assert.fail(`frame ${index} was written over`)
        }
    }
})

test('packets revived in two recoveries come out in order', async () => {
    const packets = serverPackets(10)
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    const byteReader = new ByteReader(createSocket())
    reader.revive(byteReader, packets.slice(0, 4))
    assert.equal((await reader.read()).payload.readUInt32BE(0), 0)
    assert.equal((await reader.read()).payload.readUInt32BE(0), 1)
    // A second disconnect, while the first replay is still being read.
    reader.revive(byteReader, packets.slice(4))
    assert.equal(reader.sequenceNumber, 10)
    for (let i = 2; i < 10; i++) {
        assert.equal((await reader.read()).payload.readUInt32BE(0), i)
    }
})

test('a large frame is assembled in time proportional to its size', async () => {
    const socket = createSocket()
    const reader = new ByteReader(socket)
    const size = 48 * 1024 * 1024
    const chunk = Buffer.alloc(16 * 1024, 7)
    const started = process.hrtime.bigint()
    const pending = reader.read(size)
    for (let sent = 0; sent < size; sent += chunk.length) {
        socket.emit('data', chunk)
    }
    const frame = await pending
    assert.equal(frame.length, size)
    // Joining the buffer on every chunk makes this take over forty seconds.
    assert.ok(elapsed(started) < 5000, `assembling the frame took ${elapsed(started).toFixed(0)} ms`)
})

test('reads that straddle chunks return exactly the bytes that were sent', async () => {
    const socket = createSocket()
    const reader = new ByteReader(socket)
    const sent = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251))
    for (let offset = 0; offset < sent.length;) {
        const length = 1 + (offset * 7) % 97
        socket.emit('data', sent.subarray(offset, offset + length))
        offset += length
    }
    const received = []
    for (let offset = 0; offset < sent.length;) {
        const length = Math.min(1 + (offset * 13) % 211, sent.length - offset)
        received.push(await reader.read(length))
        offset += length
    }
    assert.deepEqual(Buffer.concat(received), sent)
    await assert.rejects(reader.read(1, 20), /Timed out/)
})

test('a read times out on silence, not on how long a large message takes', async () => {
    const socket = createSocket()
    const reader = new ByteReader(socket)
    // Sixty chunks, 10 ms apart, against a 400 ms timeout: a slow link
    // delivering a large catch-up. The reference client restarts its timer on
    // every byte; a fixed deadline here could never be met, on any retry.
    const began = Date.now()
    const pending = reader.read(60, 400)
    for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        socket.emit('data', Buffer.from([i]))
    }
    assert.equal((await pending).length, 60)
    assert.ok(Date.now() - began > 400, 'the read finished too soon to prove anything')

    // Silence is still an error.
    const started = Date.now()
    const stalled = reader.read(2, 100)
    socket.emit('data', Buffer.from([1]))
    await assert.rejects(stalled, /Timed out/)
    assert.ok(Date.now() - started >= 90)
    // The timed-out read consumed nothing.
    socket.emit('data', Buffer.from([2]))
    assert.deepEqual(await reader.read(2), Buffer.from([1, 2]))
})

test('writing stays cheap however much there is to replay', () => {
    const writer = new BackedWriter(new ETCrypto(passkey, 0))
    const frames = { count: 0 }
    writer.attach({ write: () => { frames.count++ } })
    const payload = Buffer.alloc(8)
    const count = 400000
    const started = process.hrtime.bigint()
    for (let i = 0; i < count; i++) {
        writer.write(1, payload)
    }
    // Inserting at the front of an array moves everything behind it, which
    // takes over a minute for this many.
    assert.ok(elapsed(started) < 20000, `${count} writes took ${elapsed(started).toFixed(0)} ms`)
    assert.equal(frames.count, count)

    writer.detach()
    const replay = writer.recover(count - 3)
    assert.equal(replay.length, 3)
    const server = new ETCrypto(passkey, 0)
    // Oldest first, and the very packets the server is missing.
    for (let i = 0; i < count - 3; i++) {
        server.increment()
    }
    for (const serialized of replay) {
        assert.deepEqual(server.decrypt(serialized.subarray(2)), payload)
    }
})

test('the replay buffer is trimmed from its oldest end, and only while connected', () => {
    const writer = new BackedWriter(new ETCrypto(passkey, 0))
    writer.attach({ write () {} })
    const megabyte = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < 70; i++) {
        writer.write(1, megabyte)
    }
    assert.equal(writer.sequenceNumber, 70)
    assert.throws(() => writer.recover(0), /already been trimmed/)
    assert.equal(writer.recover(69).length, 1)
    // 64 MiB of 1 MiB packets: the newest 63 fit under the cap with their framing.
    assert.equal(writer.recover(70 - 63).length, 63)
    assert.throws(() => writer.recover(70 - 64), /already been trimmed/)

    writer.detach()
    for (let i = 0; i < 5; i++) {
        assert.equal(writer.write(1, megabyte), true)
    }
    // Nothing was trimmed to make room for what was written while disconnected.
    assert.equal(writer.recover(70 - 63).length, 68)
})

/**
 * What a writer holds once `frames` keepalives have gone through it, in bytes
 * of heap and of buffers, with `between` buffers of the kind that everything
 * else in the process makes and drops made after each of them.
 *
 * In a process of its own, which is the only place where what one object
 * keeps alive can be told from what the tests around it do.
 */
function replayFootprint ({ frames, between = 0, encrypting = true }) {
    const script = `
        const { createLoader } = require(${JSON.stringify(path.join(__dirname, 'support/load.cjs'))})
        const load = createLoader()
        const { BackedWriter } = load('src/protocol/backedWriter.ts')
        const { ETCrypto } = load('src/protocol/crypto.ts')
        const settled = () => {
            gc()
            gc()
            const { heapUsed, arrayBuffers } = process.memoryUsage()
            return heapUsed + arrayBuffers
        }
        // Without the cipher, where it is only the number of frames that matters:
        // an empty packet is its tag and nothing else.
        const tag = Buffer.alloc(16)
        const crypto = ${encrypting} ? new ETCrypto(${JSON.stringify(passkey)}, 0) : { encrypt: () => tag }
        const writer = new BackedWriter(crypto)
        writer.attach({ write () {} })
        const nothing = Buffer.alloc(0)
        const input = new Uint8Array(200)
        const before = settled()
        for (let i = 0; i < ${frames}; i++) {
            writer.write(0, nothing, true)
            for (let j = 0; j < ${between}; j++) {
                Buffer.from(input)
            }
        }
        const held = settled() - before
        writer.detach()
        process.stdout.write(JSON.stringify({ held, written: writer.sequenceNumber, newest: writer.recover(${frames} - 1).length }))
    `
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], { timeout: 120000, maxBuffer: 1 << 20 })
    assert.equal(child.status, 0, `the writer did not get through ${frames} keepalives: ${child.stderr}`)
    const outcome = JSON.parse(child.stdout.toString())
    assert.equal(outcome.written, frames)
    assert.equal(outcome.newest, 1)
    return outcome.held
}

const MiB = 1024 * 1024
const inMiB = bytes => `${(bytes / MiB).toFixed(1)} MiB`

test('a packet kept for replay keeps no memory alive but its own', () => {
    // A small buffer is cut from a slab that Node shares out to everyone who
    // asks for one, and the slab lives for as long as any piece of it does.
    // Keystrokes, terminal output and the cipher all take pieces between two
    // keepalives, so a keepalive of 22 bytes that was such a piece had a slab
    // of its own to keep alive: some 4 KiB for each of them here.
    const frames = 100000
    const kept = frames * 22
    const held = replayFootprint({ frames, between: 20 })
    assert.ok(held <= 2 * kept, `${inMiB(kept)} of packets held ${inMiB(held)}`)
})

test('keepalives are held to the replay budget by what they take, not by what they say', () => {
    const { MAX_BACKUP_BYTES } = load('src/protocol/constants.ts')
    // The server acknowledges nothing, so every keepalive is kept until the
    // budget is spent - and a keepalive is 18 bytes of packet. Counted as
    // that, with a buffer object and a place in a queue each, the 64 MiB
    // that an idle session was allowed came to several times as much.
    const frames = Math.ceil(MAX_BACKUP_BYTES / 18) + 100000
    const held = replayFootprint({ frames, encrypting: false })
    assert.ok(held <= MAX_BACKUP_BYTES * 1.05, `a budget of ${inMiB(MAX_BACKUP_BYTES)} held ${inMiB(held)}`)
})

test('a truncated fixed32 field is rejected like every other truncated field', () => {
    // Field 1, wire type 5 (fixed32), with two of its four bytes.
    assert.throws(() => decodeFields(Buffer.from([0x0d, 0x01, 0x02])), /Truncated protobuf fixed32/)
    const decoded = decodeFields(Buffer.from([0x0d, 1, 2, 3, 4]))
    assert.deepEqual(decoded.get(1)[0].bytes, Buffer.from([1, 2, 3, 4]))
})

test('a number that cannot be encoded is refused, not encoded forever', () => {
    // In a process of its own: a loop that never ends cannot be timed out from
    // inside the process that is running it.
    const script = `
        const { createLoader } = require(${JSON.stringify(path.join(__dirname, 'support/load.cjs'))})
        const { ProtoWriter } = createLoader()('src/protocol/protobuf.ts')
        const outcomes = {}
        for (const value of [Infinity, -Infinity, NaN, 1.5, 2 ** 64, Number.MAX_SAFE_INTEGER + 1]) {
            try {
                outcomes[String(value)] = new ProtoWriter().int32(1, value).finish().toString('hex')
            } catch (err) {
                outcomes[String(value)] = 'refused'
            }
        }
        process.stdout.write(JSON.stringify(outcomes))
    `
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 10000, maxBuffer: 1 << 20 })
    assert.equal(child.signal, null, 'the encoder never returned')
    const outcomes = JSON.parse(child.stdout.toString())
    for (const [value, outcome] of Object.entries(outcomes)) {
        assert.equal(outcome, 'refused', `${value} was encoded as ${outcome}`)
    }

    const { ProtoWriter } = load('src/protocol/protobuf.ts')
    assert.equal(new ProtoWriter().int32(1, 300).finish().toString('hex'), '08ac02')
    assert.equal(new ProtoWriter().int32(1, -1).finish().toString('hex'), '08ffffffffffffffffff01')
    assert.equal(new ProtoWriter().int32(1, 0).finish().toString('hex'), '0800')
})

test('a catch-up is read without an object for every entry', () => {
    const { decodeCatchupPackets, encodeCatchupBuffer } = load('src/protocol/messages.ts')
    const packets = serverPackets(1000)
    const recovered = decodeCatchupPackets(encodeCatchupBuffer(packets))
    assert.equal(recovered.length, 1000)
    assert.deepEqual(recovered.at(0), packets[0])
    assert.deepEqual(recovered.at(999), packets[999])
    assert.equal(recovered.at(1000), undefined)
    assert.deepEqual(decodeCatchupPackets(Buffer.alloc(0)).length, 0)

    // Unauthenticated input: anyone on the path can send this, and half a
    // million objects were made of it before a single entry was looked at.
    const hostile = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < hostile.length; i += 2) {
        hostile[i] = 0x0a // field 1, length-delimited, of length 0
    }
    const before = process.memoryUsage().heapUsed
    assert.throws(() => decodeCatchupPackets(hostile), /catch-up/i)
    assert.ok(process.memoryUsage().heapUsed - before < 8 * 1024 * 1024, 'refusing it still cost megabytes of heap')

    // Fields that are not packets are passed over, and kept nowhere.
    const padded = Buffer.concat([Buffer.from([0x10, 0x07, 0x1a, 0x02, 0xaa, 0xbb]), encodeCatchupBuffer(packets.slice(0, 2))])
    assert.equal(decodeCatchupPackets(padded).length, 2)
    assert.throws(() => decodeCatchupPackets(Buffer.from([0x0a, 0x7f, 0x01])), /Truncated|catch-up/i)
})

test('a compact catch-up is revived and read like any other', async () => {
    const { decodeCatchupPackets, encodeCatchupBuffer } = load('src/protocol/messages.ts')
    const packets = serverPackets(12)
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    const byteReader = new ByteReader(createSocket())
    reader.revive(byteReader, decodeCatchupPackets(encodeCatchupBuffer(packets.slice(0, 5))))
    assert.equal(reader.sequenceNumber, 5)
    assert.equal((await reader.read()).payload.readUInt32BE(0), 0)
    // A second recovery while the first is still being read, this one as a list.
    reader.revive(byteReader, packets.slice(5, 9))
    reader.revive(byteReader, decodeCatchupPackets(encodeCatchupBuffer(packets.slice(9))))
    assert.equal(reader.sequenceNumber, 12)
    for (let i = 1; i < 12; i++) {
        assert.equal((await reader.read()).payload.readUInt32BE(0), i)
    }
})

/** Frames as etserver sends them, and what is in them. */
function framed (count) {
    const crypto = require('node:crypto')
    const sender = new ETCrypto(passkey, 1)
    const payloads = Array.from({ length: count }, (_, i) => crypto.randomBytes(i % 7 === 0 ? 0 : 1 + i * 37 % 3000))
    const frames = payloads.map(payload => {
        const encrypted = sender.encrypt(payload)
        const frame = Buffer.alloc(4 + 2 + encrypted.length)
        frame.writeInt32BE(2 + encrypted.length, 0)
        frame[4] = 1
        frame[5] = 7
        encrypted.copy(frame, 6)
        return frame
    })
    return { payloads, frames }
}

test('packets that have arrived are read without waiting, in whatever pieces they came', () => {
    const { payloads, frames } = framed(500)
    const stream = Buffer.concat(frames)
    const socket = createSocket()
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    reader.attach(new ByteReader(socket))
    assert.equal(reader.poll(), null)

    // In pieces of every size, so that lengths and packets are cut everywhere.
    const read = []
    let offset = 0
    for (let size = 1; offset < stream.length; size = size * 3 % 4099 + 1) {
        socket.emit('data', stream.subarray(offset, offset + size))
        offset += size
        for (let packet = reader.poll(); packet; packet = reader.poll()) {
            read.push(packet)
        }
    }
    assert.equal(read.length, payloads.length)
    assert.equal(reader.sequenceNumber, payloads.length)
    read.forEach((packet, i) => {
        assert.equal(packet.header, 7)
        assert.ok(packet.payload.equals(payloads[i]), `packet ${i} is not what was sent`)
    })
    assert.equal(reader.poll(), null)
})

test('what is waited for and what is not come in the order that they were sent in', async () => {
    const { payloads, frames } = framed(200)
    const socket = createSocket()
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    reader.attach(new ByteReader(socket))
    const read = []
    for (let i = 0; i < frames.length; i++) {
        if (i % 3 === 0) {
            // Asked for before any of it is here, and sent in two pieces.
            const waited = reader.read()
            assert.equal(reader.poll(), null, 'read from under a read that was waiting')
            socket.emit('data', frames[i].subarray(0, 3))
            socket.emit('data', frames[i].subarray(3))
            read.push(await waited)
        } else {
            socket.emit('data', frames[i])
            read.push(i % 3 === 1 ? reader.poll() : await reader.read())
        }
    }
    assert.equal(reader.sequenceNumber, payloads.length)
    read.forEach((packet, i) => assert.ok(packet.payload.equals(payloads[i]), `packet ${i} is not what was sent`))
})

test('a length that cannot be one is left for the read that says so', async () => {
    const socket = createSocket()
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    reader.attach(new ByteReader(socket))
    const nonsense = Buffer.alloc(64)
    nonsense.writeInt32BE(-5, 0)
    socket.emit('data', nonsense)
    assert.equal(reader.poll(), null)
    await assert.rejects(reader.read(), /Invalid ET packet length/)
})
