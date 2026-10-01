// Assemble the static site in dist/: the runner pages plus a pinned Pyodide
// copied from node_modules, so Python previews never load from a CDN.
import fs from 'node:fs'
const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']

fs.rmSync('dist', { recursive: true, force: true })
fs.mkdirSync('dist/pyodide', { recursive: true })
for (const f of ['index.html', 'preview.html', 'preview.js']) fs.copyFileSync(f, `dist/${f}`)
for (const f of PYODIDE_FILES) fs.copyFileSync(`node_modules/pyodide/${f}`, `dist/pyodide/${f}`)
console.log(`dist/ built with pyodide ${JSON.parse(fs.readFileSync('node_modules/pyodide/package.json')).version}`)
