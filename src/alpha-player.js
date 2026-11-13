// 알파의 실제 강의실에서만 동작한다. 정상 video 재생만 제어하고 진도/시간 API는 호출하지 않는다.
(() => {
  'use strict';
  const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  const ancestors = location.ancestorOrigins;
  const inHost = window.top !== window && window.parent === window.top && ancestors?.length === 1 && ancestors[0] === EXTENSION_ORIGIN;
  // 사용자가 연 일반 강의실 탭은 제어하지 않는다. 숨겨진 확장 호스트의 직접 자식만 실행한다.
  if (!inHost || location.origin !== 'https://alpha-campus.kr' ||
      location.pathname !== '/my/classRoom/classRoomDetail') return;
  if (window.__alphaAutoPlayer) return;
  window.__alphaAutoPlayer = true;

  let ownedMedia = null;
  let runId = null;
  let blockedRunId = null;
  let stoppedVersion = 0;
  let sending = false;
  let pending = false;
  let startedAt = Date.now();
  let lastUrl = location.href;
  let playError = '';
  let lastPlayedMedia = null;
  let notices = [];
  const wired = new WeakSet();
  const TAG = 'alpha-offscreen-player';
  const waiting = new Map();
  let requestNumber = 0;

  window.addEventListener('message', event => {
    if (event.origin === EMBED_ORIGIN) { embedMessage(event); return; }
    if (event.source !== window.parent || event.origin !== EXTENSION_ORIGIN ||
        event.data?.tag !== TAG || event.data.type !== 'response') return;
    const resolve = waiting.get(event.data.requestId);
    if (resolve) resolve(event.data.response);
  });

  function sendHeartbeat(payload) {
    return new Promise(resolve => {
      const requestId = `${Date.now()}-${++requestNumber}`;
      const timeout = setTimeout(() => finish(null), 4000);
      const finish = response => { clearTimeout(timeout); waiting.delete(requestId); resolve(response); };
      waiting.set(requestId, finish);
      window.parent.postMessage({ tag: TAG, type: 'heartbeat', requestId, ...payload }, EXTENSION_ORIGIN);
    });
  }

  const hasSource = media => !!(media?.currentSrc || media?.getAttribute('src') || media?.readyState > 0);

  function sameOriginDocument(frame) {
    try {
      if (frame.contentDocument && frame.contentWindow.location.origin === location.origin) return frame.contentDocument;
    } catch { /* 외부 플레이어는 사용자의 확인 대상으로 둔다. */ }
    return null;
  }

  // 사이트의 서비스 워커(/sw.js)는 플레이어 페이지를 미리 저장해 두고 네트워크 없이 응답한다. 그 응답에는 확장의
  // 프레임 허용 규칙(X-Frame-Options 제거)이 적용되지 않아, 숨겨진 플레이어 안에서는 프레임이 차단된다.
  // 저장본과 주소가 달라지도록 표시를 붙여 다시 열면 네트워크로 요청되어 규칙이 적용되고,
  // 사이트는 프레임이 다시 열릴 때 영상 정보를 다시 전달한다.
  const PLAYER_PATH = '/catenoid.html';
  const NETWORK_MARK = 'reload';
  const blockedSince = new WeakMap();

  function reopenBlockedPlayerFrames() {
    for (const frame of document.querySelectorAll('iframe')) {
      let url;
      try { url = new URL(frame.getAttribute('src') || '', location.href); } catch { continue; }
      if (url.origin !== location.origin || url.pathname !== PLAYER_PATH || url.searchParams.has(NETWORK_MARK)) continue;
      if (sameOriginDocument(frame)) { blockedSince.delete(frame); continue; }
      // 정상적으로 불러오는 중인 프레임은 건드리지 않도록, 잠시 뒤에도 열리지 않은 경우에만 다시 연다.
      const since = blockedSince.get(frame);
      if (since === undefined) {
        blockedSince.set(frame, Date.now());
        setTimeout(reopenBlockedPlayerFrames, 1500);
      } else if (Date.now() - since >= 1200) {
        url.searchParams.set(NETWORK_MARK, '1');
        frame.src = url.pathname + url.search;
      }
    }
  }

  function mediaIn(doc, depth = 0) {
    const candidates = [...doc.querySelectorAll('video, audio')];
    const direct = candidates.find(hasSource);
    if (direct) return direct;
    if (depth < 2) for (const frame of doc.querySelectorAll('iframe')) {
      const inner = sameOriginDocument(frame);
      const media = inner && mediaIn(inner, depth + 1);
      if (media) return media;
    }
    // Video.js가 소스를 연결하는 중인 플레이어와 플레이어 자체가 없는 경우를 구분한다.
    return candidates[0] || null;
  }

  // 웹영상(유튜브 등)은 사이트 플레이어가 <video> 없이 재생한다. 플레이어 프레임의 페이지 스크립트
  // (alpha-player-page.js)에 상태 조회·재생·정지만 요청하고, 아래에서 <video>와 같은 모양으로 다룬다.
  const PLAYER_COMMAND = 'alpha-auto-player-command';
  const PLAYER_EVENT = 'alpha-auto-player-event';
  const PLAYER_ATTRIBUTE = 'data-alpha-auto-player';
  const sitePlayers = new WeakMap();

  function askSitePlayer(doc, command) {
    try {
      const root = doc.documentElement;
      root.removeAttribute(PLAYER_ATTRIBUTE);
      doc.dispatchEvent(new CustomEvent(PLAYER_COMMAND, { detail: command }));
      const state = JSON.parse(root.getAttribute(PLAYER_ATTRIBUTE) || 'null');
      return state?.ready ? state : null;
    } catch { return null; }
  }

  function sitePlayerFor(doc) {
    const state = askSitePlayer(doc, 'state');
    // <video>로 재생하는 플레이어는 요소를 직접 제어하는 기존 방식을 유지한다.
    if (!state || !state.tech || state.tech === 'Html5') return null;
    let player = sitePlayers.get(doc);
    if (!player) {
      let attempts = 0;
      let started = false;
      player = {
        sitePlayer: true,
        getAttribute: () => '',
        update(next) {
          this.currentSrc = next.source ? 'site-player' : '';
          this.readyState = next.readyState;
          this.paused = next.paused;
          this.ended = next.ended;
          this.currentTime = next.currentTime;
          this.duration = next.duration;
          this.error = next.error ? { message: next.error } : null;
          if (!next.paused) started = true;
          return this;
        },
        addEventListener(type, listener) { if (type === 'ended') doc.addEventListener(PLAYER_EVENT, () => listener()); },
        set muted(value) { askSitePlayer(doc, value ? 'mute' : 'unmute'); },
        set playbackRate(_) { askSitePlayer(doc, 'rate'); },
        // 사이트가 첫 재생 전 로딩 단계에서 한 번 정지시킬 수 있어, 재생이 시작되기 전까지만 몇 번 다시 요청한다.
        canRetryPlay: () => !started && attempts < 3,
        async play() { attempts++; const next = askSitePlayer(doc, 'play'); if (next) this.update(next); },
        pause() { const next = askSitePlayer(doc, 'pause'); if (next) this.update(next); },
      };
      sitePlayers.set(doc, player);
    }
    return player.update(state);
  }

  function sitePlayerIn(doc, depth = 0) {
    const own = sitePlayerFor(doc);
    if (own) return own;
    if (depth < 2) for (const frame of doc.querySelectorAll('iframe')) {
      const inner = sameOriginDocument(frame);
      const player = inner && sitePlayerIn(inner, depth + 1);
      if (player) return player;
    }
    return null;
  }

  // 저작도구 차시(유형 15, 사이트 표기 "인터랙티브")는 강의실이 다른 출처(make.alpha-campus.kr)의 플레이어 프레임을 띄운다.
  // 실제 값(2026-11-13): 영상 파일 하나를 감싼 플레이어이고, 상호작용은 영상 끝의 링크·이미지뿐이다.
  // 그 프레임의 alpha-embed-player.js가 <video> 상태를 알려 주고 재생·정지 요청만 받는다. 진도는 사이트가 기록한다.
  const EMBED_ORIGIN = 'https://make.alpha-campus.kr';
  const EMBED_PATH = '/bubble/embed/';
  const EMBED_TAG = 'alpha-embed-player';
  const embeds = new WeakMap();

  function embedFrames() {
    return [...document.querySelectorAll('iframe')].filter(frame => {
      try {
        const url = new URL(frame.getAttribute('src') || '', location.href);
        return url.origin === EMBED_ORIGIN && url.pathname.startsWith(EMBED_PATH);
      } catch { return false; }
    });
  }

  // 사이트는 이 차시의 진도를 실제로 본 구간의 합으로 계산하고, 다시 열면 마지막으로 본 위치에서 이어 재생한다.
  // 그 앞에 보지 않은 구간이 남아 있으면 끝까지 봐도 완료되지 않으므로, 아직 보지 않은 첫 지점(초)을 찾아 거기서부터 본다.
  // segments: 사이트 플레이어가 알려 주는 "시작[.]끝[,]시작[.]끝" 형식. 모두 봤거나 길이를 모르면 null.
  function firstUnwatched(segments, duration) {
    if (!(duration > 0)) return null;
    const pairs = String(segments || '').split('[,]').map(item => item.split('[.]').map(Number))
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
      .sort((one, two) => one[0] - two[0]);
    let covered = 0;
    for (const [start, end] of pairs) {
      if (start > covered + 2) break;
      covered = Math.max(covered, end);
    }
    return duration - covered > 2 ? Math.floor(covered) : null;
  }

  function embedEntry(frame) {
    let entry = embeds.get(frame);
    if (!entry) {
      let attempts = 0;
      let started = false;
      const send = (command, extra) => {
        try { frame.contentWindow.postMessage({ tag: EMBED_TAG, type: 'command', command, ...extra }, EMBED_ORIGIN); }
        catch { /* 프레임이 닫히는 중 */ }
      };
      entry = { tracking: false, watched: '', state: null, listeners: [], player: {
        sitePlayer: true,
        // 플레이어 스크립트와 이전 학습 상태를 불러오는 데 일반 영상보다 오래 걸린다.
        loadTimeout: 50000,
        getAttribute: () => '',
        update() {
          const state = entry.state;
          // 사이트가 진도 추적을 연결하기 전에 재생하면 그 재생은 진도에 남지 않으므로, 준비 신호를 받을 때까지 기다린다.
          const ready = entry.tracking && !!state?.source;
          this.currentSrc = ready ? 'embed-player' : '';
          this.readyState = ready ? Number(state.readyState) || 0 : 0;
          this.paused = state?.paused !== false;
          this.ended = state?.ended === true;
          this.currentTime = Number(state?.currentTime) || 0;
          this.duration = Number(state?.duration) || 0;
          this.error = state?.error ? { message: String(state.error).slice(0, 120) } : null;
          if (state && state.paused === false) started = true;
          return this;
        },
        addEventListener(type, listener) { if (type === 'ended' || type === 'error') entry.listeners.push({ type, listener }); },
        set muted(value) { send(value ? 'mute' : 'unmute'); },
        set playbackRate(_) { send('rate'); },
        // 요청이 플레이어 준비보다 먼저 도착해 버려질 수 있어, 재생이 시작되기 전까지만 몇 번 다시 요청한다.
        canRetryPlay: () => !started && attempts < 3,
        async play() { attempts++; send('play', { from: firstUnwatched(entry.watched, Number(entry.state?.duration) || 0) }); },
        pause() { send('pause'); },
      } };
      embeds.set(frame, entry);
    }
    return entry;
  }

  function embedMessage(event) {
    const frame = embedFrames().find(item => item.contentWindow === event.source);
    if (!frame) return;
    const entry = embedEntry(frame);
    // loadedState는 사이트 플레이어가 강의실에 보내는 신호로, 진도 추적 연결이 끝났다는 뜻이다.
    if (event.data?.type === 'loadedState') {
      entry.tracking = true;
      entry.watched = typeof event.data.state?.played_segments === 'string' ? event.data.state.played_segments : '';
      return;
    }
    if (event.data?.tag !== EMBED_TAG || event.data.type !== 'state') return;
    const before = entry.state;
    entry.state = event.data;
    // 종료·오류는 다음 확인 주기를 기다리지 않고 바로 알린다.
    for (const type of ['ended', 'error']) {
      if (!event.data[type] || before?.[type]) continue;
      for (const item of entry.listeners) if (item.type === type) item.listener();
    }
  }

  function embedPlayer() {
    const frame = embedFrames()[0];
    return frame ? embedEntry(frame).player.update() : null;
  }

  function findMedia() {
    const element = mediaIn(document);
    if (element && hasSource(element)) return element;
    return sitePlayerIn(document) || embedPlayer() || element;
  }

  // 영상을 찾지 못한 이유를 좁히기 위한 구조 요약. 주소의 식별자와 화면 본문은 담지 않는다.
  function diagnose() {
    const parts = [];
    if (Number.isFinite(window.innerWidth)) parts.push(`화면 ${window.innerWidth}×${window.innerHeight}`);
    try {
      // 강의실이 강의 목록을 그렸는지, 주소의 강의를 선택해 영상 자리를 만들었는지 구분한다.
      const lessonId = new URL(location.href).searchParams.get('sequenceLessonId');
      const lessons = document.querySelectorAll('[id^="lesson-item-"]').length;
      parts.push(lessons ? `강의 목록 ${lessons}개(대상 강의 ${document.getElementById(`lesson-item-${lessonId}`) ? '있음' : '없음'})` : '강의 목록 없음');
      const area = document.querySelector('.currentVideo');
      parts.push(`학습 영역 ${!area ? '없음' : area.querySelector('.videoContent01, .videoContent02') ? '영상 자리 있음'
        : area.childElementCount ? '다른 내용' : '비어 있음'}`);
    } catch { /* 진단은 실패해도 안내를 막지 않는다. */ }
    if (notices.length) parts.push(`사이트 알림 "${notices.join('" / "')}"`);
    const frames = [];
    const visit = (doc, depth) => {
      for (const frame of doc.querySelectorAll('iframe')) {
        let label = '주소 없음';
        let internal = false;
        let reopened = false;
        try {
          const url = new URL(frame.src || frame.getAttribute('src') || '', location.href);
          internal = url.origin === location.origin;
          reopened = internal && url.searchParams.has(NETWORK_MARK);
          label = internal ? url.pathname : url.hostname || url.protocol;
        } catch { /* 주소를 읽을 수 없는 프레임 */ }
        const inner = sameOriginDocument(frame);
        const embed = embeds.get(frame);
        if (embed) { frames.push(`${label}(저작도구 플레이어 응답 ${embed.state ? '있음' : '없음'}, 진도 추적 ${embed.tracking ? '연결됨' : '대기'})`); continue; }
        if (!inner) { frames.push(`${label}(${!internal ? '외부' : reopened ? '다시 열어도 열리지 않음' : '열리지 않음'})`); continue; }
        const state = askSitePlayer(inner, 'state');
        frames.push(`${label}(${state ? `플레이어 ${state.tech || '준비 중'}`
          : inner.querySelector('video, audio') ? '영상 태그 있음' : '플레이어 없음'})`);
        if (depth < 2) visit(inner, depth + 1);
      }
    };
    try { visit(document, 1); } catch { /* 진단은 실패해도 안내를 막지 않는다. */ }
    parts.push(frames.length ? `프레임 ${frames.slice(0, 3).join(', ')}` : '플레이어 프레임 없음');
    return parts.join(' · ');
  }

  // 사이트 알림(예: 이전 차시 미완료, 학습 기간 아님)은 몇 초 뒤 사라지므로 뜰 때 기록해 둔다.
  function rememberNotices(root) {
    try {
      const alerts = root.matches?.('[role="alert"]') ? [root] : [...(root.querySelectorAll?.('[role="alert"]') || [])];
      for (const alert of alerts) {
        const text = String(alert.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (text && !notices.includes(text)) notices = [...notices, text].slice(-2);
      }
    } catch { /* 페이지가 이동한 경우 */ }
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(records => {
      let frameAdded = false;
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        rememberNotices(node);
        frameAdded ||= node.matches?.('iframe') || !!node.querySelector?.('iframe');
      }
      // 플레이어 프레임이 생기면 다음 확인 주기를 기다리지 않고 차단 여부를 살핀다.
      if (frameAdded) reopenBlockedPlayerFrames();
    }).observe(document.documentElement, { childList: true, subtree: true });
    rememberNotices(document.documentElement);
  }

  function visibleDialog() {
    return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .some(dialog => dialog.getClientRects().length > 0 && dialog.getAttribute('aria-hidden') !== 'true');
  }

  function pauseOwned() {
    if (ownedMedia) {
      try { ownedMedia.pause(); } catch { /* 페이지가 이동한 경우 */ }
    }
    ownedMedia = null;
    lastPlayedMedia = null;
  }

  function snapshot(media) {
    if (playError) return { kind: 'attention', message: playError };
    if (media?.ended) return { kind: 'ended' };
    if (visibleDialog()) return { kind: 'attention', message: '알파 강의실의 안내 또는 응답 화면을 확인하세요.' };
    if (!media) return Date.now() - startedAt > 30000
      ? { kind: 'attention', message: `재생할 영상을 찾지 못했습니다. 알파 강의실을 확인하세요. (진단: ${diagnose()})`.slice(0, 290) }
      : { kind: 'ready' };
    if (media.error) return { kind: 'attention', message: media.sitePlayer && media.error.message
      ? `영상 재생에 오류가 발생했습니다(${media.error.message}). 알파 강의실을 확인하세요.`
      : '영상 재생에 오류가 발생했습니다. 알파 강의실을 확인하세요.' };
    if (!hasSource(media)) return Date.now() - startedAt > (media.loadTimeout || 30000)
      ? { kind: 'attention', message: media.loadTimeout
        ? `저작도구 플레이어가 준비되지 않았습니다. 알파 강의실을 확인하세요. (진단: ${diagnose()})`.slice(0, 290)
        : '영상 플레이어는 열렸지만 영상 파일을 불러오지 못했습니다. 학습 화면에서 로딩 상태를 확인하세요.' }
      : { kind: 'ready' };
    return { kind: media.paused ? (ownedMedia ? 'paused' : 'ready') : 'playing' };
  }

  async function heartbeat() {
    if (sending) { pending = true; return; }
    sending = true;
    const version = stoppedVersion;
    try {
      if (lastUrl !== location.href) {
        pauseOwned();
        lastUrl = location.href;
        startedAt = Date.now();
        playError = '';
        notices = [];
      }
      reopenBlockedPlayerFrames();
      const media = findMedia();
      if (media && !wired.has(media)) {
        wired.add(media);
        media.addEventListener('ended', heartbeat);
        media.addEventListener('error', heartbeat);
      }
      const status = snapshot(media);
      const response = await sendHeartbeat({
        url: location.href, runId, ...status,
        currentTime: media && Number.isFinite(media.currentTime) ? media.currentTime : 0,
        duration: media && Number.isFinite(media.duration) ? media.duration : 0,
      });
      if (version !== stoppedVersion) return;
      const params = new URL(location.href).searchParams;
      const authorized = response?.active === true && response.runId && response.runId !== blockedRunId &&
        response.lessonId === params.get('sequenceLessonId') &&
        (!response.registrationId || response.registrationId === params.get('registrationId'));
      if (!authorized) { pauseOwned(); return; }
      runId = response.runId;
      if (!media || !hasSource(media) || status.kind === 'attention' || status.kind === 'ended') {
        if (status.kind === 'attention') pauseOwned();
        return;
      }
      if (ownedMedia && ownedMedia !== media) pauseOwned();
      ownedMedia = media;
      media.muted = response.muted !== false;
      // 사이트가 배속을 허용하지 않으므로 기본 속도로 실제 재생한다.
      media.playbackRate = 1;
      if (media.paused && (media !== lastPlayedMedia || media.canRetryPlay?.())) {
        lastPlayedMedia = media;
        try { await media.play(); }
        catch {
          playError = '자동 재생이 허용되지 않았습니다. 알파 강의실에서 재생 버튼을 누른 뒤 다시 시작하세요.';
          pending = true;
        }
      }
    } catch { pauseOwned(); }
    finally {
      sending = false;
      if (pending) { pending = false; queueMicrotask(heartbeat); }
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'alpha-player-stop' || sender.id !== chrome.runtime.id) return;
    stoppedVersion++;
    blockedRunId = runId;
    // 명시적인 중지 명령은 관리 중인 강의실 탭에만 온다. 사이트 자체 자동재생도 한 번 멈춘다.
    const uncontrolledMedia = !ownedMedia && findMedia();
    pauseOwned();
    if (uncontrolledMedia) {
      try { uncontrolledMedia.pause(); } catch { /* 페이지 이동 중 */ }
    }
    sendResponse({ ok: true });
  });
  window.addEventListener('pagehide', pauseOwned);
  setInterval(heartbeat, 5000);
  heartbeat();
})();
