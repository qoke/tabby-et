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
const { decodeCatchupBuffer } = load('src/protocol/messages.ts')

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
    // Where they are, with nothing made for any of them.
    const found = []
    log.eachNewest(3, (bytes, start, end) => found.push(Buffer.from(bytes.subarray(start, end))))
    assert.deepEqual(found, model.slice(-3))
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
    assert.equal(replay.packets, 3)
    const server = new ETCrypto(passkey, 0)
    // Oldest first, and the very packets the server is missing.
    for (let i = 0; i < count - 3; i++) {
        server.increment()
    }
    for (const serialized of decodeCatchupBuffer(replay.message)) {
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
    assert.equal(writer.recover(69).packets, 1)
    // 64 MiB of 1 MiB packets: the newest 63 fit under the cap with their framing.
    assert.equal(writer.recover(70 - 63).packets, 63)
    assert.throws(() => writer.recover(70 - 64), /already been trimmed/)

    writer.detach()
    for (let i = 0; i < 5; i++) {
        assert.equal(writer.write(1, megabyte), true)
    }
    // Nothing was trimmed to make room for what was written while disconnected.
    assert.equal(writer.recover(70 - 63).packets, 68)
})

/**
 * Run `body` in a process of its own, and return what it returns.
 *
 * That is the only place where what one object keeps alive can be told from
 * what the tests around it do. The body is given `load`, for the sources, and
 * `settled`, which is what the process holds at that moment in bytes of heap
 * and of buffers, once everything that nothing refers to has been collected.
 */
function measured (body) {
    const script = `
        const { createLoader } = require(${JSON.stringify(path.join(__dirname, 'support/load.cjs'))})
        const load = createLoader()
        const settled = () => {
            gc()
            gc()
            const { heapUsed, arrayBuffers } = process.memoryUsage()
            return heapUsed + arrayBuffers
        }
        const passkey = ${JSON.stringify(passkey)}
        Promise.resolve((${body})()).then(outcome => {
            process.stdout.write(JSON.stringify(outcome))
            process.exit(0)
        })
    `
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], { timeout: 120000, maxBuffer: 1 << 20 })
    assert.equal(child.status, 0, `the measurement did not finish: ${child.stderr}`)
    return JSON.parse(child.stdout.toString())
}

/**
 * What a writer holds once `frames` keepalives have gone through it, with
 * `between` buffers of the kind that everything else in the process makes and
 * drops made after each of them.
 */
function replayFootprint ({ frames, between = 0, encrypting = true }) {
    const outcome = measured(`() => {
        const { BackedWriter } = load('src/protocol/backedWriter.ts')
        const { ETCrypto } = load('src/protocol/crypto.ts')
        // Without the cipher, where it is only the number of frames that matters:
        // an empty packet is its tag and nothing else.
        const tag = Buffer.alloc(16)
        const crypto = ${encrypting} ? new ETCrypto(passkey, 0) : { encrypt: () => tag }
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
        return { held, written: writer.sequenceNumber, newest: writer.recover(${frames} - 1).packets }
    }`)
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

test('what is waiting to be read holds its bytes, however small the pieces it came in', () => {
    // A read waits for as much as it was told to expect, which a catch-up
    // makes up to 128 MiB, and nothing has vouched for that message yet.
    // Whoever sends it decides how it arrives. A byte at a time, each byte
    // was a buffer of its own: two hundred times what was counted.
    const pieces = 1000000
    const { held, read } = measured(`async () => {
        const { EventEmitter } = require('node:events')
        const { ByteReader } = load('src/protocol/byteReader.ts')
        const socket = new EventEmitter()
        socket.pause = socket.resume = () => {}
        const reader = new ByteReader(socket)
        const pending = reader.read(${pieces} + 1, 30000)
        const before = settled()
        for (let i = 0; i < ${pieces}; i++) {
            // As a socket delivers them: each in memory of its own.
            socket.emit('data', Buffer.allocUnsafeSlow(1).fill(i % 251))
        }
        const held = settled() - before
        socket.emit('data', Buffer.from([7]))
        const message = await pending
        let intact = message.length === ${pieces} + 1 && message[${pieces}] === 7
        for (let i = 0; intact && i < ${pieces}; i++) {
            intact = message[i] === i % 251
        }
        return { held, read: intact }
    }`)
    assert.equal(read, true, 'the bytes that were read are not the bytes that were sent')
    assert.ok(held <= 4 * pieces, `${inMiB(pieces)} that was waiting held ${inMiB(held)}`)
})

test('what is queued for a forwarded connection holds its bytes, however small the packets it came in', () => {
    // A local endpoint that does not read, and a peer that sends its data
    // sixteen bytes to the packet. What is queued for the endpoint is limited
    // by its bytes, and each packet was queued by itself: a buffer, a view of
    // it and a place in the socket's queue, ten times and more what it held.
    const packets = 600000
    const { most } = measured(`async () => {
        const net = require('node:net')
        const { ETPortForwardHandler } = load('src/session/portForwarding.ts')
        const { ETPacketType } = load('src/protocol/constants.ts')
        const messages = load('src/protocol/messages.ts')

        const connections = []
        const server = net.createServer(socket => connections.push(socket.pause()))
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address()
        const sent = []
        const quiet = { debug () {}, info () {}, warn () {}, error () {}, log () {} }
        const handler = new ETPortForwardHandler(quiet, (header, payload) => sent.push(payload), () => {})
        handler.buildReverseTunnelRequests({
            forwardedPorts: [{ type: 'Remote', host: '127.0.0.1', port: 9000, targetAddress: 'localhost', targetPort: port }],
        })
        handler.handlePacket(ETPacketType.PORT_FORWARD_DESTINATION_REQUEST,
            messages.encodePortForwardDestinationRequest({ destination: { port }, fd: 1 }))
        while (!sent.length || !connections.length) {
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        const { socketId } = messages.decodePortForwardDestinationResponse(sent[0])

        const data = Buffer.alloc(16, 1)
        const before = settled()
        let most = 0
        for (let i = 1; i <= ${packets}; i++) {
            handler.handlePacket(ETPacketType.PORT_FORWARD_DATA,
                messages.encodePortForwardData({ sourceToDestination: true, socketId, buffer: data }))
            if (i % 50000 === 0) {
                await new Promise(resolve => setImmediate(resolve))
                most = Math.max(most, settled() - before)
            }
        }
        return { most }
    }`)
    assert.ok(most <= 2 * packets * 16, `${inMiB(packets * 16)} that was sent held ${inMiB(most)}`)
})

test('small pieces that are put together are not written over once they have been read', async () => {
    const socket = createSocket()
    const reader = new ByteReader(socket)
    const sent = Buffer.from(Array.from({ length: 300000 }, (_, i) => i * 7 % 251))
    // In pieces of every kind: small ones that are gathered, large ones that
    // are not, and reads that take them while more arrive behind them.
    const taken = []
    let offset = 0
    let turn = 0
    while (offset < sent.length) {
        for (let i = 0; i < 5 && offset < sent.length; i++, turn++) {
            const length = Math.min(turn % 11 === 10 ? 6000 : 1 + turn * 31 % 700, sent.length - offset)
            socket.emit('data', Buffer.from(sent.subarray(offset, offset + length)))
            offset += length
        }
        // Not all of it, so that there is always something to gather onto.
        const part = await reader.read(1 + turn * 13 % 900)
        taken.push(part)
    }
    const rest = sent.length - taken.reduce((sum, part) => sum + part.length, 0)
    taken.push(await reader.read(rest))
    // Compared at the very end: a buffer that was read early is still what
    // it was, whatever has been gathered since.
    assert.deepEqual(Buffer.concat(taken), sent)
})

test('a catch-up is made in one piece, with nothing made for each packet in it', () => {
    // A catch-up is as many packets long as the outage was busy, and a
    // packet may be a keystroke. A buffer for each tag, each length and each
    // packet, and a view of each packet to start with, came to twenty times
    // the message: what was alive while it was made is what counts here, so
    // it is the most that the process ever held that is measured.
    const packets = 1000000
    const { message, grew, intact } = measured(`() => {
        const { BackedWriter } = load('src/protocol/backedWriter.ts')
        const { decodeCatchupPackets } = load('src/protocol/messages.ts')
        const tag = Buffer.alloc(16, 7)
        const writer = new BackedWriter({ encrypt: () => tag })
        const nothing = Buffer.alloc(0)
        // With no socket: the server has none of them.
        for (let i = 0; i < ${packets}; i++) {
            writer.write(0, nothing, true)
        }
        settled()
        const before = process.resourceUsage().maxRSS
        const catchup = writer.recover(0)
        const grew = (process.resourceUsage().maxRSS - before) * 1024
        const recovered = decodeCatchupPackets(catchup.message)
        const expected = Buffer.concat([Buffer.from([1, 0]), tag])
        const intact = catchup.packets === ${packets} && recovered.length === ${packets}
            && recovered.at(0).equals(expected) && recovered.at(${packets} - 1).equals(expected)
        return { message: catchup.message.length, grew, intact }
    }`)
    assert.equal(intact, true, 'the catch-up does not carry the packets that were written')
    assert.equal(message, packets * 20)
    assert.ok(grew <= 3 * message, `making a catch-up of ${inMiB(message)} took ${inMiB(grew)}`)
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

test('ordinary packets do not retain repeated or unknown fields', () => {
    const script = `
        const { createLoader } = require(${JSON.stringify(path.join(__dirname, 'support/load.cjs'))})
        const load = createLoader()
        const { decodeTerminalBuffer, encodeTerminalBuffer } = load('src/protocol/messages.ts')
        const { decodeFields } = load('src/protocol/protobuf.ts')
        const hostile = Buffer.alloc(1024 * 1024)
        for (let i = 0; i < hostile.length; i += 4) {
            hostile[i] = 0x0a // A repeated known field 1, length-delimited, empty.
            hostile[i + 2] = 0x12 // An unknown field 2, also empty.
        }
        const expected = Buffer.from('terminal bytes')
        gc()
        const before = process.memoryUsage().heapUsed
        const decoded = decodeTerminalBuffer(Buffer.concat([encodeTerminalBuffer(expected), hostile]))
        // Measure before GC: the old decoder's temporary map was large enough to OOM the renderer.
        const held = process.memoryUsage().heapUsed - before
        const fields = decodeFields(hostile, [1])
        process.stdout.write(JSON.stringify({
            held, correct: decoded.equals(expected), fields: fields.size,
            occurrences: fields.get(1).length, firstLength: fields.get(1)[0].bytes.length,
        }))
    `
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], { timeout: 30000, maxBuffer: 1 << 20 })
    assert.equal(child.status, 0, child.stderr.toString())
    const outcome = JSON.parse(child.stdout.toString())
    assert.equal(outcome.correct, true)
    assert.equal(outcome.fields, 1)
    assert.equal(outcome.occurrences, 1)
    assert.equal(outcome.firstLength, 0)
    assert.ok(outcome.held < 8 * 1024 * 1024, `decoding used ${inMiB(outcome.held)} of heap`)
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

test('a frame that cannot be decrypted is refused before it is counted', () => {
    const socket = createSocket()
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    reader.attach(new ByteReader(socket))

    const unencrypted = Buffer.alloc(6)
    unencrypted.writeInt32BE(2, 0)
    unencrypted[4] = 0
    unencrypted[5] = 1
    socket.emit('data', unencrypted)
    assert.throws(() => reader.poll(), /unencrypted/)
    assert.equal(reader.sequenceNumber, 0)

    const short = Buffer.alloc(4 + 2 + 1)
    short.writeInt32BE(3, 0)
    short[4] = 1
    short[5] = 1
    socket.emit('data', short)
    assert.throws(() => reader.poll(), /shorter than a packet header and MAC/)
    assert.equal(reader.sequenceNumber, 0)

    const encrypted = new ETCrypto(passkey, 1).encrypt(Buffer.from('ok'))
    const valid = Buffer.alloc(4 + 2 + encrypted.length)
    valid.writeInt32BE(2 + encrypted.length, 0)
    valid[4] = 1
    valid[5] = 1
    encrypted.copy(valid, 6)
    socket.emit('data', valid)
    assert.equal(reader.poll().payload.toString(), 'ok')
    assert.equal(reader.sequenceNumber, 1)
})

test('a catch-up entry that cannot be decrypted is refused before it is counted', () => {
    const { decodeCatchupPackets } = load('src/protocol/messages.ts')
    const entry = Buffer.alloc(18)
    entry[0] = 0
    entry[1] = 1
    const message = Buffer.concat([Buffer.from([0x0a, 0x12]), entry])
    assert.throws(() => decodeCatchupPackets(message), /unencrypted/)
    const reader = new BackedReader(new ETCrypto(passkey, 1))
    assert.throws(() => reader.revive(new ByteReader(createSocket()), [entry]), /unencrypted/)
    assert.equal(reader.sequenceNumber, 0)
})
