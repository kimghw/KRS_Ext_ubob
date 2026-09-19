// isolated world — page.js(MAIN world)와 확장(chrome.*) 사이를 중계한다.
//  - 탭 모드: 사용자가 연 일반 탭
//  - 러너 모드: 확장의 플레이어(offscreen 문서 또는 "플레이어 화면 보기" 창) 안의 iframe
(() => {
  'use strict';
  const { TAG, DEFAULTS, SERIES_RE, LOGIN_RE, ERROR_RE } = UBOB_AUTO;
  // 러너 프레임 = 확장 플레이어 페이지의 "직접" 자식 프레임.
  // 사이트 페이지 안에 다시 들어 있는 iframe(개인정보처리방침 등)은 조상에 확장 페이지가 있어도 러너가 아니다.
  const anc = location.ancestorOrigins;
  const IN_RUNNER = window.top !== window && window.parent === window.top && !!anc && anc.length === 1 &&
    anc[0] === `chrome-extension://${chrome.runtime.id}`;
  if (window.top !== window && !IN_RUNNER) return;

  const IS_SERIES = SERIES_RE.test(location.pathname);
  const IS_LOGIN = LOGIN_RE.test(location.pathname);
  const IS_ERROR = ERROR_RE.test(location.pathname);

  // 확장을 다시 로드하면 기존 content script 의 chrome.* 호출은 예외를 던진다
  const send = (msg) => {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); }
  };
  const toPage = (msg) => window.postMessage({ [TAG]: 'to-page', ...msg }, location.origin);

  let pageReady = false;
  const queued = [];
  const toPageWhenReady = (msg) => { if (pageReady) toPage(msg); else queued.push(msg); };
  let onStatus = () => {};

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'to-content') return;
    const m = e.data;
    switch (m.type) {
      case 'ready':
        pageReady = true;
        while (queued.length) toPage(queued.shift());
        break;
      case 'status':
        onStatus(m.status);
        break;
      case 'event':
        send({ type: IN_RUNNER ? 'runner-event' : 'event', event: m.event });
        break;
      case 'speed-changed':
        if (!IN_RUNNER && Number(m.speed) > 0) chrome.storage.sync.set({ speed: Number(m.speed) });
        break;
      case 'course-finished':
        if (IN_RUNNER) send({ type: 'runner-course-finished', result: m.result });
        break;
      case 'reload-request':
        if (IN_RUNNER) send({ type: 'runner-reload', reason: m.reason });
        break;
    }
  });

  if (IN_RUNNER) runnerMode(); else tabMode();

  // ---------------------------------------------------------------
  // 러너 모드: 페이지 종류를 알리고 백그라운드가 시키는 일을 한다
  // ---------------------------------------------------------------
  async function runnerMode() {
    let lastKey = '';
    let lastSent = 0;
    onStatus = (st) => {
      const key = `${st.state}|${st.course}|${st.title}`;
      if (key !== lastKey || Date.now() - lastSent > 3000) {
        lastKey = key;
        lastSent = Date.now();
        send({ type: 'runner-status', status: st });
      }
    };

    // 로그인 페이지로 왔으면 백그라운드가 직접 다시 로그인한 뒤 과정 페이지로 보낸다
    const kind = IS_LOGIN ? 'login' : IS_SERIES ? 'series' : IS_ERROR ? 'error' : 'other';
    const res = await send({ type: 'runner-page', kind, url: location.href });
    if (res && res.cmd === 'play') toPageWhenReady({ type: 'settings', settings: res.settings });
  }

  // ---------------------------------------------------------------
  // 탭 모드: 사용자가 직접 연 강의 페이지 (러너가 도는 동안에는 중복 재생을 막기 위해 쉰다)
  // ---------------------------------------------------------------
  function tabMode() {
    let settings = null;
    let runnerRunning = false;
    let lastStatus = IS_SERIES ? { page: 'series', state: 'loading' } : { page: 'other' };
    let lastBadgeKey = '';

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'getStatus') {
        sendResponse({ status: lastStatus });
      } else if (msg.type === 'command' && IS_SERIES) {
        toPageWhenReady({ type: 'command', cmd: msg.cmd });
        sendResponse({ ok: true });
      }
    });

    send({ type: 'hello', series: IS_SERIES });
    if (!IS_SERIES) return;

    const push = () => {
      if (!settings) return;
      toPageWhenReady({
        type: 'settings',
        settings: { ...settings, enabled: settings.enabled && !runnerRunning, runner: false, muted: false }
      });
    };

    Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get({ runner: null })]).then(([s, l]) => {
      settings = s;
      runnerRunning = !!(l.runner && l.runner.running);
      push();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!settings) return;
      if (area === 'sync') {
        for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
        push();
      } else if (area === 'local' && changes.runner) {
        const running = !!(changes.runner.newValue && changes.runner.newValue.running);
        if (running !== runnerRunning) { runnerRunning = running; push(); }
      }
    });

    onStatus = (st) => {
      lastStatus = st;
      // 배지는 상태/배속이 바뀔 때만 갱신
      const badgeKey = `${st.state}|${st.target}|${st.speedLocked}`;
      if (badgeKey !== lastBadgeKey) {
        lastBadgeKey = badgeKey;
        send({ type: 'status', status: st });
      }
    };
  }
})();
