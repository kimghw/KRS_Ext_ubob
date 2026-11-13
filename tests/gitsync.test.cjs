// 머리의 GitHub 아이콘(popup/gitsync.js) — 확인 결과에 따른 모양, 누르면 받기·다시 불러오기, 브릿지가 없을 때의 안내 줄.
// 브릿지(워크스페이스 확장의 com.krs.gitsync)는 흉내다 — 진짜 git 은 그쪽 저장소의 test/gitclient.test.mjs 가 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HOST, CHECK_MS, NO_BRIDGE, view, create } = require('../popup/gitsync.js');

const same = { ok: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, commits: [], dirty: 0, overlap: [] };
const behind = (n, more = {}) => ({ ...same, behind: n, commits: Array.from({ length: n }, (_, i) => ({ hash: `abc${i}`, subject: `커밋 ${i + 1}` })), ...more });

function element() {
  const classes = new Set(), listeners = {}, attrs = {};
  return {
    dataset: {}, title: '', textContent: '', hidden: false, attrs,
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    setAttribute: (name, value) => { attrs[name] = value; },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    press: () => listeners.click(),
  };
}

/** replies 는 작업 이름마다의 답(함수면 부를 때마다 부른다 — 던지면 브릿지가 없는 것). */
function fixture(replies, { pending = false, hidden = () => false } = {}) {
  const button = element(), badge = element(), notice = element();
  const calls = [], timers = [], stored = { pending };
  let reloaded = 0;
  const send = async (task, timeoutMs) => {
    calls.push([task, timeoutMs]);
    const r = replies[task];
    return typeof r === 'function' ? r() : r;
  };
  const sync = create({ button, badge, notice, send, reload: () => { reloaded++; }, now: () => new Date(2026, 10, 13, 9, 5), hidden,
    every: (fn, ms) => timers.push([fn, ms]), store: { get: async () => stored.pending, set: async (on) => { stored.pending = on; } } });
  return { sync, button, badge, notice, calls, timers, stored, replies, reloaded: () => reloaded };
}
const noHost = () => { throw new Error('Specified native messaging host not found.'); };

test('확인 결과마다의 모양 — 받을 수 있을 때만 new 이고 풍선 말은 짧다', () => {
  assert.deepEqual(view(null), { mode: 'idle', count: '', title: 'GitHub 새 버전 확인' });
  assert.equal(view({ ok: false, unreachable: true, error: 'x' }).mode, 'off');
  assert.deepEqual(view({ ok: false, error: 'main 가지에 올라간 곳(upstream)이 없습니다.' }),
    { mode: 'error', count: '', title: '확인 실패 · main 가지에 올라간 곳(upstream)이 없습니다.' });
  assert.deepEqual(view(same, new Date(2026, 10, 13, 9, 5)), { mode: 'same', count: '', title: '최신 버전 · 09:05 확인' });
  assert.deepEqual(view({ ...same, ahead: 2 }), { mode: 'ahead', count: '', title: '최신 · 올리지 않은 커밋 2개' });
  assert.deepEqual(view(behind(2)), { mode: 'new', count: '2', title: '새 커밋 2개 · 눌러서 받기\n· 커밋 1\n· 커밋 2' });
  assert.deepEqual([view(behind(1, { overlap: ['popup/popup.js'] })).mode, view(behind(1, { ahead: 1 })).mode], ['blocked', 'diverged']);
  assert.equal(view(behind(120)).count, '99+');
  // 풍선 말에 적는 커밋 제목은 다섯 줄까지.
  assert.equal(view(behind(8)).title.split('\n').length, 6);
  for (const s of [null, { ok: false, unreachable: true }, same, { ...same, ahead: 2 }, behind(3), behind(1, { ahead: 1 }), behind(1, { overlap: ['a'] })]) {
    assert.ok(view(s).title.split('\n')[0].length < 25, view(s).title);
  }
  assert.ok(NO_BRIDGE.length < 25 && NO_BRIDGE.includes('워크스페이스 브릿지') && NO_BRIDGE.includes('직접 갱신'));
});

test('패널을 열면 곧바로 한 번 보고 10분마다 본다 — 가려져 있으면 그 차례는 건너뛴다', async () => {
  let covered = false;
  const f = fixture({ gitStatus: same }, { hidden: () => covered });
  await f.sync.start();
  assert.deepEqual(f.calls, [['gitStatus', 45_000]]);
  assert.deepEqual([f.button.dataset.mode, f.button.title, f.badge.hidden, f.notice.hidden], ['same', '최신 버전 · 09:05 확인', true, true]);
  assert.deepEqual([f.timers.length, f.timers[0][1], CHECK_MS], [1, 600_000, 600_000]);
  covered = true;
  await f.timers[0][0]();
  assert.equal(f.calls.length, 1);
  covered = false;
  await f.timers[0][0]();
  assert.equal(f.calls.length, 2);
});

test('브릿지가 없으면 머리 아래에 직접 갱신하라는 줄이 뜨고, 생기면 사라진다', async () => {
  const f = fixture({ gitStatus: noHost });
  await f.sync.start();
  assert.deepEqual([f.button.dataset.mode, f.notice.hidden, f.notice.textContent], ['off', false, '워크스페이스 브릿지 없음 · 직접 갱신하세요']);
  assert.equal(f.notice.title, 'Specified native messaging host not found.');
  // 눌러도 받으러 가지 않고 다시 확인만 한다.
  await f.button.press();
  assert.deepEqual(f.calls.map((c) => c[0]), ['gitStatus', 'gitStatus']);

  f.replies.gitStatus = same;
  await f.button.press();
  assert.deepEqual([f.button.dataset.mode, f.notice.hidden, f.notice.textContent, f.notice.title], ['same', true, '', '']);
});

test('브릿지는 있어도 이 확장이 등록돼 있지 않으면 없는 것과 같고, 답이 늦은 것은 브릿지 없음이 아니다', async () => {
  const f = fixture({ gitStatus: { ok: false, code: 'NOT_REGISTERED', error: '이 확장은 다리에 등록돼 있지 않습니다.' } });
  await f.sync.start();
  assert.deepEqual([f.button.dataset.mode, f.notice.textContent], ['off', NO_BRIDGE]);

  const slow = fixture({ gitStatus: () => { throw Object.assign(new Error('45초 안에 응답 없음'), { timeout: true }); } });
  await slow.sync.start();
  assert.deepEqual([slow.button.dataset.mode, slow.notice.hidden], ['error', true]);
});

test('새 커밋이 있으면 수를 띄우고, 누르면 받고, 한 번 더 누르면 확장을 다시 불러온다', async () => {
  const f = fixture({ gitStatus: behind(3), gitPull: { ok: true, from: 'aaaaaaa', to: 'bbbbbbb', pulled: 3, files: ['popup/popup.js'], fileCount: 1, reload: true } });
  await f.sync.start();
  assert.deepEqual([f.button.dataset.mode, f.badge.textContent, f.badge.hidden, f.button.attrs['aria-label']], ['new', '3', false, '새 커밋 3개 · 눌러서 받기']);

  await f.button.press();
  assert.deepEqual(f.calls.map((c) => c[0]), ['gitStatus', 'gitPull']);
  assert.deepEqual([f.button.dataset.mode, f.badge.textContent, f.button.title, f.stored.pending, f.reloaded()], ['reload', '↻', '받음 · 눌러서 다시 불러오기', true, 0]);
  // 다시 불러오기를 기다리는 동안에는 10분마다의 확인도 돌지 않는다.
  await f.timers[0][0]();
  assert.equal(f.calls.length, 2);

  await f.button.press();
  assert.deepEqual([f.reloaded(), f.calls.length], [1, 2]);
});

test('받아 두고 다시 불러오지 않은 채 패널을 닫았었다면 ↻ 부터 보인다', async () => {
  const f = fixture({ gitStatus: same }, { pending: true });
  await f.sync.start();
  assert.deepEqual([f.button.dataset.mode, f.calls.length], ['reload', 0]);
  await f.button.press();
  assert.equal(f.reloaded(), 1);
});

test('설명·검사만 받았으면 다시 불러오지 않고 최신으로 돌아간다', async () => {
  const f = fixture({ gitStatus: behind(1), gitPull: { ok: true, pulled: 1, files: ['README.md'], fileCount: 1, reload: false } });
  await f.sync.start();
  f.replies.gitStatus = same;
  await f.button.press();
  assert.deepEqual([f.button.dataset.mode, f.stored.pending, f.badge.hidden, f.notice.hidden], ['same', false, true, true]);
});

test('받지 못하면 그 까닭이 안내 줄에 남고, 받고 나면 지워진다', async () => {
  const f = fixture({ gitStatus: behind(1), gitPull: { ok: false, error: 'GitHub 인증이 필요합니다 — 터미널에서 한 번 git pull 해 로그인해 두세요.' } });
  await f.sync.start();
  await f.button.press();
  assert.deepEqual(f.calls.map((c) => c[0]), ['gitStatus', 'gitPull', 'gitStatus']);
  assert.deepEqual([f.button.dataset.mode, f.notice.hidden, f.notice.textContent],
    ['new', false, '받기 실패 · GitHub 인증이 필요합니다 — 터미널에서 한 번 git pull 해 로그인해 두세요.']);

  f.replies.gitPull = { ok: true, pulled: 1, files: ['src/background.js'], fileCount: 1, reload: true };
  await f.button.press();
  assert.deepEqual([f.button.dataset.mode, f.notice.hidden], ['reload', true]);
});

test('받을 수 없는 모양(겹침·갈라짐)에서 누르면 받지 않고 다시 확인만 한다', async () => {
  for (const status of [behind(2, { overlap: ['popup/popup.js'] }), behind(2, { ahead: 1 })]) {
    const f = fixture({ gitStatus: status, gitPull: { ok: true } });
    await f.sync.start();
    await f.button.press();
    assert.deepEqual(f.calls.map((c) => c[0]), ['gitStatus', 'gitStatus']);
    assert.equal(f.badge.textContent, '2');
  }
});

test('확장에 붙어 있다 — 권한·화면의 단추와 안내 줄·스크립트 차례', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.equal(HOST, 'com.krs.gitsync');
  const html = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  for (const id of ['gitSync', 'gitCount', 'gitNotice']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('src="gitsync.js"') > 0 && html.indexOf('src="gitsync.js"') < html.indexOf('src="popup.js"'));
  // 안내 줄은 머리 바로 아래에 있다.
  assert.match(html, /<\/header>\s*<p [^>]*id="gitNotice"/);
});
