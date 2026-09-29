// Checks the plugin against the types of the Tabby that it is written for.
//
//   TABBY_DIR=/path/to/tabby node scripts/typecheck.mjs
//
// The build does not check types: it compiles each file by itself, and a file
// by itself knows nothing of what Tabby exports, nor of what another file of
// the plugin expects of it. What Tabby exports is not on npm either, as long as
// the plugin needs a Tabby with API changes that have not been released. So
// this needs a checkout of that Tabby, with its dependencies installed and its
// typings built (`yarn run build:typings`).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tabby = process.env.TABBY_DIR ?? process.argv[2]
if (!tabby) {
    console.error('Set TABBY_DIR to a checkout of Tabby that has its typings built.')
    process.exit(2)
}
for (const plugin of ['tabby-core', 'tabby-settings', 'tabby-ssh', 'tabby-terminal']) {
    if (!existsSync(path.join(tabby, plugin, 'typings', 'index.d.ts'))) {
        console.error(`${plugin} has no typings in ${tabby}. Run "yarn run build:typings" there.`)
        process.exit(2)
    }
}

// As the build compiles them, and as strictly as Tabby checks its own plugins.
const build = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions
const scratch = mkdtempSync(path.join(tmpdir(), 'tabby-et-typecheck-'))
let status = 1
try {
    writeFileSync(path.join(scratch, 'ambient.d.ts'), 'declare function require (name: string): any\n')
    writeFileSync(path.join(scratch, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            ...build,
            noEmit: true,
            sourceMap: false,
            noImplicitAny: false,
            noImplicitReturns: true,
            noFallthroughCasesInSwitch: true,
            noUnusedLocals: true,
            strictNullChecks: true,
            skipLibCheck: true,
            types: ['node'],
            typeRoots: [path.join(root, 'node_modules/@types')],
            baseUrl: path.join(root, 'src'),
            paths: {
                'tabby-*': [path.join(tabby, 'tabby-*')],
                '*': [
                    path.join(root, 'node_modules/*'),
                    path.join(tabby, 'node_modules/*'),
                    path.join(tabby, 'app/node_modules/*'),
                ],
            },
        },
        include: [path.join(root, 'src/**/*.ts'), 'ambient.d.ts'],
    }, null, 2))
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
    status = spawnSync(process.execPath, [tsc, '-p', path.join(scratch, 'tsconfig.json')], { stdio: 'inherit' }).status ?? 1
    if (status === 0) {
        console.log("The plugin type-checks against Tabby's typings")
    }
} finally {
    rmSync(scratch, { recursive: true, force: true })
}
process.exit(status)
