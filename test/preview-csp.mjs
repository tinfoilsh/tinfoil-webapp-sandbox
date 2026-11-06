import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'

const CONFIG = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const PREVIEW_HTML = fs.readFileSync(new URL('../preview.html', import.meta.url), 'utf8')
const PREVIEW_SCRIPT = fs.readFileSync(new URL('../preview.js', import.meta.url), 'utf8')
const CHAT_URL = 'https://chat.tinfoil.sh/preview-csp-test'
const FOREIGN_SCRIPT_URL = 'https://untrusted.example/preview.js'
const PRODUCTION_HOST = 'webapp-sandbox.tinfoil.sh'
const SANDBOX_ORIGINS = [
  `https://${PRODUCTION_HOST}`,
  'https://tinfoil-webapp-sandbox-tinfoil.vercel.app',
  'http://localhost:3100',
]
const READY_TIMEOUT_MS = 5_000
const ARTIFACT = '<!doctype html><html><head><style>body{color:rgb(128,0,128)}</style><script>localStorage.setItem("cart","0")</script></head><body><h1>Cloud Rack</h1><button onclick="localStorage.setItem(\'cart\',\'1\');this.textContent=\'Added to cart\'">Add to cart</button></body></html>'

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: preview bootstrap works without relying on CSP self matching`, async (t) => {
    const browser = await engine.launch()
    t.after(() => browser.close())

    for (const origin of SANDBOX_ORIGINS) {
      await t.test(origin, async () => {
        const page = await browser.newPage()
        try {
          const condition = new URL(origin).hostname === PRODUCTION_HOST ? 'has' : 'missing'
          const policy = CONFIG.headers.find((block) => block.source === '/(.*)' && block[condition])
            .headers.find((header) => header.key === 'Content-Security-Policy').value
          // A srcdoc frame inherits the chat's URL for 'self', so only an
          // explicit sandbox script source can start this opaque frame.
          const metaPolicy = policy.split(';').filter((directive) => !/^\s*(sandbox|frame-ancestors)\b/.test(directive)).join(';')
          const html = PREVIEW_HTML
            .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${metaPolicy}">`)
            .replace('src="/preview.js"', `src="${origin}/preview.js"`)
          await page.route(CHAT_URL, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
          await page.route(`${origin}/preview.js`, (route) => route.fulfill({
            contentType: 'text/javascript',
            headers: { 'access-control-allow-origin': '*' },
            body: PREVIEW_SCRIPT,
          }))
          await page.route(FOREIGN_SCRIPT_URL, (route) => route.fulfill({ contentType: 'text/javascript', body: 'void 0' }))
          await page.goto(CHAT_URL)
          await page.evaluate((html) => {
            localStorage.setItem('parent-only', 'private')
            window.received = []
            const frame = document.createElement('iframe')
            frame.setAttribute('sandbox', 'allow-scripts')
            frame.srcdoc = html
            window.addEventListener('message', (event) => {
              if (event.source === frame.contentWindow) window.received.push(event.data)
            })
            document.body.appendChild(frame)
          }, html)
          await page.waitForFunction(() => window.received.some((message) => message.type === 'tinfoil-sandbox-ready'), null, { timeout: READY_TIMEOUT_MS })
          assert.deepEqual(await page.evaluate(() => window.received[0]), { type: 'tinfoil-sandbox-ready', nonce: '' })
          await page.evaluate((html) => {
            document.querySelector('iframe').contentWindow.postMessage({
              type: 'tinfoil-sandbox-run', kind: 'artifact', instanceId: 'csp-test', html,
            }, '*')
          }, ARTIFACT)
          const runner = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())
          await runner.locator('#runner').waitFor()
          const artifact = await runner.locator('#runner').contentFrame()
          await artifact.getByRole('heading', { name: 'Cloud Rack' }).waitFor()
          assert.equal(await artifact.locator('body').evaluate((body) => getComputedStyle(body).color), 'rgb(128, 0, 128)')
          await artifact.getByRole('button', { name: 'Add to cart', exact: true }).click()
          await artifact.getByRole('button', { name: 'Added to cart', exact: true }).waitFor()
          assert.deepEqual(await artifact.locator('body').evaluate(() => {
            let parentAccess
            try { window.parent.parent.document; parentAccess = 'allowed' } catch (error) { parentAccess = error.name }
            return { origin: window.origin, parentAccess, parentStorage: localStorage.getItem('parent-only'), cart: localStorage.getItem('cart') }
          }), { origin: 'null', parentAccess: 'SecurityError', parentStorage: null, cart: '1' })
          assert.deepEqual(await artifact.locator('body').evaluate((body, url) => new Promise((resolve) => {
            const script = document.createElement('script')
            const onViolation = (event) => {
              if (event.blockedURI !== url) return
              document.removeEventListener('securitypolicyviolation', onViolation)
              resolve({ blockedURI: event.blockedURI })
            }
            document.addEventListener('securitypolicyviolation', onViolation)
            script.onload = () => {
              document.removeEventListener('securitypolicyviolation', onViolation)
              resolve({ loaded: true })
            }
            script.src = url
            body.appendChild(script)
          }), FOREIGN_SCRIPT_URL), { blockedURI: FOREIGN_SCRIPT_URL })
        } finally {
          await page.close()
        }
      })
    }
  })
}
