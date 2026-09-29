'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createLoader } = require('./support/load.cjs')

const load = createLoader()
const { ETProfileSettingsComponent } = load('src/components/etProfileSettings.component.ts')

async function openEditor (forwardedPorts) {
    const editor = new ETProfileSettingsComponent({}, { getProfiles: async () => [], resolveProfileGroupName: x => x })
    editor.profile = { options: { forwardedPorts } }
    await editor.ngOnInit()
    return editor
}

const forward = { type: 'Local', host: '127.0.0.1', port: 8080, targetAddress: 'localhost', targetPort: 80, description: '' }

test('the editor shows only what is a forward', async () => {
    // Its list is rendered entry by entry, and one that is not an object
    // takes the whole Ports tab down with it.
    for (const saved of [[null, forward], [7, 'x', forward, undefined], [forward, [forward]]]) {
        const editor = await openEditor(saved)
        assert.deepEqual(editor.profile.options.forwardedPorts, [forward], JSON.stringify(saved))
    }
    for (const saved of [null, undefined, 'nonsense', {}]) {
        assert.deepEqual((await openEditor(saved)).profile.options.forwardedPorts, [])
    }
})

test('a list that needs no repair is left as it is', async () => {
    const saved = [forward]
    const editor = await openEditor(saved)
    assert.equal(editor.profile.options.forwardedPorts, saved)

    editor.onForwardAdded({ ...forward, port: 8081 })
    assert.equal(editor.profile.options.forwardedPorts.length, 2)
    editor.onForwardRemoved(forward)
    assert.deepEqual(editor.profile.options.forwardedPorts.map(x => x.port), [8081])
})
