/**
 * Reading profile options defensively.
 *
 * A profile is whatever the settings form and the config file left behind, not
 * what ETProfileOptions promises: clearing a number input stores `null`,
 * clearing a text input stores `''`, and a hand-edited config file can hold
 * anything at all. Every option that ends up in a socket call or on a remote
 * command line is read through here first.
 *
 * Deliberately free of runtime dependencies, like redact.ts, so it is trivially
 * testable.
 */

import type { ForwardedPortConfig } from 'tabby-ssh'

/** Was this option left empty? */
function isBlank (value: unknown): boolean {
    return value === null || value === undefined || typeof value === 'string' && value.trim() === ''
}

/** Trimmed text, or null when the option was left empty. */
export function resolveText (value: unknown): string|null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * A switch. On for `true`, and for text that says so: true, yes, on.
 *
 * The settings form stores true or false. A file that was written by hand
 * holds what was typed, and YAML as Tabby reads it takes only true and false
 * for switches: `no` and `off` are text, and text is not nothing. What these
 * switches turn on - an agent forwarded to the remote host, other sessions
 * terminated - is not to be turned on by a word that means off.
 */
export function resolveFlag (value: unknown): boolean {
    if (typeof value === 'string') {
        return ['true', 'yes', 'on'].includes(value.trim().toLowerCase())
    }
    return value === true
}

/**
 * The user to log in as: '' to be asked, undefined to leave it to SSH.
 *
 * YAML reads `user: 1234` as a number and `user:` as nothing at all. Neither
 * is text, and with no text to go by tabby-ssh logs in as root.
 */
export function resolveUser (value: unknown): string|undefined {
    if (value === undefined) {
        return undefined
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value)
    }
    return typeof value === 'string' ? value.trim() : ''
}

/** Text, or what YAML made of text that looked like something else to it. */
function asText (value: unknown): string|null {
    if (typeof value === 'string') {
        return value
    }
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : null
}

/** A login script as Tabby's script processor takes it. */
export interface ResolvedScript {
    expect: string
    send: string
    isRegex: boolean
    optional: boolean
}

/**
 * Login scripts. Tabby's script processor takes it for granted that they are
 * a list, and that what is to be waited for and what is to be sent are text:
 * anything else, and the session cannot even be created. A script that says
 * nothing to send is left out. One that waits for nothing is sent at once,
 * which is what no text to wait for means to Tabby too.
 */
export function resolveScripts (value: unknown): ResolvedScript[] {
    if (!Array.isArray(value)) {
        return []
    }
    const scripts: ResolvedScript[] = []
    for (const script of value) {
        if (typeof script !== 'object' || script === null || Array.isArray(script)) {
            continue
        }
        const send = asText(script.send)
        if (send === null) {
            continue
        }
        scripts.push({
            expect: asText(script.expect) ?? '',
            send,
            isRegex: resolveFlag(script.isRegex),
            optional: resolveFlag(script.optional),
        })
    }
    return scripts
}

/**
 * A TCP port. An empty field means the default, which is what its placeholder
 * shows. Anything else has to be a real port: falling back silently would
 * connect somewhere the user did not ask for.
 */
export function resolvePort (value: unknown, fallback: number, name: string): number {
    if (isBlank(value)) {
        return fallback
    }
    const port = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid ${name} "${String(value)}". Ports must be between 1 and 65535.`)
    }
    return port
}

/** etterminal's --verbose level, 0-9. Anything unusable means "not verbose". */
export function resolveVerbosity (value: unknown): number {
    const level = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
    if (typeof level !== 'number' || !Number.isFinite(level)) {
        return 0
    }
    return Math.min(Math.max(Math.trunc(level), 0), 9)
}

/**
 * Environment variables for InitialPayload, which can only carry strings.
 *
 * There is no settings UI for these, so they are always hand-written YAML, where
 * `DEBUG: 1` is a number and `VERBOSE: true` a boolean. A variable with no value
 * at all is left out rather than sent as the string "null".
 */
export function resolveEnvironment (value: unknown): Record<string, string> {
    // No prototype, so that a variable may be called anything, __proto__ included.
    const out: Record<string, string> = Object.create(null)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return out
    }
    for (const [name, raw] of Object.entries(value)) {
        // What is not a value is not a variable. Neither is the marker that
        // tells Tabby to leave a map alone, nor what Tabby hangs on a map that
        // it did not leave alone, which are functions.
        if (!name || name === '__nonStructural' || raw === null || raw === undefined
            || typeof raw === 'object' || typeof raw === 'function' || typeof raw === 'symbol') {
            continue
        }
        out[name] = String(raw)
    }
    return out
}

/**
 * The profile's forwards. Anything other than a list means that there are
 * none, and an entry that is not an object is not a forward. What each forward
 * says is checked where it is used.
 */
export function resolveForwards (value: unknown): ForwardedPortConfig[] {
    if (!Array.isArray(value)) {
        return []
    }
    return value.filter(x => typeof x === 'object' && x !== null && !Array.isArray(x))
}
