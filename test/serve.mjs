// Static server that applies the headers from vercel.json, so local runs and
// the smoke test see the same CSP as production. Usage: node test/serve.mjs [port] [dir]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(process.argv[3] ?? path.join(REPO, 'dist'))
const PORT = Number(process.argv[2] ?? 3100)
const vercel = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'))
const HEADERS = Object.fromEntries((vercel.headers ?? []).flatMap((h) => h.headers.map((x) => [x.key, x.value])))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.zip': 'application/zip' }

export function createServer(root = ROOT, headers = HEADERS) {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p.endsWith('/')) p += 'index.html'
    let file = path.join(root, p)
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html' // cleanUrls
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, headers).end('not found')
      return
    }
    res.writeHead(200, { ...headers, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => console.log(`sandbox on http://localhost:${PORT}`))
}
