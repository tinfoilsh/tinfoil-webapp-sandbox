// End-to-end check: a fake chat page on :3000 (an allowed frame-ancestor)
// embeds the runner from :3100 in a sandboxed iframe, sends one run message
// per kind, and checks the relayed messages and the nested document.
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
    const nonce = Math.random().toString(36).slice(2)
    f.src = '${SANDBOX}/preview#' + nonce
    const onReady = (e) => {
      if (e.source !== f.contentWindow || e.data?.type !== 'tinfoil-sandbox-ready') return
      if (e.data.nonce !== nonce) { window.badNonce = (window.badNonce || 0) + 1; return }
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

await check('ready-echoes-nonce-and-repeats', async () => {
  // Attach the listener late: the runner must keep announcing until a run arrives.
  await page.evaluate(() => { document.querySelector('iframe')?.remove(); window.received = []
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = 'http://localhost:3100/preview#late-nonce'; document.body.appendChild(f) })
  await page.waitForTimeout(1200)
  const got = await waitFor(() => window.received.some((m) => m.type === 'tinfoil-sandbox-ready'))
  const readies = got.filter((m) => m.type === 'tinfoil-sandbox-ready')
  return readies.length >= 2 && readies.every((m) => m.nonce === 'late-nonce') ? 'ok (' + readies.length + ' announcements, nonce echoed)' : 'bad ' + JSON.stringify(readies.slice(0, 3))
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

await check('relay-filtered-by-instance', async () => {
  await page.evaluate((r) => window.embed('allow-scripts', r), {
    type: 'tinfoil-sandbox-run', kind: 'artifact', instanceId: 'a2',
    html: '<script>parent.postMessage({type:"x",instanceId:"someone-else"},"*");parent.postMessage({type:"x",instanceId:"a2"},"*")</script>',
  })
  await waitFor(() => window.received.some((m) => m.type === 'x'))
  await page.waitForTimeout(500)
  const got = (await page.evaluate(() => window.received)).filter((m) => m.type === 'x')
  return got.length === 1 && got[0].instanceId === 'a2' ? 'ok (foreign instanceId dropped)' : 'bad ' + JSON.stringify(got)
})

await browser.close(); sandbox.close(); parent.close()
console.log(JSON.stringify(results, null, 2))
const failed = Object.values(results).filter((v) => !String(v).startsWith('ok'))
process.exit(failed.length ? 1 : 0)
