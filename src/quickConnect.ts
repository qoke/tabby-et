import { DEFAULT_ET_PORT } from './protocol/constants'

export interface ETQuickConnectTarget {
    host: string
    user?: string
    port: number
}

/** Options of the `et` command that are followed by a value. */
const OPTIONS_WITH_A_VALUE = new Set([
    '-u', '--username', '--host', '-p', '--port', '-c', '--command', '--terminal-path', '-t', '--tunnel',
    '-r', '--reversetunnel', '--jumphost', '--jport', '--jserverfifo', '-v', '--verbose', '-k', '--keepalive',
    '-l', '--logdir', '--ssh-socket', '--telemetry', '--serverfifo', '--ssh-option',
])

/**
 * Parse a port, falling back to the ET default for anything that is not a real
 * TCP port. `parseInt` alone is not enough: it happily yields 0, negatives and
 * values past 65535, which then fail deep inside net.connect instead of here.
 */
function parsePortOrDefault (text: string): number {
    const parsed = /^\d+$/.test(text) ? Number(text) : NaN
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_ET_PORT
}

/**
 * What an `et` command line says of where to connect to: the destination,
 * which is the first word that is neither an option nor the value of one, and
 * the options that say the same things.
 */
function readCommandLine (words: string[]): { destination: string, port?: string, user?: string, host?: string } {
    const said: { destination: string, port?: string, user?: string, host?: string } = { destination: '' }
    for (let i = 0; i < words.length; i++) {
        const word = words[i]
        if (!word.startsWith('-')) {
            said.destination ||= word
            continue
        }
        const [, name, attached] = /^(--?[^=]*)(?:=(.*))?$/.exec(word) ?? []
        if (!OPTIONS_WITH_A_VALUE.has(name)) {
            continue
        }
        const value = attached ?? words[++i] ?? ''
        if (name === '-p' || name === '--port') {
            said.port = value
        } else if (name === '-u' || name === '--username') {
            said.user = value
        } else if (name === '--host') {
            said.host = value
        }
    }
    return said
}

/**
 * Pure parser behind ETProfilesService.quickConnect.
 *
 * Accepts "user@host", "user@host:2022" and "user@[::1]:2022", an address
 * that starts with "et://", and an `et` command line, so that one can be
 * pasted. Never throws and always produces a port in 1-65535: a port that
 * cannot be read, or that is out of range, is the default, and unbalanced
 * brackets degrade to a best-effort host.
 */
export function parseQuickConnectQuery (query: string): ETQuickConnectTarget {
    let raw = query.trim()
    let said: { port?: string, user?: string, host?: string } = {}
    if (/^et:\/\//i.test(raw)) {
        // An address: what follows the host, from the first '/', is not ours.
        raw = raw.replace(/^et:\/\//i, '').replace(/\/.*$/, '')
    } else if (/^et\s/i.test(raw)) {
        const line = readCommandLine(raw.split(/\s+/).slice(1))
        raw = line.destination
        said = line
    }
    let user: string|undefined = undefined
    let port = DEFAULT_ET_PORT

    if (raw.includes('@')) {
        const parts = raw.split(/@/g)
        raw = parts[parts.length - 1]
        user = parts.slice(0, parts.length - 1).join('@')
    }
    if (raw.includes('[')) {
        // Bracketed IPv6, optionally ":port" after the ']'. The ']' may be
        // missing in malformed input - treat the whole remainder as the host
        // instead of crashing on undefined. What follows the ']' is a port
        // only behind a ':'.
        const after = raw.split(']')
        const rest = after.length > 1 ? after[1] : ''
        port = parsePortOrDefault(rest.startsWith(':') ? rest.substring(1) : '')
        raw = after[0].substring(1)
    } else if ((raw.match(/:/g) ?? []).length === 1) {
        // Exactly one ':' means host:port. Bare IPv6 hosts (::1) contain
        // multiple colons and never carry a port in this shorthand.
        port = parsePortOrDefault(raw.split(':')[1])
        raw = raw.split(':')[0]
    }

    if (said.port !== undefined) {
        port = parsePortOrDefault(said.port)
    }
    return { host: said.host || raw, user: said.user || user, port }
}
