import * as tabbySSH from 'tabby-ssh'

/**
 * Finds out whether the Tabby running the plugin has what the plugin needs
 * from it.
 *
 * The plugin starts etterminal over Tabby's own SSH connection. Released
 * Tabby keeps the pieces needed for that inside its SSH plugin: it does not
 * export `SSHSession` or `KeyboardInteractivePrompt`, has no way to run one
 * command without a shell, and keeps its keyboard-interactive panel to
 * itself. Tabby PR #11649 adds all four. A Tabby without them still loads the
 * plugin, because nothing is looked up until a connection starts, and the
 * first connection then fails with "SSHSession is not a constructor". This
 * check runs first, so the plugin can say what is wrong and how to fix it.
 */

/** The step-by-step guide that the notices point to. */
export const TABBY_SUPPORT_GUIDE_URL = 'https://github.com/qoke/tabby-et/blob/main/docs/tabby-support.md'

/** The Tabby pull request that adds what the plugin needs. */
export const TABBY_SUPPORT_PR_URL = 'https://github.com/Eugeny/tabby/pull/11649'

/** The Tabby branch that has the change on top of a Tabby release. */
export const TABBY_SUPPORT_BRANCH_URL = 'https://github.com/qoke/tabby/tree/tabby-et-ssh-support'

/** The selector of the keyboard-interactive panel that tabby-ssh has to export. */
const KEYBOARD_INTERACTIVE_PANEL = 'keyboard-interactive-auth-panel'

export interface TabbySupport {
    /** Tabby has everything the plugin needs from it. */
    supported: boolean
    /** What it lacks, one line each, for the log and for bug reports. */
    missing: string[]
}

/**
 * What an Angular module says it exports, or null where the build of Tabby
 * does not keep that at run time. Tabby compiles its plugins in JIT mode,
 * which keeps it, but a missing panel is not worth a false alarm.
 */
function exportedSelectors (module: unknown): string[]|null {
    try {
        const exports: unknown = (module as any)?.ɵmod?.exports
        const list = typeof exports === 'function' ? (exports as () => unknown)() : exports
        if (!Array.isArray(list)) {
            return null
        }
        const selectors: string[] = []
        for (const type of list) {
            for (const selector of (type?.ɵcmp?.selectors ?? []) as unknown[][]) {
                selectors.push(...selector.filter((x): x is string => typeof x === 'string' && x !== ''))
            }
        }
        return selectors
    } catch {
        return null
    }
}

/** Checks a tabby-ssh module. Exported for the tests; the plugin uses tabbySupport(). */
export function checkTabbySupport (ssh: Record<string, unknown>): TabbySupport {
    const missing: string[] = []
    const session: unknown = ssh.SSHSession
    if (typeof session !== 'function') {
        missing.push('tabby-ssh does not export SSHSession')
    } else if (typeof (session.prototype as Record<string, unknown>|undefined)?.openExecChannel !== 'function') {
        missing.push('SSHSession has no openExecChannel() method')
    }
    if (typeof ssh.KeyboardInteractivePrompt !== 'function') {
        missing.push('tabby-ssh does not export KeyboardInteractivePrompt')
    }
    const selectors = exportedSelectors(ssh.default)
    if (selectors && !selectors.includes(KEYBOARD_INTERACTIVE_PANEL)) {
        missing.push(`tabby-ssh does not export its <${KEYBOARD_INTERACTIVE_PANEL}> component`)
    }
    return { supported: !missing.length, missing }
}

let cached: TabbySupport|null = null

/** Whether the running Tabby supports the plugin. Tabby's plugins do not change while it runs. */
export function tabbySupport (): TabbySupport {
    cached ??= checkTabbySupport(tabbySSH as unknown as Record<string, unknown>)
    return cached
}

/**
 * What a tab says when it cannot connect, as terminal text. Plain lines, so
 * it can be read and copied from the tab itself.
 */
export function unsupportedTabbyTerminalText (support: TabbySupport): string {
    return [
        'This Tabby cannot open Eternal Terminal connections yet.',
        '',
        'The Eternal Terminal plugin needs a small addition to Tabby\'s SSH plugin.',
        'The addition is in a Tabby pull request that has not been released, so',
        'Tabby from tabby.sh or an app store does not have it. Until it is released,',
        'run a Tabby built from source with the change.',
        '',
        'What this Tabby is missing:',
        ...support.missing.map(x => `  - ${x}`),
        '',
        `Step-by-step guide: ${TABBY_SUPPORT_GUIDE_URL}`,
        `The Tabby pull request: ${TABBY_SUPPORT_PR_URL}`,
        '',
        'Nothing was sent to the server.',
    ].join('\r\n') + '\r\n'
}
