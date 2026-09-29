import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(path.join(root, 'dist/index.js'), 'utf8')

if (/\b(?:templateUrl|styleUrls)\s*:/.test(bundle)) {
    throw new Error('The bundle still asks Angular to load a template or style file at runtime')
}

const components = path.join(root, 'src/components')
for (const asset of readdirSync(components).filter(name => /\.(?:pug|scss)$/.test(name))) {
    if (!bundle.includes(`./src/components/${asset}`)) {
        throw new Error(`${asset} is missing from the bundle`)
    }
}

console.log('Component templates and styles are bundled without runtime file URLs')

// Angular follows what a plugin does through zone.js, which cannot follow
// `async` and `await` as they are: only what they are compiled to for ES2016
// and before. What is done after a wait that it cannot follow is not drawn.
let waits = 0
const visit = node => {
    if (ts.isAwaitExpression(node)
        || ts.isFunctionLike(node) && node.modifiers?.some(x => x.kind === ts.SyntaxKind.AsyncKeyword)) {
        waits++
    }
    ts.forEachChild(node, visit)
}
visit(ts.createSourceFile('index.js', bundle, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS))
if (waits) {
    throw new Error(`The bundle uses async or await as they are in ${waits} places, where zone.js cannot follow`)
}

console.log('The bundle waits in a way that zone.js can follow')
