'use strict'

// A stand-in etserver that speaks the real wire protocol over real TCP.
//
// It keeps the same two invariants the C++ server does, and records a failure
// wherever the real one would abort:
//
//   - every client packet is decrypted exactly once, in order, with a counter
//     nonce (CryptoHandler::decrypt calls STFATAL on a MAC failure);
//   - the first encrypted packet of a session must be INITIAL_PAYLOAD
//     (TerminalServer::handleConnection calls STFATAL otherwise).
//
// Both STFATALs take the whole etserver process down, along with every other
// user's session, so a test that sees `failures` populated has found a client
// bug that crashes servers.

const net = require('node:net')
const { EventEmitter } = require('node:events')

function createFakeEtServer (load) {
    const { ETCrypto } = load('src/protocol/crypto.ts')
    const { ByteReader } = load('src/protocol/byteReader.ts')
    const { ProtoWriter, decodeFields, getString, getInt32 } = load('src/protocol/protobuf.ts')
    const messages = load('src/protocol/messages.ts')
    const {
        ETPacketType, ETConnectStatus, CLIENT_SERVER_NONCE_MSB, SERVER_CLIENT_NONCE_MSB,
    } = load('src/protocol/constants.ts')

    return class FakeEtServer extends EventEmitter {
        constructor ({ id, passkey, strictSession = true }) {
            super()
            this.id = id
            this.passkey = passkey
            this.strictSession = strictSession
            this.session = null
            /** Decrypted client packets, in arrival order. */
            this.received = []
            /** Everything that would have aborted a real etserver. */
            this.failures = []
            /** Completed ConnectRequests. A bare TCP probe does not count. */
            this.handshakes = 0
            /** Async pause points: beforeConnectResponse, beforeServerCatchup. */
            this.hooks = {}
            this.sockets = new Set()
            this.server = net.createServer(socket => {
                this.sockets.add(socket)
                socket.on('close', () => this.sockets.delete(socket))
                socket.on('error', () => {})
                this.accept(socket).catch(() => socket.destroy())
            })
        }

        async listen () {
            await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve))
            this.port = this.server.address().port
            return this.port
        }

        async close () {
            for (const socket of this.sockets) {
                socket.destroy()
            }
            await new Promise(resolve => this.server.close(resolve))
        }

        /** Number of client sockets that are currently connected. */
        get connections () {
            return this.sockets.size
        }

        writeProto (socket, message) {
            const header = Buffer.alloc(8)
            header.writeBigInt64LE(BigInt(message.length), 0)
            socket.write(Buffer.concat([header, message]))
        }

        async readProto (reader) {
            const length = Number((await reader.read(8)).readBigInt64LE(0))
            return length ? reader.read(length) : Buffer.alloc(0)
        }

        async accept (socket) {
            const reader = new ByteReader(socket)
            let request = null
            try {
                request = decodeFields(await this.readProto(reader))
            } catch {
                return // a TCP probe that connected and left
            }
            this.handshakes++
            this.emit('connectRequest')
            await this.hooks.beforeConnectResponse?.()

            const respond = status => this.writeProto(socket, new ProtoWriter().int32(1, status).finish())
            if (getString(request, 1) !== this.id) {
                respond(ETConnectStatus.INVALID_KEY)
                socket.end()
                return
            }
            if (getInt32(request, 2) === undefined) {
                this.failures.push('ConnectRequest carried no protocol version')
            }

            if (!this.session) {
                this.session = {
                    decrypt: new ETCrypto(this.passkey, CLIENT_SERVER_NONCE_MSB),
                    encrypt: new ETCrypto(this.passkey, SERVER_CLIENT_NONCE_MSB),
                    readSequence: 0,
                    /** Serialized packets we have sent, oldest first. */
                    sent: [],
                    socket: null,
                }
                respond(ETConnectStatus.NEW_CLIENT)
            } else {
                this.session.socket?.destroy()
                this.session.socket = null
                respond(ETConnectStatus.RETURNING_CLIENT)
                await this.recover(socket, reader)
            }
            this.session.socket = socket
            this.emit('attached')
            await this.readLoop(socket, reader)
        }

        /** Connection::recover, from the server's side of the exchange. */
        async recover (socket, reader) {
            const session = this.session
            this.writeProto(socket, messages.encodeSequenceHeader(session.readSequence))
            const clientHas = messages.decodeSequenceHeader(await this.readProto(reader))
            const clientCatchup = messages.decodeCatchupBuffer(await this.readProto(reader))
            // The client has now sent its catch-up and is waiting for ours.
            await this.hooks.beforeServerCatchup?.()
            this.writeProto(socket, messages.encodeCatchupBuffer(session.sent.slice(clientHas)))
            for (const serialized of clientCatchup) {
                this.consume(serialized)
            }
        }

        async readLoop (socket, reader) {
            for (;;) {
                let serialized = null
                try {
                    const length = (await reader.read(4)).readInt32BE(0)
                    serialized = await reader.read(length)
                } catch {
                    return // the socket went away
                }
                try {
                    this.consume(serialized)
                } catch {
                    socket.destroy()
                    return
                }
            }
        }

        consume (serialized) {
            const session = this.session
            session.readSequence++
            const header = serialized[1]
            let payload = null
            try {
                payload = session.decrypt.decrypt(serialized.subarray(2))
            } catch (err) {
                this.fail(`client packet ${session.readSequence} failed its MAC check`)
                throw err
            }
            if (this.strictSession && session.readSequence === 1 && header !== ETPacketType.INITIAL_PAYLOAD) {
                this.fail(`the first client packet had header ${header}, not INITIAL_PAYLOAD`)
                throw new Error('Invalid header')
            }
            this.received.push({ header, payload })
            this.emit('packet', { header, payload })
            if (header === ETPacketType.INITIAL_PAYLOAD) {
                this.send(ETPacketType.INITIAL_RESPONSE, this.hooks.initialResponse?.() ?? Buffer.alloc(0))
            } else if (header === ETPacketType.KEEP_ALIVE) {
                this.send(ETPacketType.KEEP_ALIVE, Buffer.alloc(0))
            }
        }

        fail (reason) {
            this.failures.push(reason)
            this.emit('failure', reason)
        }

        /** Send one encrypted packet, or just queue it while no client is attached. */
        send (header, payload) {
            const session = this.session
            const encrypted = session.encrypt.encrypt(payload)
            const serialized = Buffer.concat([Buffer.from([1, header]), encrypted])
            session.sent.push(serialized)
            if (session.socket && !session.socket.destroyed) {
                const length = Buffer.alloc(4)
                length.writeInt32BE(serialized.length, 0)
                session.socket.write(Buffer.concat([length, serialized]))
            }
        }

        /** Sever the TCP connection, as a network failure would. */
        dropConnection () {
            this.session?.socket?.destroy()
            if (this.session) {
                this.session.socket = null
            }
        }

        /** Payloads of the packets received with `header`, as strings. */
        payloads (header) {
            return this.received.filter(x => x.header === header).map(x => x.payload.toString())
        }
    }
}

module.exports = { createFakeEtServer }
