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

test('a range that was added in part leaves only the ports that were not', () => {
    const form = createForm()
    form.spec = '8080-8082:9080-9082'
    form.importSpec()
    assert.deepEqual(form.submitted.map(x => x.port), [8080, 8081, 8082])

    // Only 8081 was taken.
    form.model.push(form.submitted[0], form.submitted[2])
    form.detectChanges()
    assert.equal(form.spec, '8081:9081')

    // Trying again must not try the two that are already bound.
    form.submitted.length = 0
    form.importSpec()
    assert.deepEqual(form.submitted.map(x => [x.port, x.targetPort]), [[8081, 9081]])
    form.model.push(form.submitted[0])
    form.detectChanges()
    assert.equal(form.spec, '')
})

test('what is left of a spec can be parsed back into the same forwards', () => {
    const { parseTunnelSpec } = load('src/session/tunnelSpec.ts')
    const form = createForm()
    form.spec = '0.0.0.0:8443:localhost:443, 8080:80, 9000-9001:9100-9101'
    form.importSpec()
    const submitted = [...form.submitted]
    form.model.push(submitted[1], submitted[3]) // 8080 and 9001 were added
    form.detectChanges()
    assert.equal(form.spec, '0.0.0.0:8443:localhost:443, 9000:9100')

    const strip = fw => ({ ...fw, description: undefined })
    assert.deepEqual(
        parseTunnelSpec(form.spec, 'Local').map(strip),
        [submitted[0], submitted[2]].map(strip),
    )
})

test('a tunnel to another host is refused, since ET would not take it there', () => {
    const { parseTunnelSpec } = load('src/session/tunnelSpec.ts')
    assert.throws(() => parseTunnelSpec('127.0.0.1:5432:db.internal:5432', 'Local'), /always ends at localhost/)
    assert.throws(() => parseTunnelSpec('8080:80, 0.0.0.0:8443:10.0.0.7:443', 'Remote'), /10\.0\.0\.7/)
    for (const local of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
        if (local.includes(':')) {
            continue // a spec is split on its colons
        }
        assert.deepEqual(
            parseTunnelSpec(`0.0.0.0:8443:${local}:443`, 'Local').map(x => [x.host, x.port, x.targetAddress, x.targetPort]),
            [['0.0.0.0', 8443, 'localhost', 443]],
        )
    }

    const form = createForm()
    form.spec = '127.0.0.1:5432:db.internal:5432'
    form.importSpec()
    assert.deepEqual(form.submitted, [])
    assert.match(form.specError, /always ends at localhost/)
    assert.equal(form.spec, '127.0.0.1:5432:db.internal:5432')
})

test('the list says where a tunnel ends, which is not where a saved forward may say', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const template = fs.readFileSync(path.join(__dirname, '..', 'src/components/etPortForwardingConfig.component.pug'), 'utf8')
    const list = template.slice(0, template.indexOf('Add a port forward'))
    assert.match(list, /localhost:\{\{fw\.targetPort\}\}/)
    assert.doesNotMatch(list, /fw\.targetAddress/)
})
