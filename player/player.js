// CueSign player.
//
// Asks a CueSign server what to show, downloads the media to local storage, then displays
// it. Runs on a BrightSign (Node.js enabled, media cached on the SD card) and, for
// previewing, in a desktop browser at http://<server>/player/ (no cache, media is streamed).
//
// A new player has no server. It announces itself on the network until a server pairs with
// it, then remembers that server on the SD card.
//
// Written without newer syntax (optional chaining etc.) so it runs on older BrightSign OS.

(function () {
  'use strict';

  var VERSION = '0.3.0';
  // The override exists so the caching code can be exercised with plain Node off the device.
  var SD_ROOT = (typeof process !== 'undefined' && process.env && process.env.CUESIGN_SD_ROOT) || '/storage/sd';
  var CACHE_DIR = SD_ROOT + '/cuesign-cache';
  var CACHE_URL = 'cuesign-cache/'; // relative to index.html, which sits in the SD card root
  var PAIRING_FILE = SD_ROOT + '/cuesign-pairing.json';
  var DISCOVERY_PORT = 48550;
  var ANNOUNCE_MS = 2000;
  var LOST_SERVER_MS = 6000;
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
  var pairing = null;       // { serverId, server } once a server has paired with this player
  var fixedServer = false;  // true when config.json pins the server address, bypassing pairing

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
      // config.json is optional: it pins the server address where discovery is blocked.
      try {
        if (fs.existsSync(SD_ROOT + '/config.json')) {
          var file = JSON.parse(fs.readFileSync(SD_ROOT + '/config.json', 'utf8'));
          config.server = file.server || null;
          config.name = file.name || null;
          fixedServer = !!config.server;
        }
      } catch (e) {
        setInfo('Cannot read config.json on the SD card: ' + e.message);
      }
      if (!fixedServer) {
        try {
          pairing = JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf8'));
          config.server = pairing.server;
        } catch (e) {
          pairing = null; // not paired yet
        }
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
            cache.ready[file.slice(0, 64)] = CACHE_URL + file;
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
          cache.ready[next.id] = CACHE_URL + next.file;
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
          fs.unlinkSync(CACHE_DIR + '/' + cache.ready[id].slice(CACHE_URL.length));
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
    // Reported against the cue the server is on now, which may be later than the one the video started on.
    if (showing && showing.asset.kind === 'video') send({ type: 'ended', cue: lastState ? lastState.cue : showing.cue });
  };

  // ---- Self-update --------------------------------------------------------------------
  //
  // The server lists the player files it ships, with hashes. If ours differ, download the new
  // ones to the SD card and restart on them, so a fix never needs the card pulled.
  // TODO(production): reconsider before a final release; see the README.

  var updateTried = {};     // server software versions already attempted since this page loaded
  var updating = false;
  var updateError = null;

  function hashOfLocalFile(name) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(SD_ROOT + '/' + name)).digest('hex');
    } catch (e) {
      return null; // missing
    }
  }

  // Downloads one player file next to the real one as "<name>.update", verified by hash.
  function stageUpdate(file, done) {
    var staged = SD_ROOT + '/' + file.name + '.update';
    var url = config.server + '/player/' + file.name;
    var hash = crypto.createHash('sha256');
    var output = fs.createWriteStream(staged);
    var finished = false;
    function finish(err) {
      if (finished) return;
      finished = true;
      if (err) { try { output.destroy(); } catch (e) { /* ignore */ } }
      done(err);
    }
    var request = (url.indexOf('https:') === 0 ? https : http).get(url, function (response) {
      if (response.statusCode !== 200) return finish(new Error('HTTP ' + response.statusCode + ' for ' + file.name));
      response.on('data', function (chunk) { hash.update(chunk); });
      response.on('aborted', function () { finish(new Error('connection lost')); });
      response.on('error', finish);
      response.pipe(output);
    });
    request.on('error', finish);
    request.setTimeout(30000, function () { request.abort(); finish(new Error('timed out')); });
    output.on('error', finish);
    output.on('finish', function () {
      finish(hash.digest('hex') === file.sha256 ? null : new Error('checksum mismatch for ' + file.name));
    });
  }

  function checkForUpdate(software) {
    if (!onDevice || updating || !software || !software.files || updateTried[software.version]) return;
    var stale = software.files.filter(function (file) {
      return /^[A-Za-z0-9._-]+$/.test(file.name) && hashOfLocalFile(file.name) !== file.sha256;
    });
    if (!stale.length) return;

    updateTried[software.version] = true; // one attempt per page load, so a bad update cannot loop
    updating = true;
    updateError = null;
    sendStatus();

    var index = 0;
    (function next(err) {
      if (err) {
        stale.forEach(function (file) { try { fs.unlinkSync(SD_ROOT + '/' + file.name + '.update'); } catch (e) { /* not staged */ } });
        updating = false;
        updateError = 'Player update failed: ' + err.message;
        sendStatus();
        return;
      }
      if (index < stale.length) return stageUpdate(stale[index++], next);

      // Everything downloaded and verified: swap the files in, then restart on them.
      try {
        stale.forEach(function (file) { fs.renameSync(SD_ROOT + '/' + file.name + '.update', SD_ROOT + '/' + file.name); });
      } catch (e) {
        return next(e);
      }
      var needsReboot = stale.some(function (file) { return file.name === 'autorun.brs'; });
      try {
        if (needsReboot) {
          var System = require('@brightsign/system');
          new System().reboot();
          return;
        }
      } catch (e) { /* fall back to reloading the page */ }
      if (location.reload) location.reload();
    })(null);
  }

  // ---- Server state -------------------------------------------------------------------

  var lastState = null;

  function apply(state, fromDisk) {
    if (!state || state.type !== 'state') return;
    lastState = state;
    if (onDevice && !fromDisk) {
      // Remembered so the player can come back up on its own after a power cycle.
      fs.writeFile(CACHE_DIR + '/last-state.json', JSON.stringify(state), function () {});
    }
    if (!fromDisk) checkForUpdate(state.software);

    cache.sync(state.assets || [], state.library || []);

    var current = state.current;
    // The server changes current.key only when the item should (re)start; an item held across
    // cues keeps its key and so keeps playing.
    var key = current ? (current.key !== undefined ? current.key : state.cue) + ':' + current.id : 'black';
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
  var connection = 0;       // bumped whenever the current socket is abandoned
  var reconnectTimer = null;
  var disconnectedSince = Date.now();

  function playerQuery() {
    return 'id=' + encodeURIComponent(device.id) + (config.name ? '&name=' + encodeURIComponent(config.name) : '');
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (!config.server) return;
    var mine = ++connection;
    var ws;
    try {
      ws = new WebSocket(config.server.replace(/^http/, 'ws') + '/ws/player?' + playerQuery());
    } catch (e) {
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
      return;
    }
    socket = ws;
    ws.onopen = function () {
      if (mine !== connection) return;
      connected = everConnected = true;
      updateInfo();
      sendStatus();
    };
    ws.onmessage = function (event) {
      if (mine !== connection) return;
      var message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      if (message.type === 'unpair') unpair(); else apply(message);
    };
    ws.onclose = function () {
      if (mine !== connection) return;
      connected = false;
      socket = null;
      disconnectedSince = Date.now();
      updateInfo();
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };
  }

  function disconnect() {
    connection++;
    clearTimeout(reconnectTimer);
    try { if (socket) socket.close(); } catch (e) { /* already closed */ }
    socket = null;
    connected = false;
    disconnectedSince = Date.now();
  }

  // The server has let this player go: forget it and wait to be paired again.
  function unpair() {
    disconnect();
    if (fixedServer || !onDevice) {
      // Nothing to forget: the address comes from config.json or the page URL.
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
      return;
    }
    pairing = null;
    config.server = null;
    everConnected = false;
    try { fs.unlinkSync(PAIRING_FILE); } catch (e) { /* already gone */ }
    try { fs.unlinkSync(CACHE_DIR + '/last-state.json'); } catch (e) { /* already gone */ }
    lastState = null;
    targetKey = null;
    show(null, 0);
    updateInfo();
  }

  // ---- Discovery and pairing ----------------------------------------------------------

  // Every address worth broadcasting to: the limited broadcast plus each subnet's own.
  function broadcastAddresses() {
    var addresses = ['255.255.255.255'];
    var interfaces = require('os').networkInterfaces();
    Object.keys(interfaces).forEach(function (name) {
      interfaces[name].forEach(function (net) {
        if ((net.family !== 'IPv4' && net.family !== 4) || net.internal || !net.netmask) return;
        var ip = net.address.split('.'), mask = net.netmask.split('.');
        var broadcast = ip.map(function (part, i) { return (part | (~mask[i] & 255)); }).join('.');
        if (addresses.indexOf(broadcast) < 0) addresses.push(broadcast);
      });
    });
    return addresses;
  }

  function startDiscovery() {
    if (!onDevice || fixedServer) return;
    var udp;
    try {
      udp = require('dgram').createSocket('udp4');
    } catch (e) {
      setInfo('Cannot start discovery: ' + e.message);
      return;
    }
    udp.on('error', function () { /* keep announcing; the network may not be up yet */ });

    udp.on('message', function (data) {
      var message;
      try { message = JSON.parse(data.toString()); } catch (e) { return; }
      if (!message || message.cuesign !== 1 || message.type !== 'pair') return;
      if (!message.serverId || !/^https?:\/\//.test(message.url)) return;
      if (pairing && pairing.serverId !== message.serverId) return; // belongs to another server

      var server = String(message.url).replace(/\/+$/, '');
      if (pairing && pairing.server === server) return; // nothing new; already retrying that address
      pairing = { serverId: message.serverId, server: server };
      try {
        fs.writeFileSync(PAIRING_FILE, JSON.stringify(pairing));
      } catch (e) {
        setInfo('Cannot save pairing to the SD card: ' + e.message);
      }
      config.server = server;
      disconnect();
      connect();
      updateInfo();
    });

    // Unpaired: announce until a server pairs with us. Paired but the server has been gone a
    // while: announce with its id, so it can answer from a new address.
    function announce() {
      if (connected) return;
      if (pairing && Date.now() - disconnectedSince < LOST_SERVER_MS) return;
      var message = Buffer.from(JSON.stringify({
        cuesign: 1,
        type: 'announce',
        id: device.id,
        model: device.model,
        os: device.os,
        version: VERSION,
        serverId: pairing ? pairing.serverId : null
      }));
      try {
        broadcastAddresses().forEach(function (address) {
          udp.send(message, 0, message.length, DISCOVERY_PORT, address, function () { /* retried next round */ });
        });
      } catch (e) { /* network not ready */ }
    }

    udp.bind(0, function () {
      udp.setBroadcast(true);
      announce();
      setInterval(announce, ANNOUNCE_MS);
    });
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
    var server = config.server;
    fetch(server + '/api/player/' + encodeURIComponent(device.id) + '/state?' + playerQuery())
      .then(function (response) { return response.json(); })
      .then(function (state) {
        if (config.server !== server) return; // unpaired or re-paired while this was in flight
        everConnected = true;
        apply(state);
      })
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
      link: !onDevice ? 'preview' : fixedServer ? 'fixed' : 'paired',
      showing: showing ? showing.asset.id : null,
      cue: showing ? showing.cue : null,
      cached: counts.cached,
      total: counts.total,
      downloading: active ? { id: active.id, received: active.received, size: active.size } : null,
      updating: updating,
      error: updateError || displayError || cache.error
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
    document.getElementById('info-server').textContent = config.server || 'not paired';
    document.getElementById('info-status').textContent = infoMessage ||
      (!config.server ? 'Waiting to be paired. Open CueSign on the server and choose Pair on the Players tab.'
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

  startDiscovery();
  connect();
  setInterval(poll, RECONNECT_MS);
  setInterval(sendStatus, STATUS_INTERVAL_MS);
})();
