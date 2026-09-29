// Shows what the regression tests are worth: that each one fails on the code
// from before its fix, and passes on the code as it is now.
//
//   node scripts/verify-regressions.mjs [<revision>]      default: origin/main
//
// The tests of the working tree are run twice: against the sources of the
// working tree, where every one of them has to pass, and against the sources
// of <revision>, where the ones that fail are the ones that detect something.
// Nothing is checked out: the old sources are unpacked into a temporary
// directory, which is removed afterwards.

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const self = fileURLToPath(import.meta.url)
/** A test that waits on a timeout the old code never meets can take this long. */
const TEST_TIMEOUT = 120000
/**
 * A file of them, this long. Old code can do worse than fail a test: it can
 * spin in a loop that a test had every reason to expect to end. No timeout
 * inside the process can interrupt that, so the process is killed from outside.
 */
const FILE_TIMEOUT = 10 * 60 * 1000

/** Child mode: run one file of tests, print one JSON line per test. */
if (process.argv[2] === '--collect') {
    const file = path.resolve(process.argv[3])
    for await (const { type, data } of run({ files: [file], timeout: TEST_TIMEOUT })) {
        // Nested entries are steps of a test; an entry named after the file is
        // the file itself, reported when it could not be loaded at all.
        if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0) {
            const loaded = path.basename(data.name) !== path.basename(file)
            console.log(JSON.stringify({ name: loaded ? data.name : '(the file could not be loaded)', passed: type === 'test:pass' }))
        }
    }
    process.exit(0)
}

/** The results of one file of tests, run against the sources in `dir`. */
function collectFile (dir, file) {
    return new Promise((resolve, reject) => {
        // A process group of its own, so that the runner's children go with it.
        const child = spawn(process.execPath, [self, '--collect', path.join(dir, 'tests', file)], {
            cwd: dir, stdio: ['ignore', 'pipe', 'inherit'], detached: true,
        })
        let output = ''
        let finished = true
        const watchdog = setTimeout(() => {
            finished = false
            try {
                process.kill(-child.pid, 'SIGKILL')
            } catch {
                child.kill('SIGKILL')
            }
        }, FILE_TIMEOUT)
        child.stdout.on('data', data => { output += data })
        child.on('error', reject)
        child.on('close', () => {
            clearTimeout(watchdog)
            const tests = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
            resolve({ file, finished, tests })
        })
    })
}

async function collect (dir) {
    const files = readdirSync(path.join(dir, 'tests')).filter(name => name.endsWith('.test.cjs')).sort()
    const results = new Map()
    const unfinished = new Set()
    for (const { file, finished, tests } of await Promise.all(files.map(file => collectFile(dir, file)))) {
        if (!finished) {
            unfinished.add(file)
        }
        for (const { name, passed } of tests) {
            results.set(`${file}\n${name}`, { name, file, passed })
        }
    }
    return { results, unfinished }
}

const revision = process.argv[2] ?? 'origin/main'
const commit = execFileSync('git', ['rev-parse', '--short', `${revision}^{commit}`], { cwd: root }).toString().trim()
const scratch = mkdtempSync(path.join(tmpdir(), 'tabby-et-regressions-'))
let status = 0
try {
    const before = path.join(scratch, 'before')
    mkdirSync(before)
    execFileSync('tar', ['-x', '-C', before], { input: execFileSync('git', ['archive', commit, 'src', 'tsconfig.json'], { cwd: root, maxBuffer: 1 << 28 }) })
    cpSync(path.join(root, 'tests'), path.join(before, 'tests'), { recursive: true })
    symlinkSync(path.join(root, 'node_modules'), path.join(before, 'node_modules'), 'dir')

    console.log(`Running the tests against the working tree, and against the sources of ${commit}...\n`)
    const [now, then] = await Promise.all([collect(root), collect(before)])

    const was = row => {
        const result = then.results.get(`${row.file}\n${row.name}`)
        if (result) {
            return result.passed ? 'passes' : 'FAILS'
        }
        // A test with no result from a file that was killed is the one that
        // hung, or came after the one that did.
        return then.unfinished.has(row.file) ? 'HANGS' : 'absent'
    }
    const rows = [...now.results.values()].map(row => ({ ...row, was: was(row) }))
    const detecting = rows.filter(x => x.passed && x.was !== 'passes')
    const holding = rows.filter(x => x.passed && x.was === 'passes')
    const broken = rows.filter(x => !x.passed)

    console.log(`  ${commit.padEnd(8)} now     test`)
    for (const row of [...detecting, ...broken]) {
        console.log(`  ${row.was.padEnd(8)} ${(row.passed ? 'passes' : 'FAILS').padEnd(7)} ${row.name}   [${row.file}]`)
    }
    console.log(`  passes   passes  ${holding.length} more, which hold on both\n`)
    console.log(`${detecting.length} tests fail on ${commit} and pass now: each shows an issue and checks its fix.`)
    if (broken.length || now.unfinished.size) {
        console.log(`${broken.length} tests FAIL on the working tree${now.unfinished.size ? `, and ${[...now.unfinished].join(', ')} did not finish` : ''}.`)
        status = 1
    }
} finally {
    rmSync(scratch, { recursive: true, force: true })
}
process.exit(status)
