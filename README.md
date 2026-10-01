# tinfoil-webapp-sandbox

Static origin that runs **untrusted, model-generated code previews** for
[Tinfoil Chat](https://chat.tinfoil.sh) inside sandboxed iframes. Deployed to
`https://webapp-sandbox.tinfoil.sh`.

It exists so that chat.tinfoil.sh can carry a strict Content-Security-Policy
(`script-src 'self'` plus hashes, as required for WEBCAT enrollment) while
previews that need `unsafe-inline`, `unsafe-eval`, Pyodide from a CDN or
arbitrary third-party pages keep working. Those run here instead.

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

## Protocol

The chat loads `https://webapp-sandbox.tinfoil.sh/preview` in a sandboxed
iframe and waits for a ready message, then posts one run message. Messages
from the nested preview document (heights, console output) are relayed back
unchanged, so the chat's existing listeners keep working. The chat
authenticates relayed messages by `event.source === iframe.contentWindow`;
the frame's origin reads as `"null"`.

| Direction | Message |
| --- | --- |
| sandbox → chat | `{ type: 'tinfoil-sandbox-ready' }` |
| chat → sandbox | `{ type: 'tinfoil-sandbox-run', kind, instanceId, ... }` |
| sandbox → chat | whatever the preview posts, e.g. `{ type: 'html-preview-height', instanceId, height }` |

`kind` and its payload:

| kind | payload | preview output |
| --- | --- | --- |
| `html` | `code` | `html-preview-height` |
| `js` | `code` (module syntax already stripped by the chat) | `js-preview-output` |
| `css` | `code` | `css-preview-height` |
| `python` | `code` | `python-preview-loading`, `python-preview-output` |
| `artifact` | `html` (GenUI HTML artifact; storage shims injected) | none |
| `url` | `url` (https only, else `about:blank`) | none |

The run message is only accepted from `window.parent`. Messages from the
nested document are relayed only when they carry the current run's
`instanceId`, and never for the `url` kind, so a third-party page or a
previous preview cannot speak for another one. The nested document
for each kind is the template the chat used to inline as a `data:` URL,
including its per-kind `<meta>` CSP (the html/js/css previews cannot reach
the network; python may fetch only this origin, where a pinned Pyodide lives).

## Embedding from the chat

```html
<iframe src="https://webapp-sandbox.tinfoil.sh/preview"
        sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
```

```js
window.addEventListener('message', (e) => {
  if (e.source !== iframe.contentWindow) return
  if (e.data?.type === 'tinfoil-sandbox-ready')
    iframe.contentWindow.postMessage({ type: 'tinfoil-sandbox-run', kind: 'js', instanceId, code }, '*')
  // ...existing handlers for js-preview-output etc. unchanged
})
```

`targetOrigin` must be `'*'` because the frame's origin is opaque.

## Development

```sh
npm install
npm run dev     # builds dist/ and serves it on :3100 with the vercel.json headers applied
npm test        # Playwright smoke test of every kind (SKIP_PYTHON=1 to skip Pyodide)
```

`npx playwright install chromium` once if the browser is missing.

## Deployment

Vercel project linked to this repo: framework **Other**, build command
`npm run build`, output directory `dist`. The build copies the runner pages
and the pinned `pyodide` npm package (version in `package.json`) into
`dist/`; the wasm is never committed. Domain `webapp-sandbox.tinfoil.sh`, DNS-only CNAME in
the Cloudflare zone to the target Vercel shows. Headers live in
`vercel.json`; `cleanUrls` maps `/preview` to `preview.html`.
`Access-Control-Allow-Origin: *` is required: previews have an opaque origin,
so even their imports of `/pyodide/*` from this host are cross-origin fetches.

Update `frame-ancestors` in `vercel.json` when a chat preview domain exists
or the chat is embedded from another origin.

## Not here yet

- **MapKit.** The map widget needs Apple's MapKit JS, which the chat CSP
  will no longer allow. Moving it here is blocked on tokens: the controlplane
  mints MapKit JWTs bound to the chat origin, and an opaque frame sends
  `Origin: null`. Either mint origin-less short-lived tokens for the sandbox
  or give the map frame `allow-same-origin` and bind tokens to this host.
