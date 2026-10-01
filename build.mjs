// Assemble the static site in dist/.
import fs from 'node:fs'
fs.rmSync('dist', { recursive: true, force: true })
fs.mkdirSync('dist')
for (const f of ['index.html', 'preview.html', 'preview.js']) fs.copyFileSync(f, `dist/${f}`)
console.log('dist/ built')
