/**
 * Strip ET session credentials from any user-visible or logged text.
 *
 * Handles both the `IDPASSKEY:<id>/<passkey>` marker the remote prints and the bare
 * `<id>/<passkey>` pair used by the ET protocol (16 alphanumerics /
 * 32 alphanumerics). Both forms carry the session passkey and must never reach a log.
 *
 * Deliberately dependency-free so it is trivially testable and importable from
 * anywhere, including the fuzz harness.
 */
export interface ETCredentialPair {
    id: string
    passkey: string
}

export function redactCredentials (text: string, credentials?: ETCredentialPair): string {
    let redacted = text
        .replace(/IDPASSKEY:\S+/g, 'IDPASSKEY:[redacted]')
        .replace(/[A-Za-z0-9]{16}\/[A-Za-z0-9]{32}/g, '[redacted]/[redacted]')
    // A server can reflect either value on its own, not just as IDPASSKEY or a pair.
    if (credentials?.passkey) {
        redacted = redacted.split(credentials.passkey).join('[redacted]')
    }
    if (credentials?.id) {
        redacted = redacted.split(credentials.id).join('[redacted]')
    }
    return redacted
}

/** Make untrusted text one safe log line, including all control characters. */
export function sanitizeLogText (text: string, credentials?: ETCredentialPair): string {
    return JSON.stringify(redactCredentials(text, credentials))
}
