// Starts Tabby with the plugin, and asks it whether the plugin is there.
//
//   node scripts/smoke-tabby.mjs --tabby <checkout of Tabby, built> --plugin <unpacked package>
//
// Tabby starts whatever becomes of its plugins: one that cannot be loaded is
// left out, with a line in the console that nobody reads. So that Tabby runs
// says nothing of the plugin. What says something is the console, and Tabby
// itself, which is asked here for the kinds of profile that it knows.
//
// Needs a display. Where there is none: xvfb-run -a node scripts/smoke-tabby.mjs ...

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const option = name => {
    const at = process.argv.indexOf(`--${name}`)
    return at < 0 ? undefined : process.argv[at + 1]
}
const tabby = path.resolve(option('tabby') ?? '')
const plugin = path.resolve(option('plugin') ?? '')
const electron = path.join(tabby, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
for (const [what, needed] of [['Tabby', path.join(tabby, 'app/dist/main.js')], ['Electron', electron], ['the plugin', path.join(plugin, 'dist/index.js')]]) {
    if (!existsSync(needed)) {
        console.error(`Cannot find ${what}: ${needed} does not exist.`)
        process.exit(2)
    }
}
const packed = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8'))
const name = packed.name.replace(/^tabby-/, '')
if (path.basename(plugin) !== packed.name) {
    // Tabby names a plugin after its directory.
    console.error(`The plugin has to be in a directory called ${packed.name}, and is in ${plugin}.`)
    process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const freePort = () => new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        server.close(() => resolve(port))
    })
})

async function evaluate (port, expression) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    const page = targets.find(x => x.type === 'page' && !/devtools/.test(x.url))
    if (!page) {
        throw new Error('Tabby has no window')
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        socket.onopen = resolve
        socket.onerror = () => reject(new Error('Cannot reach the window of Tabby'))
    })
    const answer = await new Promise(resolve => {
        socket.onmessage = event => resolve(JSON.parse(event.data))
        socket.send(JSON.stringify({
            id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
        }))
    })
    socket.close()
    if (answer.result?.exceptionDetails) {
        throw new Error(answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text)
    }
    return answer.result.result.value
}

// A configuration of its own, so that nothing of anybody's is read or written.
const home = mkdtempSync(path.join(tmpdir(), 'tabby-et-smoke-'))
const port = await freePort()
let log = ''
const child = spawn(electron, [path.join(tabby, 'app'), '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`], {
    cwd: tabby,
    env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_CACHE_HOME: path.join(home, 'cache'),
        TABBY_DEV: '1',
        TABBY_PLUGINS: plugin,
        ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', data => { log += data })
child.stderr.on('data', data => { log += data })
let exited = null
child.on('exit', code => { exited = code ?? 1 })

const problems = []
try {
    const deadline = Date.now() + 90000
    const loading = new RegExp(`"Loading ${name}: `)
    const failed = new RegExp(`"Could not load ${name}: ([^"]*)`)
    while (!loading.test(log) && exited === null && Date.now() < deadline) {
        await sleep(250)
    }
    if (!loading.test(log)) {
        problems.push(exited === null ? `Tabby did not get to loading ${name}` : `Tabby exited with ${exited} before it loaded ${name}`)
    }
    // Loading is said before it is done, and failing after.
    await sleep(3000)
    if (failed.test(log)) {
        problems.push(`Tabby could not load the plugin: ${failed.exec(log)[1]}`)
    }
    if (!problems.length) {
        let known = null
        for (let i = 0; i < 60 && !known; i++) {
            known = await evaluate(port, `(() => {
                const root = document.querySelector('app-root')
                const injector = root && typeof ng === 'object' ? ng.getInjector(root) : null
                if (!injector) { return null }
                const core = require('tabby-core')
                return JSON.stringify({
                    providers: injector.get(core.ProfilesService).getProviders().map(x => x.id),
                    plugins: injector.get(core.BOOTSTRAP_DATA).installedPlugins.map(x => x.name + '@' + x.version),
                })
            })()`).catch(() => null)
            if (!known) {
                await sleep(500)
            }
        }
        if (!known) {
            problems.push('Tabby did not answer')
        } else {
            const { providers, plugins } = JSON.parse(known)
            console.log(`Tabby runs with: ${plugins.join(', ')}`)
            console.log(`It knows these kinds of profile: ${providers.join(', ')}`)
            if (!plugins.includes(`${name}@${packed.version}`)) {
                problems.push(`${name}@${packed.version} is not among the plugins of Tabby`)
            }
            if (!providers.includes(name)) {
                problems.push(`Tabby has no profiles of the kind "${name}"`)
            }
        }
    }
} finally {
    child.kill()
    await sleep(500)
    if (exited === null) {
        child.kill('SIGKILL')
    }
    rmSync(home, { recursive: true, force: true })
}

if (problems.length) {
    for (const problem of problems) {
        console.error(problem)
    }
    console.error('\nWhat Tabby said of its plugins:')
    console.error(log.split('\n').filter(x => /"(Loading|Could not load|Found) /.test(x)).map(x => x.replace(/^.*?"/, '  ').slice(0, 300)).join('\n'))
    process.exit(1)
}
console.log(`${packed.name}@${packed.version} is loaded by Tabby`)
process.exit(0)
