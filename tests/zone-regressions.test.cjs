'use strict'

// Angular draws again when what was started in its zone has run its course,
// and it follows that through zone.js. zone.js can follow a wait that is
// carried out with promises, which is what `await` is compiled to for ES2016
// and before. It cannot follow `await` itself. Whatever a plugin that is
// compiled for anything later does after its first wait is done where Angular
// does not see it: a prompt is set and not drawn, a state changes and the tab
// goes on showing the old one, until something else makes Angular look.
//
// In a file of its own, because loading zone.js changes what a promise is for
// everything in the process.

require('zone.js')

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createLoader } = require('./support/load.cjs')

const load = createLoader()
const { ETProfileSettingsComponent } = load('src/components/etProfileSettings.component.ts')

/* global Zone */

test('what the plugin does after it has waited is done in the zone that it was called in', async () => {
    const angular = Zone.current.fork({ name: 'angular' })
    const seen = []
    const editor = new ETProfileSettingsComponent({}, {
        // Answered from outside the zone, as by a socket or by a file.
        getProfiles: () => new Promise(resolve => Zone.root.run(() => setTimeout(() => resolve([]), 5))),
        resolveProfileGroupName: x => x,
    })
    editor.profile = { options: { forwardedPorts: [] } }
    Object.defineProperty(editor, 'sshProfiles', {
        get: () => [],
        set: () => seen.push(Zone.current.name),
    })
    await angular.run(() => editor.ngOnInit())
    assert.deepEqual(seen, ['angular'])
})
