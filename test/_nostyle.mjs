// Chat under the real vercel.json CSP (now style-src 'self'): report every CSP violation,
// exercise a Radix dialog (scroll lock via react-remove-scroll) and check fonts/shell styles applied.
import { chromium, firefox } from 'playwright'
import fs from 'node:fs'; import path from 'node:path'
const OUT = process.argv[2]; const engine = process.argv[3] === 'firefox' ? firefox : chromium; const ORIGIN = 'https://chat.tinfoil.sh'
const CSP = JSON.parse(fs.readFileSync(path.join(OUT, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', woff2: 'font/woff2', otf: 'font/otf', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webmanifest: 'application/manifest+json' }
const b = await engine.launch(); const page = await b.newPage()
await page.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.effectiveDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '').slice(0, 50))) })
await page.route(`${ORIGIN}/**`, async (route) => {
  let p = decodeURIComponent(new URL(route.request().url()).pathname); if (p === '/') p = '/index.html'
  let f = path.join(OUT, p); if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html'; if (!fs.existsSync(f)) f = path.join(OUT, '404.html')
  await route.fulfill({ status: 200, headers: { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream', 'content-security-policy': CSP }, body: fs.readFileSync(f) })
})
const r = {}
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' }); await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500)
r.home = await page.evaluate(() => ({
  shellPosition: getComputedStyle(document.querySelector('.app-shell') || document.body).position,
  rootFontVar: getComputedStyle(document.documentElement).getPropertyValue('--font-aeonik').trim(),
  bodyFontFamily: getComputedStyle(document.body).fontFamily.slice(0, 40),
  toastRegion: !!document.querySelector('[role="region"]'),
}))
const settings = page.getByRole('button', { name: /settings/i }).first()
if (await settings.count()) {
  await settings.click(); await page.waitForTimeout(1200)
  r.dialog = await page.evaluate(() => ({ open: !!document.querySelector('[role="dialog"]'), adoptedSheets: document.adoptedStyleSheets.length, bodyOverflow: getComputedStyle(document.body).overflow, scrollLocked: !!document.querySelector('[data-scroll-locked]') }))
  await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  r.afterClose = await page.evaluate(() => ({ adoptedSheets: document.adoptedStyleSheets.length, bodyOverflow: getComputedStyle(document.body).overflow }))
} else r.dialog = 'no settings button found'
r.violations = await page.evaluate(() => window.__v)
await page.goto(`${ORIGIN}/signin`, { waitUntil: 'load' }); await page.waitForTimeout(3000)
r.signinViolations = await page.evaluate(() => window.__v)
console.log(JSON.stringify(r, null, 1)); await b.close()
