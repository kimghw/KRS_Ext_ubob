const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/alpha-certificate-batch.js');
const loginId = 'current-learner';
const user = { authenticated: true, loginId };
const uuid = number => `12345678-1234-1234-1234-${String(number).padStart(12, '0')}`;
const entry = number => ({ registrationId: uuid(number), course: {
  id: uuid(number + 100), sequenceId: uuid(number + 200), title: `Actual completed course ${number}`,
  type: number === 1 ? 1 : 4, url: `https://alpha-campus.kr/explore/${uuid(number + 100)}`,
} });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let turn = 0; turn < 100 && !predicate(); turn++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'background operation reached the expected state');
}
function fixture({ initial, login, list, ensure, session, get, set, now } = {}) {
  const saved = initial ? { alphaCertificateBatch: structuredClone(initial) } : {};
  const calls = { login: 0, list: [], ensure: [], sessions: 0, writes: [] };
  let run = 0;
  const batch = create({ now: now || (() => 1000 + calls.writes.length), id: () => `run-${++run}`,
    auth: { ensureLoggedIn: async () => { calls.login++; return login ? login() : user; } },
    api: { session: async () => { calls.sessions++; return session ? session(calls.sessions) : user; } },
    list: { listCompleted: async options => {
      calls.list.push(options);
      return list ? list(options) : [entry(1), entry(2), entry(3)];
    } },
    certificates: { ensureListed: async options => {
      calls.ensure.push(options);
      return ensure ? ensure(options, calls.ensure.length) : { status: 'complete', message: 'saved' };
    } },
    storage: {
      get: async key => get ? get(key) : { [key]: structuredClone(saved[key]) },
      set: async value => {
        if (set) await set(value);
        calls.writes.push(structuredClone(value)); Object.assign(saved, structuredClone(value));
      },
    },
  });
  return { batch, saved, calls, state: () => saved.alphaCertificateBatch };
}

test('start acknowledges while login is pending and rejects double-click starts', async () => {
  const gate = deferred();
  const f = fixture({ login: () => gate.promise });
  assert.equal((await f.batch.start()).ok, true);
  assert.equal(f.state().phase, 'listing');
  assert.equal(await f.batch.isBusy(), true);
  await assert.rejects(f.batch.start(), /진행 중/);
  gate.resolve(user); await until(() => f.state().phase === 'done');
  assert.equal(f.calls.login, 1); assert.equal(f.calls.list.length, 1);
});

test('batch processes actual account courses without catalog filtering and separates saved from downloading', async () => {
  const statuses = ['complete', 'downloading', 'failed'];
  const f = fixture({ ensure: async (_input, index) => ({ status: statuses[index - 1], message: statuses[index - 1] }) });
  await f.batch.start(); await until(() => f.state().phase === 'done');
  const state = await f.batch.getState();
  assert.equal(state.busy, false); assert.equal(state.total, 3); assert.equal(state.processed, 3);
  assert.deepEqual(state.items.map(item => item.status), statuses);
  assert.match(state.message, /저장 완료 1개/); assert.match(state.message, /다운로드 중 1개/); assert.match(state.message, /확인 필요 1개/);
  assert.deepEqual(f.calls.ensure.map(item => item.course), [entry(1).course, entry(2).course, entry(3).course]);
  for (const input of f.calls.ensure) {
    assert.equal(input.loginId, loginId); assert.equal(input.retry, true);
    assert.equal(typeof input.shouldStop, 'function');
  }
  state.items[0].status = 'modified';
  assert.equal((await f.batch.getState()).items[0].status, 'complete');
});

test('page progress is persisted while listing and late page callbacks cannot overwrite completed state', async () => {
  const gate = deferred(); let options;
  const f = fixture({ list: async args => {
    options = args; await args.onPage({ scanned: 100, total: 205, page: 0 }); await gate.promise;
    await args.onPage({ scanned: 205, total: 205, page: 2 }); return [entry(1)];
  } });
  await f.batch.start(); await until(() => f.state().scanned === 100);
  assert.equal(f.state().phase, 'listing'); assert.equal(f.state().total, 205);
  gate.resolve(); await until(() => f.state().phase === 'done');
  assert.equal(f.state().scanned, 205); assert.equal(f.state().total, 1);
  const message = f.state().message;
  await options.onPage({ scanned: 999, total: 999 });
  assert.equal(f.state().message, message); assert.equal(f.state().scanned, 205);
});

test('ordinary per-certificate errors continue to later certificates and redact obvious credentials', async () => {
  const f = fixture({ ensure: async (_input, index) => {
    if (index === 1) throw new Error('PDF unavailable token=private-value');
    if (index === 2) return { status: 'interrupted', message: 'download cancelled' };
    return { status: 'complete', message: 'saved' };
  } });
  await f.batch.start(); await until(() => f.state().phase === 'done');
  assert.equal(f.calls.ensure.length, 3);
  assert.deepEqual(f.state().items.map(item => item.status), ['failed', 'interrupted', 'complete']);
  assert.equal(JSON.stringify(f.saved).includes('private-value'), false);
});

test('account switches or missing authentication after a certificate stop all later items', async () => {
  for (const switched of [{ authenticated: true, loginId: 'other' }, { authenticated: false }]) {
    let changed = false;
    const f = fixture({ session: () => changed ? switched : user,
      ensure: async () => { changed = true; return { status: 'failed', message: 'account changed' }; } });
    await f.batch.start(); await until(() => f.state().phase === 'error');
    assert.equal(f.calls.ensure.length, 1); assert.equal(f.state().processed, 1);
    assert.match(f.state().message, /계정/); assert.equal(f.state().items[1].status, 'pending');
  }
});

test('account change during listing prevents any certificate issuance', async () => {
  let changed = false;
  const f = fixture({ session: () => changed ? { authenticated: true, loginId: 'other' } : user,
    list: async () => { changed = true; return [entry(1)]; } });
  await f.batch.start(); await until(() => f.state().phase === 'error');
  assert.equal(f.calls.ensure.length, 0); assert.equal(f.state().busy, false);
});

test('stop during listing acknowledges quickly and prevents all certificate side effects', async () => {
  const gate = deferred(); let options;
  const f = fixture({ list: async args => { options = args; return gate.promise; } });
  await f.batch.start(); await until(() => !!options);
  assert.equal((await f.batch.stop()).ok, true);
  assert.equal(options.shouldStop(), true); assert.equal(f.state().phase, 'stopping');
  gate.resolve([entry(1)]); await until(() => f.state().phase === 'stopped');
  assert.equal(f.calls.ensure.length, 0); assert.equal(f.state().busy, false);
});

test('stop propagates to the active certificate and preserves its result without starting another', async () => {
  const gate = deferred();
  const f = fixture({ ensure: () => gate.promise });
  await f.batch.start(); await until(() => f.calls.ensure.length === 1);
  await f.batch.stop();
  assert.equal(f.calls.ensure[0].shouldStop(), true);
  await assert.rejects(f.batch.start(), /진행 중/);
  gate.resolve({ status: 'downloading', message: 'already started before stop' });
  await until(() => f.state().phase === 'stopped');
  assert.equal(f.calls.ensure.length, 1); assert.equal(f.state().processed, 1);
  assert.equal(f.state().items[0].status, 'downloading');
  assert.equal(f.state().items[1].status, 'pending');
});

test('stop before the initial state is persisted prevents even login from starting', async () => {
  const gate = deferred(); let blocking = true;
  const f = fixture({ set: async () => { if (blocking) { blocking = false; await gate.promise; } } });
  const starting = f.batch.start();
  await until(() => !blocking);
  const stopping = f.batch.stop(); gate.resolve();
  await Promise.all([starting, stopping]); await until(() => f.state().phase === 'stopped');
  assert.equal(f.calls.login, 0); assert.equal(f.calls.list.length, 0); assert.equal(f.calls.ensure.length, 0);
});

test('worker restart marks unfinished work interrupted without automatically reissuing requests', async () => {
  const f = fixture({ initial: { busy: true, phase: 'downloading', runId: 'previous-run', loginId,
    total: 3, scanned: 3, processed: 1, currentTitle: 'old', items: [{ registrationId: entry(1).registrationId, status: 'downloading' }] } });
  await f.batch.ready;
  assert.equal(f.state().phase, 'interrupted'); assert.equal(f.state().busy, false);
  assert.equal(f.state().processed, 1); assert.equal(f.state().items[0].status, 'downloading');
  assert.equal(f.calls.login, 0); assert.equal(f.calls.list.length, 0); assert.equal(f.calls.ensure.length, 0);
  assert.equal(await f.batch.isBusy(), false);
});

test('duplicate registration pages are deduplicated, while conflicting identities fail before downloads', async () => {
  const repeated = fixture({ list: async () => [entry(1), entry(1), entry(2)] });
  await repeated.batch.start(); await until(() => repeated.state().phase === 'done');
  assert.equal(repeated.calls.ensure.length, 2); assert.equal(repeated.state().total, 2);
  const conflicting = fixture({ list: async () => [entry(1), { ...entry(1), course: entry(2).course }] });
  await conflicting.batch.start(); await until(() => conflicting.state().phase === 'error');
  assert.equal(conflicting.calls.ensure.length, 0);
});

test('only this year (Korea time) is requested from the completed list', async () => {
  // 한국 시간 2026-01-01 00:30 — UTC로는 아직 2025년이다.
  const f = fixture({ now: () => Date.parse('2025-12-31T15:30:00Z') });
  await f.batch.start(); await until(() => f.state().phase === 'done');
  assert.equal(f.calls.list[0].year, 2026); assert.equal(f.state().year, 2026);
  const empty = fixture({ now: () => Date.parse('2026-11-14T03:00:00Z'), list: async () => [] });
  await empty.batch.start(); await until(() => empty.state().phase === 'done');
  assert.match(empty.state().message, /2026년에 수강한 강의 중 수료한 교육이 없습니다/);
});

test('empty history reports no completed courses and malformed manager results never count as saved', async () => {
  const empty = fixture({ list: async () => [] });
  await empty.batch.start(); await until(() => empty.state().phase === 'done');
  assert.equal(empty.state().processed, 0); assert.equal(empty.calls.ensure.length, 0);
  assert.match(empty.state().message, /수료한 교육이 없습니다/);
  const malformed = fixture({ list: async () => [entry(1)], ensure: async () => ({ status: 'unknown' }) });
  await malformed.batch.start(); await until(() => malformed.state().phase === 'done');
  assert.equal(malformed.state().items[0].status, 'failed'); assert.match(malformed.state().message, /저장 완료 0개/);
});

test('initial state persistence failure prevents login and settles in a retryable error state', async () => {
  let attempts = 0;
  const f = fixture({ set: async () => { if (++attempts === 1) throw new Error('storage write failed'); } });
  await assert.rejects(f.batch.start(), /storage write failed/);
  await until(() => f.state()?.phase === 'error');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.batch.isBusy(), false);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.ensure.length, 0);
  await f.batch.start(); await until(() => f.state().phase === 'done');
  assert.equal(f.calls.ensure.length, 3);
});

test('startup storage rejection is handled before any caller awaits ready and never starts side effects', async () => {
  const f = fixture({ get: async () => { throw new Error('storage read failed'); } });
  // Give the host a full turn to report unhandled rejections before a UI action arrives.
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.batch.ready, /storage read failed/);
  await assert.rejects(f.batch.start(), /storage read failed/);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.list.length, 0); assert.equal(f.calls.ensure.length, 0);
});
