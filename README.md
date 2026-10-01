# tinfoil-webapp-sandbox

Static origin that runs the **model-generated code previews that execute
inline code** for [Tinfoil Chat](https://chat.tinfoil.sh) inside sandboxed
iframes: HTML previews, JavaScript previews and HTML artifacts. Deployed to
`https://webapp-sandbox.tinfoil.sh`.

It exists so that chat.tinfoil.sh can carry a strict Content-Security-Policy
(`script-src 'self'` plus hashes, as required for WEBCAT enrollment). Every
preview whose payload is *data* rather than code (Mermaid, Python via
Pyodide, CSS, SVG, Markdown, URL artifacts) stays inside the chat origin,
verified; only the kinds that need `unsafe-inline` / `unsafe-eval` run
here.

## Trust model

- This origin is **deliberately not WEBCAT-verified**. It stores no user data,
  sets no cookies, has no API and holds no secrets. There is nothing here for
  the code it runs to steal.
- The chat embeds `/preview` with `sandbox="allow-scripts"` (artifacts add
  `allow-forms allow-modals allow-popups`). The frame therefore has an
  **opaque origin**: no cookies, no storage, `Origin: null` on requests, and
  it is never same-origin with anything, including other preview frames.
- The sandbox is same-site with chat.tinfoil.sh. WEBCAT forces
  `Origin-Agent-Cluster: ?1` on enrolled documents, which isolates same-site
  frames at the agent-cluster level; the opaque origin covers cookies and
  storage. The remaining difference from a separate site is that Firefox
  places same-site frames in the same content process. This is a recorded
  decision, not an oversight.
- `frame-ancestors` restricts embedding to the chat origins.
  `Permissions-Policy` denies camera, microphone, geolocation, payment and
  WebAuthn. The chat must never set an `allow=` attribute on the frame.

## What leaves the verified origin

Only the payload of the three kinds below, and only after the user asks for
it: HTML and JavaScript previews start in code view in the chat, and HTML
artifacts start in source view. Everything that can be rendered with the
payload as data stays in the chat origin, so this origin never sees
diagrams, Python, stylesheets or chat text.

## Protocol

The chat loads `https://webapp-sandbox.tinfoil.sh/preview#<nonce>` in a
sandboxed iframe, with a fresh random nonce per frame, and waits for a ready
message that echoes the nonce, then posts one run message. The nonce proves
the ready message comes from this document and not from something that
navigated the frame; repeating the announcement covers a listener attached
after the first one. Messages
from the nested preview document (heights, console output) are relayed back
unchanged, so the chat's existing listeners keep working. The chat
authenticates relayed messages by `event.source === iframe.contentWindow`;
the frame's origin reads as `"null"`.

| Direction | Message |
| --- | --- |
| sandbox → chat | `{ type: 'tinfoil-sandbox-ready', nonce }`, repeated every 250 ms until a run arrives |
| chat → sandbox | `{ type: 'tinfoil-sandbox-run', kind, instanceId, ... }` |
| sandbox → chat | whatever the preview posts, e.g. `{ type: 'html-preview-height', instanceId, height }` |

`kind` and its payload:

| kind | payload | preview output |
| --- | --- | --- |
| `html` | `code` | `html-preview-height` |
| `js` | `code` (module syntax already stripped by the chat) | `js-preview-output` |
| `artifact` | `html` (GenUI HTML artifact; storage shims injected) | none |

The run message is only accepted from `window.parent`. Messages from the
nested document are relayed only when they carry the current run's
`instanceId`, so a previous preview cannot speak for another one. The nested document
for each kind is the template the chat used to inline as a `data:` URL,
including its per-kind `<meta>` CSP: none of them can reach the network.

## Embedding from the chat

```html
<iframe src="https://webapp-sandbox.tinfoil.sh/preview#<nonce>"
        sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
```

```js
window.addEventListener('message', (e) => {
  if (e.source !== iframe.contentWindow) return
  if (e.data?.type === 'tinfoil-sandbox-ready' && e.data.nonce === nonce)
    iframe.contentWindow.postMessage({ type: 'tinfoil-sandbox-run', kind: 'js', instanceId, code }, '*')
  // ...existing handlers for js-preview-output etc. unchanged
})
```

`targetOrigin` must be `'*'` because the frame's origin is opaque.

## Development

```sh
npm install
npm run dev     # builds dist/ and serves it on :3100 with the vercel.json headers applied
npm test        # Playwright smoke test of every kind
```

`npx playwright install chromium` once if the browser is missing.

## Deployment

Vercel project linked to this repo: framework **Other**, build command
`npm run build`, output directory `dist`. Domain `webapp-sandbox.tinfoil.sh`, DNS-only CNAME in
the Cloudflare zone to the target Vercel shows. Headers live in
`vercel.json`; `cleanUrls` maps `/preview` to `preview.html`.
`frame-ancestors` allows any `https://*.tinfoil.sh` host plus localhost for
development.

## Not here yet

- **MapKit.** Apple's MapKit JS cannot load under the chat CSP and its
  tokens are bound to the chat origin; an opaque frame sends `Origin: null`.
  Needs origin-less short-lived tokens or a decision to give the map frame a
  real origin.
