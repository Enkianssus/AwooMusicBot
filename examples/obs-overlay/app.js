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
  var endpointHost = '127.0.0.1:' + port;
  var stateUrl = 'http://' + endpointHost + '/api/v1/state';
  var websocketUrl = 'ws://' + endpointHost + '/ws';

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
    currentCoverFallback: document.getElementById('current-cover-fallback'),
    playbackAlert: document.getElementById('playback-alert'),
    playbackState: document.getElementById('playback-state'),
    requestAlert: document.getElementById('request-alert'),
    requestState: document.getElementById('request-state'),
    queueCount: document.getElementById('queue-count'),
    queueList: document.getElementById('queue-list'),
    queueEmpty: document.getElementById('queue-empty'),
    lastUpdated: document.getElementById('last-updated')
  };

  var socket = null;
  var reconnectTimer = null;
  var pollTimer = null;
  var reconnectDelay = 1000;
  var websocketConnected = false;
  var lastState = null;

  window.addEventListener('awoo-overlay-settings', function (event) {
    var values = event.detail && event.detail.values && typeof event.detail.values === 'object'
      ? event.detail.values
      : {};
    if (Number.isFinite(Number(values.maxQueue))) {
      maxQueue = readMaxQueue(String(values.maxQueue));
      if (lastState) renderQueue(lastState);
    }
    var nextArtworkSource = readArtworkSource(values.artworkSource);
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

  function renderCurrent(state) {
    var song = state.current;
    if (!song) {
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
  }

  function renderQueue(state) {
    elements.queueCount.textContent = String(state.queueLength) + ' 首';
    elements.queueList.replaceChildren();
    var visibleQueue = state.queue.slice(0, maxQueue);
    elements.queueEmpty.hidden = visibleQueue.length !== 0;

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
    lastState = state;
    renderCurrent(state);
    setPlayerConnection(state);
    setSwitch(elements.playbackState, elements.playbackAlert, elements.playbackRegion, state.playing);
    setSwitch(elements.requestState, elements.requestAlert, elements.queueRegion, state.accepting);
    renderQueue(state);
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
      });
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollState();
    pollTimer = window.setInterval(pollState, 3000);
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
      if (lastState) renderState(lastState, 'websocket');
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
  startPolling();
  connectWebSocket();
}());
