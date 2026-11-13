// offscreen 확장 문서에서만 실행되는 ALPHA 프레임 중계기.
(() => {
  'use strict';
  if (new URLSearchParams(location.search).get('host') !== 'offscreen') return;
  const ORIGIN = 'https://alpha-campus.kr', TAG = 'alpha-offscreen-player';
  let frame = document.getElementById('alpha-runner');
  let active = null;
  const identity = value => {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.pathname !== '/my/classRoom/classRoomDetail' || url.searchParams.get('type') !== 'ONLINE') return null;
      return `${url.pathname}|${url.searchParams.get('registrationId')}|${url.searchParams.get('sequenceLessonId')}`;
    } catch { return null; }
  };
  function replaceFrame(url = 'about:blank') {
    // 매 이동마다 WindowProxy를 바꿔 이전 문서가 늦게 보낸 메시지를 구분한다.
    const next = document.createElement('iframe');
    next.id = 'alpha-runner'; next.allow = 'autoplay; fullscreen'; next.src = url;
    frame.replaceWith(next); frame = next;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.target !== 'alpha-host' || sender.id !== chrome.runtime.id ||
        (sender.url && sender.url !== chrome.runtime.getURL('src/background.js'))) return;
    if (message.cmd === 'navigate') {
      if (!identity(message.url) || !message.runId || !message.playerToken) { respond({ ok: false }); return; }
      active = { url: message.url, runId: message.runId, playerToken: message.playerToken };
      replaceFrame(message.url); respond({ ok: true });
    } else if (message.cmd === 'clear') {
      active = null; replaceFrame(); respond({ ok: true });
    } else if (message.cmd === 'ping') respond({ ok: true, ...(active || {}) });
  });
  window.addEventListener('message', event => {
    const message = event.data, current = active, source = frame.contentWindow;
    if (!current || event.source !== source || event.origin !== ORIGIN || message?.tag !== TAG || message.type !== 'heartbeat' ||
        typeof message.requestId !== 'string' || message.requestId.length > 150 ||
        !identity(message.url) || identity(message.url) !== identity(current.url) ||
        (message.runId && message.runId !== current.runId)) return;
    chrome.runtime.sendMessage({ type: 'alpha-host-heartbeat', url: message.url,
      runId: current.runId, playerToken: current.playerToken, kind: message.kind,
      currentTime: message.currentTime, duration: message.duration,
      ...(typeof message.message === 'string' ? { message: message.message.slice(0, 300) } : {}) })
      .then(response => {
        if (active !== current || frame.contentWindow !== source) return;
        source.postMessage({ tag: TAG, type: 'response', requestId: message.requestId, response: response || { active: false } }, ORIGIN);
      }).catch(() => {
        if (active === current && frame.contentWindow === source) source.postMessage({ tag: TAG, type: 'response',
          requestId: message.requestId, response: { active: false } }, ORIGIN);
      });
  });
})();
