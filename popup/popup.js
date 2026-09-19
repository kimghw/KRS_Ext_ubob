const { DEFAULTS, SPEEDS } = UBOB_AUTO;
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let runner = null;
let status = null;
let runnerLog = [];
let account = null;
let excluded = [];
let auth = null;
let editingAccount = false;
let loginChecking = false;
let listLoading = false;
let listResult = null;   // { ok, text }

const COURSE_STATUS = {
  pending: '대기', playing: '학습 중', done: '완료', passed: '수료', closed: '기간 종료',
  complete: '진도 100%', skipped: '건너뜀', failed: '실패'
};
const PLAYABLE = new Set(['pending', 'playing', 'done', 'skipped', 'failed']);

const fmtRate = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2)));
const fmtTime = (sec) => {
  if (!Number.isFinite(sec)) return '--:--';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const fmtClock = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`;
};

// ---------- 불러오기 ----------
async function load() {
  const [s, l, ss] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ runner: null, runnerLog: [], account: null, excluded: [], auth: null }),
    chrome.storage.session.get({ runnerStatus: null })
  ]);
  settings = s;
  runner = l.runner;
  runnerLog = l.runnerLog;
  account = l.account;
  excluded = l.excluded;
  auth = l.auth;
  status = ss.runnerStatus;
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  const v = (k) => changes[k].newValue;
  if (area === 'sync') for (const k of Object.keys(changes)) settings[k] = v(k);
  if (area === 'local') {
    if (changes.runner) runner = v('runner');
    if (changes.runnerLog) runnerLog = v('runnerLog') || [];
    if (changes.account) account = v('account');
    if (changes.excluded) excluded = v('excluded') || [];
    if (changes.auth) auth = v('auth');
  }
  if (area === 'session' && changes.runnerStatus) status = v('runnerStatus');
  render();
});

const act = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch((e) => ({ ok: false, error: String(e) }));

// ---------- 러너 상태 ----------
function phaseView() {
  const r = runner || { running: false, phase: 'idle' };
  if (!r.running) {
    if (r.phase === 'done') return ['모든 과정 완료', 'done'];
    if (r.phase === 'error') return ['중지됨', 'warn'];
    return ['대기 중', ''];
  }
  if (r.phase === 'prepare') return [r.message || '준비 중…', 'ok'];
  if (r.phase === 'attention') return ['확인이 필요합니다', 'warn'];
  const st = status && status.state;
  if (st === 'playing') return ['재생 중', 'ok'];
  if (st === 'course-finished') return ['다음 과정으로 이동 중…', 'ok'];
  if (st === 'waiting-next' || st === 'next-countdown' || st === 'countdown') return ['다음 강의 준비 중…', 'ok'];
  return ['강의 불러오는 중…', 'ok'];
}

function renderRunner() {
  const r = runner || { running: false, phase: 'idle', courses: [] };
  const [label, cls] = phaseView();
  $('phaseText').textContent = label;
  $('dot').className = `dot ${cls}`;

  const msg = $('message');
  msg.hidden = !r.message || r.phase === 'prepare';
  msg.textContent = r.message || '';
  msg.className = `msg${r.phase === 'attention' || r.phase === 'error' ? ' warn' : ''}`;

  const cur = (r.courses || []).find((c) => c.orderId === r.currentOrderId);
  const playing = r.running && r.phase !== 'prepare' && cur;
  $('nowPlaying').hidden = !playing;
  if (playing) {
    $('courseTitle').textContent = cur.title;
    const s = status || {};
    const sameCourse = !s.course || s.course === cur.title || !cur.title;
    if (sameCourse && s.title) {
      $('lectureTitle').textContent = `${s.total ? `${s.index}/${s.total}강 · ` : ''}${s.title}`;
      const pct = s.isLecture && s.duration ? Math.min(100, (s.currentTime / s.duration) * 100) : 0;
      $('bar').style.width = `${pct}%`;
      $('time').textContent = s.isLecture && s.duration
        ? `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}${s.rate ? ` · ${fmtRate(s.rate)}x` : ''}`
        : '';
      $('progress').textContent = s.progress != null ? `과정 진도 ${s.progress}%` : '';
      $('saves').textContent = `진도 저장 ${s.saveCount || 0}회${s.lastSaveAt ? ` · ${ago(s.lastSaveAt)}` : ''}`;
      $('lectureProgress').textContent = s.lectureProgress != null ? `이 강의 ${s.lectureProgress}%` : '';
    } else {
      $('lectureTitle').textContent = s.state === 'loading' && s.hasPlayer === false ? '강의 페이지에 플레이어가 아직 없습니다' : '강의 정보를 불러오는 중…';
      $('bar').style.width = '0%';
      $('time').textContent = '';
      $('progress').textContent = '';
      $('saves').textContent = '';
      $('lectureProgress').textContent = '';
    }
    // 재생 중이라는데 진도 저장이 없으면 표시
    const warn = $('playWarn');
    const stuck = s.state === 'playing' && !s.saveCount && s.currentTime > 90;
    warn.hidden = !stuck;
    if (stuck) warn.textContent = '재생은 되고 있지만 사이트가 진도를 저장하지 않았습니다. 90초 안에 저장이 없으면 페이지를 다시 불러옵니다.';
  }

  const attention = r.running && r.phase === 'attention';
  $('btnStart').hidden = r.running;
  $('btnStop').hidden = !r.running;
  $('btnOpenTab').hidden = !attention;
  $('btnRetry').hidden = !attention;
  $('btnSkip').hidden = !(attention && cur);
  $('btnPlayer').hidden = !r.running || r.phase === 'prepare';
  $('startHint').hidden = r.running;
}

// ---------- 과정 목록 ----------
function renderCourses() {
  const list = (runner && runner.courses) || [];
  const todo = list.filter((c) => (c.status === 'pending' || c.status === 'playing') && !excluded.includes(c.orderId)).length;
  $('coursesLabel').textContent = list.length ? `학습중인 과정 ${list.length}개 · 학습할 과정 ${todo}개` : '학습중인 과정';
  $('coursesEmpty').hidden = list.length > 0;
  $('btnList').disabled = listLoading;
  $('btnList').textContent = listLoading ? '불러오는 중…' : '목록 새로고침';
  $('listResult').hidden = !listResult;
  if (listResult) {
    $('listResult').textContent = listResult.text;
    $('listResult').className = `msg${listResult.ok ? '' : ' warn'}`;
  }

  $('courses').replaceChildren(...list.map((c) => {
    const li = document.createElement('li');
    if (runner && runner.running && c.orderId === runner.currentOrderId) li.className = 'current';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const playable = PLAYABLE.has(c.status);
    cb.checked = playable && !excluded.includes(c.orderId);
    cb.disabled = !playable;
    cb.title = playable ? '자동 학습에 포함' : '학습할 필요가 없는 과정';
    cb.addEventListener('change', () => {
      const set = new Set(excluded);
      if (cb.checked) set.delete(c.orderId); else set.add(c.orderId);
      chrome.storage.local.set({ excluded: [...set] });
    });

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'title';
    title.textContent = c.title;
    title.title = `${c.title}${c.group ? `\n분류: ${c.group}` : ''}${c.endDate ? `\n학습기간: ~${String(c.endDate).slice(0, 10)}` : ''}${c.note ? `\n${c.note}` : ''}\n(누르면 과정 페이지를 탭으로 엽니다)`;
    title.addEventListener('click', () => act('open-course', { seriesId: c.seriesId }));

    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${Math.round(Number(c.studyProgress) || 0)}%`;

    const chip = document.createElement('span');
    chip.className = `chip ${c.status}`;
    chip.textContent = COURSE_STATUS[c.status] || c.status;

    li.append(cb, title, pct, chip);
    return li;
  }));
}

// ---------- 계정 ----------
function renderAccount() {
  const has = !!(account && account.userName && account.password);
  const showForm = !has || editingAccount;
  $('accountForm').hidden = !showForm;
  $('accountView').hidden = showForm;
  $('btnEditAccount').hidden = showForm;
  if (has) {
    const host = (() => { try { return new URL(settings.baseUrl).host; } catch { return settings.baseUrl; } })();
    $('accountSaved').textContent = `${host} · ${account.userName}`;
    let text, cls;
    if (loginChecking) { text = '로그인 확인 중…'; cls = ''; }
    else if (auth && auth.ok) { text = `로그인됨${auth.name ? ` · ${auth.name}` : ''} (${fmtClock(auth.checkedAt)} 확인)`; cls = 'ok'; }
    else if (auth) { text = `로그인 실패: ${auth.message}`; cls = 'warn'; }
    else { text = '아직 로그인을 확인하지 않았습니다'; cls = ''; }
    $('authText').textContent = text;
    $('authDot').className = `dot ${cls}`;
    $('btnTestLogin').disabled = loginChecking;
  }
  if (showForm && !$('baseUrl').value) {
    $('baseUrl').value = settings.baseUrl || DEFAULTS.baseUrl;
    $('userName').value = (account && account.userName) || '';
    $('password').placeholder = has ? '저장됨 (바꾸려면 입력)' : '';
    $('password').required = !has;
  }
}

async function testLogin() {
  loginChecking = true;
  render();
  await act('account-test');
  loginChecking = false;
  const l = await chrome.storage.local.get({ auth: null });
  auth = l.auth;
  render();
}

$('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('accountError');
  err.hidden = true;
  let base;
  try {
    const u = new URL($('baseUrl').value.trim());
    if (u.protocol !== 'https:' || !/(^|\.)ubob\.com$/.test(u.hostname)) throw new Error();
    base = u.origin;
  } catch {
    err.textContent = 'https://○○○.ubob.com 형식의 주소를 입력해 주세요.';
    err.hidden = false;
    return;
  }
  const userName = $('userName').value.trim();
  const password = $('password').value || (account && account.password) || '';
  if (!userName || !password) {
    err.textContent = '아이디와 비밀번호를 입력해 주세요.';
    err.hidden = false;
    return;
  }
  await chrome.storage.sync.set({ baseUrl: base });
  settings.baseUrl = base;
  account = { userName, password };
  await chrome.storage.local.set({ account, auth: null });
  auth = null;
  $('password').value = '';
  editingAccount = false;
  testLogin();   // 저장하면 바로 로그인을 확인한다
});

$('btnEditAccount').addEventListener('click', () => {
  editingAccount = true;
  $('baseUrl').value = '';
  renderAccount();
  $('userName').focus();
});

$('btnTestLogin').addEventListener('click', testLogin);

// ---------- 설정 ----------
const CHECKS = ['runnerMuted', 'notify', 'enabled'];
for (const k of CHECKS) $(k).addEventListener('change', (e) => chrome.storage.sync.set({ [k]: e.target.checked }));

function renderSettings() {
  for (const k of CHECKS) $(k).checked = !!settings[k];
  const list = SPEEDS.includes(settings.speed) ? SPEEDS : [...SPEEDS, settings.speed].sort((a, b) => a - b);
  $('speeds').replaceChildren(...list.map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${fmtRate(v)}x`;
    b.setAttribute('aria-pressed', String(v === settings.speed));
    b.addEventListener('click', () => chrome.storage.sync.set({ speed: v }));
    return b;
  }));
}

// ---------- 기록 ----------
function renderLog() {
  $('logCard').hidden = runnerLog.length === 0;
  $('log').replaceChildren(...runnerLog.slice(-15).reverse().map((e) => {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = fmtClock(e.t);
    const span = document.createElement('span');
    span.textContent = e.text;
    li.append(t, span);
    return li;
  }));
}

function render() {
  renderRunner();
  renderCourses();
  renderAccount();
  renderSettings();
  renderLog();
}

// ---------- 버튼 ----------
$('btnStart').addEventListener('click', () => act('runner-start'));
$('btnStop').addEventListener('click', () => act('runner-stop'));
$('btnRetry').addEventListener('click', () => act('runner-retry'));
$('btnSkip').addEventListener('click', () => act('runner-skip'));
$('btnOpenTab').addEventListener('click', () => act('runner-open-tab'));
$('btnPlayer').addEventListener('click', () => act('player-show'));

let diagText = '';
$('btnDiag').addEventListener('click', async () => {
  const btn = $('btnDiag');
  btn.disabled = true;
  btn.textContent = '진단 중…';
  const res = await act('diagnose');
  diagText = res && res.ok ? res.result : `진단 실패: ${(res && res.error) || '알 수 없는 오류'}`;
  $('diag').textContent = diagText;
  $('diag').hidden = false;
  $('btnDiagCopy').hidden = false;
  btn.disabled = false;
  btn.textContent = '다시 진단';
});
$('btnDiagCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagText);
    $('btnDiagCopy').textContent = '복사됨';
    setTimeout(() => { $('btnDiagCopy').textContent = '진단 결과 복사'; }, 1500);
  } catch {
    $('diag').focus();
  }
});
$('btnMyRoom').addEventListener('click', async () => {
  const btn = $('btnMyRoom');
  btn.disabled = true;
  btn.textContent = '여는 중…';   // 로그인 확인 후 탭이 열리면 팝업은 닫힌다
  await act('open-myroom');
  btn.disabled = false;
  btn.textContent = '내 강의실 열기';
});
$('btnList').addEventListener('click', async () => {
  listLoading = true;
  listResult = null;
  render();
  const res = await act('runner-list');
  listLoading = false;
  const r = res && res.result;
  if (res && res.ok && r && r.ok) {
    listResult = { ok: true, text: `수강 과정 ${r.total}개를 불러왔습니다 (학습할 과정 ${r.todo}개)` };
  } else {
    listResult = { ok: false, text: `목록을 불러오지 못했습니다: ${(r && r.error) || (res && res.error) || '알 수 없는 오류'}` };
  }
  const l = await chrome.storage.local.get({ auth: null });
  auth = l.auth;
  render();
});

load();
