'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('node:stream')

const { createLoader } = require('./support/load.cjs')
const load = createLoader()
const { ByteReader } = load('src/protocol/byteReader.ts')
const { ETClientConnection } = load('src/protocol/connection.ts')
const { BackedReader } = load('src/protocol/backedReader.ts')
const { ETCrypto } = load('src/protocol/crypto.ts')
const { encodeSequenceHeader } = load('src/protocol/messages.ts')
const { UnrecoverableSessionError } = load('src/protocol/errors.ts')
const {
    MAX_CATCHUP_PROTO_LENGTH, MAX_ENCRYPTED_PACKET_LENGTH, SERVER_CLIENT_NONCE_MSB,
} = load('src/protocol/constants.ts')
const passkey = '0123456789ABCDEF0123456789ABCDEF'

function protoFrame (message) {
    const header = Buffer.alloc(8)
    header.writeBigInt64LE(BigInt(message.length), 0)
    return Buffer.concat([header, message])
}

test('recovery rejects an oversized unauthenticated catch-up from its length header', async () => {
    const socket = new PassThrough()
    const reader = new ByteReader(socket)
    let revived = false
    const connection = Object.create(ETClientConnection.prototype)
    connection.reader = {
        sequenceNumber: 0,
        revive () { revived = true },
    }
    connection.writer = {
        recover: () => [],
        attach () {},
    }
    connection.logger = { info () {} }
    connection.writeProto = async () => {}
    connection.writeProtoToTheEnd = async () => {}
    connection.throwIfShutDown = () => {}

    const oversizedLength = MAX_CATCHUP_PROTO_LENGTH + 1
    const catchupHeader = Buffer.alloc(8)
    catchupHeader.writeBigInt64LE(BigInt(oversizedLength), 0)
    // The server sends a valid sequence header and then claims a catch-up body
    // larger than the client's safe unauthenticated budget. It never sends the
    // body: rejection must happen from the length header alone.
    socket.write(Buffer.concat([
        protoFrame(encodeSequenceHeader(0)),
        catchupHeader,
    ]))

    let deadline
    try {
        const recovery = connection.recover(socket, reader)
        const timedOut = new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('recovery waited for the oversized catch-up body')), 500)
        })
        await assert.rejects(
            Promise.race([recovery, timedOut]),
            UnrecoverableSessionError,
        )
        assert.equal(revived, false, 'oversized unauthenticated catch-up was revived')
        assert.equal(reader.buffered, 0, 'reader consumed bytes beyond the catch-up length header')
    } finally {
        clearTimeout(deadline)
        reader.dispose()
        socket.destroy()
    }
})

test('the encrypted packet reader rejects an oversized frame before waiting for its body', async () => {
    const socket = new PassThrough()
    const byteReader = new ByteReader(socket)
    const reader = new BackedReader(new ETCrypto(passkey, SERVER_CLIENT_NONCE_MSB))
    reader.attach(byteReader)

    const frameHeader = Buffer.alloc(4)
    frameHeader.writeInt32BE(MAX_ENCRYPTED_PACKET_LENGTH + 1, 0)
    socket.write(frameHeader)

    try {
        await assert.rejects(reader.read(), /Invalid ET packet length/)
        assert.equal(byteReader.buffered, 0, 'reader consumed bytes beyond the oversized frame header')
    } finally {
        byteReader.dispose()
        socket.destroy()
    }
})
