// Runner for previews that execute model-authored code (HTML, JavaScript,
// HTML artifacts), which the chat's own CSP cannot allow. The chat embeds
// /preview in a sandboxed iframe, waits for `tinfoil-sandbox-ready`, then
// posts one `tinfoil-sandbox-run` message. The code runs in a nested iframe
// whose document is built here from the templates the chat used to inline
// as data: URLs. Messages the nested document posts (heights, console
// output) are relayed to the chat unchanged.
//
// Trust model: everything that arrives here is untrusted and runs with an
// opaque origin. Nothing on this origin is secret, so there is nothing for
// the code to steal; the sandbox attribute set by the chat is what keeps it
// away from the chat itself.
;(function () {
  'use strict'

  if (window.parent === window) {
    document.body.textContent = 'This page only works embedded by Tinfoil Chat.'
    return
  }

  var runner = document.getElementById('runner')
  var current = null // the run message being displayed

  // JSON.stringify plus `<` escaping, so user code can be embedded inside a
  // <script> element without terminating it.
  function js(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c')
  }

  // Posts to `parent`, which inside the nested document is this runner.
  function reporter(type, id, body) {
    return (
      '<script>' +
      'function reportHeight(){var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);' +
      'parent.postMessage({type:' + js(type) + ',instanceId:' + js(id) + ',height:h},"*")}' +
      body +
      '</script>'
    )
  }

  var builders = {
    html: function (m) {
      var csp =
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\';">'
      var report = reporter(
        'html-preview-height',
        m.instanceId,
        'window.addEventListener("load",reportHeight);window.addEventListener("resize",reportHeight);' +
          'new MutationObserver(reportHeight).observe(document.body,{childList:true,subtree:true});setTimeout(reportHeight,100);',
      )
      return '<!DOCTYPE html><html><head>' + csp + '</head><body>' + m.code + report + '</body></html>'
    },

    js: function (m) {
      return (
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\';">' +
        '</head><body><script>' +
        'const output=[];' +
        'console.log=(...args)=>{output.push(args.map(a=>typeof a==="object"?JSON.stringify(a):String(a)).join(" "))};' +
        'try{const result=eval(' + js(m.code) + ');' +
        'if(result!==undefined){output.push("\\u2192 "+(typeof result==="object"?JSON.stringify(result):String(result)))}}' +
        'catch(e){output.push("Error: "+(e.message||String(e)||"Unknown error"))}' +
        'parent.postMessage({type:"js-preview-output",instanceId:' + js(m.instanceId) + ',output},"*");' +
        '</script></body></html>'
      )
    },

    // GenUI HTML artifact: model-authored document with storage shims, since
    // an opaque origin makes localStorage / document.cookie throw.
    artifact: function (m) {
      return injectArtifactPolyfills(String(m.html))
    },
  }

  var POLYFILL =
    '<script>(function(){try{' +
    'function mem(){var s=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},' +
    'setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[String(k)]},clear:function(){s=Object.create(null)},' +
    'key:function(i){var ks=Object.keys(s);return i>=0&&i<ks.length?ks[i]:null},get length(){return Object.keys(s).length}}}' +
    'function install(n){try{var p=window[n];if(p&&typeof p.getItem==="function"){p.getItem("__tinfoil_probe__");return}}catch(_){}' +
    'try{Object.defineProperty(window,n,{value:mem(),configurable:true,writable:true})}catch(_){}}' +
    'install("localStorage");install("sessionStorage");' +
    'try{document.cookie}catch(_){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(__){}}' +
    '}catch(_){}})();</script>'

  // Same insertion rules as the chat's injectArtifactPolyfills: before the
  // first <script> in <head>, else before </head>, else after <body>, else
  // prepended.
  function injectArtifactPolyfills(html) {
    if (!html) return html
    var headOpen = html.match(/<head[^>]*>/i)
    var headClose = html.match(/<\/head\s*>/i)
    if (headOpen && headClose) {
      var headStart = headOpen.index + headOpen[0].length
      var headContent = html.slice(headStart, headClose.index)
      var firstScript = headContent.match(/<script\b/i)
      var at = firstScript ? headStart + firstScript.index : headClose.index
      return html.slice(0, at) + POLYFILL + html.slice(at)
    }
    if (headClose) return html.slice(0, headClose.index) + POLYFILL + html.slice(headClose.index)
    var bodyOpen = html.match(/<body[^>]*>/i)
    if (bodyOpen) {
      var after = bodyOpen.index + bodyOpen[0].length
      return html.slice(0, after) + POLYFILL + html.slice(after)
    }
    return POLYFILL + html
  }

  function run(m) {
    if (typeof m.instanceId !== 'string' || !/^[\w:.-]{1,128}$/.test(m.instanceId)) return
    current = m
    var build = builders[m.kind]
    if (!build) return
    runner.srcdoc = build(m)
  }

  window.addEventListener('message', function (event) {
    // From the nested document: relay to the chat, but only messages tagged
    // with the current run's id, so previews cannot speak for each other.
    if (runner.contentWindow && event.source === runner.contentWindow) {
      var d = event.data
      if (current && d && d.instanceId === current.instanceId) {
        window.parent.postMessage(d, '*')
      }
      return
    }
    // From the chat.
    if (event.source !== window.parent) return
    var m = event.data
    if (!m || m.type !== 'tinfoil-sandbox-run') return
    run(m)
  })

  // The chat focuses this frame for keyboard-driven artifacts; the code runs
  // one level down, so pass focus on to the nested document.
  window.addEventListener('focus', function () {
    if (runner.contentWindow) runner.contentWindow.focus()
  })

  // Announce readiness until the first run arrives. The chat passes a
  // per-frame nonce in the URL fragment and accepts only a ready message
  // that echoes it, so a document that replaced this one could not claim
  // the run. Repeating covers a chat listener attached after our first post.
  var nonce = location.hash.slice(1)
  var announce = setInterval(function () {
    window.parent.postMessage({ type: 'tinfoil-sandbox-ready', nonce: nonce }, '*')
  }, 250)
  setTimeout(function () { clearInterval(announce) }, 30000)
  window.addEventListener('message', function (event) {
    if (event.source === window.parent && event.data && event.data.type === 'tinfoil-sandbox-run') clearInterval(announce)
  })
  window.parent.postMessage({ type: 'tinfoil-sandbox-ready', nonce: nonce }, '*')
})()
