(function () {
  'use strict';

  // The overlay deliberately uses only GET/fetch and a read-only WebSocket.
  // It never sends commands back to the point machine.
  var params = new URLSearchParams(window.location.search);
  var pagePort = Number.parseInt(window.location.port || '', 10);
  var port = readPort(
    params.get('port'),
    Number.isInteger(pagePort) ? pagePort : 5556
  );
  var maxQueue = readMaxQueue(params.get('maxQueue'));
  var artworkSource = readArtworkSource(params.get('artworkSource'));
  // A value written into the OBS source address wins over the Mod UI settings panel.
  var maxQueueFromUrl = params.has('maxQueue');
  var artworkSourceFromUrl = params.has('artworkSource');
  var endpointHost = '127.0.0.1:' + port;
  var stateUrl = 'http://' + endpointHost + '/api/v1/state';
  var websocketUrl = 'ws://' + endpointHost + '/ws';
  var hlsScriptPath = '/overlay/vendor/hls.min.js';

  var elements = {
    connection: document.getElementById('connection-status'),
    connectionLabel: document.getElementById('connection-label'),
    playbackRegion: document.getElementById('playback-region'),
    queueRegion: document.getElementById('queue-region'),
    playerStatus: document.getElementById('player-status'),
    playerLabel: document.getElementById('player-label'),
    currentTitle: document.getElementById('current-title'),
    currentArtist: document.getElementById('current-artist'),
    currentRequester: document.getElementById('current-requester'),
    currentRequesterName: document.getElementById('current-requester-name'),
    currentCoverFrame: document.getElementById('current-cover-frame'),
    currentCover: document.getElementById('current-cover'),
    currentCoverVideo: document.getElementById('current-cover-video'),
    currentCoverFallback: document.getElementById('current-cover-fallback'),
    playbackAlert: document.getElementById('playback-alert'),
    playbackState: document.getElementById('playback-state'),
    requestAlert: document.getElementById('request-alert'),
    requestState: document.getElementById('request-state'),
    queueCount: document.getElementById('queue-count'),
    queueList: document.getElementById('queue-list'),
    queueEmpty: document.getElementById('queue-empty'),
    queueNotifications: document.getElementById('queue-notifications'),
    lastUpdated: document.getElementById('last-updated')
  };

  var socket = null;
  var reconnectTimer = null;
  var pollTimer = null;
  var pollPending = false;
  var reconnectDelay = 1000;
  var websocketConnected = false;
  var lastState = null;
  var notificationTimer = null;
  var notificationClockOffset = 0;
  var latestNotificationSnapshotAt = null;
  var notificationNodes = new Map();
  var queueRenderKey = null;
  var currentArtworkKey = '';
  var dynamicArtworkKey = '';
  var dynamicArtworkSession = null;
  var hlsLoader = null;

  window.addEventListener('awoo-overlay-settings', function (event) {
    var values = event.detail && event.detail.values && typeof event.detail.values === 'object'
      ? event.detail.values
      : {};
    // The host may deliver the same settings again; only a real change re-renders.
    if (!maxQueueFromUrl && Number.isFinite(Number(values.maxQueue))) {
      var nextMaxQueue = readMaxQueue(String(values.maxQueue));
      if (nextMaxQueue !== maxQueue) {
        maxQueue = nextMaxQueue;
        if (lastState) renderQueue(lastState);
      }
    }
    var nextArtworkSource = artworkSourceFromUrl ? artworkSource : readArtworkSource(values.artworkSource);
    if (nextArtworkSource !== artworkSource) {
      artworkSource = nextArtworkSource;
      if (lastState) renderCurrent(lastState);
    }
  });

  function readPort(value, fallbackPort) {
    var parsed = Number.parseInt(value || '', 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
      ? parsed
      : fallbackPort;
  }

  function readMaxQueue(value) {
    var parsed = Number.parseInt(value || '', 10);
    if (!Number.isInteger(parsed)) return 3;
    return Math.min(30, Math.max(1, parsed));
  }

  function readArtworkSource(value) {
    return value === 'requester_avatar'
      ? 'requester_avatar'
      : 'album_cover';
  }

  function text(value, fallback) {
    if (value === null || value === undefined) return fallback || '';
    return String(value);
  }

  function firstText(values, fallback) {
    for (var i = 0; i < values.length; i += 1) {
      var value = values[i];
      if (value !== null && value !== undefined && String(value).trim() !== '') return String(value);
    }
    return fallback || '';
  }

  function asBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function switchEnabled(switchValue, legacyValue, fallback) {
    if (typeof switchValue.enabled === 'boolean') return switchValue.enabled;
    if (typeof legacyValue === 'boolean') return legacyValue;
    var state = text(switchValue.state, '').toLowerCase();
    if (state === 'active' || state === 'enabled' || state === 'running') return true;
    if (state === 'paused' || state === 'disabled' || state === 'stopped') return false;
    return fallback;
  }

  function normalizeSong(song) {
    if (!song || typeof song !== 'object') return null;
    return {
      id: firstText([song.id, song.Id], ''),
      title: firstText([song.title, song.SongName, song.name], '未知歌曲'),
      artist: firstText([song.artist, song.ArtistName], '未知歌手'),
      album: firstText([song.album, song.Album], ''),
      coverUrl: firstText([song.coverUrl, song.CoverUrl], ''),
      dynamicCoverUrl: firstText([song.dynamicCoverUrl, song.DynamicCoverUrl], ''),
      requestedBy: firstText([song.requestedBy, song.OrderedBy, song.requester], ''),
      requestedByAvatar: firstText([song.requestedByAvatar, song.OrderedByAvatar], '')
    };
  }

  function normalizeState(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var service = payload.service && typeof payload.service === 'object' ? payload.service : {};
    var requestIntake = service.requestIntake && typeof service.requestIntake === 'object'
      ? service.requestIntake
      : {};
    var queuePlayback = service.queuePlayback && typeof service.queuePlayback === 'object'
      ? service.queuePlayback
      : {};
    var accepting = switchEnabled(requestIntake, payload.accepting, false);
    var playing = switchEnabled(queuePlayback, typeof payload.playing === 'boolean' ? payload.playing : payload.playbackEnabled, false);
    var queue = Array.isArray(payload.queue) ? payload.queue.map(normalizeSong).filter(Boolean) : [];
    var queueLength = Number.isFinite(Number(payload.queueLength))
      ? Math.max(0, Number(payload.queueLength))
      : queue.length;
    var player = payload.player && typeof payload.player === 'object' ? payload.player : {};
    var connected = asBoolean(player.connected, asBoolean(payload.playerConnected, asBoolean(payload.cdpConnected, false)));
    return {
      timestamp: text(payload.timestamp, ''),
      current: normalizeSong(payload.current),
      currentIsRequested: payload.currentIsRequested === true,
      queue: queue,
      queueLength: queueLength,
      requestNotifications: normalizeRequestNotifications(payload.requestNotifications),
      accepting: accepting,
      acceptingState: text(requestIntake.state, accepting ? 'active' : 'paused'),
      playing: playing,
      playingState: text(queuePlayback.state, playing ? 'active' : 'paused'),
      playerConnected: connected,
      playerConnecting: player.connecting === true
    };
  }

  function setConnection(state, label) {
    elements.connection.dataset.state = state;
    elements.connectionLabel.textContent = label;
    elements.connectionLabel.hidden = state === 'connected';
    elements.connection.title = label;
    elements.connection.setAttribute('aria-label', label);
  }

  function normalizeRequestNotifications(values) {
    if (!Array.isArray(values)) return [];
    var notices = new Map();
    values.slice(-20).forEach(function (notice) {
      if (!notice || typeof notice !== 'object'
        || typeof notice.id !== 'string' || !notice.id.trim()
        || ['waiting', 'success', 'cancelled', 'error'].indexOf(notice.kind) === -1
        || typeof notice.title !== 'string' || typeof notice.message !== 'string'
        || typeof notice.requestedBy !== 'string'
        || typeof notice.createdAt !== 'number' || !Number.isFinite(notice.createdAt)
        || typeof notice.expiresAt !== 'number' || !Number.isFinite(notice.expiresAt)
        || notice.createdAt <= 0 || notice.expiresAt <= notice.createdAt) return;
      notices.set(notice.id, {
        id: notice.id,
        kind: notice.kind,
        action: notificationAction(notice.action),
        title: notice.title.trim() || '点歌请求',
        message: notice.message.trim(),
        requestedBy: notice.requestedBy.trim(),
        createdAt: notice.createdAt,
        expiresAt: notice.expiresAt
      });
    });
    return Array.from(notices.values());
  }

  function syncNotificationClock(timestamp) {
    var snapshotAt = Date.parse(timestamp);
    // Duplicate or stale snapshots must not restart the lifetime of a popup.
    if (!Number.isFinite(snapshotAt)
      || (latestNotificationSnapshotAt !== null && snapshotAt <= latestNotificationSnapshotAt)) return;
    latestNotificationSnapshotAt = snapshotAt;
    notificationClockOffset = snapshotAt - Date.now();
  }

  function notificationAction(value) {
    if (typeof value !== 'string') return '';
    // Actions added after this overlay are treated as requests, as documented.
    return ['request', 'cancel', 'remove'].indexOf(value) !== -1 ? value : 'request';
  }

  function notificationLabel(notice) {
    if (notice.kind === 'waiting') return '待处理';
    if (notice.kind === 'success') return '点歌成功';
    if (notice.kind === 'cancelled') return notice.action === 'remove' ? '主播已移出' : '撤回成功';
    if (notice.action) return notice.action === 'cancel' ? '撤回失败' : '点歌失败';
    // Hosts before 1.2.6 send no action; only their message tells withdrawals apart.
    return notice.message.indexOf('撤回') !== -1 ? '撤回失败' : '点歌失败';
  }

  function updateNotificationText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function renderRequestNotifications(state) {
    if (!elements.queueNotifications) return;
    if (notificationTimer !== null) {
      window.clearTimeout(notificationTimer);
      notificationTimer = null;
    }
    var now = Date.now() + notificationClockOffset;
    var active = state.requestNotifications.filter(function (notice) {
      return notice.expiresAt > now;
    }).sort(function (a, b) {
      return b.createdAt - a.createdAt;
    });
    // Pending requests can last minutes, so only the newest one takes a card.
    var waitingShown = false;
    var visible = active.filter(function (notice) {
      if (notice.kind !== 'waiting') return true;
      if (waitingShown) return false;
      waitingShown = true;
      return true;
    }).slice(0, 2);
    var visibleIds = new Set(visible.map(function (notice) { return notice.id; }));
    notificationNodes.forEach(function (entry, id) {
      if (!visibleIds.has(id)) {
        entry.card.remove();
        notificationNodes.delete(id);
      }
    });
    visible.forEach(function (notice, index) {
      var entry = notificationNodes.get(notice.id);
      if (!entry) {
        var card = document.createElement('div');
        card.className = 'request-notification';
        var status = document.createElement('span');
        status.className = 'request-notification-status';
        var title = document.createElement('p');
        title.className = 'request-notification-title';
        var message = document.createElement('p');
        message.className = 'request-notification-message';
        card.append(status, title, message);
        entry = { card: card, status: status, title: title, message: message };
        notificationNodes.set(notice.id, entry);
      }
      var label = notificationLabel(notice);
      // A removal always comes from the streamer, which its message already says.
      var requester = notice.action === 'remove' ? '' : notice.requestedBy;
      var detail = [requester, notice.message].filter(Boolean).join(' · ');
      entry.card.dataset.kind = notice.kind;
      entry.card.title = [label, notice.title, detail].filter(Boolean).join(' · ');
      updateNotificationText(entry.status, label);
      updateNotificationText(entry.title, notice.title);
      updateNotificationText(entry.message, detail);
      entry.message.hidden = !detail;
      // Keep existing nodes in place so repeated state broadcasts remain quiet.
      var current = elements.queueNotifications.children[index];
      if (current !== entry.card) elements.queueNotifications.insertBefore(entry.card, current || null);
    });
    elements.queueNotifications.hidden = visible.length === 0;
    elements.queueRegion.dataset.hasNotices = visible.length ? 'true' : 'false';
    if (active.length) {
      var nextExpiry = Math.min.apply(null, active.map(function (notice) { return notice.expiresAt; }));
      notificationTimer = window.setTimeout(function () {
        notificationTimer = null;
        if (lastState) renderRequestNotifications(lastState);
      }, Math.min(2147483647, Math.max(1, nextExpiry - now)));
    }
  }

  function setPlayerConnection(state) {
    var playerState = state.playerConnected ? 'connected' : (state.playerConnecting ? 'connecting' : 'offline');
    var label = state.playerConnected
      ? '播放器已连接'
      : (state.playerConnecting ? '播放器连接中' : '播放器未连接');
    elements.playerStatus.dataset.state = playerState;
    elements.playerLabel.textContent = label;
    elements.playerStatus.hidden = state.playerConnected || state.playerConnecting;
  }

  function setSwitch(element, alertElement, regionElement, enabled) {
    element.dataset.enabled = enabled ? 'true' : 'false';
    element.textContent = enabled ? '运行中' : '已暂停';
    alertElement.hidden = enabled;
    regionElement.dataset.paused = enabled ? 'false' : 'true';
  }

  function safeCoverUrl(value) {
    var candidate = text(value, '').trim();
    if (!candidate) return '';
    try {
      var url = new URL(candidate, window.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (_error) {
      return '';
    }
  }

  function currentArtworkCandidates(song, state) {
    var candidates = artworkSource === 'requester_avatar'
      && state.currentIsRequested
      ? [
          { kind: 'requester_avatar', value: song.requestedByAvatar },
          { kind: 'album_cover', value: song.coverUrl }
        ]
      : [{ kind: 'album_cover', value: song.coverUrl }];
    return candidates
      .map(function (candidate) {
        return { kind: candidate.kind, url: safeCoverUrl(candidate.value) };
      })
      .filter(function (candidate, index, values) {
        return Boolean(candidate.url) && values.map(function (item) {
          return item.url;
        }).indexOf(candidate.url) === index;
      });
  }

  function renderCurrentArtwork(candidates) {
    var key = JSON.stringify(candidates);
    if (key === currentArtworkKey) return;
    currentArtworkKey = key;
    var index = 0;
    function showNext() {
      if (index >= candidates.length) {
        elements.currentCoverFrame.dataset.artworkKind = 'fallback';
        elements.currentCover.hidden = true;
        elements.currentCover.removeAttribute('src');
        elements.currentCoverFallback.hidden = false;
        return;
      }
      var candidate = candidates[index];
      index += 1;
      elements.currentCoverFrame.dataset.artworkKind = candidate.kind;
      elements.currentCover.hidden = false;
      elements.currentCoverFallback.hidden = true;
      elements.currentCover.src = candidate.url;
    }
    elements.currentCover.alt = '';
    elements.currentCover.onerror = showNext;
    showNext();
  }

  function stopDynamicArtwork() {
    var active = dynamicArtworkSession;
    dynamicArtworkSession = null;
    var video = elements.currentCoverVideo;
    if (video) video.hidden = true;
    elements.currentCoverFrame.dataset.dynamicCover = 'false';
    if (!active) return;
    window.clearTimeout(active.timer);
    video.removeEventListener('canplay', active.ready);
    video.removeEventListener('playing', active.playing);
    video.removeEventListener('waiting', active.waiting);
    video.removeEventListener('stalled', active.stalled);
    video.removeEventListener('error', active.fail);
    if (active.hls) active.hls.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  // hls.js is about 600 KB, so it loads only once a track has an HLS motion cover.
  // Callbacks run once the script settles; on failure window.Hls stays empty.
  function loadHls(callback) {
    if (window.Hls || (hlsLoader && hlsLoader.settled)) {
      callback();
      return;
    }
    if (hlsLoader) {
      hlsLoader.callbacks.push(callback);
      return;
    }
    var loader = { settled: false, callbacks: [callback] };
    hlsLoader = loader;
    function settle() {
      if (loader.settled) return;
      loader.settled = true;
      loader.callbacks.splice(0).forEach(function (next) { next(); });
    }
    try {
      var script = document.createElement('script');
      script.onload = settle;
      script.onerror = settle;
      script.src = hlsScriptPath;
      (document.head || document.documentElement).appendChild(script);
    } catch (_error) {
      settle();
    }
  }

  function renderDynamicArtwork(song, state) {
    var url = song
      && !(artworkSource === 'requester_avatar' && state.currentIsRequested)
      ? safeCoverUrl(song.dynamicCoverUrl)
      : '';
    var key = url ? JSON.stringify([song.id, song.title, song.artist, url]) : '';
    // Keep a failed key too: broadcasts should not retry broken media every 250ms.
    if (key === dynamicArtworkKey) return;
    dynamicArtworkKey = key;
    stopDynamicArtwork();
    var video = elements.currentCoverVideo;
    if (!url || !video || typeof video.play !== 'function'
      || typeof video.pause !== 'function' || typeof video.load !== 'function'
      || typeof video.addEventListener !== 'function'
      || typeof video.removeEventListener !== 'function') return;

    var active = { hls: null, timer: null, ready: null, playing: null, waiting: null, stalled: null, fail: null, starting: false };
    dynamicArtworkSession = active;
    active.fail = function () {
      if (dynamicArtworkSession === active) stopDynamicArtwork();
    };
    active.waiting = function () {
      if (dynamicArtworkSession !== active || active.timer !== null) return;
      active.timer = window.setTimeout(active.fail, 10000);
    };
    active.stalled = function () {
      // A download stall does not interrupt playback while future frames remain buffered.
      if (video.readyState < 3) active.waiting();
    };
    function showVideo() {
      if (dynamicArtworkSession !== active) return;
      window.clearTimeout(active.timer);
      active.timer = null;
      video.hidden = false;
      elements.currentCoverFrame.dataset.dynamicCover = 'true';
    }
    active.playing = showVideo;
    active.ready = function () {
      if (dynamicArtworkSession !== active || active.starting) return;
      active.starting = true;
      try {
        var playing = video.play();
        if (playing && typeof playing.then === 'function') {
          playing.then(showVideo, active.fail);
        } else {
          showVideo();
        }
      } catch (_error) {
        active.fail();
      }
    };
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('canplay', active.ready);
    video.addEventListener('playing', active.playing);
    video.addEventListener('waiting', active.waiting);
    video.addEventListener('stalled', active.stalled);
    video.addEventListener('error', active.fail);
    active.waiting();
    var isHls = /\.m3u8(?:$|[?#])/i.test(url);
    function attachSource() {
      try {
        var nativeHls = typeof video.canPlayType === 'function'
          && video.canPlayType('application/vnd.apple.mpegurl');
        var Hls = window.Hls;
        var useHls = isHls && Hls && typeof Hls.isSupported === 'function' && Hls.isSupported();
        // Chromium can advertise native HLS without actually advancing playback.
        // Prefer MSE when available; native HLS remains the fallback for other browsers.
        if (useHls) {
          active.hls = new Hls({
            enableWorker: false,
            capLevelToPlayerSize: true,
            startLevel: 0,
            maxBufferLength: 20,
            maxMaxBufferLength: 30
          });
          active.hls.on(Hls.Events.ERROR, function (_event, data) {
            if (data && data.fatal) active.fail();
          });
          active.hls.on(Hls.Events.MEDIA_ATTACHED, function () {
            if (dynamicArtworkSession === active) active.hls.loadSource(url);
          });
          active.hls.attachMedia(video);
        } else if (!isHls || nativeHls) {
          video.src = url;
          video.load();
        } else {
          active.fail();
        }
      } catch (_error) {
        active.fail();
      }
    }
    if (isHls && !window.Hls) {
      // The static cover stays while hls.js loads; a newer track replaces this session.
      loadHls(function () {
        if (dynamicArtworkSession === active) attachSource();
      });
    } else {
      attachSource();
    }
  }

  function renderCurrent(state) {
    var song = state.current;
    if (!song) {
      renderDynamicArtwork(null, state);
      currentArtworkKey = '';
      elements.currentTitle.textContent = '等待播放';
      elements.currentArtist.textContent = '暂无歌曲';
      elements.currentRequester.hidden = true;
      elements.currentRequesterName.textContent = '';
      elements.currentCoverFrame.dataset.artworkKind = 'fallback';
      elements.currentCover.hidden = true;
      elements.currentCover.onerror = null;
      elements.currentCover.removeAttribute('src');
      elements.currentCoverFallback.hidden = false;
      return;
    }

    elements.currentTitle.textContent = song.title;
    elements.currentArtist.textContent = song.artist;
    var requester = song.requestedBy;
    elements.currentRequester.hidden = !state.currentIsRequested || !requester;
    elements.currentRequesterName.textContent = requester;
    renderCurrentArtwork(currentArtworkCandidates(song, state));
    renderDynamicArtwork(song, state);
  }

  function renderQueue(state) {
    elements.queueCount.textContent = String(state.queueLength) + ' 首';
    var visibleQueue = state.queue.slice(0, maxQueue);
    elements.queueEmpty.hidden = visibleQueue.length !== 0;
    // Broadcasts for notices or player status keep the rows when nothing visible changed.
    var key = JSON.stringify(visibleQueue.map(function (song) {
      return [song.title, song.artist, song.requestedBy];
    }));
    if (key === queueRenderKey) return;
    queueRenderKey = key;
    elements.queueList.replaceChildren();

    visibleQueue.forEach(function (song, index) {
      var item = document.createElement('li');
      item.className = 'queue-item';

      var queueIndex = document.createElement('span');
      queueIndex.className = 'queue-index';
      queueIndex.textContent = String(index + 1).padStart(2, '0');

      var copy = document.createElement('div');
      copy.className = 'queue-song';
      var title = document.createElement('p');
      title.className = 'queue-title';
      title.textContent = song.title;
      var artist = document.createElement('p');
      artist.className = 'queue-artist';
      artist.textContent = song.artist;
      copy.append(title, artist);

      var requester = document.createElement('span');
      requester.className = 'queue-meta';
      requester.textContent = song.requestedBy ? '点歌：' + song.requestedBy : '代播';

      item.append(queueIndex, copy, requester);
      elements.queueList.append(item);
    });
  }

  function formatTimestamp(value) {
    if (!value) return '状态已更新';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '状态已更新';
    return '更新于 ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderState(rawState, transport) {
    var state = normalizeState(rawState);
    if (!state) return;
    var snapshotAt = Date.parse(state.timestamp);
    if (lastState && latestNotificationSnapshotAt !== null
      && Number.isFinite(snapshotAt) && snapshotAt < latestNotificationSnapshotAt) {
      // An HTTP request started before a WS update can finish after it.
      state.requestNotifications = lastState.requestNotifications;
    }
    lastState = state;
    syncNotificationClock(state.timestamp);
    renderCurrent(state);
    setPlayerConnection(state);
    setSwitch(elements.playbackState, elements.playbackAlert, elements.playbackRegion, state.playing);
    setSwitch(elements.requestState, elements.requestAlert, elements.queueRegion, state.accepting);
    renderQueue(state);
    renderRequestNotifications(state);
    elements.lastUpdated.textContent = formatTimestamp(state.timestamp);

    if (transport === 'websocket') {
      setConnection('connected', 'WebSocket 已连接');
    } else if (!websocketConnected) {
      setConnection('polling', 'HTTP 轮询中');
    }
  }

  function parseStateMessage(rawMessage) {
    try {
      var payload = JSON.parse(rawMessage);
      if (payload && payload.type === 'state') return payload.data;
      // Accept a raw state object as a small convenience for local tooling.
      return payload;
    } catch (_error) {
      return null;
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollState(forceSnapshot) {
    var force = forceSnapshot === true;
    if (websocketConnected && !force) return;
    // A slow reply must not pile up more requests behind the 1 s interval.
    if (pollPending && !force) return;
    pollPending = true;
    fetch(stateUrl, { method: 'GET', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (!websocketConnected || force) {
          renderState(payload, websocketConnected ? 'websocket' : 'http');
        }
      })
      .catch(function () {
        if (!websocketConnected) setConnection('offline', '接口未连接');
      })
      .then(function () {
        pollPending = false;
      });
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollState();
    // Request notices are short-lived, so poll quickly until WebSocket returns.
    pollTimer = window.setInterval(pollState, 1000);
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connectWebSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(15000, reconnectDelay * 2);
  }

  function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    setConnection('connecting', '连接中…');
    try {
      socket = new WebSocket(websocketUrl);
    } catch (_error) {
      websocketConnected = false;
      startPolling();
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', function () {
      websocketConnected = true;
      reconnectDelay = 1000;
      stopPolling();
      setConnection('connected', 'WebSocket 已连接');
      // A newly connected WebSocket may not receive a message until state
      // changes, so always seed it with one current read-only HTTP snapshot.
      pollState(true);
    });
    socket.addEventListener('message', function (event) {
      var payload = parseStateMessage(event.data);
      if (payload) renderState(payload, 'websocket');
    });
    socket.addEventListener('error', function () {
      // The close event owns fallback/retry handling; keep this callback quiet.
    });
    socket.addEventListener('close', function () {
      websocketConnected = false;
      socket = null;
      startPolling();
      setConnection('polling', 'HTTP 轮询中');
      scheduleReconnect();
    });
  }

  // HTTP starts immediately so the overlay still shows data while WS is connecting.
  window.addEventListener('pagehide', stopDynamicArtwork);
  startPolling();
  connectWebSocket();
}());
