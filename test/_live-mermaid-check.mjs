// From the real chat page, frame the live Mermaid page exactly as the app does
// (sandbox="allow-scripts", nonce in the fragment) and see whether its scripts run.
import { chromium, firefox } from 'playwright'
for (const engine of [chromium, firefox]) {
  const browser = await engine.launch(); const page = await browser.newPage()
  const csp = []; page.on('console', (m) => { if (/Content.Security|Refused|blocked|violat/i.test(m.text())) csp.push(m.text().slice(0, 160)) })
  await page.goto('https://preview.tinfoil.sh/', { waitUntil: 'load' })
  const r = await page.evaluate(() => new Promise((resolve) => {
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = '/preview/mermaid.html#live-nonce'; f.style.cssText = 'width:600px;height:300px'
    const got = []; const t = setTimeout(() => resolve({ ready: false, got }), 15000)
    window.addEventListener('message', (e) => {
      if (e.source !== f.contentWindow) return
      if (e.data?.type === 'tinfoil-sandbox-ready' && e.data.nonce === 'live-nonce' && !got.length) { got.push('ready'); f.contentWindow.postMessage({ type: 'tinfoil-sandbox-run', kind: 'mermaid', instanceId: 'x', code: 'graph TD; A-->B', isDarkMode: false }, '*') }
      else if (e.data?.type?.startsWith('mermaid-preview')) { got.push(e.data.type + (e.data.height ? '=' + e.data.height : '') + (e.data.message ? ':' + e.data.message : '')); clearTimeout(t); resolve({ ready: true, got }) }
    })
    document.body.appendChild(f)
  }))
  const frame = page.frames().find((fr) => fr.url().includes('/preview/mermaid.html'))
  const nodes = frame ? await frame.evaluate(() => document.querySelectorAll('.node').length).catch(() => 'n/a') : 'no frame'
  console.log(engine.name(), JSON.stringify({ ...r, nodesRendered: nodes, cspMessages: csp }))
  await browser.close()
}
