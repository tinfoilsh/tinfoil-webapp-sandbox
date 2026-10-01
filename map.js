// Apple Maps embed for Tinfoil Chat's map widget. The chat frames /map with
// sandbox="allow-scripts allow-same-origin" (this page needs a real origin:
// Apple binds MapKit tokens to it) and posts one `tinfoil-sandbox-run` with
// kind 'map' after the nonce handshake. Later runs update theme and pins.
//
// This page runs Tinfoil's code and Apple's library only; the chat's
// locations are data. It fetches its own MapKit token, bound to this origin
// by the controlplane. Status goes back as `map-preview-status`.
;(function () {
  'use strict'

  if (window.parent === window) {
    document.body.textContent = 'This page only works embedded by Tinfoil Chat.'
    return
  }

  var MAPKIT_SRC = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js'
  var TOKEN_URL = 'https://api.tinfoil.sh/api/mapkit/token'
  var CHAT_ORIGIN = null // learned from the first run message
  var current = null
  var map = null
  var annotations = []
  var mapkitReady = null

  function post(message) {
    if (!current) return
    window.parent.postMessage(Object.assign({ instanceId: current.instanceId }, message), CHAT_ORIGIN || '*')
  }
  function status(state, message) {
    post({ type: 'map-preview-status', status: state, message: message })
  }

  function fetchToken(done) {
    fetch(TOKEN_URL)
      .then(function (r) { if (!r.ok) throw new Error('token request failed: ' + r.status); return r.json() })
      .then(function (body) { done(body.token) })
      .catch(function (e) { status('error', 'MapKit token: ' + e.message) })
  }

  // Load MapKit JS once; resolves with the global `mapkit` after init.
  function loadMapKit() {
    if (mapkitReady) return mapkitReady
    mapkitReady = new Promise(function (resolve, reject) {
      window.__tinfoilMapKitReady = function () {
        try {
          mapkit.init({ authorizationCallback: fetchToken })
          resolve(mapkit)
        } catch (e) {
          reject(e)
        }
      }
      var s = document.createElement('script')
      s.src = MAPKIT_SRC
      s.crossOrigin = 'anonymous'
      s.async = true
      s.dataset.callback = '__tinfoilMapKitReady'
      s.dataset.libraries = 'map,annotations,services'
      s.onerror = function () { reject(new Error('MapKit JS failed to load')) }
      document.head.appendChild(s)
    })
    return mapkitReady
  }

  function colorScheme(mk, isDarkMode) {
    return isDarkMode === true ? mk.Map.ColorSchemes.Dark : isDarkMode === false ? mk.Map.ColorSchemes.Light : mk.Map.ColorSchemes.Adaptive
  }
  function mapType(mk, type) {
    return { hybrid: mk.Map.MapTypes.Hybrid, satellite: mk.Map.MapTypes.Satellite, muted: mk.Map.MapTypes.MutedStandard }[type] || mk.Map.MapTypes.Standard
  }

  // Address-only locations: the geocoder handles street addresses, Search
  // handles place names like "Eiffel Tower". Try both, resolve null on miss.
  function resolveCoordinate(mk, query) {
    return new Promise(function (resolve) {
      new mk.Geocoder().lookup(query, function (geoErr, geo) {
        var hit = geo && geo.results && geo.results[0]
        if (hit && hit.coordinate) return resolve(new mk.Coordinate(hit.coordinate.latitude, hit.coordinate.longitude))
        new mk.Search().search(query, function (searchErr, found) {
          var place = found && found.places && found.places[0]
          resolve(place && place.coordinate ? new mk.Coordinate(place.coordinate.latitude, place.coordinate.longitude) : null)
        })
      })
    })
  }

  function signature(locations) {
    return (locations || []).map(function (l) { return [l.name, l.address, l.latitude, l.longitude, l.description].join('|') }).join('~')
  }

  function render(mk, run, previous) {
    if (!map) {
      map = new mk.Map(document.getElementById('map'), {
        showsCompass: 'adaptive',
        showsZoomControl: true,
        showsMapTypeControl: false,
        colorScheme: colorScheme(mk, run.isDarkMode),
      })
    } else {
      map.colorScheme = colorScheme(mk, run.isDarkMode)
    }
    map.mapType = mapType(mk, run.mapType)
    if (previous && signature(previous.locations) === signature(run.locations) && previous.mapType === run.mapType) {
      return status('ready')
    }
    if (annotations.length) map.removeAnnotations(annotations)
    annotations = []
    var pending = []
    ;(run.locations || []).forEach(function (loc) {
      var opts = { title: loc.name || '', subtitle: loc.description || loc.address || '' }
      if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        annotations.push(new mk.MarkerAnnotation(new mk.Coordinate(loc.latitude, loc.longitude), opts))
      } else if (loc.address || loc.name) {
        pending.push(resolveCoordinate(mk, loc.address || loc.name).then(function (coord) {
          if (coord) annotations.push(new mk.MarkerAnnotation(coord, opts))
        }))
      }
    })
    Promise.all(pending).then(function () {
      if (current !== run) return
      annotations.forEach(function (a) { map.addAnnotation(a) })
      if (annotations.length) map.showItems(annotations, { animate: false })
      // The map is usable even if every geocode failed; the chat keeps the
      // "Open in Apple Maps" link, which resolves the text server-side.
      status('ready')
    })
  }

  var nonce = location.hash.slice(1)
  var announce = setInterval(function () {
    window.parent.postMessage({ type: 'tinfoil-sandbox-ready', nonce: nonce }, '*')
  }, 250)
  setTimeout(function () { clearInterval(announce) }, 30000)

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var m = event.data
    if (!m || m.type !== 'tinfoil-sandbox-run' || m.kind !== 'map') return
    if (typeof m.instanceId !== 'string' || !/^[\w:.-]{1,128}$/.test(m.instanceId)) return
    clearInterval(announce)
    CHAT_ORIGIN = event.origin
    var previous = current
    current = m
    status('loading')
    loadMapKit().then(function (mk) { if (current === m) render(mk, m, previous) }).catch(function (e) {
      if (current === m) status('error', e && e.message ? e.message : String(e))
    })
  })
  window.parent.postMessage({ type: 'tinfoil-sandbox-ready', nonce: nonce }, '*')
})()
