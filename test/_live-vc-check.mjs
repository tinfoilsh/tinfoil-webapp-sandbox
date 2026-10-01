import { firefox, chromium } from 'playwright'
const engine = process.argv[2] === 'chromium' ? chromium : firefox
const browser = await engine.launch(); const page = await browser.newPage()
const logs = []
page.on('console', (m) => { const t = m.text(); if (/Content.Security|blocked|violat|WEBCAT|Layout was forced/i.test(t)) logs.push(t.slice(0, 200)) })
await page.goto('https://preview.tinfoil.sh/', { waitUntil: 'load' })
await page.waitForTimeout(6000)
const frames = page.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank')
const vc = page.frames().find((f) => f.url().startsWith('https://verification-center.tinfoil.sh'))
let vcState = 'no VC frame in page'
if (vc) { try { vcState = await vc.evaluate(() => ({ readyState: document.readyState, title: document.title, bodyChars: document.body?.innerText.length ?? 0, scripts: document.scripts.length })) } catch (e) { vcState = 'frame not evaluable: ' + e.message.slice(0, 80) } }
const inlineScripts = await page.evaluate(() => [...document.scripts].filter((s) => !s.src).map((s) => s.outerHTML.slice(0, 80)))
console.log(JSON.stringify({ engine: process.argv[2] || 'firefox', frames, vcState, inlineScriptsInChatDoc: inlineScripts, logs }, null, 2))
await browser.close()
