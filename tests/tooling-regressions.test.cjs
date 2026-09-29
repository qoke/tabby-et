'use strict'

// What is checked before anything is released, and by whom. The build
// compiles file by file and checks no types, and a Tabby that starts says
// nothing of a plugin that it could not load: both have to be looked for.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

/** The text of one job of a workflow. */
function job (workflow, name) {
    const text = read(`.github/workflows/${workflow}`)
    const start = text.search(new RegExp(`^  ${name}:$`, 'm'))
    assert.notEqual(start, -1, `${workflow} has no job called ${name}`)
    const rest = text.slice(start + name.length + 3)
    const end = rest.search(/^  [A-Za-z][\w-]*:$/m)
    return end === -1 ? rest : rest.slice(0, end)
}

test('the types of the plugin are checked, against the Tabby that it is written for', () => {
    const scripts = JSON.parse(read('package.json')).scripts
    assert.equal(scripts.typecheck, 'node scripts/typecheck.mjs')
    assert.ok(fs.existsSync(path.join(root, 'scripts/typecheck.mjs')))

    const typecheck = job('build.yml', 'typecheck')
    assert.match(typecheck, /repository: qoke\/tabby/)
    assert.match(typecheck, /ref: tabby-et-ssh-support/)
    // Tabby cannot be installed without the tags of its releases.
    assert.match(typecheck, /fetch-depth: 0/)
    assert.match(typecheck, /git fetch --force --tags/)
    assert.match(typecheck, /yarn run build:typings/)
    assert.match(typecheck, /run: npm run typecheck/)
    assert.match(typecheck, /TABBY_DIR: /)
})

test('Tabby is started with the plugin, and asked whether the plugin is there', () => {
    assert.ok(fs.existsSync(path.join(root, 'scripts/smoke-tabby.mjs')))
    const smoke = job('tabby-preview.yml', 'linux-smoke')
    assert.match(smoke, /needs: plugin/)
    assert.match(smoke, /fetch-depth: 0/)
    assert.match(smoke, /git fetch --force --tags/)
    assert.match(smoke, /name: tabby-et-plugin/)
    assert.match(smoke, /yarn run build/)
    assert.match(smoke, /scripts\/smoke-tabby\.mjs --tabby tabby --plugin plugins\/tabby-et/)

    // And where it is only launched, it is launched with the plugin.
    const launched = job('tabby-preview.yml', 'macos-smoke')
    assert.match(launched, /name: tabby-et-plugin/)
    assert.match(launched, /TABBY_PLUGINS=/)
    assert.match(launched, /Could not load et/)
})

test('the plugin is compiled for what zone.js can follow, and the package is checked for it', () => {
    const target = JSON.parse(read('tsconfig.json')).compilerOptions.target
    assert.match(target, /^es(5|6|2015|2016)$/i, `compiled for ${target}`)
    assert.match(read('scripts/check-bundle.mjs'), /isAwaitExpression/)
})
