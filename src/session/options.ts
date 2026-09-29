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
        if (!name || raw === null || raw === undefined || typeof raw === 'object') {
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
    return value.filter(x => typeof x === 'object' && x !== null)
}
