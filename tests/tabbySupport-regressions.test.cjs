'use strict'

// A Tabby without the SSH API changes of Tabby PR #11649 loads the plugin and
// used to fail on the first connection with "SSHSession is not a constructor".
// The plugin now finds that out first, says what is missing, and points to
// the setup guide, without starting any connection.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createLoader } = require('./support/load.cjs')

const root = path.resolve(__dirname, '..')

/** What a tabby-ssh with the changes looks like at run time. */
function patchedSSH (overrides = {}) {
    class SSHSession {
        async openExecChannel () {}
    }
    class KeyboardInteractiveAuthComponent {}
    KeyboardInteractiveAuthComponent.ɵcmp = { selectors: [['keyboard-interactive-auth-panel']] }
    class SSHModule {}
    SSHModule.ɵmod = { exports: [KeyboardInteractiveAuthComponent] }
    // Tabby's plugins are ES modules compiled to CommonJS, so the module is
    // the default export, not the whole of what tabby-ssh exports.
    return {
        __esModule: true,
        PortForwardType: { Local: 'Local', Remote: 'Remote', Dynamic: 'Dynamic' },
        SSHSession,
        KeyboardInteractivePrompt: class KeyboardInteractivePrompt {},
        default: SSHModule,
        ...overrides,
    }
}

/** What a released tabby-ssh looks like: none of the four. */
function stockSSH () {
    class SSHModule {}
    SSHModule.ɵmod = { exports: [] }
    return { __esModule: true, PortForwardType: { Local: 'Local', Remote: 'Remote', Dynamic: 'Dynamic' }, default: SSHModule }
}

function support (ssh) {
    return createLoader({ 'tabby-ssh': ssh })('src/tabbySupport.ts')
}

test('a Tabby with the SSH changes is supported', () => {
    const { checkTabbySupport, tabbySupport } = support(patchedSSH())
    assert.deepEqual(checkTabbySupport(patchedSSH()), { supported: true, missing: [] })
    assert.equal(tabbySupport().supported, true)
})

test('a released Tabby is not, and every missing piece is named', () => {
    const { tabbySupport } = support(stockSSH())
    const result = tabbySupport()
    assert.equal(result.supported, false)
    assert.deepEqual(result.missing, [
        'tabby-ssh does not export SSHSession',
        'tabby-ssh does not export KeyboardInteractivePrompt',
        'tabby-ssh does not export its <keyboard-interactive-auth-panel> component',
    ])
})

test('an SSHSession without openExecChannel() is not enough', () => {
    const { checkTabbySupport } = support(patchedSSH())
    const result = checkTabbySupport(patchedSSH({ SSHSession: class SSHSession {} }))
    assert.deepEqual(result, { supported: false, missing: ['SSHSession has no openExecChannel() method'] })
})

test('module exports that cannot be read at run time are no reason to complain', () => {
    const { checkTabbySupport } = support(patchedSSH())
    class SSHModule {}
    assert.equal(checkTabbySupport(patchedSSH({ default: SSHModule })).supported, true)
    class Throwing {}
    Object.defineProperty(Throwing, 'ɵmod', { get () { throw new Error('not compiled') } })
    assert.equal(checkTabbySupport(patchedSSH({ default: Throwing })).supported, true)
    // Angular can also hand the exports over as a function.
    const Lazy = class {}
    Lazy.ɵmod = { exports: () => patchedSSH().default.ɵmod.exports }
    assert.equal(checkTabbySupport(patchedSSH({ default: Lazy })).supported, true)
})

test('the terminal text lists what is missing and links the guide', () => {
    const { tabbySupport, unsupportedTabbyTerminalText, TABBY_SUPPORT_GUIDE_URL } = support(stockSSH())
    const text = unsupportedTabbyTerminalText(tabbySupport())
    assert.match(text, /tabby-ssh does not export SSHSession/)
    assert.ok(text.includes(TABBY_SUPPORT_GUIDE_URL))
    assert.ok(text.includes('https://github.com/Eugeny/tabby/pull/11649'))
    // A terminal needs both, or each line starts where the last one ended.
    assert.ok(!/[^\r]\n/.test(text))
})

test('the guide that the plugin links to is in the repository', () => {
    const { TABBY_SUPPORT_GUIDE_URL } = support(stockSSH())
    const prefix = 'https://github.com/qoke/tabby-et/blob/main/'
    assert.ok(TABBY_SUPPORT_GUIDE_URL.startsWith(prefix))
    assert.ok(fs.existsSync(path.join(root, TABBY_SUPPORT_GUIDE_URL.slice(prefix.length))))
})

test('a tab on a released Tabby says what is wrong and connects to nothing', async () => {
    const load = createLoader({ 'tabby-ssh': stockSSH() })
    const { ETTabComponent } = load('src/components/etTab.component.ts')
    const tab = new ETTabComponent({ get () { throw new Error('nothing may be looked up') } }, { open () {} }, {})
    tab.profile = { type: 'et', name: 'test', options: { host: 'example.invalid' } }
    const written = []
    tab.write = async data => { written.push(data) }

    await tab.initializeSession()

    assert.equal(tab.session, null)
    assert.equal(tab.errors.length, 1)
    assert.match(tab.errors[0][0], /cannot open Eternal Terminal connections/)
    assert.match(written.join(''), /docs\/tabby-support\.md/)
})
