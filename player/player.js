// CueSign player.
//
// Asks a CueSign server what to show, downloads the media to local storage, then displays
// it. Runs on a BrightSign (Node.js enabled, media cached on the SD card) and, for
// previewing, in a desktop browser at http://<server>/player/ (no cache, media is streamed).
//
// Written without newer syntax (optional chaining etc.) so it runs on older BrightSign OS.

(function () {
  'use strict';

  var VERSION = '0.1.0';
  // The override exists so the caching code can be exercised with plain Node off the device.
  var SD_ROOT = (typeof process !== 'undefined' && process.env && process.env.CUESIGN_SD_ROOT) || '/storage/sd';
  var CACHE_DIR = SD_ROOT + '/cuesign-cache';
  var STATUS_INTERVAL_MS = 2000;
  var RECONNECT_MS = 2000;
  var RETRY_DOWNLOAD_MS = 3000;

  // ---- Environment --------------------------------------------------------------------

  var fs = null, path = null, http = null, https = null, crypto = null;
  try {
    if (typeof require === 'function') {
      fs = require('fs');
      path = require('path');
      http = require('http');
      https = require('https');
      crypto = require('crypto');
    }
  } catch (e) {
    fs = null;
  }
  var onDevice = !!fs;
  if (!onDevice) document.documentElement.className = 'browser';

  var device = { id: null, model: null, os: null };
  var config = { server: null, name: null };

  function query(name) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function loadEnvironment() {
    if (onDevice) {
      try {
        var DeviceInfo = require('@brightsign/deviceinfo');
        var info = new DeviceInfo();
        device.id = info.serialNumber;
        device.model = info.model;
        device.os = info.osVersion;
      } catch (e) {
        device.id = require('os').hostname();
      }
      try {
        var file = JSON.parse(fs.readFileSync(SD_ROOT + '/config.json', 'utf8'));
        config.server = file.server;
        config.name = file.name || null;
      } catch (e) {
        setInfo('Cannot read config.json on the SD card: ' + e.message);
      }
    } else {
      // Browser preview: the page is served by the server itself.
      config.server = location.origin;
      device.id = query('id');
      if (!device.id) {
        try {
          device.id = localStorage.getItem('cuesign-id');
          if (!device.id) {
            device.id = 'preview-' + Math.random().toString(36).slice(2, 8);
            localStorage.setItem('cuesign-id', device.id);
          }
        } catch (e) {
          device.id = 'preview';
        }
      }
      device.model = 'Browser preview';
    }
    device.id = String(device.id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    if (config.server) config.server = String(config.server).replace(/\/+$/, '');
  }

  // ---- Media cache --------------------------------------------------------------------

  var cache = {
    ready: {},        // media id -> URL that can be played right now
    wanted: [],       // assets to hold, most urgent first
    waiters: {},      // media id -> callbacks waiting for that file
    active: null,     // { id, received, size, abort }
    error: null,

    init: function () {
      if (!onDevice) return;
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.readdirSync(CACHE_DIR).forEach(function (file) {
          if (/\.part$/.test(file)) {
            fs.unlinkSync(path.join(CACHE_DIR, file)); // left over from an interrupted download
          } else if (/^[0-9a-f]{64}\./.test(file)) {
            cache.ready[file.slice(0, 64)] = 'file://' + CACHE_DIR + '/' + file;
          }
        });
      } catch (e) {
        cache.error = 'Cache folder: ' + e.message;
      }
    },

    // Sets what should be cached. The first asset is the one about to be shown.
    sync: function (assets, library) {
      cache.wanted = assets;
      if (!onDevice) {
        assets.forEach(function (asset) { cache.ready[asset.id] = config.server + asset.url; });
        return;
      }
      cache.prune(library);
      cache.pump();
    },

    // Calls back with a playable URL once the asset is in the cache.
    ensure: function (asset, callback) {
      if (cache.ready[asset.id]) return callback(cache.ready[asset.id]);
      (cache.waiters[asset.id] = cache.waiters[asset.id] || []).push(callback);
      cache.pump();
    },

    pump: function () {
      var next = null;
      for (var i = 0; i < cache.wanted.length; i++) {
        if (!cache.ready[cache.wanted[i].id]) { next = cache.wanted[i]; break; }
      }
      if (cache.active) {
        // Something less urgent is downloading while the item on cue is missing: drop it.
        var urgent = cache.wanted[0];
        if (urgent && !cache.ready[urgent.id] && cache.active.id !== urgent.id) cache.active.abort();
        return;
      }
      if (!next) return;

      download(next, function (err, aborted) {
        cache.active = null;
        if (!err) {
          cache.error = null;
          cache.ready[next.id] = 'file://' + CACHE_DIR + '/' + next.file;
          var waiting = cache.waiters[next.id] || [];
          delete cache.waiters[next.id];
          waiting.forEach(function (callback) { callback(cache.ready[next.id]); });
          cache.pump();
        } else if (aborted) {
          cache.pump();
        } else {
          cache.error = 'Download failed: ' + err.message;
          setTimeout(cache.pump, RETRY_DOWNLOAD_MS);
        }
        sendStatus();
      });
    },

    // Deletes cached files the server no longer has in its library.
    prune: function (library) {
      var keep = {};
      library.forEach(function (id) { keep[id] = true; });
      Object.keys(cache.ready).forEach(function (id) {
        if (keep[id] || (showing && showing.asset.id === id)) return;
        try {
          fs.unlinkSync(cache.ready[id].replace('file://', ''));
        } catch (e) { /* already gone */ }
        delete cache.ready[id];
      });
    },

    counts: function () {
      var cached = 0;
      cache.wanted.forEach(function (asset) { if (cache.ready[asset.id]) cached++; });
      return { cached: cached, total: cache.wanted.length };
    }
  };

  // Streams one asset to the SD card, verifying size and SHA-256 before it counts as cached.
  function download(asset, done) {
    var dest = path.join(CACHE_DIR, asset.file);
    var part = dest + '.part';
    var url = config.server + asset.url;
    var hash = crypto.createHash('sha256');
    var finished = false;
    var request = null;
    var output = fs.createWriteStream(part);

    function fail(err, aborted) {
      if (finished) return;
      finished = true;
      try { if (request) request.abort(); } catch (e) { /* ignore */ }
      try { output.destroy(); } catch (e) { /* ignore */ }
      fs.unlink(part, function () { done(err, aborted); });
    }

    cache.active = {
      id: asset.id,
      received: 0,
      size: asset.size,
      abort: function () { fail(new Error('aborted'), true); }
    };
    var active = cache.active;

    request = (url.indexOf('https:') === 0 ? https : http).get(url, function (response) {
      if (response.statusCode !== 200) return fail(new Error('HTTP ' + response.statusCode + ' for ' + asset.file));
      response.on('data', function (chunk) {
        active.received += chunk.length;
        hash.update(chunk);
      });
      response.on('aborted', function () { fail(new Error('connection lost')); });
      response.on('error', fail);
      response.pipe(output);
    });
    request.on('error', fail);
    request.setTimeout(30000, function () { fail(new Error('timed out')); });
    output.on('error', fail);
    output.on('finish', function () {
      if (finished) return;
      if (active.received !== asset.size || hash.digest('hex') !== asset.id) {
        return fail(new Error('checksum mismatch for ' + asset.file));
      }
      fs.rename(part, dest, function (err) {
        if (err) return fail(err);
        finished = true;
        done(null);
      });
    });
  }

  // ---- Display ------------------------------------------------------------------------

  var video = document.getElementById('video');
  var images = [document.getElementById('imgA'), document.getElementById('imgB')];
  var curtain = document.getElementById('curtain');
  var front = 0;            // index into images of the layer currently on top
  var videoOnScreen = false;
  var showToken = 0;        // bumped by every transition so an interrupted one can stop
  var showing = null;       // { key, cue, asset } once fully on screen
  var targetKey = null;     // what the server last asked for
  var displayError = null;

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fade(element, opacity, ms) {
    element.style.transition = ms > 0 ? 'opacity ' + ms + 'ms linear' : 'none';
    void element.offsetWidth; // commit the starting value so the transition runs
    element.style.opacity = opacity;
  }

  function loadImage(element, url) {
    return new Promise(function (resolve, reject) {
      element.onload = function () { resolve(); };
      element.onerror = function () { reject(new Error('cannot decode image')); };
      element.src = url;
    });
  }

  function startVideo(url, loop) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(resolve, 5000); // never hold the cue forever on a slow start
      video.onplaying = function () { clearTimeout(timer); resolve(); };
      video.onerror = function () { clearTimeout(timer); reject(new Error('cannot play video')); };
      video.loop = loop;
      video.muted = !onDevice; // desktop browsers refuse to autoplay with sound
      video.src = url;
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () { /* reported through onerror */ });
    });
  }

  function stopVideo() {
    video.onplaying = video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    videoOnScreen = false;
  }

  // Transitions to an item ({ key, cue, asset, url, loop, fadeMs }) or to black (null).
  async function show(item, fadeMs) {
    var token = ++showToken;
    var ms = Math.max(0, fadeMs || 0);
    displayError = null;

    try {
      if (!item) {
        fade(curtain, 1, ms);
        await wait(ms);
        if (token !== showToken) return;
        stopVideo();
        images.forEach(function (image) { fade(image, 0, 0); image.removeAttribute('src'); });
        showing = null;
      } else if (item.asset.kind === 'image') {
        var back = 1 - front;
        fade(images[back], 0, 0);
        await loadImage(images[back], item.url);
        if (token !== showToken) return;
        images[back].style.zIndex = 2;
        images[front].style.zIndex = 1;
        fade(images[back], 1, ms);
        fade(curtain, 0, ms);
        await wait(ms);
        if (token !== showToken) return;
        fade(images[front], 0, 0);
        images[front].removeAttribute('src');
        front = back;
        stopVideo();
        showing = item;
      } else {
        // A hardware video plane cannot crossfade with itself, so video-to-video dips to black.
        if (videoOnScreen) {
          fade(curtain, 1, ms / 2);
          await wait(ms / 2);
          if (token !== showToken) return;
        }
        await startVideo(item.url, item.loop);
        if (token !== showToken) return;
        videoOnScreen = true;
        images.forEach(function (image) { fade(image, 0, ms); });
        fade(curtain, 0, ms);
        showing = item;
        await wait(ms);
        if (token !== showToken) return;
        images.forEach(function (image) { image.removeAttribute('src'); });
      }
    } catch (e) {
      if (token !== showToken) return;
      displayError = (item ? item.asset.file + ': ' : '') + e.message;
    }
    updateInfo();
    sendStatus();
  }

  video.onended = function () {
    if (showing && showing.asset.kind === 'video') send({ type: 'ended', cue: showing.cue });
  };

  // ---- Server state -------------------------------------------------------------------

  var lastState = null;

  function apply(state, fromDisk) {
    if (!state || state.type !== 'state') return;
    lastState = state;
    if (onDevice && !fromDisk) {
      // Remembered so the player can come back up on its own after a power cycle.
      fs.writeFile(CACHE_DIR + '/last-state.json', JSON.stringify(state), function () {});
    }

    cache.sync(state.assets || [], state.library || []);

    var current = state.current;
    var key = current ? state.cue + ':' + current.id : 'black';
    if (key === targetKey) {
      if (current && showing && showing.key === key) video.loop = current.loop;
      updateInfo();
      return;
    }
    targetKey = key;

    if (!current) {
      show(null, state.fadeMs);
    } else {
      // The previous item stays on screen until the new one is fully downloaded.
      cache.ensure(current, function (url) {
        if (targetKey !== key) return;
        show({ key: key, cue: state.cue, asset: current, url: url, loop: current.loop }, state.fadeMs);
      });
    }
    updateInfo();
    sendStatus();
  }

  // ---- Connection ---------------------------------------------------------------------

  var socket = null;
  var connected = false;
  var everConnected = false;

  function playerQuery() {
    return 'id=' + encodeURIComponent(device.id) + (config.name ? '&name=' + encodeURIComponent(config.name) : '');
  }

  function connect() {
    try {
      socket = new WebSocket(config.server.replace(/^http/, 'ws') + '/ws/player?' + playerQuery());
    } catch (e) {
      setTimeout(connect, RECONNECT_MS);
      return;
    }
    socket.onopen = function () {
      connected = everConnected = true;
      updateInfo();
      sendStatus();
    };
    socket.onmessage = function (event) {
      try { apply(JSON.parse(event.data)); } catch (e) { /* ignore a bad message */ }
    };
    socket.onclose = function () {
      connected = false;
      socket = null;
      updateInfo();
      setTimeout(connect, RECONNECT_MS);
    };
  }

  function send(message) {
    if (connected && socket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    } else if (config.server) {
      fetch(config.server + '/api/player/' + encodeURIComponent(device.id) + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      }).catch(function () { /* server unreachable; the next status report will retry */ });
    }
  }

  // Fallback for when the WebSocket cannot be established: plain polling.
  function poll() {
    if (connected || !config.server) return;
    fetch(config.server + '/api/player/' + encodeURIComponent(device.id) + '/state?' + playerQuery())
      .then(function (response) { return response.json(); })
      .then(function (state) { everConnected = true; apply(state); })
      .catch(function () { /* still unreachable */ });
  }

  function sendStatus() {
    if (!config.server) return;
    var counts = cache.counts();
    var active = cache.active;
    send({
      type: 'status',
      version: VERSION,
      model: device.model,
      os: device.os,
      storage: onDevice ? 'sd' : 'none',
      showing: showing ? showing.asset.id : null,
      cue: showing ? showing.cue : null,
      cached: counts.cached,
      total: counts.total,
      downloading: active ? { id: active.id, received: active.received, size: active.size } : null,
      error: displayError || cache.error
    });
  }

  // ---- Setup overlay ------------------------------------------------------------------

  var infoMessage = null;

  function setInfo(message) {
    infoMessage = message;
    updateInfo();
  }

  // Shown only while there is nothing to play, so an installer can see which player this is.
  function updateInfo() {
    var info = document.getElementById('info');
    var idle = !showing && !(lastState && lastState.current);
    var blackout = everConnected && lastState && lastState.assets && lastState.assets.length > 0;
    info.className = 'layer' + (idle && !blackout ? ' visible' : '');
    document.getElementById('info-id').textContent = device.id + (lastState && lastState.name !== device.id ? ' (' + lastState.name + ')' : '');
    document.getElementById('info-server').textContent = config.server || 'not configured';
    document.getElementById('info-status').textContent = infoMessage ||
      (!config.server ? 'Set "server" in config.json on the SD card.'
        : connected ? 'Connected. Assign a playlist to this player.'
        : everConnected ? 'Reconnecting…' : 'Connecting…');
  }

  // ---- Start --------------------------------------------------------------------------

  loadEnvironment();
  cache.init();
  updateInfo();

  if (onDevice) {
    try {
      apply(JSON.parse(fs.readFileSync(CACHE_DIR + '/last-state.json', 'utf8')), true);
    } catch (e) { /* first run */ }
  }

  if (config.server) {
    connect();
    setInterval(poll, RECONNECT_MS);
    setInterval(sendStatus, STATUS_INTERVAL_MS);
  }
})();
