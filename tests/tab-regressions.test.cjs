'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { waitFor } = require('./support/load.cjs')
const { createSessionFixture } = require('./support/sessionFixture.cjs')

const { load, ssh, createInjector, createProfile, startServer } = createSessionFixture()
const { ETTabComponent } = load('src/components/etTab.component.ts')

function createTab (port) {
    const toastr = { warning: () => ({ toastId: 1 }), success () {}, clear () {} }
    const tab = new ETTabComponent(createInjector(), { open () {} }, toastr)
    tab.profile = createProfile(port)
    return tab
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function within (ms, promise, what) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} never settled`)), ms)),
    ])
}

test('closing a tab that is still connecting tears its session down', async () => {
    const server = await startServer()
    let finishBootstrap = null
    ssh.behavior.start = () => new Promise(resolve => { finishBootstrap = resolve })
    const tab = createTab(server.port)
    try {
        const initializing = tab.initializeSession()
        await waitFor(() => ssh.sessions[0]?.started, 'the SSH bootstrap to begin')
        const session = tab.session

        await tab.destroy()
        finishBootstrap()
        await within(1000, initializing, 'initializeSession()')
        await settle(100)

        assert.equal(server.handshakes, 0, 'the session connected after its tab was closed')
        assert.equal(session.open, false)
        assert.equal(ssh.sessions[0].destroyed, true)
        assert.deepEqual(tab.errors, [], 'closing a tab was reported as a connection error')
    } finally {
        finishBootstrap?.()
        await tab.session?.destroy()
        await server.close()
    }
})

test('asking for a new session mid-connect abandons the old attempt quietly', async () => {
    const server = await startServer()
    ssh.behavior.start = () => new Promise(() => {}) // every bootstrap waits on the user
    const tab = createTab(server.port)
    try {
        const first = tab.initializeSession()
        await waitFor(() => ssh.sessions[0]?.started, 'the first bootstrap to begin')

        const second = tab.reconnect()
        second.catch(() => {})
        await within(1000, first, 'the abandoned attempt')
        await waitFor(() => ssh.sessions[1]?.started, 'the second bootstrap to begin')

        assert.equal(ssh.sessions[0].destroyed, true)
        assert.deepEqual(tab.errors, [], 'the abandoned attempt was reported as an error')
        assert.equal(tab.spinnerActive, true, 'the abandoned attempt stopped the new attempt\'s spinner')
    } finally {
        await tab.destroy()
        await server.close()
    }
})

test('a new attempt does not inherit the ended indicator of the last session', async () => {
    const server = await startServer()
    const tab = createTab(server.port)
    try {
        await tab.initializeSession()
        assert.equal(tab.connectionState, 'connected')

        ssh.behavior.start = () => new Promise(() => {})
        const second = tab.reconnect()
        second.catch(() => {})
        await waitFor(() => ssh.sessions[1]?.started, 'the second bootstrap to begin')

        assert.equal(tab.connectionState, 'connecting')
    } finally {
        await tab.destroy()
        await server.close()
    }
})

test('a pending prompt survives a click and leaves with the bootstrap', async () => {
    const server = await startServer()
    const prompt = { name: 'Password', instruction: '', prompts: [{ prompt: 'Password:' }] }
    let finishBootstrap = null
    ssh.behavior.start = session => new Promise(resolve => {
        finishBootstrap = resolve
        session.keyboardInteractivePrompt$.next(prompt)
    })
    const tab = createTab(server.port)
    try {
        const initializing = tab.initializeSession()
        await waitFor(() => tab.activeKIPrompt, 'the prompt to be shown')

        // Angular would call a click handler for any click inside the tab,
        // including the one that gives the terminal focus.
        tab.onClick?.()
        assert.equal(tab.activeKIPrompt, prompt, 'a click hid a prompt that is still waiting for its answer')

        finishBootstrap()
        await within(2000, initializing, 'initializeSession()')
        assert.equal(tab.activeKIPrompt, null, 'the prompt outlived the SSH session that asked')
        assert.equal(tab.session.open, true)
    } finally {
        finishBootstrap?.()
        await tab.destroy()
        await server.close()
    }
})
