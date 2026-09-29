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
//   - a returning client may not claim more packets than it was sent
//     (BackedWriter::recover calls STFATAL: "client is ahead of server").
//
// It also refuses what the real one refuses without aborting: a handshake
// message of more than 128 MiB (SocketHandler::readProto throws, and the
// connection is closed). Those are counted in `rejections`.
//
// Every STFATAL takes the whole etserver process down, along with every other
// user's session, so a test that sees `failures` populated has found a client
// bug that crashes servers.
//
// A resume follows Connection::recover step for step, because the order is
// what a client has to cope with: the server sends its catch-up BEFORE it
// reads the client's, takes the client's whole or not at all, and answers
// nothing - not even what arrived in that catch-up - until it has it.

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
    /** SocketHandler::readProto: "Invalid size (<0 or >128 MB)". */
    const MAX_MESSAGE_BYTES = 128 * 1024 * 1024

    return class FakeEtServer extends EventEmitter {
        constructor ({ id, passkey, strictSession = true, acceptAnyId = false }) {
            super()
            this.id = id
            this.passkey = passkey
            this.strictSession = strictSession
            /** Register whatever id turns up, as etterminal would have done. */
            this.acceptAnyId = acceptAnyId
            /** By client id. `session` is the one that was created last. */
            this.sessions = new Map()
            this.session = null
            /** Decrypted client packets, in arrival order. */
            this.received = []
            /** Everything that would have aborted a real etserver. */
            this.failures = []
            /** Connections a real etserver would have closed on the client. */
            this.rejections = []
            /** Completed ConnectRequests. A bare TCP probe does not count. */
            this.handshakes = 0
            /**
             * Async pause points: beforeConnectResponse, beforeServerCatchup
             * (the client's sequence number has been read, nothing has been
             * sent in answer). serverCatchup replaces what is sent.
             */
            this.hooks = {}
            /** Catch-ups from clients that were taken whole: their sizes in bytes. */
            this.catchups = []
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
            if (length < 0 || length > MAX_MESSAGE_BYTES) {
                this.rejections.push(`a handshake message of ${length} bytes`)
                throw new Error('Invalid size')
            }
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
            const clientId = getString(request, 1)
            if (!this.acceptAnyId && clientId !== this.id) {
                respond(ETConnectStatus.INVALID_KEY)
                socket.end()
                return
            }
            if (getInt32(request, 2) === undefined) {
                this.failures.push('ConnectRequest carried no protocol version')
            }

            let session = this.sessions.get(clientId)
            let recovered = []
            if (!session) {
                session = {
                    id: clientId,
                    decrypt: new ETCrypto(this.passkey, CLIENT_SERVER_NONCE_MSB),
                    encrypt: new ETCrypto(this.passkey, SERVER_CLIENT_NONCE_MSB),
                    readSequence: 0,
                    /** Decrypted client packets of this session, in arrival order. */
                    received: [],
                    /** Serialized packets we have sent, oldest first. */
                    sent: [],
                    socket: null,
                }
                this.sessions.set(clientId, session)
                this.session = session
                respond(ETConnectStatus.NEW_CLIENT)
            } else {
                session.socket?.destroy()
                session.socket = null
                respond(ETConnectStatus.RETURNING_CLIENT)
                recovered = await this.recover(session, socket, reader)
                // A client that gave up meanwhile, and came back on another
                // connection, has been answered there.
                if (socket.destroyed) {
                    return
                }
            }
            session.socket?.destroy()
            session.socket = socket
            socket.on('close', () => {
                if (session.socket === socket) {
                    session.socket = null
                }
            })
            this.emit('attached', session)
            // reader->revive(): what came in the catch-up is read like any
            // other packet, now that there is a socket to answer on.
            try {
                for (const serialized of recovered) {
                    this.consume(session, serialized)
                }
            } catch {
                socket.destroy()
                return
            }
            await this.readLoop(session, socket, reader)
        }

        /** Sessions a client is connected to at this moment. */
        get attached () {
            return [...this.sessions.values()].filter(x => x.socket && !x.socket.destroyed)
        }

        /**
         * Connection::recover, from the server's side of the exchange. Returns
         * the packets of the client's catch-up, which are not read until the
         * exchange is over.
         */
        async recover (session, socket, reader) {
            this.writeProto(socket, messages.encodeSequenceHeader(session.readSequence))
            const clientHas = messages.decodeSequenceHeader(await this.readProto(reader))
            if (clientHas > session.sent.length) {
                this.fail(`the client claims ${clientHas} packets, and was sent ${session.sent.length}`)
                throw new Error('Client is ahead of server')
            }
            await this.hooks.beforeServerCatchup?.()
            // Ours goes out first, and only then is theirs read.
            this.writeProto(socket, this.hooks.serverCatchup?.() ?? messages.encodeCatchupBuffer(session.sent.slice(clientHas)))
            const message = await this.readProto(reader)
            this.catchups.push(message.length)
            return messages.decodeCatchupBuffer(message)
        }

        async readLoop (session, socket, reader) {
            for (;;) {
                let serialized = null
                try {
                    const length = (await reader.read(4)).readInt32BE(0)
                    serialized = await reader.read(length)
                } catch {
                    return // the socket went away
                }
                try {
                    this.consume(session, serialized)
                } catch {
                    socket.destroy()
                    return
                }
            }
        }

        consume (session, serialized) {
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
            session.received.push({ header, payload })
            this.emit('packet', { header, payload, session })
            if (header === ETPacketType.INITIAL_PAYLOAD) {
                this.send(ETPacketType.INITIAL_RESPONSE, this.hooks.initialResponse?.() ?? Buffer.alloc(0), session)
            } else if (header === ETPacketType.KEEP_ALIVE) {
                this.send(ETPacketType.KEEP_ALIVE, Buffer.alloc(0), session)
            }
        }

        fail (reason) {
            this.failures.push(reason)
            this.emit('failure', reason)
        }

        /** Send one encrypted packet, or just queue it while no client is attached. */
        send (header, payload, session = this.session) {
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
        dropConnection (session = this.session) {
            session?.socket?.destroy()
            if (session) {
                session.socket = null
            }
        }

        /** Payloads of the packets received with `header`, as strings. */
        payloads (header) {
            return this.received.filter(x => x.header === header).map(x => x.payload.toString())
        }
    }
}

module.exports = { createFakeEtServer }
