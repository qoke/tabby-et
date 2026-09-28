import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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
