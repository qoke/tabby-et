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
    assert.match(read('.github/workflows/build.yml'), /^permissions:\n  contents: read$/m)
})

test('Tabby is started with the plugin, and asked whether the plugin is there', () => {
    assert.ok(fs.existsSync(path.join(root, 'scripts/smoke-tabby.mjs')))
    const smoke = job('tabby-preview.yml', 'linux-smoke')
    assert.match(smoke, /needs: plugin/)
    assert.match(smoke, /fetch-depth: 0/)
    assert.match(smoke, /git fetch --force --tags/)
    assert.match(smoke, /name: tabby-et-plugin/)
    assert.match(smoke, /yarn run build/)
    assert.match(smoke, /scripts\/smoke-tabby\.mjs --tabby tabby --plugin plugins\/tabby-eternal-terminal/)

    const plugin = job('tabby-preview.yml', 'plugin')
    assert.match(plugin, /Check the requested Tabby ref/)
    assert.match(plugin, /TABBY_REF/)
    assert.match(job('tabby-preview.yml', 'tabby-lint'), /needs: plugin/)

    // And where it is only launched, it is launched with the plugin.
    const launched = job('tabby-preview.yml', 'macos-smoke')
    assert.match(launched, /name: tabby-et-plugin/)
    assert.match(launched, /TABBY_PLUGINS=/)
    assert.match(launched, /Could not load eternal-terminal: /)
})

test('the plugin is compiled for what zone.js can follow, and the package is checked for it', () => {
    const target = JSON.parse(read('tsconfig.json')).compilerOptions.target
    assert.match(target, /^es(5|6|2015|2016)$/i, `compiled for ${target}`)
    assert.match(read('scripts/check-bundle.mjs'), /isAwaitExpression/)
})

test('npm publishing is isolated from build code behind release approval', () => {
    const workflow = read('.github/workflows/publish.yml')
    const build = job('publish.yml', 'build')
    const publish = job('publish.yml', 'publish')

    assert.doesNotMatch(build, /id-token:\s*write/)
    assert.doesNotMatch(build, /npm publish/)
    assert.match(build, /npm pack --ignore-scripts/)
    assert.match(build, /actions\/upload-artifact@/)

    assert.match(publish, /needs: build/)
    assert.match(publish, /if: github.event_name == 'push'/)
    assert.match(publish, /environment: release/)
    assert.match(publish, /id-token: write/)
    assert.match(publish, /actions\/download-artifact@/)
    assert.match(publish, /git merge-base --is-ancestor/)
    assert.match(publish, /npm publish "\$package" --access public --ignore-scripts/)
    assert.doesNotMatch(publish, /npm (?:ci|test|run build|pack)\b/)
    assert.doesNotMatch(publish, /npm install --global npm@\^/)

    for (const action of ['checkout', 'setup-node', 'upload-artifact', 'download-artifact']) {
        assert.match(workflow, new RegExp(`uses: actions/${action}@[0-9a-f]{40}\\b`), `${action} is not pinned to a commit`)
    }
    assert.doesNotMatch(workflow, /uses: actions\/\w+@v\d+\b/)
})
