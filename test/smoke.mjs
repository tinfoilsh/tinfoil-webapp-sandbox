// End-to-end check: a fake chat page on :3000 (an allowed frame-ancestor)
// embeds the runner from :3100 in a sandboxed iframe, sends one run message
// per kind, and checks the relayed messages and the nested document.
// Set SKIP_PYTHON=1 to skip the Pyodide case (needs network, ~20s).
import { chromium } from 'playwright'
import http from 'node:http'
import { createServer } from './serve.mjs'

const SANDBOX = 'http://localhost:3100'
const PARENT_HTML = `<!doctype html><html><body>
<script>
  window.received = []
  window.addEventListener('message', (e) => {
    if (e.source === document.querySelector('iframe')?.contentWindow) window.received.push(e.data)
  })
  window.embed = (sandboxAttr, run) => new Promise((resolve) => {
    document.querySelector('iframe')?.remove(); window.received = []
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', sandboxAttr)
    f.src = '${SANDBOX}/preview'
    const onReady = (e) => {
      if (e.source !== f.contentWindow || e.data?.type !== 'tinfoil-sandbox-ready') return
      window.removeEventListener('message', onReady)
      f.contentWindow.postMessage(run, '*'); resolve(true)
    }
    window.addEventListener('message', onReady)
    document.body.appendChild(f)
  })
</script></body></html>`

const sandbox = createServer().listen(3100)
const parent = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PARENT_HTML)).listen(3000)
const browser = await chromium.launch()
const page = await browser.newPage()
const cspViolations = []
page.on('console', (m) => { if (/Content.Security.Policy|Refused to/.test(m.text())) cspViolations.push(m.text().slice(0, 140)) })
await page.goto('http://localhost:3000/')

const waitFor = (pred, ms = 15000) => page.waitForFunction(pred, null, { timeout: ms }).then(() => page.evaluate(() => window.received))
const nested = () => page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame())
const results = {}
const check = async (name, fn) => { try { results[name] = await fn() } catch (e) { results[name] = 'FAIL: ' + String(e).split('\n')[0] } }

await check('html', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'html', instanceId: 'h1', code: '<h1 style="height:300px">Hello</h1>' })
  const got = await waitFor(() => window.received.some((m) => m.type === 'html-preview-height'))
  const h = got.find((m) => m.type === 'html-preview-height')
  return h.instanceId === 'h1' && h.height >= 300 ? 'ok height=' + h.height : 'bad ' + JSON.stringify(h)
})

await check('js', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'js', instanceId: 'j1', code: 'console.log("hi", {a:1}); 1+2' })
  const got = await waitFor(() => window.received.some((m) => m.type === 'js-preview-output'))
  const out = got.find((m) => m.type === 'js-preview-output').output
  return JSON.stringify(out) === JSON.stringify(['hi {"a":1}', '→ 3']) ? 'ok' : 'bad ' + JSON.stringify(out)
})

await check('js-blocks-network', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'js', instanceId: 'j2', code: 'fetch("https://example.com").then(()=>console.log("fetched"),()=>console.log("blocked")); "sent"' })
  await waitFor(() => window.received.some((m) => m.type === 'js-preview-output'))
  await page.waitForTimeout(1500)
  // fetch() is async: the output message is posted before it settles, so the
  // CSP violation shows up in the console instead.
  return cspViolations.some((v) => /connect-src|example\.com/.test(v)) ? 'ok (fetch refused by CSP)' : 'no violation seen'
})

await check('css', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'css', instanceId: 'c1', code: 'h1{color:red}' })
  const got = await waitFor(() => window.received.some((m) => m.type === 'css-preview-height'))
  const h = got.find((m) => m.type === 'css-preview-height')
  return h.instanceId === 'c1' && h.height >= 150 ? 'ok height=' + h.height : 'bad'
})

await check('artifact-polyfills', async () => {
  await page.evaluate((r) => window.embed('allow-scripts allow-forms allow-modals allow-popups', r), {
    type: 'tinfoil-sandbox-run', kind: 'artifact', instanceId: 'a1',
    html: '<!doctype html><html><head><script>localStorage.setItem("k","v")</script></head><body><div id=o></div><script>document.getElementById("o").textContent="stored:"+localStorage.getItem("k")</script></body></html>',
  })
  await page.waitForFunction(() => true)
  const f = await page.waitForFunction(() => document.querySelector('iframe')).then(() => nested())
  await f.waitForFunction(() => document.getElementById('o')?.textContent)
  const text = await f.evaluate(() => document.getElementById('o').textContent)
  const origin = await f.evaluate(() => { try { return window.origin } catch { return 'n/a' } })
  return text === 'stored:v' && origin === 'null' ? 'ok (opaque origin, storage shimmed)' : `bad text=${text} origin=${origin}`
})

await check('url', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'url', instanceId: 'u1', url: 'https://example.com/' })
  await page.waitForFunction(() => document.querySelector('iframe'))
  await page.waitForTimeout(500)
  const target = await page.frames().find((f) => f.parentFrame() === page.mainFrame()).evaluate(() => document.getElementById('runner').getAttribute('src'))
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'url', instanceId: 'u2', url: 'javascript:alert(1)' })
  await page.waitForTimeout(500)
  const rejected = await page.frames().find((f) => f.parentFrame() === page.mainFrame()).evaluate(() => document.getElementById('runner').getAttribute('src'))
  return target === 'https://example.com/' && rejected === 'about:blank' ? 'ok (https only)' : `bad ${target} ${rejected}`
})

await check('ignores-foreign-sender', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'js', instanceId: 'j3', code: '"first"' })
  await waitFor(() => window.received.some((m) => m.type === 'js-preview-output'))
  // A message that does not come from window.parent must be dropped: post it from the runner to itself.
  const runnerFrame = page.frames().find((f) => f.parentFrame() === page.mainFrame())
  await runnerFrame.evaluate(() => window.postMessage({ type: 'tinfoil-sandbox-run', kind: 'js', instanceId: 'j4', code: '"evil"' }, '*'))
  await page.waitForTimeout(800)
  const got = await page.evaluate(() => window.received)
  return got.some((m) => m.instanceId === 'j4') ? 'bad: accepted self-posted run' : 'ok'
})

if (!process.env.SKIP_PYTHON) await check('python', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), { type: 'tinfoil-sandbox-run', kind: 'python', instanceId: 'p1', code: 'print("hi")\n1+2' })
  const got = await waitFor(() => window.received.some((m) => m.type === 'python-preview-output'), 90000)
  const out = got.find((m) => m.type === 'python-preview-output').output
  return JSON.stringify(out) === JSON.stringify(['hi']) ? 'ok' : 'bad ' + JSON.stringify(out)
})

await browser.close(); sandbox.close(); parent.close()
console.log(JSON.stringify(results, null, 2))
const failed = Object.values(results).filter((v) => !String(v).startsWith('ok'))
process.exit(failed.length ? 1 : 0)
