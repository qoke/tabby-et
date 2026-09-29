'use strict'

// The forwarding form is shared by the profile editor, where adding a forward
// cannot fail, and the live session's dialog, where it can: the port may be
// taken, and a remote forward cannot be added to a running session at all.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createLoader } = require('./support/load.cjs')

const load = createLoader()
const { ETPortForwardingConfigComponent } = load('src/components/etPortForwardingConfig.component.ts')

/** A form wired to a host that decides, some time later, whether to accept. */
function createForm () {
    const form = new ETPortForwardingConfigComponent()
    form.model = []
    form.submitted = []
    form.forwardAdded.subscribe(forward => form.submitted.push(forward))
    // What Angular does after every event and every resolved promise.
    form.detectChanges = () => form.ngDoCheck()
    return form
}

function fill (form, values) {
    Object.assign(form.newForward, { host: '127.0.0.1', port: 8080, targetPort: 3000, description: 'dev server' }, values)
}

const untouched = { type: 'Local', host: '127.0.0.1', port: 8000, targetAddress: 'localhost', targetPort: 80, description: '' }

test('a forward that could not be added stays in the form', () => {
    const form = createForm()
    fill(form)
    form.addForward()
    assert.equal(form.submitted.length, 1)

    // The port was taken: the host reports the failure and adds nothing.
    form.detectChanges()
    assert.equal(form.newForward.port, 8080)
    assert.equal(form.newForward.description, 'dev server')
})

test('a forward that was added clears the form', () => {
    const form = createForm()
    fill(form)
    form.addForward()
    form.detectChanges()
    assert.equal(form.newForward.port, 8080, 'the form was cleared before the forward was accepted')

    form.model.push(form.submitted[0])
    form.detectChanges()
    assert.deepEqual(form.newForward, untouched)
})

test('a host that adds the forward at once clears the form at once', () => {
    // The profile editor: its handler pushes to the list as the event fires.
    const form = createForm()
    form.forwardAdded.subscribe(forward => form.model.push(forward))
    fill(form)
    form.addForward()
    assert.deepEqual(form.newForward, untouched)
})

test('the form never shares an object with a forward it submitted', () => {
    const form = createForm()
    fill(form)
    form.addForward()
    form.model.push(form.submitted[0])
    // The user is already typing the next one when the first is accepted.
    form.newForward.port = 9090
    form.detectChanges()
    assert.equal(form.submitted[0].port, 8080, 'editing the form edited the active forward')
    assert.equal(form.newForward.port, 9090, 'the accepted forward wiped what the user typed since')
})

test('a refused remote forward stays in the form', () => {
    const form = createForm()
    fill(form, { type: 'Remote', port: 9000 })
    form.addForward()
    form.detectChanges()
    assert.equal(form.newForward.type, 'Remote')
    assert.equal(form.newForward.port, 9000)
})

test('an imported spec keeps the tunnels that were not added', () => {
    const form = createForm()
    form.spec = '8080:80, 8081:81, 8082:82'
    form.importSpec()
    assert.equal(form.submitted.length, 3)
    assert.equal(form.spec, '8080:80, 8081:81, 8082:82', 'the spec was cleared before anything was accepted')

    // The second port was taken.
    form.model.push(form.submitted[0], form.submitted[2])
    form.detectChanges()
    assert.equal(form.spec, '8081:81')

    form.spec = '8081:81'
    form.submitted.length = 0
    form.importSpec()
    form.model.push(form.submitted[0])
    form.detectChanges()
    assert.equal(form.spec, '')
})

test('a spec that does not parse is left alone and explained', () => {
    const form = createForm()
    form.spec = '8080:80, nonsense'
    form.importSpec()
    assert.equal(form.submitted.length, 0)
    assert.equal(form.spec, '8080:80, nonsense')
    assert.match(form.specError, /nonsense/)
})
