// Manual check for review P1: do runtime inline styles (React style={{}}) survive
// style-src 'self'? Loads the chat export under the production CSP header.
import { chromium, firefox } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
const OUT = process.argv[2]; const engine = process.argv[3] === 'firefox' ? firefox : chromium; const ORIGIN = 'https://chat.tinfoil.sh'
const CSP = JSON.parse(fs.readFileSync(path.join(OUT, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value
const TYPES = { html: 'text/html', js: 'application/javascript', mjs: 'application/javascript', css: 'text/css', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', wasm: 'application/wasm' }
const browser = await engine.launch(); const page = await browser.newPage()
await page.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber)) })
const consoleCsp = []; page.on('console', (m) => { if (/Content.Security.Policy|Refused to|violates/.test(m.text())) consoleCsp.push(m.text().slice(0, 160)) })
await page.route(`${ORIGIN}/**`, async (route) => {
  let p = decodeURIComponent(new URL(route.request().url()).pathname); if (p === '/') p = '/index.html'
  let f = path.join(OUT, p); if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html'; if (!fs.existsSync(f)) f = path.join(OUT, '404.html')
  await route.fulfill({ status: 200, headers: { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream', 'content-security-policy': CSP }, body: fs.readFileSync(f) })
})
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' }); await page.waitForSelector('textarea', { timeout: 30000 }); await page.waitForTimeout(1500)

// 1. chat textarea auto-sizing (el.style.height = `${n}px` in chat-input.tsx)
const ta = page.locator('textarea').first(); await ta.click()
const before = await ta.evaluate((el) => ({ inline: el.style.height, computed: getComputedStyle(el).height }))
for (let i = 1; i <= 6; i++) { await ta.type('line ' + i); if (i < 6) await page.keyboard.press('Shift+Enter') }; await page.waitForTimeout(400)
const after = await ta.evaluate((el) => ({ inline: el.style.height, computed: getComputedStyle(el).height }))

// 2. timer-button colors, applied exactly as react-dom does (style[name] = value)
const colors = await page.evaluate(() => {
  const b = document.createElement('button'); b.textContent = 'x'; document.body.appendChild(b)
  b.style.backgroundColor = '#ffc400'; b.style.color = '#1a1100'; b.style.setProperty('--tw-x', '1')
  const cs = getComputedStyle(b); const out = { backgroundColor: cs.backgroundColor, color: cs.color, custom: cs.getPropertyValue('--tw-x') }
  // negative control: a real inline style *attribute* must be blocked
  const c = document.createElement('div'); c.setAttribute('style', 'color: rgb(1, 2, 3)'); document.body.appendChild(c)
  out.attributeControl = getComputedStyle(c).color; b.remove(); c.remove(); return out
})

// 3. every element that currently carries runtime inline styles: declared vs computed
const audit = await page.evaluate(() => {
  const rows = []; for (const el of document.querySelectorAll('*')) { if (!(el instanceof HTMLElement) || el.style.length === 0) continue
    for (const prop of el.style) { const want = el.style.getPropertyValue(prop); const got = getComputedStyle(el).getPropertyValue(prop); rows.push({ prop, want, got, same: want === got }) } }
  return { elements: document.querySelectorAll('[style]').length, props: rows.length, mismatches: rows.filter((r) => !r.same).slice(0, 10) }
})
const violations = await page.evaluate(() => window.__v)
console.log(JSON.stringify({ engine: process.argv[3] || 'chromium', textarea: { before, after, grew: parseFloat(after.computed) > parseFloat(before.computed) && after.inline === after.computed }, colors, audit, violations: violations.filter((v) => !v.startsWith('style-src-attr  ') || !v.includes('inline')), rawViolations: violations.length, consoleCsp }, null, 2))
await browser.close()
