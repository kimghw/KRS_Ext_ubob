importScripts('shared.js');

const { DEFAULTS, SERIES_RE } = UBOB_AUTO;
const RUNNER_PAGE = 'src/runner.html';
const FRAME_RULE_ID = 1;
const WATCHDOG = 'ubob-watchdog';
const STALL_MS = 3 * 60 * 1000;      // 플레이어가 이만큼 조용하면 다시 불러온다
const PAGE_TIMEOUT_MS = 30 * 1000;   // 이동 후 이 시간 안에 페이지가 안 열리면 문제
const LOG_MAX = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const siteBase = (s) => String(s.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
const courseUrl = (s, c) => `${siteBase(s)}/Series/SeriesDetail/${c.seriesId}`;
const errMsg = (e) => (e && e.message) || String(e);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULTS, ...current });
  if (details.reason === 'update') await resumeAfterReload();
});

// 확장을 새로고침/업데이트하면 플레이어(offscreen 문서)와 알람이 사라진다. 실행 중이었다면 이어서 진행한다.
async function resumeAfterReload() {
  const r = await getRunner();
  if (!r.running) return;
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  await chrome.storage.session.remove(['runnerStatus', 'navAt', 'pageAt', 'pageTimeouts', 'playerWindow']);
  if (r.phase === 'prepare' || !cur) {
    await mutate((x) => { x.running = false; });
    addLog('확장이 다시 로드되어 자동 학습을 처음부터 다시 시작합니다');
    await start();
    return;
  }
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  if (r.phase === 'attention') { updateRunnerBadge(); return; }   // 사람이 볼 차례였다면 그대로 둔다
  addLog(`확장이 다시 로드되어 이어서 진행합니다: ${cur.title}`);
  const s = await getSettings();
  try {
    await navigate(courseUrl(s, cur));
  } catch (e) {
    addLog(`플레이어를 다시 열지 못했습니다: ${errMsg(e)}`);
  }
  updateRunnerBadge();
}

// =====================================================================
// 상태 저장 (서비스 워커가 내려가도 유지)
// =====================================================================
const EMPTY_RUNNER = { running: false, phase: 'idle', message: '', courses: [], currentOrderId: null };

async function getRunner() {
  const { runner } = await chrome.storage.local.get('runner');
  return { ...EMPTY_RUNNER, ...(runner || {}) };
}

// 읽고-고치고-쓰기를 순서대로 처리한다 (fn 안에서 mutate 를 다시 부르면 안 됨)
let chain = Promise.resolve();
function mutate(fn) {
  const run = chain.then(async () => {
    const r = await getRunner();
    const out = await fn(r);
    r.updatedAt = Date.now();
    await chrome.storage.local.set({ runner: r });
    return out;
  });
  chain = run.catch(() => {});
  return run;
}

let logChain = Promise.resolve();
function addLog(text) {
  logChain = logChain.then(async () => {
    const { runnerLog = [] } = await chrome.storage.local.get('runnerLog');
    runnerLog.push({ t: Date.now(), text });
    await chrome.storage.local.set({ runnerLog: runnerLog.slice(-LOG_MAX) });
  }).catch(() => {});
  return logChain;
}

const setAuth = (auth) => chrome.storage.local.set({ auth: { ...auth, checkedAt: Date.now() } });

let lastBeatSaved = 0;
async function beat(force) {
  const now = Date.now();
  if (!force && now - lastBeatSaved < 20000) return;
  lastBeatSaved = now;
  await chrome.storage.session.set({ beatAt: now });
}

// =====================================================================
// 사이트 API — 확장 백그라운드에서 직접 호출 (Chrome 쿠키를 그대로 공유)
// =====================================================================
async function siteFetch(path, opts = {}) {
  const base = siteBase(await getSettings());
  try {
    return await fetch(base + path, { credentials: 'include', ...opts });
  } catch (e) {
    throw new Error(`사이트(${base})에 연결하지 못했습니다: ${errMsg(e)}`);
  }
}

async function apiJSON(path) {
  const res = await siteFetch(path, { headers: { Accept: 'application/json' } });
  if (res.status === 401) throw Object.assign(new Error('로그인이 필요합니다'), { code: 401 });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`사이트가 예상과 다른 응답을 보냈습니다 (HTTP ${res.status})`);
  }
}

async function sessionOk() {
  const today = ymd(new Date());
  try {
    const d = await apiJSON(`/api/myroom?date1=${today}&date2=${today}`);
    return !!d && d.result !== 'FAIL';
  } catch (e) {
    if (e.code === 401) return false;
    throw e;
  }
}

// 로그인 페이지와 같은 요청: POST /api/auth/login (userName, password)
async function login() {
  const { account } = await chrome.storage.local.get('account');
  if (!account || !account.userName || !account.password) throw new Error('아이디와 비밀번호를 먼저 저장해 주세요.');
  await siteFetch('/Account/Login').catch(() => {});   // 사이트 기본 쿠키를 먼저 받는다
  const fd = new FormData();
  fd.append('userName', account.userName);
  fd.append('password', account.password);
  const res = await siteFetch('/api/auth/login', { method: 'POST', body: fd });
  let data = null;
  try { data = await res.json(); } catch { /* 아래에서 처리 */ }
  if (!data) throw new Error(`로그인 요청이 실패했습니다 (HTTP ${res.status})`);
  if (data.result === 'FAIL') throw new Error(String(data.msg || '로그인에 실패했습니다').replace(/<br\s*\/?>/gi, ' '));
  return account.userName;
}

// 서버가 HTML 로 인코딩한 문자(&#xAE40; 등)를 되돌린다
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);

// 로그인된 페이지 머리글의 이름 (없으면 null)
async function whoAmI() {
  const res = await siteFetch('/MyPage/MyRoom');
  if (/\/account\/login/i.test(res.url)) return null;
  const html = await res.text();
  const m = /class="user-name"[^>]*>\s*([^<]+?)\s*</.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

async function ensureLoggedIn({ force = false } = {}) {
  try {
    if (!force && await sessionOk()) {
      const { auth } = await chrome.storage.local.get('auth');
      await setAuth({ ok: true, name: auth && auth.ok ? auth.name : null, via: 'session' });
      return;
    }
    const user = await login();
    if (!(await sessionOk())) {
      throw new Error('로그인 응답은 성공했지만 로그인 상태가 유지되지 않습니다. Chrome 설정에서 쿠키 차단 여부를 확인해 주세요.');
    }
    const name = await whoAmI().catch(() => null);
    await setAuth({ ok: true, name, user });
    addLog(`로그인 성공: ${name || user}`);
  } catch (e) {
    await setAuth({ ok: false, message: errMsg(e) });
    addLog(`로그인 실패: ${errMsg(e)}`);
    throw e;
  }
}

// 내 강의실(/js/myroom.js)과 같은 API: 분류 목록 → 분류별 과정 목록
async function fetchCourses() {
  const now = new Date();
  let first = null;
  let query = '';
  for (const days of [730, 365, 31]) {   // 기간이 너무 길다고 거절되면 줄여서 다시
    query = `date1=${ymd(new Date(now.getTime() - days * 864e5))}&date2=${ymd(now)}`;
    first = await apiJSON(`/api/myroom?${query}`);
    if (first && first.result !== 'FAIL') break;
  }
  if (!first || first.result === 'FAIL') throw new Error((first && first.msg) || '과정 목록을 가져오지 못했습니다');
  // 내 강의실의 "학습중인 과정" 분류만 쓴다 (전체 신청/수료 과정은 제외). 그 분류가 없는 사이트면 전체 분류.
  const items = ((first.item && first.item.itemList) || []).filter((i) => i.hasList === 'Y');
  const studying = items.filter((i) => /학습\s*중/.test(String(i.name || '')));
  const groups = (studying.length ? studying : items).filter((i) => Number(i.seriesCount) > 0);
  const byOrder = new Map();
  for (const g of groups) {
    const r = await apiJSON(`/api/myroom/$itemlist?itemId=${encodeURIComponent(g.id)}&${query}`);
    if (!r || r.result === 'FAIL') continue;
    for (const s of r.list || []) {
      if (byOrder.has(s.id)) continue;
      byOrder.set(s.id, {
        orderId: s.id,
        seriesId: s.seriesId,
        title: s.title,
        group: g.name,
        orderStatus: s.orderStatus,
        passStatus: s.passStatus,
        studyProgress: Number(s.studyProgress) || 0,
        passProgress: s.passProgress,
        endDate: s.endDate,
        cannotPlayMsg: s.cannotPlayMsg || ''
      });
    }
  }
  return [...byOrder.values()];
}

const classify = (c) => (c.orderStatus === 'OPEN' && c.passStatus !== 'Y' && Number(c.studyProgress) < 100 ? 'pending'
  : c.passStatus === 'Y' ? 'passed'
  : c.orderStatus !== 'OPEN' ? 'closed'
  : 'complete');

// fresh=false 이면 이번 실행에서 이미 처리한 과정의 상태는 유지한다
function applyCourses(list, { fresh }) {
  return mutate((x) => {
    const prev = new Map((x.courses || []).map((c) => [c.orderId, c]));
    x.courses = list.map((c) => {
      const old = prev.get(c.orderId);
      const keep = !fresh && x.running && old && ['playing', 'done', 'skipped', 'failed'].includes(old.status);
      return { ...c, status: keep ? old.status : classify(c) };
    });
    x.listedAt = Date.now();
    return {
      total: x.courses.length,
      todo: x.courses.filter((c) => c.status === 'pending' || c.status === 'playing').length
    };
  });
}

async function testAccount() {
  try {
    await ensureLoggedIn({ force: true });
  } catch { /* auth 에 기록됨 */ }
  const { auth } = await chrome.storage.local.get('auth');
  return auth;
}

async function refreshList() {
  try {
    await ensureLoggedIn();
    const { total, todo } = await applyCourses(await fetchCourses(), { fresh: false });
    addLog(`목록 새로고침: 학습중인 과정 ${total}개 · 학습할 과정 ${todo}개`);
    return { ok: true, total, todo };
  } catch (e) {
    addLog(`목록 새로고침 실패: ${errMsg(e)}`);
    return { ok: false, error: errMsg(e) };
  }
}

// =====================================================================
// 플레이어 — 보이지 않는 offscreen 문서, 또는 "플레이어 화면 보기" 창
// =====================================================================
// 일반 탭이 아니라서 "숨겨진 탭" 제약(미디어 로딩 보류, 타이머 지연)을 받지 않고,
// 확장 페이지라서 사용자 조작 없이도 소리 있는 자동재생이 허용된다.
async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: `${RUNNER_PAGE}?host=offscreen`,
      reasons: ['IFRAME_SCRIPTING'],
      justification: '로그인된 학습 사이트를 보이지 않는 곳에서 열어 강의를 재생합니다.'
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function getPlayerWindow() {
  const { playerWindow } = await chrome.storage.session.get('playerWindow');
  if (!playerWindow) return null;
  try {
    await chrome.tabs.get(playerWindow.tabId);
    return playerWindow;
  } catch {
    await chrome.storage.session.remove('playerWindow');
    return null;
  }
}

// 사이트가 X-Frame-Options: DENY 를 보내므로, 확장 자신의 플레이어 요청에 한해서만 제거한다
// (탭이 아닌 요청 = offscreen, 그리고 "플레이어 화면 보기" 창의 탭)
async function ensureFrameRule(playerTabId) {
  const tabIds = [chrome.tabs.TAB_ID_NONE];
  if (playerTabId) tabIds.push(playerTabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FRAME_RULE_ID],
    addRules: [{
      id: FRAME_RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }] },
      condition: { requestDomains: ['ubob.com'], resourceTypes: ['sub_frame'], tabIds }
    }]
  });
}

async function ensureHost() {
  const w = await getPlayerWindow();
  await ensureFrameRule(w ? w.tabId : null);
  if (w) {
    await closeOffscreen();
    return 'window';
  }
  await ensureOffscreen();
  return 'offscreen';
}

async function hostAlive() {
  return !!(await getPlayerWindow()) || await hasOffscreen();
}

async function sendToHost(host, msg) {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'runner', host, ...msg });
      if (res && res.ok) return res;
    } catch { /* 아직 로딩 중 */ }
    await sleep(250);
  }
  throw new Error('플레이어를 열지 못했습니다');
}

async function navigate(url) {
  await chrome.storage.session.set({ lastUrl: url, navAt: Date.now() });
  const host = await ensureHost();
  try {
    await sendToHost(host, { cmd: 'navigate', url });
  } catch (e) {
    addLog(`플레이어(${host === 'window' ? '창' : '보이지 않는 문서'})에 명령을 보내지 못했습니다: ${errMsg(e)}`);
    throw e;
  }
  await beat(true);
}

// 플레이어 페이지가 열리면 스스로 알려 온다 → 지금 열어야 할 주소를 돌려준다
async function onHostReady(host, sender) {
  if (host === 'window' && sender.tab) {
    await chrome.storage.session.set({ playerWindow: { windowId: sender.tab.windowId, tabId: sender.tab.id } });
    await ensureFrameRule(sender.tab.id);
    await closeOffscreen();   // 창이 열리면 보이지 않는 플레이어는 멈춘다 (중복 재생 방지)
  }
  const r = await getRunner();
  const { lastUrl } = await chrome.storage.session.get('lastUrl');
  if (r.running && r.phase === 'course' && lastUrl) {
    await chrome.storage.session.set({ navAt: Date.now() });
    return { url: lastUrl };
  }
  return { url: null };
}

async function closePlayers() {
  await closeOffscreen();
  const w = await getPlayerWindow();
  await chrome.storage.session.remove('playerWindow');
  if (w) await chrome.windows.remove(w.windowId).catch(() => {});
}

async function showPlayer() {
  const w = await getPlayerWindow();
  if (w) {
    await chrome.windows.update(w.windowId, { focused: true });
    return;
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`${RUNNER_PAGE}?host=window`), type: 'popup', width: 1120, height: 800, focused: true
  });
  let tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ windowId: win.id });
    tabId = tab && tab.id;
  }
  await chrome.storage.session.set({ playerWindow: { windowId: win.id, tabId } });
  // 창 안의 플레이어 페이지가 준비되면 onHostReady 가 주소를 넘겨 이어서 재생한다
  const r = await getRunner();
  if (r.running) addLog('플레이어 화면을 열었습니다');
}

// 플레이어 창을 닫으면 보이지 않는 플레이어로 돌아가 이어서 재생
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { playerWindow } = await chrome.storage.session.get('playerWindow');
  if (!playerWindow || playerWindow.windowId !== windowId) return;
  await chrome.storage.session.remove('playerWindow');
  const r = await getRunner();
  const { lastUrl } = await chrome.storage.session.get('lastUrl');
  if (r.running && lastUrl) {
    addLog('플레이어 화면을 닫았습니다. 보이지 않는 곳에서 계속 재생합니다');
    navigate(lastUrl).catch(() => {});
  }
});

// =====================================================================
// 자동 학습 흐름: 로그인 → 목록 → 과정 1 → 과정 2 → … → 완료
// =====================================================================
const runnerSettings = (s) => ({
  enabled: true, runner: true, speed: s.speed, muted: s.runnerMuted,
  autoNext: true, autoStart: true, nextDelay: 1, overlay: false,
  stall: s.stall || null   // 테스트용: 멈춤 감지 시간(ms) 재정의
});

async function start() {
  if ((await getRunner()).running) return;
  await mutate((r) => {
    Object.assign(r, { running: true, phase: 'prepare', message: '로그인 확인 중…', currentOrderId: null, loginTries: 0, loginAt: 0 });
  });
  await chrome.storage.session.remove(['runnerStatus', 'navAt', 'pageAt', 'pageTimeouts']);
  addLog('자동 학습을 시작합니다');
  updateRunnerBadge();
  try {
    await ensureLoggedIn();
    await mutate((r) => { r.message = '과정 목록 불러오는 중…'; });
    const { total, todo } = await applyCourses(await fetchCourses(), { fresh: true });
    addLog(`학습중인 과정 ${total}개 · 학습할 과정 ${todo}개`);
  } catch (e) {
    await stop(`시작하지 못했습니다: ${errMsg(e)}`, 'error');
    notify('시작하지 못했습니다', errMsg(e), true);
    return;
  }
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  await nextCourse();
}

async function stop(message, phase = 'idle') {
  await mutate((r) => {
    r.running = false;
    r.phase = phase;
    r.message = message || '';
    for (const c of r.courses || []) if (c.status === 'playing') c.status = 'pending';
  });
  await closePlayers();
  await chrome.alarms.clear(WATCHDOG);
  await chrome.storage.session.remove('runnerStatus');
  if (message) addLog(message);
  updateRunnerBadge();
}

async function nextCourse() {
  const { excluded = [] } = await chrome.storage.local.get('excluded');
  const s = await getSettings();
  const cur = await mutate((x) => {
    const c = (x.courses || []).find((k) => k.status === 'pending' && !excluded.includes(k.orderId));
    x.currentOrderId = c ? c.orderId : null;
    if (c) {
      c.status = 'playing';
      x.phase = 'course';
      x.message = '';
    }
    return c ? { ...c } : null;
  });
  if (!cur) {
    const r = await getRunner();
    const done = (r.courses || []).filter((c) => c.status === 'done').length;
    await stop(done ? `모든 과정을 마쳤습니다 (${done}개 과정)` : '학습할 과정이 없습니다', 'done');
    notify('자동 학습 완료', done ? `${done}개 과정의 강의를 모두 재생했습니다. 시험·설문이 있으면 직접 진행해 주세요.` : '진행할 과정이 없습니다.');
    return;
  }
  await chrome.storage.session.remove(['runnerStatus', 'pageTimeouts']);
  lastProgressKey = '';
  addLog(`과정 시작: ${cur.title}`);
  try {
    await navigate(courseUrl(s, cur));
  } catch (e) {
    await stop(`플레이어를 열지 못했습니다: ${errMsg(e)}`, 'error');
    notify('플레이어 오류', errMsg(e), true);
  }
  updateRunnerBadge();
}

async function finishCurrent(status, note, progress) {
  const cur = await mutate((x) => {
    const c = (x.courses || []).find((k) => k.orderId === x.currentOrderId);
    if (!c) return null;
    c.status = status;
    c.note = note || '';
    if (Number.isFinite(progress)) c.studyProgress = progress;
    return { ...c };
  });
  if (cur) {
    const pct = Number.isFinite(progress) ? ` · 진도 ${progress}%` : '';
    const label = status === 'done' ? '과정 완료' : status === 'skipped' ? '과정 건너뜀' : '과정 실패';
    addLog(`${label}: ${cur.title}${pct}${note ? ` (${note})` : ''}`);
    if (status === 'done') notify('과정 완료', `${cur.title}${pct}`);
  }
  await nextCourse();
}

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return url; } };

async function onRunnerPage(kind, url) {
  const r = await getRunner();
  if (!r.running) return { cmd: 'none' };
  await chrome.storage.session.set({ pageAt: Date.now(), pageTimeouts: 0 });
  await beat(true);
  const s = await getSettings();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);

  if (kind === 'login') {
    reloginAndReturn();
    return { cmd: 'none' };
  }
  if (kind === 'error') {
    addLog(`플레이어가 오류 페이지를 열었습니다 (${pathOf(url)})`);
    if (cur) finishCurrent('failed', '사이트 오류 페이지');
    else stop('사이트 오류 페이지가 열렸습니다. 사이트 주소를 확인해 주세요.', 'error');
    return { cmd: 'none' };
  }
  if ((r.phase === 'course' || r.phase === 'attention') && cur) {
    if (kind === 'series' && url.toLowerCase().includes(String(cur.seriesId).toLowerCase())) {
      addLog(`강의 페이지를 열었습니다: ${cur.title}`);
      return { cmd: 'play', settings: runnerSettings(s) };
    }
    const where = (() => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } })();
    addLog(`플레이어가 다른 페이지(${where})로 이동해 과정 페이지로 돌아갑니다`);
    navigate(courseUrl(s, cur)).catch(() => {});
  }
  return { cmd: 'none' };
}

// 재생 중 로그인이 풀리면(플레이어가 로그인 페이지로 이동) 다시 로그인하고 과정으로 돌아간다
async function reloginAndReturn() {
  const r = await getRunner();
  const now = Date.now();
  const tries = now - (r.loginAt || 0) < 120000 ? (r.loginTries || 0) + 1 : 1;
  await mutate((x) => { x.loginTries = tries; x.loginAt = now; });
  if (tries > 2) {
    // 이 사이트는 같은 계정으로 다른 곳에서 로그인하면 기존 로그인이 풀린다. 짧은 시간에 반복되면 두 곳이 서로 밀어내는 중이다.
    const text = '로그인이 짧은 시간에 반복해서 풀립니다. 다른 PC·브라우저·앱에서 같은 계정으로 로그인 중이면 그쪽 로그인이 이쪽을 끊습니다. 다른 곳의 사용을 끝낸 뒤 다시 시작하세요.';
    await stop(text, 'error');
    notify('로그인이 반복해서 풀림', '다른 곳에서 같은 계정으로 로그인 중인지 확인해 주세요.', true);
    return;
  }
  addLog('로그인이 풀려 다시 로그인합니다 (다른 곳에서 같은 계정으로 로그인했거나 세션이 만료됨)');
  try {
    await ensureLoggedIn({ force: true });
  } catch (e) {
    await stop(`로그인 실패: ${errMsg(e)}`, 'error');
    notify('로그인 실패', errMsg(e), true);
    return;
  }
  const s = await getSettings();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  if (cur) navigate(courseUrl(s, cur)).catch(() => {});
}

// 강의 페이지 안에서 "학습이 실제로 되고 있지 않다"고 판단하면 페이지를 다시 불러온다. 같은 과정에서 3번 넘으면 멈추고 알린다.
async function onReloadRequest(reason) {
  const r = await getRunner();
  if (!r.running || r.phase !== 'course') return;
  const s = await getSettings();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  if (!cur) return;
  const n = await mutate((x) => {
    const c = (x.courses || []).find((k) => k.orderId === x.currentOrderId);
    if (!c) return 0;
    c.reloads = (c.reloads || 0) + 1;
    return c.reloads;
  });
  if (n > 3) {
    const text = `학습이 진행되지 않아 멈췄습니다 (${reason}). "플레이어 화면 보기"와 "진단"으로 원인을 확인해 주세요.`;
    await mutate((x) => { x.phase = 'attention'; x.message = text; });
    addLog(text);
    notify('학습이 진행되지 않습니다', `${cur.title}: ${reason}`, true);
    updateRunnerBadge();
    return;
  }
  addLog(`강의 페이지를 다시 불러옵니다 (${n}/3): ${reason}`);
  await chrome.storage.session.remove('runnerStatus');
  await navigate(courseUrl(s, cur)).catch(() => {});
}

// 플레이어가 알려 준 과정 진도율을 목록에도 반영한다
let lastProgressKey = '';
async function onRunnerStatus(status) {
  await chrome.storage.session.set({ runnerStatus: status });
  beat();
  updateRunnerBadge(status);
  if (status.progress == null) return;
  const r = await getRunner();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  if (!cur || (status.course && cur.title && status.course !== cur.title)) return;
  const key = `${cur.orderId}:${status.progress}`;
  if (key === lastProgressKey || Number(cur.studyProgress) === Number(status.progress)) return;
  lastProgressKey = key;
  await mutate((x) => {
    const c = (x.courses || []).find((k) => k.orderId === x.currentOrderId);
    if (c) c.studyProgress = Number(status.progress);
  });
}

// ---------- 진단: 지금 상태와 사이트 응답을 모아 한 번에 보여준다 ----------
const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}초 전` : '없음');

async function diagnose() {
  const lines = [];
  const s = await getSettings();
  const base = siteBase(s);
  const r = await getRunner();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  lines.push(`진단 ${new Date().toLocaleString('ko-KR')} · 확장 ${chrome.runtime.getManifest().version} · ${(navigator.userAgent.match(/Chrome\/[\d.]+/) || ['Chrome ?'])[0]}`);
  lines.push(`사이트 ${base} · 자동 학습 ${r.running ? '실행 중' : '멈춤'} · 단계 ${r.phase}${r.message ? ` · ${r.message}` : ''}`);
  lines.push(`현재 과정: ${cur ? `${cur.title} (${cur.seriesId})` : '없음'}`);

  try {
    lines.push(`로그인 세션: ${(await sessionOk()) ? '유효' : '없음(401)'}`);
  } catch (e) { lines.push(`로그인 세션 확인 실패: ${errMsg(e)}`); }

  const url = cur ? courseUrl(s, cur) : `${base}/MyPage/MyRoom`;
  try {
    const res = await siteFetch(url.replace(base, ''));
    const html = await res.text();
    const moved = res.url && res.url !== url ? ` → 이동: ${res.url}` : '';
    lines.push(`페이지 요청 ${url}`);
    lines.push(`  HTTP ${res.status}${moved} · ${html.length}자`);
    lines.push(`  X-Frame-Options: ${res.headers.get('x-frame-options') || '없음'}`);
    const csp = res.headers.get('content-security-policy') || '';
    const fa = csp.match(/frame-ancestors[^;]*/i);
    lines.push(`  CSP frame-ancestors: ${fa ? fa[0] : '없음'}`);
    lines.push(`  내용: 플레이어 ${html.includes('videojsplayer') ? '있음' : '없음'} · series.js ${/\/js\/series\.js/i.test(html) ? '있음' : '없음'} · 로그인 폼 ${/id="password"/.test(html) ? '있음' : '없음'} · 강의 목록 ${html.includes('course-accordion') ? '있음' : '없음'}`);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    const sus = [];
    for (const sc of inline) {
      for (const line of sc.split('\n')) {
        if (/window\.top|\btop\s*(!==?|===?)\s*(self|window)|\b(self|window)\s*(!==?|===?)\s*top|top\.location|parent\.location|frameElement|ancestorOrigins|\.top\s*!=|in_iframe|inIframe/i.test(line)) {
          sus.push(line.trim().slice(0, 160));
        }
      }
    }
    lines.push(`  프레임 감지 의심 코드: ${sus.length ? '' : '없음'}`);
    for (const x of sus.slice(0, 8)) lines.push(`    ${x}`);
  } catch (e) { lines.push(`페이지 요청 실패: ${errMsg(e)}`); }

  const rules = await chrome.declarativeNetRequest.getSessionRules();
  lines.push(`프레임 허용 규칙: ${rules.length ? rules.map((x) => `#${x.id} tabIds=${JSON.stringify(x.condition.tabIds)}`).join(', ') : '없음'}`);

  const w = await getPlayerWindow();
  const off = await hasOffscreen();
  lines.push(`플레이어: ${w ? `창 (tab ${w.tabId})` : off ? '보이지 않는 문서' : '없음'}`);
  if (w || off) {
    try {
      const p = await chrome.runtime.sendMessage({ target: 'runner', host: w ? 'window' : 'offscreen', cmd: 'ping' });
      lines.push(`  프레임 주소: ${p && p.src ? p.src : '(없음)'} · 주소 지정 ${ago(p && p.setAt)} · 로드 완료 ${ago(p && p.loadedAt)}`);
    } catch (e) { lines.push(`  플레이어 응답 없음: ${errMsg(e)}`); }
  }
  const ss = await chrome.storage.session.get(['navAt', 'pageAt', 'beatAt', 'runnerStatus', 'lastUrl']);
  lines.push(`마지막 이동 ${ago(ss.navAt)} (${ss.lastUrl || '-'}) · 페이지 응답 ${ago(ss.pageAt)} · 상태 보고 ${ago(ss.beatAt)}`);
  const st = ss.runnerStatus;
  if (st) {
    lines.push(`플레이어 상태: ${st.state} · 과정 "${st.course || ''}" · 강의 "${st.title || ''}" (${st.index}/${st.total}) · player ${st.hasPlayer ? '있음' : '없음'} · src ${st.src || '-'} · readyState ${st.readyState}`);
    lines.push(`  시간 ${st.currentTime != null ? Math.round(st.currentTime) : '-'}/${st.duration != null ? Math.round(st.duration) : '-'}s · rate ${st.rate} · muted ${st.muted} · visibility ${st.visibility} · 진도 저장 ${st.saveCount}회 (${ago(st.lastSaveAt)}) · 이 강의 ${st.lectureProgress}% · 과정 ${st.progress}%`);
    if (st.log && st.log.length) lines.push(`  페이지 기록: ${st.log.map((e) => e.text).join(' | ')}`);
  } else {
    lines.push('플레이어 상태: 보고 없음 (강의 페이지의 확장 스크립트가 아직 동작하지 않음)');
  }
  const { runnerLog = [] } = await chrome.storage.local.get('runnerLog');
  lines.push(`최근 기록: ${runnerLog.slice(-8).map((e) => e.text).join(' | ')}`);

  const text = lines.join('\n');
  await chrome.storage.local.set({ diag: { t: Date.now(), text } });
  return text;
}

async function onRunnerEvent(ev) {
  const r = await getRunner();
  if (!r.running) return;
  if (ev.kind === 'attention') {
    await mutate((x) => { x.phase = 'attention'; x.message = ev.text; });
    addLog(ev.text);
    notify('확인이 필요합니다', `${ev.text}\n팝업에서 "플레이어 화면 보기" 또는 "탭에서 열기"로 처리한 뒤 "다시 시도"를 눌러 주세요.`, true);
    updateRunnerBadge();
  } else {
    addLog(ev.text);
  }
}

async function retry() {
  const r = await getRunner();
  if (!r.running) { await start(); return; }
  const s = await getSettings();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  if (!cur) { await nextCourse(); return; }
  await mutate((x) => { x.phase = 'course'; x.message = ''; });
  addLog('다시 시도합니다');
  await navigate(courseUrl(s, cur));
  updateRunnerBadge();
}

async function openCurrentInTab() {
  const r = await getRunner();
  const s = await getSettings();
  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  // 탭과 플레이어가 동시에 재생하지 않도록 플레이어는 잠시 비운다
  if (r.running) {
    await mutate((x) => { x.phase = 'attention'; x.message = x.message || '탭에서 직접 확인 중'; });
    const host = await ensureHost();
    await sendToHost(host, { cmd: 'navigate', url: 'about:blank' }).catch(() => {});
  }
  await chrome.tabs.create({ url: cur ? courseUrl(s, cur) : `${siteBase(s)}/MyPage/MyRoom` });
  updateRunnerBadge();
}

// 사이트 페이지를 탭으로 연다 (이미 열려 있으면 그 탭으로 이동). 계정이 있으면 먼저 로그인해 둔다.
async function openSitePage(path) {
  const base = siteBase(await getSettings());
  const { account } = await chrome.storage.local.get('account');
  if (account && account.userName && account.password) {
    try { await ensureLoggedIn(); } catch { /* 실패하면 사이트의 로그인 화면이 뜬다 */ }
  }
  const [existing] = await chrome.tabs.query({ url: `${base}${path}*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${base}${path}` });
  }
}

// 30초마다: 페이지가 안 열리거나, 플레이어가 사라졌거나, 오래 조용하면 다시 불러온다
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  const r = await getRunner();
  if (!r.running) { chrome.alarms.clear(WATCHDOG); return; }
  if (r.phase !== 'course') return;
  const { navAt = 0, pageAt = 0, beatAt = 0, pageTimeouts = 0 } =
    await chrome.storage.session.get(['navAt', 'pageAt', 'beatAt', 'pageTimeouts']);
  const now = Date.now();
  if (navAt > pageAt && now - navAt > PAGE_TIMEOUT_MS) {
    if (pageTimeouts >= 1) {
      const text = '플레이어가 사이트 페이지를 열지 못합니다. 팝업의 "플레이어 화면 보기"로 무엇이 보이는지 확인해 주세요.';
      await mutate((x) => { x.phase = 'attention'; x.message = text; });
      addLog(text);
      notify('플레이어 문제', text, true);
      updateRunnerBadge();
      return;
    }
    await chrome.storage.session.set({ pageTimeouts: pageTimeouts + 1 });
    addLog('플레이어가 30초 동안 페이지를 열지 못해 다시 시도합니다');
    await retry();
    return;
  }
  if (!(await hostAlive()) || now - beatAt > STALL_MS) {
    addLog('플레이어 응답이 없어 다시 불러옵니다');
    await retry();
  }
});

// 브라우저를 다시 켜면 플레이어는 사라지므로 상태를 정리한다
chrome.runtime.onStartup.addListener(async () => {
  const r = await getRunner();
  if (r.running) await stop('브라우저가 다시 시작되어 자동 학습이 멈췄습니다. 팝업에서 다시 시작하세요.', 'idle');
});

// =====================================================================
// 배지 / 알림 / 탭 음소거 (탭 모드)
// =====================================================================
const fmtRate = (r) => (Number.isInteger(r) ? `${r}x` : String(+r.toFixed(2)));

async function updateRunnerBadge(status) {
  const r = await getRunner();
  let text = '';
  let color = '#5d7a00';
  if (r.running) {
    if (r.phase === 'attention') { text = '!'; color = '#d97706'; }
    else if (status && status.state === 'playing') text = fmtRate(status.target || 1);
    else text = '...';
  } else if (r.phase === 'error') { text = '!'; color = '#d97706'; }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
}

function badgeFor(s) {
  switch (s.state) {
    case 'playing': return { text: s.speedLocked ? '1x' : fmtRate(s.target), color: '#5d7a00' };
    case 'next-countdown':
    case 'countdown':
    case 'waiting-next': return { text: '>>', color: '#5d7a00' };
    case 'user-paused': return { text: 'II', color: '#6b7280' };
    case 'attention': return { text: '!', color: '#d97706' };
    case 'done': return { text: 'OK', color: '#2563eb' };
    default: return { text: '', color: '#6b7280' };
  }
}

function setTabBadge(tabId, status) {
  const b = badgeFor(status);
  chrome.action.setBadgeText({ tabId, text: b.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }).catch(() => {});
  chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
}

async function notify(title, message, important = false, tab = null) {
  const s = await getSettings();
  if (!s.notify) return;
  const id = tab ? `ubob:${tab.id}:${tab.windowId}:${Date.now()}` : `ubob:runner:${Date.now()}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `유밥 자동학습 · ${title}`,
    message,
    priority: important ? 2 : 0,
    requireInteraction: important
  });
}

chrome.notifications.onClicked.addListener((id) => {
  const [prefix, tabId, windowId] = id.split(':');
  if (prefix !== 'ubob') return;
  if (tabId !== 'runner') {
    chrome.tabs.update(Number(tabId), { active: true }).catch(() => {});
    chrome.windows.update(Number(windowId), { focused: true }).catch(() => {});
  }
  chrome.notifications.clear(id);
});

const TAB_EVENT_TITLE = { 'lecture-done': '강의 종료', 'series-done': '과정 마지막 강의 완료', attention: '확인이 필요합니다', info: '알림' };

// 영상 자체를 음소거하면 크롬이 "소리 없는 백그라운드 탭"으로 보고 타이머를 크게 늦출 수 있다.
// 탭 음소거는 페이지 입장에서는 계속 소리를 내는 상태라 백그라운드에서도 정상 속도로 동작한다.
async function applyMute(tabId, mute) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const mutedByUs = tab.mutedInfo?.reason === 'extension' && tab.mutedInfo?.extensionId === chrome.runtime.id;
    if (mute && !tab.mutedInfo?.muted) await chrome.tabs.update(tabId, { muted: true });
    else if (!mute && mutedByUs) await chrome.tabs.update(tabId, { muted: false });
  } catch { /* 탭이 닫힘 */ }
}

async function seriesTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://*.ubob.com/*' });
  return tabs.filter((t) => SERIES_RE.test(pathOf(t.url || '')));
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if ('muteTab' in changes || 'enabled' in changes) {
    const s = await getSettings();
    for (const t of await seriesTabs()) applyMute(t.id, s.enabled && s.muteTab);
  }
  if ('enabled' in changes && !changes.enabled.newValue) {
    for (const t of await seriesTabs()) chrome.action.setBadgeText({ tabId: t.id, text: '' });
  }
});

// =====================================================================
// 메시지
// =====================================================================
const POPUP_ACTIONS = {
  'runner-start': () => start(),
  'runner-stop': () => stop('자동 학습을 중지했습니다'),
  'runner-retry': () => retry(),
  'runner-skip': () => finishCurrent('skipped', '사용자가 건너뜀'),
  'runner-open-tab': () => openCurrentInTab(),
  'runner-list': () => refreshList(),
  'account-test': () => testAccount(),
  'player-show': () => showPlayer(),
  'open-myroom': () => openSitePage('/MyPage/MyRoom'),
  'open-course': (msg) => openSitePage(`/Series/SeriesDetail/${encodeURIComponent(msg.seriesId)}`),
  'diagnose': () => diagnose()
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'runner') return;

  // 팝업
  if (POPUP_ACTIONS[msg.type]) {
    POPUP_ACTIONS[msg.type](msg).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: errMsg(e) })
    );
    return true;
  }

  // 플레이어 페이지 자체
  if (msg.type === 'runner-host-ready') {
    onHostReady(msg.host, sender).then(sendResponse, () => sendResponse({ url: null }));
    return true;
  }

  // 플레이어 안의 content script
  switch (msg.type) {
    case 'runner-page':
      onRunnerPage(msg.kind, msg.url).then(sendResponse, () => sendResponse({ cmd: 'none' }));
      return true;
    case 'runner-reload':
      onReloadRequest(msg.reason);
      return;
    case 'runner-course-finished':
      getRunner().then((r) => {
        if (r.running) finishCurrent('done', msg.result && msg.result.reason, msg.result && Number(msg.result.progress));
      });
      return;
    case 'runner-status':
      onRunnerStatus(msg.status);
      return;
    case 'runner-event':
      onRunnerEvent(msg.event);
      return;
  }

  // 탭 모드
  const tab = sender.tab;
  if (!tab) return;
  switch (msg.type) {
    case 'hello':
      if (msg.series) getSettings().then((s) => applyMute(tab.id, s.enabled && s.muteTab));
      break;
    case 'status':
      setTabBadge(tab.id, msg.status);
      break;
    case 'event':
      notify(TAB_EVENT_TITLE[msg.event.kind] || '알림', msg.event.text, msg.event.kind === 'attention', tab);
      break;
  }
});
