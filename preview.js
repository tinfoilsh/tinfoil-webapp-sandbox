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

  function imageBridge(instanceId) {
    var MAX_IMAGES = 64
    var sources = new Map()
    var replies = new Map()
    var currentSources = new WeakMap()
    var nextId = 0
    var selectors = 'img, image, video[poster], input[type="image"], picture source'
    var xlinkNamespace = 'http://www.w3.org/1999/xlink'
    var attributes = new Set(['src', 'srcset', 'href', 'poster', 'type'])

    window.addEventListener('message', function (event) {
      var message = event.data
      if (event.source !== parent || !message || message.type !== 'tinfoil-sandbox-image' || message.instanceId !== instanceId) return
      var resolve = replies.get(message.requestId)
      if (!resolve) return
      replies.delete(message.requestId)
      var source = message.dataURL
      resolve(typeof source === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(source) ? source : null)
    })

    function fetchImage(url) {
      if (sources.has(url)) return sources.get(url)
      if (sources.size >= MAX_IMAGES) return Promise.resolve(null)
      var requestId = String(++nextId)
      var request = new Promise(function (resolve) {
        replies.set(requestId, resolve)
        parent.postMessage({ type: 'tinfoil-sandbox-image-request', instanceId: instanceId, requestId: requestId, url: url }, '*')
      })
      sources.set(url, request)
      return request
    }

    function rewrite(element) {
      if (element.hasAttribute('srcset')) element.removeAttribute('srcset')
      if (element.localName === 'source') return
      var attribute = element.localName === 'video' ? 'poster' : element.localName === 'image' ? 'href' : 'src'
      var source = element.getAttribute(attribute) || (element.localName === 'image' ? element.getAttributeNS(xlinkNamespace, 'href') : null)
      if (!source || /^(data:|blob:)/i.test(source)) return
      if (element.localName === 'image') element.removeAttributeNS(xlinkNamespace, 'href')
      element.removeAttribute(attribute)
      currentSources.set(element, source)
      fetchImage(source).then(function (dataURL) {
        if (dataURL && currentSources.get(element) === source && !element.hasAttribute(attribute)) element.setAttribute(attribute, dataURL)
      })
    }

    function visit(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (node.matches(selectors)) rewrite(node)
      node.querySelectorAll(selectors).forEach(rewrite)
    }

    new MutationObserver(function (changes) {
      changes.forEach(function (change) {
        if (change.type === 'attributes') {
          if (attributes.has(change.attributeName)) visit(change.target)
        }
        else change.addedNodes.forEach(visit)
      })
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true })
    visit(document.documentElement)
  }

  function imageScript(id) {
    return '<script>(' + imageBridge.toString() + ')(' + js(id) + ');</script>'
  }

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
        'window.addEventListener("load",reportHeight);document.addEventListener("load",reportHeight,true);window.addEventListener("resize",reportHeight);' +
          'new MutationObserver(reportHeight).observe(document.body,{childList:true,subtree:true});setTimeout(reportHeight,100);',
      )
      return '<!DOCTYPE html><html><head>' + csp + imageScript(m.instanceId) + '</head><body>' + m.code + report + '</body></html>'
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
      return injectArtifactPolyfills(String(m.html), imageScript(m.instanceId))
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
  function injectArtifactPolyfills(html, images) {
    if (!html) return html
    var additions = POLYFILL + images
    var headOpen = html.match(/<head[^>]*>/i)
    var headClose = html.match(/<\/head\s*>/i)
    if (headOpen && headClose) {
      var headStart = headOpen.index + headOpen[0].length
      var headContent = html.slice(headStart, headClose.index)
      var firstScript = headContent.match(/<script\b/i)
      var at = firstScript ? headStart + firstScript.index : headClose.index
      return html.slice(0, at) + additions + html.slice(at)
    }
    if (headClose) return html.slice(0, headClose.index) + additions + html.slice(headClose.index)
    var bodyOpen = html.match(/<body[^>]*>/i)
    if (bodyOpen) {
      var after = bodyOpen.index + bodyOpen[0].length
      return html.slice(0, after) + additions + html.slice(after)
    }
    return additions + html
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
    if (m && m.type === 'tinfoil-sandbox-image' && current && m.instanceId === current.instanceId) {
      runner.contentWindow.postMessage(m, '*')
      return
    }
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
