import { randomBytes } from 'crypto'
import nacl from 'tweetnacl'

import { UnrecoverableSessionError } from './errors'

export const KEY_BYTES = 32
export const NONCE_BYTES = 24
export const MAC_BYTES = 16

/** Move a nonce on by one. It is a little-endian counter, and its last byte is not part of it. */
function advance (nonce: Uint8Array): void {
    for (let i = 0; i < NONCE_BYTES; i++) {
        nonce[i] = nonce[i] + 1 & 0xff
        if (nonce[i]) {
            break
        }
    }
}

/**
 * ET's CryptoHandler: XSalsa20-Poly1305 (libsodium crypto_secretbox_easy),
 * key = the 32-character passkey used directly as raw bytes, no KDF.
 *
 * The nonce is a 24-byte little-endian counter whose LAST byte distinguishes the
 * two directions. It is incremented BEFORE every operation, so the first packet
 * uses counter value 1. That means the nonce is exactly the per-direction packet
 * index: packets must be encrypted/decrypted exactly once, in order.
 */
export class ETCrypto {
    private readonly key: Uint8Array
    private readonly nonce: Uint8Array
    /** Where the nonce after this one is worked out, before it is known to be used. */
    private readonly following: Uint8Array

    constructor (passkey: string, nonceMSB: number) {
        if (passkey.length !== KEY_BYTES) {
            throw new Error(`ET passkey must be ${KEY_BYTES} characters, got ${passkey.length}`)
        }
        this.key = Uint8Array.from(Buffer.from(passkey, 'ascii'))
        this.nonce = new Uint8Array(NONCE_BYTES)
        this.nonce[NONCE_BYTES - 1] = nonceMSB
        this.following = new Uint8Array(NONCE_BYTES)
    }

    private increment (): void {
        advance(this.nonce)
    }

    /**
     * The nonce moves on when there is a packet under it, and not before.
     *
     * Making the packet takes memory, and there may be none: a renderer that
     * has run out of it fails every allocation, this one among them. A nonce
     * that had moved on by then would be one that no packet was sent under,
     * and the server would be asked to take the next packet for it. It
     * cannot, and no later packet either.
     */
    encrypt (plaintext: Buffer): Buffer {
        this.following.set(this.nonce)
        advance(this.following)
        const sealed = Buffer.from(nacl.secretbox(Uint8Array.from(plaintext), this.following, this.key))
        this.nonce.set(this.following)
        return sealed
    }

    decrypt (ciphertext: Buffer): Buffer {
        this.increment()
        const out = nacl.secretbox.open(Uint8Array.from(ciphertext), this.nonce, this.key)
        if (!out) {
            // Deliberately fatal, not a reconnect. Recovery cannot help: this
            // packet's sequence number is already counted, so the server will
            // never replay it. Worse, if the counters really have desynchronised
            // then every later packet fails too, and because a successful
            // reconnect resets the attempt counter the session would churn
            // forever. A failed authentication check is also exactly the signal
            // we must not paper over - see ETERNAL_TERMINAL.md §17.1.
            throw new UnrecoverableSessionError(
                'a packet failed its authentication check (wrong passkey, desynchronised nonce, or tampering)',
            )
        }
        return Buffer.from(out)
    }
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Uniform random alphanumerics, rejection-sampled to avoid modulo bias. */
export function randomAlphaNum (length: number): string {
    const out: string[] = []
    while (out.length < length) {
        for (const b of randomBytes(length * 2)) {
            if (out.length === length) {
                break
            }
            if (b < 248) { // 248 = 4 * 62
                out.push(ALPHABET[b % 62])
            }
        }
    }
    return out.join('')
}

/**
 * The bootstrap id. ET forces the first three characters to 'XXX', which tells a
 * modern etterminal to discard our credentials and generate its own. We never use
 * the passkey we generate here - only the one the server echoes back.
 */
export function generateBootstrapId (): string {
    return 'XXX' + randomAlphaNum(13)
}

export function generateBootstrapPasskey (): string {
    return randomAlphaNum(32)
}
