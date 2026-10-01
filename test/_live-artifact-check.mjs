// From a real page on preview.tinfoil.sh, drive the live sandbox with the html
// and artifact kinds exactly as the chat does, and inspect what renders.
import { chromium } from 'playwright'
const SANDBOX = 'https://webapp-sandbox.tinfoil.sh'
const HTML = `<!DOCTYPE html><html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:linear-gradient(135deg,#1e3a8a,#0ea5e9);color:#fff}h1{font-size:2rem} .badge{background:#fff;color:#1e3a8a;padding:.3rem .7rem;border-radius:999px;font-weight:600;margin-left:.5rem}</style></head><body><h1>HTML renders <span class='badge'>OK</span></h1></body></html>`
const browser = await chromium.launch(); const page = await browser.newPage()
const logs = []; page.on('console', (m) => { if (/Content.Security|Refused|blocked|violat/i.test(m.text())) logs.push(m.text().slice(0, 200)) })
await page.goto('https://preview.tinfoil.sh/', { waitUntil: 'load' })
const out = {}
for (const [kind, name] of [['artifact', 'a1'], ['html', 'h1']]) {
  const r = await page.evaluate(async ({ SANDBOX, HTML, kind, name }) => {
    const f = document.createElement('iframe'); f.name = name; f.setAttribute('sandbox', 'allow-scripts' + (kind === 'artifact' ? ' allow-forms allow-modals allow-popups' : '')); f.src = SANDBOX + '/preview#' + name + '-nonce'
    f.style.cssText = 'width:600px;height:400px'
    const received = []
    return await new Promise((resolve) => {
      let posted = false
      const t = setTimeout(() => resolve({ ready: posted, received, timeout: true }), 15000)
      window.addEventListener('message', (e) => {
        if (e.source !== f.contentWindow) return
        received.push(e.data)
        if (!posted && e.data?.type === 'tinfoil-sandbox-ready' && e.data.nonce === name + '-nonce') {
          posted = true
          const run = kind === 'artifact' ? { type: 'tinfoil-sandbox-run', kind, instanceId: name, html: HTML } : { type: 'tinfoil-sandbox-run', kind, instanceId: name, code: HTML }
          f.contentWindow.postMessage(run, '*')
          setTimeout(() => { clearTimeout(t); resolve({ ready: true, received: received.filter((m) => m.type !== 'tinfoil-sandbox-ready') }) }, 4000)
        }
      })
      document.body.appendChild(f)
    })
  }, { SANDBOX, HTML, kind, name })
  // Look inside: the sandbox page frame and its nested srcdoc frame.
  const frames = page.frames().map((fr) => ({ name: fr.name(), url: fr.url().slice(0, 60) }))
  const nested = page.frames().find((fr) => fr.url() === 'about:srcdoc' || fr.url().startsWith('about:srcdoc'))
  let rendered = null
  if (nested) { try { rendered = await nested.evaluate(() => ({ text: document.body?.innerText.slice(0, 80), bg: getComputedStyle(document.body).backgroundImage.slice(0, 40), h1Color: getComputedStyle(document.querySelector('h1') || document.body).color })) } catch (e) { rendered = 'nested not evaluable: ' + e.message.slice(0, 80) } }
  out[kind] = { ...r, rendered }
  await page.evaluate((name) => document.querySelector(`iframe[name="${name}"]`)?.remove(), name)
  out[kind].framesAtCheck = frames.length
}
console.log(JSON.stringify({ out, cspLogs: logs }, null, 2))
await browser.close()
