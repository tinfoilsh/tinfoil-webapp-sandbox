// Serve the chat export as https://chat.tinfoil.sh (route interception) with the
// CSP from vercel.json and check the app itself still works: Clerk loads,
// sign-in renders, boot.js applied the theme, no page errors, only the known
// blob-worker CSP noise.
import { chromium, firefox } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
const OUT = process.argv[2]; const engine = process.argv[3] === 'firefox' ? firefox : chromium
const ORIGIN = 'https://chat.tinfoil.sh'
const CSP = JSON.parse(fs.readFileSync(path.join(OUT, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value
const TYPES = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', woff2: 'font/woff2', otf: 'font/otf', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webmanifest: 'application/manifest+json', wasm: 'application/wasm', zip: 'application/zip' }
function resolveFile(p) {
  p = decodeURIComponent(p); if (p === '/') return path.join(OUT, 'index.html')
  for (const c of [p.slice(1), p.slice(1).replace(/\/$/, '') + '.html']) { const f = path.join(OUT, c); if (fs.existsSync(f) && fs.statSync(f).isFile()) return f }
  for (const [prefix, file] of [['/chat', 'chat/[[...slug]].html'], ['/project', 'project/[[...slug]].html'], ['/share', 'share/[[...slug]].html']]) if (p.startsWith(prefix)) return path.join(OUT, file)
  return path.join(OUT, '404.html')
}
const browser = await engine.launch(); const page = await browser.newPage()
const csp = [], errors = [], pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).split('\n')[0].slice(0, 160)))
page.on('console', (m) => { const t = m.text(); if (/Content.Security.Policy|Refused to|violates/.test(t)) csp.push(t.slice(0, 150)); else if (m.type() === 'error') errors.push(t.slice(0, 150)) })
await page.route(`${ORIGIN}/**`, async (route) => {
  const f = resolveFile(new URL(route.request().url()).pathname)
  const cors = /\/(preview|vendor)\//.test(f) ? { 'access-control-allow-origin': '*' } : {}
  await route.fulfill({ status: 200, headers: { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream', 'content-security-policy': CSP, ...cors }, body: fs.readFileSync(f) })
})
const r = {}
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' })
await page.waitForFunction(() => window.Clerk && window.Clerk.loaded === true, null, { timeout: 30000 }).catch(() => {})
r.home = await page.evaluate(() => ({ clerkLoaded: !!(window.Clerk && window.Clerk.loaded), clerkVersion: window.Clerk?.version, themeAttr: document.documentElement.getAttribute('data-theme'), appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(), bootScript: !!document.querySelector('script[src="/js/boot.js"]'), inlineScripts: [...document.scripts].filter((s) => !s.src && s.type !== 'application/json').length }))
await page.goto(`${ORIGIN}/signin`, { waitUntil: 'load' })
await page.locator('input[type="email"], input[autocomplete="username"], input[autocomplete="email"]').first().waitFor({ timeout: 30000 }).catch(() => {})
r.signin = { emailInput: await page.locator('input[type="email"], input[autocomplete="username"], input[autocomplete="email"]').count() }
r.cspViolations = { workerBlob: csp.filter((c) => /worker/.test(c)).length, other: csp.filter((c) => !/worker/.test(c)) }
r.pageErrors = pageErrors; r.consoleErrors = errors.filter((e) => !/Failed to load resource|_cfuvid|status of 4/.test(e)).slice(0, 6)
console.log(JSON.stringify(r, null, 2)); await browser.close()
