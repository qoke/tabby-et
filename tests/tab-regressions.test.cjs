'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { waitFor } = require('./support/load.cjs')
const { createSessionFixture } = require('./support/sessionFixture.cjs')

const { load, ssh, createInjector, createProfile, startServer } = createSessionFixture()
const { ETTabComponent } = load('src/components/etTab.component.ts')
const { ETSession } = load('src/session/etSession.ts')

/** Every session that is started from here on, in the order they were. */
function watchSessions () {
    const started = []
    const start = ETSession.prototype.start
    ETSession.prototype.start = function (...args) {
        started.push(this)
        return start.apply(this, args)
    }
    started.restore = () => { ETSession.prototype.start = start }
    return started
}

function createTab (port) {
    const toastr = { warning: () => ({ toastId: 1 }), success () {}, clear () {} }
    const tab = new ETTabComponent(createInjector(), { open () {} }, toastr)
    tab.profile = createProfile(port)
    return tab
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wait for what was going to happen to have happened: long enough for a
 * session that should not have been started to show, and until the
 * connections that were being closed have gone, which takes the time that the
 * machine has for it.
 */
async function settled (server, attached) {
    await settle(200)
    await waitFor(() => server.attached.length === attached, `${attached} connection(s) to be left`, 5000)
}

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

test('asking for a new session starts one session, whatever the tab does when one ends', async () => {
    for (const behaviorOnSessionEnd of ['reconnect', 'keep', 'auto', undefined]) {
        const server = await startServer({ acceptAnyId: true })
        const tab = createTab(server.port)
        tab.profile.behaviorOnSessionEnd = behaviorOnSessionEnd
        const sessions = watchSessions()
        try {
            await tab.initializeSession()
            assert.equal(tab.session.open, true)

            await tab.reconnect()
            await settled(server, 1)

            const live = sessions.filter(x => x.open)
            assert.equal(live.length, 1, `${live.length} sessions are live with behaviorOnSessionEnd=${behaviorOnSessionEnd}`)
            assert.equal(live[0], tab.session, 'the live session is not the one the tab is showing')
            assert.equal(sessions.length, 2, `${sessions.length} sessions were started`)
            assert.equal(server.attached.length, 1, 'a session without a tab is still connected')
        } finally {
            sessions.restore()
            await tab.destroy()
            for (const session of sessions) {
                await session.destroy()
            }
            await server.close()
        }
    }
})

test('asking for a new session does not close a tab that closes when its session ends', async () => {
    // To the tab, the session that is being replaced is a session that ended.
    // A tab that is set to close when that happens closed, and the new session
    // was started all the same, with nothing to show it or to end it.
    const cases = [
        { name: 'close', prepare: tab => { tab.profile.behaviorOnSessionEnd = 'close' } },
        { name: 'auto, after exit', prepare: tab => { tab.profile.behaviorOnSessionEnd = 'auto'; tab.recentInputs = 'exit\r' } },
        { name: 'auto, after ctrl-d', prepare: tab => { tab.profile.behaviorOnSessionEnd = 'auto'; tab.recentInputs = 'print(1)\r\x04' } },
    ]
    for (const { name, prepare } of cases) {
        const server = await startServer({ acceptAnyId: true })
        const tab = createTab(server.port)
        const sessions = watchSessions()
        let closed = 0
        const destroy = tab.destroy.bind(tab)
        tab.destroy = () => {
            closed++
            return destroy()
        }
        try {
            prepare(tab)
            await tab.initializeSession()
            assert.equal(tab.session.open, true)

            await tab.reconnect()
            await settled(server, 1)

            assert.equal(closed, 0, `the tab was closed (${name})`)
            const live = sessions.filter(x => x.open)
            assert.equal(live.length, 1, `${live.length} sessions are live (${name})`)
            assert.equal(live[0], tab.session, `the live session is not the one the tab is showing (${name})`)
            assert.equal(server.attached.length, 1)
        } finally {
            sessions.restore()
            await destroy()
            for (const session of sessions) {
                await session.destroy()
            }
            await server.close()
        }
    }
})

test('a tab that closes when its session ends still does, when the session ends by itself', async () => {
    const server = await startServer({ acceptAnyId: true })
    const tab = createTab(server.port)
    tab.profile.behaviorOnSessionEnd = 'close'
    const sessions = watchSessions()
    let closed = 0
    const destroy = tab.destroy.bind(tab)
    tab.destroy = () => {
        closed++
        return destroy()
    }
    try {
        await tab.initializeSession()
        await tab.session.destroy() // as when the remote shell exits
        await settled(server, 0)

        assert.equal(closed, 1)
        assert.equal(sessions.length, 1)
        assert.equal(server.attached.length, 0)
    } finally {
        sessions.restore()
        await destroy()
        for (const session of sessions) {
            await session.destroy()
        }
        await server.close()
    }
})

test('nothing is started for a tab that has been closed', async () => {
    const server = await startServer({ acceptAnyId: true })
    const tab = createTab(server.port)
    const sessions = watchSessions()
    try {
        await tab.initializeSession()
        await tab.destroy()
        await tab.reconnect() // a hotkey that was on its way
        await tab.initializeSession()
        await settled(server, 0)

        assert.equal(sessions.length, 1, `${sessions.length} sessions were started`)
        assert.equal(sessions.filter(x => x.open).length, 0)
        assert.equal(server.attached.length, 0)
    } finally {
        sessions.restore()
        await tab.destroy()
        for (const session of sessions) {
            await session.destroy()
        }
        await server.close()
    }
})

test('asking twice in a row still starts one session', async () => {
    const server = await startServer({ acceptAnyId: true })
    const tab = createTab(server.port)
    tab.profile.behaviorOnSessionEnd = 'reconnect'
    const sessions = watchSessions()
    try {
        await tab.initializeSession()
        await Promise.all([tab.reconnect(), tab.reconnect()])
        await settled(server, 1)

        assert.equal(sessions.filter(x => x.open).length, 1)
        assert.equal(sessions.filter(x => x.open)[0], tab.session)
        assert.equal(server.attached.length, 1)
    } finally {
        sessions.restore()
        await tab.destroy()
        for (const session of sessions) {
            await session.destroy()
        }
        await server.close()
    }
})

test('a session that ends by itself is still replaced when the tab is set to reconnect', async () => {
    const server = await startServer({ acceptAnyId: true })
    const tab = createTab(server.port)
    tab.profile.behaviorOnSessionEnd = 'reconnect'
    const sessions = watchSessions()
    try {
        await tab.initializeSession()
        const first = tab.session
        await first.destroy() // as when the remote shell exits
        await waitFor(() => tab.session && tab.session !== first && tab.session.open, 'the replacement')

        assert.equal(sessions.length, 2)
        assert.equal(sessions.filter(x => x.open).length, 1)
    } finally {
        sessions.restore()
        await tab.destroy()
        for (const session of sessions) {
            await session.destroy()
        }
        await server.close()
    }
})

test('a password is saved for the user who logged in, not for the blank in the profile', async () => {
    const server = await startServer()
    const prompt = { name: 'Password', instruction: '', prompts: [{ prompt: 'Password:' }] }
    let finishBootstrap = null
    ssh.behavior.prompted = 'typed-at-the-prompt'
    ssh.behavior.start = session => new Promise(resolve => {
        finishBootstrap = resolve
        // tabby-ssh knows the user by the time it asks for a password.
        session.authUsername = ssh.behavior.prompted
        session.keyboardInteractivePrompt$.next(prompt)
    })
    const tab = createTab(server.port)
    tab.profile.options.user = ''
    try {
        const initializing = tab.initializeSession()
        await waitFor(() => tab.activeKIPrompt, 'the prompt to be shown')

        // This is the profile that tabby-ssh's panel saves the password under.
        assert.equal(tab.bootstrapProfile.options.user, 'typed-at-the-prompt')
        assert.equal(tab.bootstrapProfile.options.host, '127.0.0.1')
        assert.equal(ssh.sessions[0].profile.options.user, '', 'the profile of the SSH session itself was rewritten')

        finishBootstrap()
        await within(2000, initializing, 'initializeSession()')
    } finally {
        finishBootstrap?.()
        await tab.destroy()
        await server.close()
    }
})

test('asking again for a new session gives up one that is going nowhere', async () => {
    const server = await startServer({ acceptAnyId: true })
    const tab = createTab(server.port)
    const sessions = watchSessions()
    try {
        await tab.initializeSession()
        assert.equal(tab.session.open, true)

        // The replacement waits for an answer that is not going to come.
        let stuck = 0
        ssh.behavior.start = () => {
            stuck++
            return new Promise(() => {})
        }
        const replacing = tab.reconnect()
        await waitFor(() => stuck === 1, 'the replacement to get stuck')
        const waiting = tab.session

        // At once, it is the same request twice. Later, it is another.
        // Neither is waited for: what is asked of a tab that is busy is
        // noted, or it is not, and that is all.
        await within(1000, tab.reconnect(), 'the second request')
        assert.equal(waiting.disposed, false, 'a button that was clicked twice gave up what the first click had started')
        await settle(1100)
        ssh.behavior.start = null
        await within(1000, tab.reconnect(), 'the third request')
        await within(3000, replacing, 'the request for a new session')
        await settled(server, 1)

        assert.equal(waiting.disposed, true, 'what was going nowhere was left to go on')
        assert.equal(tab.session.open, true, 'nothing was started in its place')
        assert.notEqual(tab.session, waiting)
        assert.equal(sessions.filter(x => x.open).length, 1)
        assert.equal(server.attached.length, 1)
        assert.deepEqual(tab.errors, [])
    } finally {
        ssh.behavior.start = null
        sessions.restore()
        await tab.destroy()
        for (const session of sessions) {
            await session.destroy()
        }
        await server.close()
    }
})

test('a session that cannot even be created is said to have failed', async () => {
    const tab = createTab(1)
    // Nothing that a file can hold should do this. Whatever does is reported.
    tab.profile = { type: 'et', name: 'broken', options: null }
    await within(1000, tab.initializeSession(), 'initializeSession()')
    assert.equal(tab.errors.length, 1, 'a tab with no session, and not a word of why')
    assert.equal(tab.spinnerActive, false)
})

test('what the window has to show is done where Angular sees it, and the rest is not', async () => {
    // Tabby starts a session from outside Angular's zone, and what a session
    // reports comes from a socket, which is outside of it as well.
    const server = await startServer({ acceptAnyId: true })
    const tab = createTab(server.port)
    const seen = []
    const watch = name => {
        const original = tab[name].bind(tab)
        tab[name] = (...args) => {
            seen.push([name, tab.zone.inside, ...args.filter(x => typeof x === 'string')].join(' '))
            return original(...args)
        }
    }
    for (const name of ['onETConnectionState', 'showServiceToast', 'stopSpinner']) {
        watch(name)
    }
    let startedInside = null
    const start = ETSession.prototype.start
    ETSession.prototype.start = function (...args) {
        startedInside = tab.zone.inside
        return start.apply(this, args)
    }
    try {
        await tab.zone.run(() => tab.initializeSession())
        assert.equal(tab.session.open, true)
        assert.equal(startedInside, false, 'the session does its reading and writing in the zone')
        tab.session.forceReconnect()
        await waitFor(() => seen.includes('onETConnectionState true connected') && seen.filter(x => /connected$/.test(x)).length >= 2, 'the session to resume', 8000)

        const outside = seen.filter(x => / false/.test(x))
        assert.deepEqual(outside, [], 'done where Angular does not see it')
        assert.ok(seen.includes('onETConnectionState true reconnecting'))
        assert.ok(seen.some(x => x.startsWith('stopSpinner true')))
        assert.ok(seen.some(x => x.startsWith('showServiceToast true')))
    } finally {
        ETSession.prototype.start = start
        await tab.destroy()
        await server.close()
    }
})
