'use strict'

// What the profile selector asks of every profile, and what is made of what
// is typed into it.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createLoader } = require('./support/load.cjs')

const load = createLoader()
const { ETProfilesService } = load('src/profiles.ts')
const { parseQuickConnectQuery } = load('src/quickConnect.ts')

const provider = new ETProfilesService({ instant: text => text })
const profile = options => ({ type: 'et', name: 'test', options: { host: 'example.org', user: 'alice', port: 2022, ...options } })

test('a profile whose host is not text does not take the profile selector down', () => {
    // Asked of every profile each time the selector is opened. One that
    // throws leaves no selector at all, for any profile.
    for (const host of [null, undefined, '', '   ', {}, [], true]) {
        assert.equal(provider.intoQuickConnectString(profile({ host })), null, JSON.stringify(host))
        assert.equal(provider.getDescription(profile({ host })), '')
    }
    assert.equal(provider.intoQuickConnectString(profile({ host: 1234 })), 'alice@1234')
    assert.equal(provider.getDescription(profile({ host: 1234 })), '1234')
    assert.equal(provider.getDescription({ type: 'et' }), '')
})

test('what a profile is called for short says what is known, and nothing else', () => {
    assert.equal(provider.intoQuickConnectString(profile({})), 'alice@example.org')
    assert.equal(provider.intoQuickConnectString(profile({ port: 2222 })), 'alice@example.org:2222')
    assert.equal(provider.intoQuickConnectString(profile({ host: '::1', port: 2222 })), 'alice@[::1]:2222')
    assert.equal(provider.intoQuickConnectString(profile({ port: null })), 'alice@example.org')
    assert.equal(provider.intoQuickConnectString(profile({ port: '2222' })), 'alice@example.org')
    assert.equal(provider.intoQuickConnectString(profile({ user: null })), 'example.org')
    assert.equal(provider.intoQuickConnectString(profile({ user: 1234 })), '1234@example.org')
    assert.equal(provider.getSuggestedName(profile({ user: '', port: null })), 'example.org')
})

test('what is typed to connect is read as it was meant', () => {
    const read = query => parseQuickConnectQuery(query)
    // What follows a bracket without a colon is not a port.
    assert.deepEqual(read('alice@[::1]2222'), { host: '::1', user: 'alice', port: 2022 })
    assert.deepEqual(read('alice@[::1]:2222'), { host: '::1', user: 'alice', port: 2222 })
    // An address may end in a slash, and may be written in capitals.
    assert.deepEqual(read('et://alice@example.org:2222/'), { host: 'example.org', user: 'alice', port: 2222 })
    assert.deepEqual(read('ET://alice@example.org'), { host: 'example.org', user: 'alice', port: 2022 })
    assert.deepEqual(read('et://example.org/some/path'), { host: 'example.org', user: undefined, port: 2022 })
    // A command line says where to in its options as well.
    assert.deepEqual(read('et -p 2222 alice@example.org'), { host: 'example.org', user: 'alice', port: 2222 })
    assert.deepEqual(read('et alice@example.org --port=2222'), { host: 'example.org', user: 'alice', port: 2222 })
    assert.deepEqual(read('et -x -t 8080:80 -r 9000:90 alice@example.org:2223'), { host: 'example.org', user: 'alice', port: 2223 })
    assert.deepEqual(read('et -u bob --host example.org'), { host: 'example.org', user: 'bob', port: 2022 })
    assert.deepEqual(read('ET  alice@example.org'), { host: 'example.org', user: 'alice', port: 2022 })
})

test('what could always be typed to connect still can', () => {
    const read = query => parseQuickConnectQuery(query)
    assert.deepEqual(read('example.org'), { host: 'example.org', user: undefined, port: 2022 })
    assert.deepEqual(read(' alice@example.org '), { host: 'example.org', user: 'alice', port: 2022 })
    assert.deepEqual(read('alice@example.org:2222'), { host: 'example.org', user: 'alice', port: 2222 })
    assert.deepEqual(read('alice@example.org:70000'), { host: 'example.org', user: 'alice', port: 2022 })
    assert.deepEqual(read('a@b@example.org'), { host: 'example.org', user: 'a@b', port: 2022 })
    assert.deepEqual(read('et alice@example.org'), { host: 'example.org', user: 'alice', port: 2022 })
    assert.deepEqual(read('et://alice@example.org:2222'), { host: 'example.org', user: 'alice', port: 2222 })
    assert.deepEqual(read('::1'), { host: '::1', user: undefined, port: 2022 })
    assert.deepEqual(read('etc.example.org'), { host: 'etc.example.org', user: undefined, port: 2022 })
    for (const query of ['', 'et', 'et ', '[', '@', ':', 'et -p']) {
        const target = read(query)
        assert.equal(typeof target.host, 'string', JSON.stringify(query))
        assert.ok(target.port >= 1 && target.port <= 65535)
    }
})
