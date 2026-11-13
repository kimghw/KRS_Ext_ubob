const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/alpha-runner.js');
const catalog = require('../src/alpha-catalog.js');
const selection = () => ({ role: 'researcher', courseIds: catalog.defaultsForRole('researcher') });
const registrationId = 'aaaaaaaa-0000-4000-8000-000000000001';
const firstLesson = 'bbbbbbbb-0000-4000-8000-000000000001';
const secondLesson = 'bbbbbbbb-0000-4000-8000-000000000002';
const hostUrl = 'chrome-extension://test-extension/src/runner.html?host=offscreen';
const urlFor = lessonId => `${catalog.BASE_URL}/my/classRoom/classRoomDetail?registrationId=${registrationId}&type=ONLINE&sequenceLessonId=${lessonId}`;
const playable = (lessonId = firstLesson) => ({ status: 'ready', nextLesson: { id: lessonId, title: '테스트 영상', progress: 0, url: urlFor(lessonId) } });
const surveyState = (courseIndex = 2) => ({
  ...selection(), running: false, phase: 'attention', attentionReason: 'survey',
  runId: 'previous-run', loginId: 'tester', courseIndex,
  courseId: selection().courseIds[courseIndex], tabId: 55, lessonId: firstLesson,
  url: urlFor(firstLesson), message: '설문을 완료해 주세요.'
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async predicate => {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Runner did not reach the expected state');
};
function fixture({ initial, login, enroll, inspect, storageGet, storageSet, certificate, hostAlive = true, hostNavigate, plan, survey } = {}) {
  let clock = 1000000, runNumber = 0;
  let session = { authenticated: true, loginId: 'tester' };
  const state = { ...(initial ? { alphaRunner: structuredClone(initial) } : {}) };
  const calls = { login: 0, enroll: 0, inspect: [], navigate: [], pause: [], hostPause: 0, hostAlive: [],
    tabCreate: [], tabUpdate: [], tabRemove: [], manualNavigate: [], alarms: [], notify: [], sessions: 0, certificates: [] };
  const tabMap = new Map();
  if (initial?.tabId != null) tabMap.set(initial.tabId, { id: initial.tabId, windowId: 1, url: initial.url });
  const storage = {
    async get(key) {
      if (storageGet) await storageGet(key);
      return { [key]: structuredClone(state[key]) };
    },
    async set(value) { if (storageSet) await storageSet(value); Object.assign(state, structuredClone(value)); }
  };
  const tabs = {
    async create(value) { const tab = { ...value, id: 20 + tabMap.size, windowId: 1 }; tabMap.set(tab.id, tab); calls.tabCreate.push(value); calls.manualNavigate.push(value.url); return tab; },
    async update(tabId, value) { const tab = { ...tabMap.get(tabId), ...value }; tabMap.set(tabId, tab); calls.tabUpdate.push({ tabId, ...value }); if (value.url) calls.manualNavigate.push(value.url); return tab; },
    async get(tabId) { if (!tabMap.has(tabId)) throw new Error('closed'); return tabMap.get(tabId); },
    async sendMessage(tabId, value) { calls.pause.push({ tabId, ...value }); return {}; },
    async remove(tabId) { tabMap.delete(tabId); calls.tabRemove.push(tabId); }
  };
  const api = { async session() { calls.sessions++; return structuredClone(session); } };
  const auth = { async ensureLoggedIn() { calls.login++; return login ? login() : structuredClone(session); } };
  const service = { async enroll(value, options) { calls.enroll++; return enroll ? enroll(value, options) : { ok: true }; } };
  const learning = { async inspect(course) { calls.inspect.push(course.id); return inspect ? inspect(course, calls.inspect.length) : playable(); } };
  const alarms = { async create(name, opts) { calls.alarms.push({ name, opts }); }, async clear() {} };
  const certificates = certificate ? { async ensure(input) { calls.certificates.push(input); return certificate(input); } } : undefined;
  let mounted = initial?.transport === 'offscreen' ? { url: initial.url, runId: initial.runId,
    playerToken: initial.playerToken, documentId: initial.documentId } : null;
  const host = {
    async navigate(url, options) {
      calls.navigate.push(url);
      mounted = { url, ...options, documentId: 'host-document' };
      return hostNavigate ? hostNavigate(url, options) : { documentId: mounted.documentId };
    },
    async pause() { calls.hostPause++; mounted = null; },
    async isAlive(expected) {
      calls.hostAlive.push(expected);
      return hostAlive && !!mounted && ['url', 'runId', 'playerToken'].every(key => mounted[key] === expected[key]);
    },
    accepts(message, sender, expected) {
      return !!mounted && message.type === 'alpha-host-heartbeat' && sender.id === 'test-extension' &&
        sender.url === hostUrl && !sender.tab && sender.frameId === 0 && sender.documentId === mounted.documentId &&
        (!expected.documentId || sender.documentId === expected.documentId) &&
        ['url', 'runId', 'playerToken'].every(key => message[key] === expected[key] && mounted[key] === expected[key]);
    }
  };
  const runner = create({ catalog, api, auth, service, learning, certificates, storage, tabs, host, windows: { async update() {} }, alarms,
    notify: async (...args) => calls.notify.push(args), now: () => clock, id: () => `run-${++runNumber}`,
    // plan: 사이드 패널 상단의 근무 시간·휴식 설정 (시험 중 바꿀 수 있는 객체). 휴식 시간은 범위의 가운데 값으로 고정한다.
    ...(plan ? { schedule: async () => ({ ...plan }), random: () => 0.5 } : {}), ...(survey ? { survey } : {}) });
  return { runner, state, calls, tabs, host, setSession: value => { session = value; },
    advanceClock: amount => { clock += amount; },
    sender: () => ({ id: 'test-extension', frameId: 0, url: hostUrl, documentId: state.alphaRunner.documentId || 'host-document' }),
    message: kind => ({ type: 'alpha-host-heartbeat', kind, url: state.alphaRunner.url, runId: state.alphaRunner.runId,
      playerToken: state.alphaRunner.playerToken, currentTime: 10, duration: 100 }) };
}

test('start logs in, enrolls five categories, and opens only the selected lesson', async () => {
  let received;
  const f = fixture({ enroll: async input => { received = input; return { ok: true }; } });
  assert.equal((await f.runner.start(selection())).ok, true);
  await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  assert.equal(f.calls.login, 1); assert.equal(f.calls.enroll, 1);
  assert.deepEqual(received, selection()); assert.equal(received.courseIds.length, 5);
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson)]);
  assert.equal(f.state.alphaRunner.lessonId, firstLesson);
  assert.equal(f.state.alphaRunner.transport, 'offscreen'); assert.ok(f.state.alphaRunner.playerToken);
  assert.deepEqual(f.calls.tabCreate, []); assert.deepEqual(f.calls.tabUpdate, []);
  assert.equal(f.state.alphaRunner.tabId == null, true);
  const heartbeat = await f.runner.heartbeat(f.message('playing'), f.sender());
  assert.equal(heartbeat.active, true); assert.equal(heartbeat.lessonId, firstLesson);
  assert.equal(f.state.alphaRunner.phase, 'playing');
  await f.runner.stop();
});

test('a numeric subject classification cannot be used as the classroom route mode', async () => {
  const result = playable();
  result.nextLesson.url = result.nextLesson.url.replace('type=ONLINE', 'type=4');
  const f = fixture({ inspect: async () => result });
  await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.calls.navigate.length, 0);
  assert.match(f.state.alphaRunner.message, /강의실 주소/);
});
test('an ended event advances only after the site reports the next unfinished lesson', async () => {
  const f = fixture({ inspect: async (course, count) => playable(count === 1 ? firstLesson : secondLesson) });
  await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  assert.equal((await f.runner.heartbeat(f.message('ended'), f.sender())).active, false);
  await flush(() => f.state.alphaRunner?.lessonId === secondLesson && f.calls.navigate.length === 2);
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)]);
  assert.equal(f.calls.enroll, 1);
  await f.runner.stop();
});
test('stop while login is pending prevents enrollment and navigation', async () => {
  const gate = deferred();
  const f = fixture({ login: () => gate.promise });
  await f.runner.start(selection()); await flush(() => f.calls.login === 1);
  await f.runner.stop();
  gate.resolve({ authenticated: true, loginId: 'tester' });
  await flush(() => f.state.alphaRunner?.phase === 'stopped');
  assert.equal(f.calls.enroll, 0); assert.equal(f.calls.inspect.length, 0); assert.equal(f.calls.navigate.length, 0);
});
test('stop during enrollment cancels the remaining work and never opens a lesson', async () => {
  const gate = deferred(); let stopRequested;
  const f = fixture({ enroll: (input, options) => { stopRequested = options.shouldStop; return gate.promise; } });
  await f.runner.start(selection()); await flush(() => f.calls.enroll === 1);
  await f.runner.stop(); assert.equal(stopRequested(), true);
  gate.resolve({ ok: true });
  await flush(() => f.state.alphaRunner?.phase === 'stopped');
  assert.equal(f.calls.inspect.length, 0); assert.equal(f.calls.navigate.length, 0);
});
test('concurrent start requests cannot cause duplicate enrollment', async () => {
  const gate = deferred();
  const f = fixture({ storageGet: key => key === 'alphaState' ? gate.promise : null });
  const starts = [f.runner.start(selection()), f.runner.start(selection())];
  gate.resolve();
  const results = await Promise.allSettled(starts);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  assert.equal(f.calls.enroll, 1); await f.runner.stop();
});
test('normal tabs, wrong frames or origins, wrong tokens and stale lessons never authorize hidden playback', async () => {
  const f = fixture(); await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  const candidates = [
    [f.message('playing'), { ...f.sender(), tab: { id: 999 } }],
    [f.message('playing'), { ...f.sender(), frameId: 1 }],
    [f.message('playing'), { ...f.sender(), url: 'https://other.example/' }],
    [{ ...f.message('playing'), type: 'alpha-player-heartbeat' }, f.sender()],
    [{ ...f.message('playing'), playerToken: 'another-player-token' }, f.sender()],
    [{ ...f.message('playing'), playerToken: null }, f.sender()],
    [{ ...f.message('playing'), runId: null }, f.sender()],
    [{ ...f.message('playing'), url: urlFor(secondLesson) }, f.sender()],
    [f.message('ended'), { ...f.sender(), url: urlFor(secondLesson) }]
  ];
  for (const [message, sender] of candidates) assert.deepEqual(await f.runner.heartbeat(message, sender), { active: false });
  assert.equal(f.calls.inspect.length, 1); assert.equal(f.state.alphaRunner.phase, 'loading');
  await f.runner.stop();
});
test('an account switch during a learning query prevents navigation', async () => {
  const gate = deferred();
  const f = fixture({ inspect: () => gate.promise });
  await f.runner.start(selection()); await flush(() => f.calls.inspect.length === 1);
  f.setSession({ authenticated: true, loginId: 'someone-else' });
  gate.resolve(playable());
  await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.state.alphaRunner.running, false);
});
test('watchdog pauses playback when the account changes, without logging in again', async () => {
  const f = fixture(); await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  f.setSession({ authenticated: true, loginId: 'someone-else' }); await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
  assert.ok(f.calls.hostPause > 0);
  assert.equal(f.calls.login, 1, 'only the login at the start'); assert.equal(f.calls.navigate.length, 1);
});

// ---------- 로그인 만료: 저장한 계정으로 다시 로그인해 이어 간다 ----------
const tester = () => ({ authenticated: true, loginId: 'tester' });
// 저장한 계정으로 로그인하는 가짜 ensureLoggedIn: 로그인되면 세션도 살아난다.
const renewing = holder => () => { holder.f.setSession(tester()); return tester(); };

test('watchdog logs in again when the session expires and reopens the hidden player from the site progress', async () => {
  const holder = {};
  const f = holder.f = fixture({ login: renewing(holder), inspect: async (course, count) => playable(count === 1 ? firstLesson : secondLesson) });
  await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.documentId != null);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
  const { runId, playerToken } = f.state.alphaRunner;
  f.setSession({ authenticated: false }); await f.runner.tick();
  assert.equal(f.calls.login, 2, 'the saved account is used once more');
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)], 'the lesson is chosen again from the site record');
  assert.equal(f.state.alphaRunner.runId, runId, 'the same run continues');
  assert.notEqual(f.state.alphaRunner.playerToken, playerToken, 'the player opened with the expired login is replaced');
  assert.deepEqual(f.state.alphaRunner.deferredCourses, []);
  assert.equal(f.calls.enroll, 0); assert.equal(f.calls.notify.length, 0);
  await f.runner.stop();
});

test('a login that cannot be renewed stops the run with the reason from the login', async () => {
  for (const reason of ['알파 계정을 저장하거나 알파에서 먼저 로그인해 주세요.',
    '다른 브라우저에서 접속 중입니다. 알파에서 중복 로그인 안내를 확인해 주세요.']) {
    let expired = false;
    const f = fixture({ login: async () => { if (expired) throw new Error(reason); return tester(); } });
    await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.documentId != null);
    expired = true; f.setSession({ authenticated: false }); await f.runner.tick();
    assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
    assert.match(f.state.alphaRunner.message, /로그인이 만료/); assert.ok(f.state.alphaRunner.message.includes(reason));
    assert.equal(f.calls.login, 2); assert.equal(f.calls.navigate.length, 1); assert.ok(f.calls.hostPause > 0);
    assert.deepEqual(f.state.alphaRunner.deferredCourses, [], 'an expired login never sets a course aside');
    assert.equal(f.state.alphaRunner.courseIndex, 0); assert.equal(f.calls.notify.length, 1);
    await f.runner.tick();
    assert.equal(f.calls.login, 2, 'a stopped run does not try again');
  }
});

test('logging in again as a different account stops instead of playing', async () => {
  let expired = false;
  const f = fixture({ login: async () => expired ? { authenticated: true, loginId: 'someone-else' } : tester() });
  await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.documentId != null);
  expired = true; f.setSession({ authenticated: false }); await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
  assert.match(f.state.alphaRunner.message, /계정이 바뀌었습니다/);
  assert.equal(f.calls.navigate.length, 1); assert.ok(f.calls.hostPause > 0);
});

test('automatic re-login is limited to three times in thirty minutes when the session keeps being cut', async () => {
  const holder = {};
  const f = holder.f = fixture({ login: renewing(holder) });
  await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.documentId != null);
  for (let count = 1; count <= 3; count++) {
    f.advanceClock(30000); f.setSession({ authenticated: false }); await f.runner.tick();
    assert.equal(f.calls.login, 1 + count); assert.equal(f.calls.navigate.length, 1 + count);
    assert.equal(f.state.alphaRunner.running, true);
  }
  f.advanceClock(30000); f.setSession({ authenticated: false }); await f.runner.tick();
  assert.equal(f.calls.login, 4, 'the account is not sent a fourth time');
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
  assert.match(f.state.alphaRunner.message, /계속 끊깁니다/);
  assert.equal(f.calls.navigate.length, 4); assert.deepEqual(f.state.alphaRunner.deferredCourses, []);
  assert.equal(f.calls.notify.length, 1);
});

test('an occasional expiry keeps being renewed once the thirty-minute window has passed', async () => {
  const holder = {};
  const f = holder.f = fixture({ login: renewing(holder) });
  await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.documentId != null);
  for (let count = 1; count <= 6; count++) {
    f.advanceClock(11 * 60 * 1000); f.setSession({ authenticated: false }); await f.runner.tick();
    assert.equal(f.calls.login, 1 + count); assert.equal(f.state.alphaRunner.running, true);
  }
  await f.runner.stop();
});

test('a session that expires before or during a learning query is renewed and the course is queried again', async () => {
  const first = selection().courseIds[0];
  // 다음 강의로 넘어갈 때 만료를 발견한 경우
  const before = {};
  const ended = before.f = fixture({ login: renewing(before), inspect: async (course, count) => playable(count === 1 ? firstLesson : secondLesson) });
  await ended.runner.startEnrolled(selection()); await flush(() => ended.state.alphaRunner?.documentId != null);
  ended.setSession({ authenticated: false });
  await ended.runner.heartbeat(ended.message('ended'), ended.sender());
  await flush(() => ended.calls.navigate.length === 2);
  assert.deepEqual(ended.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)]);
  assert.equal(ended.calls.login, 2); assert.equal(ended.state.alphaRunner.running, true);
  await ended.runner.stop();

  // 조회하는 사이 만료된 경우: 조회가 값을 돌려주든 실패하든 그 결과는 쓰지 않는다.
  for (const settle of [gate => gate.resolve(playable()), gate => gate.reject(new Error('알파 로그인을 다시 확인하세요.'))]) {
    const gate = deferred(), holder = {};
    const f = holder.f = fixture({ login: renewing(holder), inspect: (course, count) => count === 1 ? gate.promise : playable(secondLesson) });
    await f.runner.startEnrolled(selection()); await flush(() => f.calls.inspect.length === 1);
    f.setSession({ authenticated: false }); settle(gate);
    await flush(() => f.calls.navigate.length === 1);
    assert.deepEqual(f.calls.navigate, [urlFor(secondLesson)], 'the result read with the expired login is not used');
    assert.deepEqual(f.calls.inspect, [first, first]); assert.equal(f.calls.login, 2);
    assert.equal(f.state.alphaRunner.running, true); assert.deepEqual(f.state.alphaRunner.deferredCourses, []);
    await f.runner.stop();
  }
});

test('a learning query that fails while the login is still valid stops with the query error', async () => {
  const f = fixture({ inspect: async () => { throw new Error('조회 연결이 끊겼습니다.'); } });
  await f.runner.startEnrolled(selection()); await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.match(f.state.alphaRunner.message, /조회 연결이 끊겼습니다/);
  assert.equal(f.calls.login, 1); assert.equal(f.calls.inspect.length, 1); assert.equal(f.calls.navigate.length, 0);
});
test('ended without saved progress waits, then sets the course aside and plays the next course without replaying', async () => {
  const ids = selection().courseIds;
  const f = fixture({ inspect: async course => course.id === ids[0] ? playable() : playable(secondLesson) });
  await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  await f.runner.heartbeat(f.message('ended'), f.sender());
  await flush(() => f.calls.inspect.length === 2 && f.state.alphaRunner.message.includes('진도 저장'));
  assert.equal(f.calls.navigate.length, 1); assert.equal(f.state.alphaRunner.running, true);
  f.advanceClock(91000); await f.runner.tick();
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)], 'the unsaved lesson is not replayed');
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.courseId, ids[1]);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => [item.courseId, item.reason]), [[ids[0], 'unsaved']]);
  assert.match(f.state.alphaRunner.deferredCourses[0].message, /진도 저장/);
  assert.equal(f.calls.notify.length, 0);
  await f.runner.stop();
});
test('worker restart never replays a login or enrollment request', async () => {
  for (const phase of ['login', 'enrolling', 'stopping']) {
    const f = fixture({ initial: { running: true, phase, runId: 'older', ...selection() } });
    await f.runner.tick();
    assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
    assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
  }
});
test('all course completions must be confirmed before reporting done', async () => {
  const f = fixture({ inspect: async () => ({ status: 'completed' }) });
  await f.runner.start(selection()); await flush(() => f.state.alphaRunner?.phase === 'done');
  assert.deepEqual(f.calls.inspect, selection().courseIds); assert.equal(f.calls.navigate.length, 0);
  assert.equal(f.state.alphaRunner.running, false); assert.match(f.calls.notify[0][0], /완료/);
});
test('stop cancels a start waiting for enrollment-state storage', async () => {
  const gate = deferred(); let reading = false;
  const f = fixture({ storageGet: key => { if (key === 'alphaState') { reading = true; return gate.promise; } } });
  const started = f.runner.start(selection()); await flush(() => reading);
  await f.runner.stop(); gate.resolve();
  assert.equal((await started).cancelled, true);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
});
test('old run ids and documents cannot authorize a new player', async () => {
  const f = fixture(); await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  const originalSender = f.sender();
  const result = await f.runner.heartbeat(f.message('playing'), originalSender);
  assert.equal(result.active, true);
  assert.deepEqual(await f.runner.heartbeat({ ...f.message('ended'), runId: 'older-run' }, originalSender), { active: false });
  assert.deepEqual(await f.runner.heartbeat(f.message('ended'), { ...originalSender, documentId: 'document-old' }), { active: false });
  assert.equal(f.calls.inspect.length, 1); await f.runner.stop();
});
test('offscreen playback restart restores only the watchdog, with no enrollment resubmission', async () => {
  const f = fixture({ initial: { running: true, phase: 'playing', runId: 'older', ...selection(),
    loginId: 'tester', transport: 'offscreen', playerToken: 'saved-player-token', documentId: 'host-document',
    url: urlFor(firstLesson), navigatedAt: 1000000, lastHeartbeatAt: 1000000, lastPositionAt: 1000000 } });
  await f.runner.tick();
  assert.equal(f.calls.alarms.length, 1); assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.state.alphaRunner.running, true);
  await f.runner.stop();
});
test('manual exam or survey opens the registration classroom without a lesson id', async () => {
  const classroom = `${catalog.BASE_URL}/my/classRoom/classRoomDetail?registrationId=${registrationId}&type=ONLINE`;
  const f = fixture({ inspect: async (course, count) => count === 1 ? playable() :
    ({ status: 'attention', message: '설문을 진행해 주세요.', url: classroom }) });
  await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  await f.runner.heartbeat(f.message('ended'), f.sender()); await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.url, classroom);
  await f.runner.openPlayer(); assert.equal(f.calls.manualNavigate.at(-1), classroom);
  assert.equal((await f.runner.heartbeat({ kind: 'playing', url: classroom }, f.sender())).active, false);
});

test('repeated ended heartbeats verify saved progress no more often than every 15 seconds', async () => {
  const f = fixture();
  await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  await f.runner.heartbeat(f.message('ended'), f.sender());
  await flush(() => f.calls.inspect.length === 2 && f.state.alphaRunner.message.includes('진도 저장'));
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 2; i++) {
    f.advanceClock(5000);
    await f.runner.heartbeat(f.message('ended'), f.sender());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.inspect.length, 2);
  }
  f.advanceClock(5000);
  await f.runner.heartbeat(f.message('ended'), f.sender());
  await flush(() => f.calls.inspect.length === 3);
  assert.equal(f.calls.navigate.length, 1);
  await f.runner.stop();
});

test('a stale watchdog host failure cannot stop a newer run', async () => {
  const f = fixture();
  await f.runner.start(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  await new Promise(resolve => setImmediate(resolve));
  const previousRun = f.state.alphaRunner.runId;
  const gate = deferred();
  const originalIsAlive = f.host.isAlive;
  let held = false;
  f.host.isAlive = async expected => {
    if (!held) { held = true; return gate.promise; }
    return originalIsAlive(expected);
  };
  const oldTick = f.runner.tick();
  await flush(() => held);
  await f.runner.stop();
  await f.runner.start(selection());
  await flush(() => f.calls.navigate.length === 2 && f.state.alphaRunner.phase === 'loading');
  const nextRun = f.state.alphaRunner.runId;
  assert.notEqual(nextRun, previousRun);
  gate.reject(new Error('old host was closed'));
  await oldTick;
  assert.equal(f.state.alphaRunner.runId, nextRun);
  assert.equal(f.state.alphaRunner.running, true);
  assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.equal(f.calls.notify.length, 0);
  await f.runner.stop();
});

test('survey continuation waits when the server has not confirmed submission', async () => {
  const initial = surveyState();
  const f = fixture({ initial, inspect: async () => ({ status: 'attention', attentionReason: 'survey',
    message: '설문 제출이 필요합니다.', url: urlFor(firstLesson) }) });
  assert.equal((await f.runner.continueSurvey()).ok, true);
  await flush(() => f.calls.inspect.length === 1 && f.state.alphaRunner?.phase === 'attention');
  assert.deepEqual(f.calls.inspect, [initial.courseId]);
  assert.equal(f.state.alphaRunner.courseIndex, initial.courseIndex);
  assert.equal(f.state.alphaRunner.attentionReason, 'survey');
  assert.match(f.state.alphaRunner.message, /아직 설문 제출/);
  assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
});

test('confirmed survey completion resumes the next course without re-reading previous courses or enrolling', async () => {
  const initial = surveyState(2);
  const f = fixture({ initial, inspect: async course => course.id === initial.courseId
    ? { status: 'completed' } : playable(secondLesson) });
  await f.runner.continueSurvey();
  await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.deepEqual(f.calls.inspect, selection().courseIds.slice(2, 4));
  assert.equal(f.state.alphaRunner.courseIndex, 3);
  assert.equal(f.state.alphaRunner.courseId, selection().courseIds[3]);
  assert.equal(f.state.alphaRunner.attentionReason, null);
  assert.deepEqual(f.calls.navigate, [urlFor(secondLesson)]);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('confirming the final course survey reports done without replaying earlier courses', async () => {
  const initial = surveyState(4);
  const f = fixture({ initial, inspect: async () => ({ status: 'completed' }) });
  await f.runner.continueSurvey(); await flush(() => f.state.alphaRunner?.phase === 'done');
  assert.deepEqual(f.calls.inspect, [initial.courseId]);
  assert.equal(f.state.alphaRunner.courseIndex, 5); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
  assert.match(f.calls.notify.at(-1)[0], /완료/);
});

test('survey continuation never switches accounts, and keeps the survey marker when an expired login cannot be renewed', async () => {
  const reason = '알파 계정을 저장하거나 알파에서 먼저 로그인해 주세요.';
  for (const [session, logins] of [[{ authenticated: false }, 1], [{ authenticated: true, loginId: 'someone-else' }, 0]]) {
    const initial = surveyState(); const f = fixture({ initial, login: async () => { throw new Error(reason); } }); f.setSession(session);
    await f.runner.continueSurvey();
    await flush(() => f.calls.sessions > 0 && f.state.alphaRunner?.phase === 'attention');
    assert.equal(f.state.alphaRunner.attentionReason, 'survey');
    assert.equal(f.state.alphaRunner.courseIndex, initial.courseIndex);
    assert.equal(f.calls.inspect.length, 0); assert.equal(f.calls.navigate.length, 0);
    assert.equal(f.calls.login, logins, 'only an expired login is renewed'); assert.equal(f.calls.enroll, 0);
    assert.equal(f.state.alphaRunner.message.includes(reason), logins === 1);
  }
});

test('survey continuation logs in again when the session has expired, then continues to the next course', async () => {
  const initial = surveyState(2), holder = {};
  const f = holder.f = fixture({ initial, login: renewing(holder), inspect: async course => course.id === initial.courseId
    ? { status: 'completed' } : playable(secondLesson) });
  f.setSession({ authenticated: false });
  await f.runner.continueSurvey();
  await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.deepEqual(f.calls.inspect, selection().courseIds.slice(2, 4));
  assert.equal(f.state.alphaRunner.courseIndex, 3); assert.equal(f.state.alphaRunner.attentionReason, null);
  assert.equal(f.calls.login, 1); assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('account change during survey confirmation prevents advancing the saved course index', async () => {
  const gate = deferred(); const initial = surveyState();
  const f = fixture({ initial, inspect: () => gate.promise });
  await f.runner.continueSurvey(); await flush(() => f.calls.inspect.length === 1);
  f.setSession({ authenticated: true, loginId: 'someone-else' }); gate.resolve({ status: 'completed' });
  await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.courseIndex, initial.courseIndex);
  assert.equal(f.state.alphaRunner.attentionReason, 'survey');
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
});

test('stop while survey confirmation is pending prevents opening the next course', async () => {
  const gate = deferred(); const initial = surveyState();
  const f = fixture({ initial, inspect: () => gate.promise });
  await f.runner.continueSurvey(); await flush(() => f.calls.inspect.length === 1);
  await f.runner.stop(); gate.resolve({ status: 'completed' });
  await flush(() => f.state.alphaRunner?.phase === 'stopped');
  assert.equal(f.state.alphaRunner.running, false); assert.equal(f.state.alphaRunner.courseIndex, initial.courseIndex);
  assert.deepEqual(f.calls.inspect, [initial.courseId]); assert.equal(f.calls.navigate.length, 0);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
});

test('concurrent survey confirmation clicks launch only one check', async () => {
  const storageGate = deferred(), queryGate = deferred();
  const f = fixture({ initial: surveyState(), storageGet: key => key === 'alphaState' ? storageGate.promise : null,
    inspect: () => queryGate.promise });
  const checks = [f.runner.continueSurvey(), f.runner.continueSurvey()]; storageGate.resolve();
  const results = await Promise.allSettled(checks);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  await flush(() => f.calls.inspect.length === 1);
  await f.runner.stop(); queryGate.resolve({ status: 'completed' });
  await flush(() => f.state.alphaRunner?.phase === 'stopped');
  assert.equal(f.calls.inspect.length, 1); assert.equal(f.calls.navigate.length, 0);
});

test('restart during survey confirmation waits for another explicit check', async () => {
  const initial = { ...surveyState(), phase: 'checking-survey', running: true };
  const f = fixture({ initial }); await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.state.alphaRunner.attentionReason, 'survey');
  assert.equal(f.state.alphaRunner.courseIndex, initial.courseIndex);
  assert.equal(f.calls.sessions, 0); assert.equal(f.calls.inspect.length, 0); assert.equal(f.calls.alarms.length, 0);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
});

test('stop cancels survey confirmation before its storage prerequisite finishes', async () => {
  const gate = deferred(); let reading = false;
  const f = fixture({ initial: surveyState(), storageGet: key => {
    if (key === 'alphaState') { reading = true; return gate.promise; }
  } });
  const check = f.runner.continueSurvey(); await flush(() => reading);
  await f.runner.stop(); gate.resolve();
  assert.equal((await check).cancelled, true);
  assert.equal(f.calls.inspect.length, 0); assert.equal(f.calls.sessions, 0); assert.equal(f.calls.navigate.length, 0);
});

test('a survey confirmation query failure preserves the manual continue action', async () => {
  const f = fixture({ initial: surveyState(), inspect: async () => { throw new Error('조회 연결이 끊겼습니다.'); } });
  await f.runner.continueSurvey(); await flush(() => f.calls.inspect.length === 1 && f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.attentionReason, 'survey'); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
});

test('another remaining requirement replaces the survey marker without advancing', async () => {
  const initial = surveyState();
  const f = fixture({ initial, inspect: async () => ({ status: 'attention', attentionReason: 'assessment', message: '시험을 완료해 주세요.' }) });
  await f.runner.continueSurvey(); await flush(() => f.calls.inspect.length === 1 && f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.attentionReason, 'assessment');
  assert.equal(f.state.alphaRunner.courseIndex, initial.courseIndex); assert.equal(f.calls.navigate.length, 0);
});

test('survey continuation rejects a changed role or course selection before querying the server', async () => {
  for (const changed of [{ role: 'principal', courseIds: catalog.defaultsForRole('principal') },
    { ...selection(), courseIds: selection().courseIds.slice(0, 4) }]) {
    const f = fixture({ initial: surveyState() });
    await assert.rejects(f.runner.continueSurvey(changed), /교육 대상 또는 과정 선택이 변경/);
    assert.equal(f.calls.sessions, 0); assert.equal(f.calls.inspect.length, 0);
    assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
    assert.equal(f.state.alphaRunner.attentionReason, 'survey');
  }
});

test('existing enrollment mode plays a selected subset without requesting enrollment', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(1, 3) };
  const f = fixture();
  assert.equal((await f.runner.startEnrolled(chosen)).ok, true);
  await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.equal(f.state.alphaRunner.mode, 'enrolled');
  assert.deepEqual(f.state.alphaRunner.courseIds, chosen.courseIds);
  assert.deepEqual(f.calls.inspect, [chosen.courseIds[0]]);
  assert.equal(f.calls.login, 1); assert.equal(f.calls.enroll, 0);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
  await f.runner.stop();
});

test('an unregistered first selection does not block a later enrolled course', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 2) };
  const f = fixture({ inspect: async course => course.id === chosen.courseIds[0]
    ? { status: 'not-enrolled', message: '신청하지 않은 과정입니다.' } : playable(secondLesson) });
  await f.runner.startEnrolled(chosen);
  await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.deepEqual(f.calls.inspect, chosen.courseIds);
  assert.equal(f.state.alphaRunner.courseId, chosen.courseIds[1]);
  assert.deepEqual(f.state.alphaRunner.skippedCourses.map(item => [item.courseId, item.status]), [[chosen.courseIds[0], 'not-enrolled']]);
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, []);
  assert.deepEqual(f.calls.navigate, [urlFor(secondLesson)]); assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('only verified waiting and expired courses are skipped before a playable enrollment', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 3) };
  const f = fixture({ inspect: async course => {
    if (course.id === chosen.courseIds[0]) return { status: 'waiting', message: '학습 시작 전입니다.' };
    if (course.id === chosen.courseIds[1]) return { status: 'attention', attentionReason: 'expired', message: '학습 기간이 지났습니다.' };
    return playable();
  } });
  await f.runner.startEnrolled(chosen);
  await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.deepEqual(f.calls.inspect, chosen.courseIds);
  assert.deepEqual(f.state.alphaRunner.skippedCourses.map(item => item.status), ['waiting', 'expired']);
  assert.equal(f.state.alphaRunner.courseIndex, 2); assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('no existing enrollments reports no available courses without claiming completion', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 2) };
  const f = fixture({ inspect: async () => ({ status: 'not-enrolled', message: '미신청' }) });
  await f.runner.startEnrolled(chosen);
  await flush(() => f.calls.inspect.length === 2 && f.state.alphaRunner?.phase === 'idle');
  assert.equal(f.state.alphaRunner.running, false); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, []); assert.equal(f.state.alphaRunner.skippedCourses.length, 2);
  assert.match(f.state.alphaRunner.message, /과정이 없습니다/);
  assert.doesNotMatch(f.state.alphaRunner.message, /5개|수료를 사이트에서 확인/);
  assert.doesNotMatch(f.calls.notify.at(-1)[0], /완료/);
});

test('already completed enrollments are skipped and only verified completions enter the final count', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 3) };
  let secondFinished = false;
  const f = fixture({ inspect: async course => {
    if (course.id === chosen.courseIds[0]) return { status: 'completed' };
    if (course.id === chosen.courseIds[1]) return secondFinished ? { status: 'completed' } : playable();
    return { status: 'not-enrolled', message: '미신청' };
  } });
  await f.runner.startEnrolled(chosen); await flush(() => f.calls.navigate.length === 1);
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, [chosen.courseIds[0]]);
  secondFinished = true;
  await f.runner.heartbeat(f.message('ended'), f.sender()); await flush(() => f.state.alphaRunner?.phase === 'done');
  assert.deepEqual(f.calls.inspect, [chosen.courseIds[0], chosen.courseIds[1], chosen.courseIds[1], chosen.courseIds[2]]);
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, chosen.courseIds.slice(0, 2));
  assert.equal(f.state.alphaRunner.skippedCourses.length, 1);
  assert.match(f.state.alphaRunner.message, /2개의 수료/); assert.match(f.state.alphaRunner.message, /1개는 제외/);
  assert.equal(f.calls.navigate.length, 1); assert.equal(f.calls.enroll, 0);
});

test('a query failure stops instead of skipping or claiming completion', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 2) };
  const f = fixture({ inspect: async () => { throw new Error('조회 실패'); } });
  await f.runner.startEnrolled(chosen);
  await flush(() => f.calls.inspect.length === 1 && f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.running, false); assert.equal(f.state.alphaRunner.courseIndex, 0);
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, []); assert.deepEqual(f.state.alphaRunner.skippedCourses, []);
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.calls.enroll, 0);
  assert.doesNotMatch(f.calls.notify.at(-1)[0], /완료/);
});

test('an unknown enrollment state is deferred until the other courses are checked, without claiming completion', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 2) };
  const f = fixture({ inspect: async () => ({ status: 'attention', message: '수강 상태 확인이 필요합니다.' }) });
  await f.runner.startEnrolled(chosen);
  await flush(() => f.calls.inspect.length === 2 && f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.running, false); assert.equal(f.state.alphaRunner.attentionReason, 'deferred');
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, []); assert.deepEqual(f.state.alphaRunner.skippedCourses, []);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => item.courseId), chosen.courseIds);
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.calls.enroll, 0);
  assert.doesNotMatch(f.calls.notify.at(-1)[0], /완료/);
  assert.doesNotMatch(f.state.alphaRunner.message, /수료를 사이트에서 확인/);
});

test('a course that cannot continue automatically does not stop the run: the other courses play first', async () => {
  // 실제 사례(2026-11-13): 연구윤리 과정은 영상 4개 뒤에 인터랙티브 차시가 남아 실행이 거기서 멈췄다.
  const ids = selection().courseIds;
  const interactiveUrl = urlFor(secondLesson);
  let firstCourseVideosDone = false;
  const f = fixture({ inspect: async course => {
    if (course.id === ids[0]) return firstCourseVideosDone
      ? { status: 'attention', attentionReason: 'interactive', message: '인터랙티브 학습을 진행해 주세요.', url: interactiveUrl } : playable();
    if (course.id === ids[1]) return playable(secondLesson);
    return { status: 'attention', attentionReason: 'interactive', message: '인터랙티브 학습을 진행해 주세요.', url: interactiveUrl };
  } });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner?.documentId != null);
  firstCourseVideosDone = true;
  await f.runner.heartbeat(f.message('ended'), f.sender());
  await flush(() => f.calls.navigate.length === 2);
  assert.equal(f.state.alphaRunner.running, true, 'the run keeps going');
  assert.equal(f.state.alphaRunner.courseId, ids[1], 'the next course with videos plays');
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)]);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => [item.courseId, item.reason]), [[ids[0], 'interactive']]);
  await f.runner.stop();

  // 볼 수 있는 영상이 더 없으면 그때 한 번만 확인을 요청하고, 학습 화면 열기는 미뤄 둔 첫 과정의 차시를 연다.
  const all = fixture({ inspect: async () => ({ status: 'attention', attentionReason: 'interactive', message: '인터랙티브 학습을 진행해 주세요.', url: interactiveUrl }) });
  await all.runner.startEnrolled(selection());
  await flush(() => all.state.alphaRunner?.phase === 'attention' && all.calls.notify.length === 1);
  assert.equal(all.calls.inspect.length, 5); assert.equal(all.calls.navigate.length, 0);
  assert.equal(all.state.alphaRunner.running, false); assert.equal(all.state.alphaRunner.attentionReason, 'deferred');
  assert.equal(all.state.alphaRunner.courseId, ids[0]); assert.equal(all.state.alphaRunner.url, interactiveUrl);
  assert.match(all.state.alphaRunner.message, /직접 진행할 과정 5개/);
  assert.doesNotMatch(all.state.alphaRunner.message, /수료를 사이트에서 확인/);
  assert.equal(all.calls.notify[0][0], '알파 자동 실행 확인 필요');
  await all.runner.openPlayer();
  assert.deepEqual(all.calls.manualNavigate, [interactiveUrl]);
  // 직접 마친 뒤 다시 시도하면 처음부터 다시 확인한다.
  assert.equal((await all.runner.retry()).ok, true);
  await flush(() => all.calls.inspect.length === 10 && all.state.alphaRunner?.phase === 'attention' && all.calls.notify.length === 2);
  assert.equal(all.state.alphaRunner.deferredCourses.length, 5);
});

test('survey continuation retains existing-enrollment mode for a subset', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(1, 3) };
  const initial = { ...surveyState(0), ...chosen, mode: 'enrolled', courseIndex: 0, courseId: chosen.courseIds[0],
    completedCourseIds: [], skippedCourses: [] };
  const f = fixture({ initial, inspect: async course => course.id === chosen.courseIds[0] ? { status: 'completed' } : playable(secondLesson) });
  await f.runner.continueSurvey(chosen);
  await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.equal(f.state.alphaRunner.mode, 'enrolled'); assert.deepEqual(f.calls.inspect, chosen.courseIds);
  assert.equal(f.state.alphaRunner.courseIndex, 1); assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('retry preserves existing-enrollment mode and never calls enrollment for a subset', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(1, 2) };
  const initial = { ...surveyState(0), ...chosen, mode: 'enrolled', courseId: chosen.courseIds[0], attentionReason: null };
  const f = fixture({ initial });
  await f.runner.retry(); await flush(() => f.state.alphaRunner?.phase === 'loading' && f.calls.navigate.length === 1);
  assert.equal(f.state.alphaRunner.mode, 'enrolled'); assert.deepEqual(f.state.alphaRunner.courseIds, chosen.courseIds);
  assert.equal(f.calls.login, 1); assert.equal(f.calls.enroll, 0); assert.deepEqual(f.calls.inspect, chosen.courseIds);
  await f.runner.stop();
});

test('existing-enrollment mode honors stop during login and account changes during lookup', async () => {
  const chosen = { ...selection(), courseIds: selection().courseIds.slice(0, 1) };
  const loginGate = deferred(); const stopped = fixture({ login: () => loginGate.promise });
  await stopped.runner.startEnrolled(chosen); await flush(() => stopped.calls.login === 1);
  await stopped.runner.stop(); loginGate.resolve({ authenticated: true, loginId: 'tester' });
  await flush(() => stopped.state.alphaRunner?.phase === 'stopped');
  assert.equal(stopped.calls.enroll, 0); assert.equal(stopped.calls.inspect.length, 0); assert.equal(stopped.calls.navigate.length, 0);

  const queryGate = deferred(); const changed = fixture({ inspect: () => queryGate.promise });
  await changed.runner.startEnrolled(chosen); await flush(() => changed.calls.inspect.length === 1);
  changed.setSession({ authenticated: true, loginId: 'someone-else' }); queryGate.resolve(playable());
  await flush(() => changed.state.alphaRunner?.phase === 'attention');
  assert.equal(changed.calls.enroll, 0); assert.equal(changed.calls.navigate.length, 0);
  assert.deepEqual(changed.state.alphaRunner.completedCourseIds, []);
});

test('restart during existing enrollment lookup waits for explicit retry without any resubmission', async () => {
  const initial = { ...surveyState(), mode: 'enrolled', phase: 'checking-enrolled', running: true, attentionReason: null };
  const f = fixture({ initial }); await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.mode, 'enrolled');
  assert.equal(f.state.alphaRunner.running, false); assert.equal(f.calls.sessions, 0); assert.equal(f.calls.inspect.length, 0);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.navigate.length, 0);
});

test('verified course completion requests its certificate before continuing to the next course', async () => {
  const f = fixture({ inspect: async (course, count) => count === 1
    ? { status: 'completed', registrationId } : playable(),
    certificate: async () => ({ status: 'downloading' }) });
  await f.runner.startEnrolled(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
  assert.equal(f.calls.certificates.length, 1);
  const request = f.calls.certificates[0];
  assert.equal(request.course.id, selection().courseIds[0]);
  assert.equal(request.registrationId, registrationId); assert.equal(request.loginId, 'tester');
  assert.equal(request.completed, true); assert.equal(request.shouldStop(), false);
  assert.equal(f.state.alphaRunner.courseId, selection().courseIds[1]);
  assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('uncompleted media and waiting surveys never request a certificate', async () => {
  for (const result of [playable(), { status: 'attention', attentionReason: 'survey', message: '설문 작성 필요' }]) {
    const f = fixture({ inspect: async () => result, certificate: async () => ({ status: 'complete' }) });
    await f.runner.startEnrolled(selection());
    await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null || !f.state.alphaRunner?.running);
    assert.equal(f.calls.certificates.length, 0);
    await f.runner.stop();
  }
});

test('a course with only its survey left does not stop the run: the other courses are played first', async () => {
  const ids = selection().courseIds;
  // 첫 과정은 영상을 모두 봐서 설문만 남았고, 둘째 과정에 볼 영상이 있다.
  const f = fixture({ inspect: async course => course.id === ids[0]
    ? { status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' } : playable() });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner?.documentId != null);
  assert.deepEqual(f.calls.inspect, ids.slice(0, 2));
  assert.equal(f.state.alphaRunner.running, true);
  assert.equal(f.state.alphaRunner.courseId, ids[1]);
  assert.deepEqual(f.state.alphaRunner.surveyCourses.map(item => item.courseId), [ids[0]]);
  assert.equal(f.calls.notify.length, 0, 'a pending survey is not an interruption');
  await f.runner.stop();
});

test('when every course only has its survey left, the run ends by pointing to the per-course survey menu', async () => {
  const f = fixture({ inspect: async () => ({ status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' }) });
  await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.phase === 'done');
  assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.navigate.length, 0);
  assert.equal(f.state.alphaRunner.surveyCourses.length, selection().courseIds.length);
  assert.match(f.state.alphaRunner.message, /설문이 남은 과정 5개.*자동 설문/);
  assert.doesNotMatch(f.state.alphaRunner.message, /수료를 사이트에서 확인/);
  assert.equal(f.calls.certificates.length, 0);
});

test('certificate failure leaves verified completion intact and continues other courses', async () => {
  for (const certificate of [async () => ({ status: 'failed' }), async () => { throw new Error('download failure'); }]) {
    const f = fixture({ inspect: async (course, count) => count === 1
      ? { status: 'completed', registrationId } : playable(), certificate });
    await f.runner.startEnrolled(selection()); await flush(() => f.calls.navigate.length > 0 && f.state.alphaRunner?.documentId != null);
    assert.deepEqual(f.state.alphaRunner.completedCourseIds, [selection().courseIds[0]]);
    assert.equal(f.state.alphaRunner.courseId, selection().courseIds[1]);
    assert.equal(f.state.alphaRunner.running, true);
    await f.runner.stop();
  }
});

test('stop during certificate preparation cancels its pending side effect and subsequent learning', async () => {
  const gate = deferred();
  const f = fixture({ inspect: async () => ({ status: 'completed', registrationId }), certificate: () => gate.promise });
  await f.runner.startEnrolled(selection()); await flush(() => f.calls.certificates.length === 1);
  assert.equal(f.state.alphaRunner.phase, 'certificate');
  await f.runner.stop(); assert.equal(f.calls.certificates[0].shouldStop(), true);
  gate.resolve({ status: 'failed' }); await flush(() => f.state.alphaRunner.phase === 'stopped');
  assert.equal(f.calls.inspect.length, 1); assert.equal(f.calls.navigate.length, 0);
});

test('survey continuation saves a newly completed certificate without reenrollment', async () => {
  const initial = surveyState(0);
  const f = fixture({ initial, inspect: async (course, count) => count === 1
    ? { status: 'completed', registrationId } : playable(), certificate: async () => ({ status: 'complete' }) });
  await f.runner.continueSurvey(); await flush(() => f.calls.navigate.length === 1);
  assert.equal(f.calls.certificates.length, 1); assert.equal(f.calls.certificates[0].course.id, initial.courseId);
  assert.equal(f.calls.enroll, 0); assert.equal(f.calls.login, 0);
  await f.runner.stop();
});

test('worker restart during certificate handling waits without requesting another download', async () => {
  const f = fixture({ initial: { ...surveyState(), running: true, phase: 'certificate', attentionReason: null },
    certificate: async () => ({ status: 'complete' }) });
  await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.certificates.length, 0); assert.equal(f.calls.login, 0);
});

test('each hidden lesson navigation has a fresh token and previous player messages stay unauthorized', async () => {
  const f = fixture({ inspect: async (_course, count) => playable(count === 1 ? firstLesson : secondLesson) });
  await f.runner.startEnrolled(selection()); await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner.documentId);
  const previousMessage = f.message('playing'), previousToken = f.state.alphaRunner.playerToken;
  await f.runner.heartbeat(f.message('ended'), f.sender());
  await flush(() => f.calls.navigate.length === 2 && f.state.alphaRunner.documentId);
  assert.notEqual(f.state.alphaRunner.playerToken, previousToken);
  assert.equal((await f.runner.heartbeat(previousMessage, f.sender())).active, false);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
  assert.deepEqual(f.calls.tabCreate, []); assert.deepEqual(f.calls.tabUpdate, []);
  await f.runner.stop();
});

test('stop releases the hidden player and subsequent heartbeats cannot restart it', async () => {
  const f = fixture(); await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner.documentId);
  const before = f.calls.hostPause, message = f.message('playing'), sender = f.sender();
  await f.runner.stop();
  assert.ok(f.calls.hostPause > before);
  assert.equal(await f.host.isAlive({ url: message.url, runId: message.runId, playerToken: message.playerToken }), false);
  assert.deepEqual(await f.runner.heartbeat(message, sender), { active: false });
  assert.equal(f.state.alphaRunner.phase, 'stopped'); assert.deepEqual(f.calls.tabCreate, []);
});

test('opening a visible classroom explicitly pauses hidden playback first', async () => {
  const f = fixture(); await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner.documentId);
  const before = f.calls.hostPause, message = f.message('playing'), sender = f.sender();
  await f.runner.openPlayer();
  assert.ok(f.calls.hostPause > before); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.attentionReason, 'manual');
  assert.equal(f.calls.tabCreate.length, 1); assert.equal(f.calls.tabCreate[0].active, true);
  assert.equal(f.calls.tabCreate[0].url, urlFor(firstLesson));
  assert.equal(f.state.alphaRunner.manualUrl, urlFor(firstLesson));
  assert.deepEqual(await f.runner.heartbeat(message, sender), { active: false });
  assert.equal(f.calls.navigate.length, 1);
});

test('opening a survey classroom preserves the survey continuation marker', async () => {
  const f = fixture({ initial: surveyState() });
  await f.runner.openPlayer();
  assert.equal(f.state.alphaRunner.attentionReason, 'survey'); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0);
  assert.equal(f.calls.tabUpdate.length, 1); assert.equal(f.calls.tabUpdate[0].active, true);
});

test('retry closes only the unchanged manual classroom before resuming hidden playback', async () => {
  for (const changed of [false, true]) {
    const f = fixture(); await f.runner.startEnrolled(selection());
    await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner.documentId);
    await f.runner.openPlayer(); const manualTabId = f.state.alphaRunner.tabId;
    if (changed) await f.tabs.update(manualTabId, { pendingUrl: 'https://example.com/elsewhere' });
    await f.runner.retry(); await flush(() => f.calls.navigate.length === 2 && f.state.alphaRunner.documentId);
    assert.deepEqual(f.calls.tabRemove, changed ? [] : [manualTabId]);
    assert.equal(f.calls.tabCreate.length, 1); assert.equal(f.calls.enroll, 0);
    assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
    await f.runner.stop();
  }
});

const lostPlayer = () => ({ ...selection(), running: true, phase: 'playing', runId: 'older', mode: 'enrolled', courseIndex: 0,
  loginId: 'tester', transport: 'offscreen', playerToken: 'saved-player-token', documentId: 'host-document',
  url: urlFor(firstLesson), navigatedAt: 1000000, lastHeartbeatAt: 1000000, lastPositionAt: 1000000 });

test('a hidden player lost to an extension reload is reopened from the saved site progress without login, enrollment or a tab', async () => {
  const f = fixture({ hostAlive: false, initial: lostPlayer(), inspect: async () => playable(secondLesson) });
  await f.runner.tick();
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.deepEqual(f.calls.navigate, [urlFor(secondLesson)], 'the lesson is chosen again from the site record');
  assert.notEqual(f.state.alphaRunner.playerToken, 'saved-player-token');
  assert.equal(f.state.alphaRunner.runId, 'older', 'the same run continues');
  assert.deepEqual(f.calls.tabCreate, []); assert.deepEqual(f.calls.tabUpdate, []);
  assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.notify.length, 0);
  await f.runner.stop();
});

test('automatic reopening is limited, then the course is set aside with the original reason and the next course opens', async () => {
  const ids = selection().courseIds;
  const f = fixture({ hostAlive: false, initial: lostPlayer() });
  for (let count = 1; count <= 3; count++) {
    await f.runner.tick();
    assert.equal(f.calls.navigate.length, count); assert.equal(f.state.alphaRunner.running, true);
    assert.equal(f.state.alphaRunner.courseId, ids[0]);
    f.advanceClock(30000);
  }
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 4, 'the next course is opened instead of stopping');
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.courseId, ids[1]);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => [item.courseId, item.reason]), [[ids[0], 'playback']]);
  assert.match(f.state.alphaRunner.deferredCourses[0].message, /종료되었습니다/);
  assert.equal(f.calls.notify.length, 0);
  // 어느 과정도 재생되지 않으면 과정마다 같은 횟수만 시도한 뒤 한 번만 확인을 요청한다.
  for (let count = 0; count < 40 && f.state.alphaRunner.running; count++) { f.advanceClock(30000); await f.runner.tick(); }
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.attentionReason, 'deferred');
  assert.equal(f.state.alphaRunner.running, false);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => item.courseId), ids);
  assert.equal(f.calls.navigate.length, 19, 'three reopenings for the lost course, then one opening and three reopenings per course');
  assert.equal(f.calls.notify.length, 1);
});

test('occasional interruptions keep recovering once the ten-minute window has passed', async () => {
  const f = fixture({ hostAlive: false, initial: lostPlayer() });
  for (let count = 1; count <= 5; count++) {
    await f.runner.tick();
    assert.equal(f.calls.navigate.length, count); assert.equal(f.state.alphaRunner.running, true);
    f.advanceClock(6 * 60 * 1000);
  }
  await f.runner.stop();
});

test('a silent classroom and a stalled video are reopened automatically', async () => {
  const silent = fixture(); await silent.runner.startEnrolled(selection());
  await flush(() => silent.state.alphaRunner?.documentId);
  assert.equal((await silent.runner.heartbeat(silent.message('playing'), silent.sender())).active, true);
  silent.advanceClock(61000);
  await silent.runner.tick();
  assert.equal(silent.calls.navigate.length, 2); assert.equal(silent.state.alphaRunner.phase, 'loading');
  await silent.runner.stop();

  const stalled = fixture(); await stalled.runner.startEnrolled(selection());
  await flush(() => stalled.state.alphaRunner?.documentId);
  for (let i = 0; i < 4; i++) {
    await stalled.runner.heartbeat(stalled.message('playing'), stalled.sender());
    stalled.advanceClock(35000);
    await stalled.runner.heartbeat(stalled.message('playing'), stalled.sender());
    await stalled.runner.tick();
  }
  assert.equal(stalled.calls.navigate.length, 2, 'the position did not move for two minutes');
  assert.equal(stalled.state.alphaRunner.running, true);
  await stalled.runner.stop();
});

test('stop during automatic recovery prevents the player from reopening', async () => {
  const gate = deferred(); let inspecting = false;
  const f = fixture({ hostAlive: false, initial: lostPlayer(), inspect: () => { inspecting = true; return gate.promise; } });
  const ticking = f.runner.tick();
  await flush(() => inspecting);
  await f.runner.stop(); gate.resolve(playable());
  await ticking;
  assert.equal(f.calls.navigate.length, 0);
  assert.equal(f.state.alphaRunner.phase, 'stopped'); assert.equal(f.state.alphaRunner.running, false);
});

test('recovery that finds only manual steps such as interactive content hands over instead of replaying', async () => {
  const f = fixture({ hostAlive: false, initial: lostPlayer(),
    inspect: async () => ({ status: 'attention', attentionReason: 'interactive', message: '인터랙티브 학습을 진행해 주세요.' }) });
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 0);
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.attentionReason, 'deferred');
  assert.equal(f.state.alphaRunner.deferredCourses.length, 5); assert.equal(f.state.alphaRunner.running, false);
});

test('a course whose exam is left does not stop the run, and the exam is never taken automatically', async () => {
  const ids = selection().courseIds;
  let surveyCalls = 0;
  const f = fixture({ survey: { reserved: async () => true, auto: async () => { surveyCalls++; return { submitted: 1 }; } },
    inspect: async course => course.id === ids[0] ? { status: 'attention', attentionReason: 'assessment', message: '시험을 진행하세요.' }
      : course.id === ids[1] ? playable() : { status: 'attention', attentionReason: 'assessment', message: '시험을 진행하세요.' } });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner?.documentId != null);
  assert.equal(f.state.alphaRunner.courseId, ids[1], 'the next course with videos plays');
  assert.deepEqual(f.state.alphaRunner.examCourses.map(item => item.courseId), [ids[0]]);
  assert.equal(surveyCalls, 0, 'a reserved survey is not sent while the exam is still left');
  await f.runner.stop();

  const all = fixture({ inspect: async () => ({ status: 'attention', attentionReason: 'assessment', message: '시험을 진행하세요.' }) });
  await all.runner.startEnrolled(selection());
  await flush(() => all.state.alphaRunner?.phase === 'done');
  assert.match(all.state.alphaRunner.message, /시험이 남은 과정 5개는 시험 바로가기로 직접 응시/);
  assert.doesNotMatch(all.state.alphaRunner.message, /수료를 사이트에서 확인/);
  assert.equal(all.calls.navigate.length, 0);
});

test('legacy visible-tab state never automatically migrates or replays after worker restart', async () => {
  for (const phase of ['loading', 'playing']) {
    const f = fixture({ initial: { ...selection(), running: true, phase, runId: 'legacy', loginId: 'tester',
      tabId: 55, url: urlFor(firstLesson), navigatedAt: 1000000, lastHeartbeatAt: 1000000 } });
    await f.runner.tick();
    assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
    assert.equal(f.calls.navigate.length, 0); assert.deepEqual(f.calls.tabCreate, []); assert.deepEqual(f.calls.tabUpdate, []);
    assert.equal(f.calls.login, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.inspect.length, 0);
  }
});

test('stop during hidden host creation cannot restore running state or authorize late messages', async () => {
  const gate = deferred();
  const f = fixture({ hostNavigate: () => gate.promise });
  await f.runner.startEnrolled(selection()); await flush(() => f.calls.navigate.length === 1);
  const message = f.message('playing'), sender = f.sender();
  await f.runner.stop(); gate.resolve({ documentId: 'host-document' });
  await flush(() => f.state.alphaRunner.phase === 'stopped');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.alphaRunner.running, false); assert.deepEqual(await f.runner.heartbeat(message, sender), { active: false });
  assert.deepEqual(f.calls.tabCreate, []); assert.ok(f.calls.hostPause > 0);
});

test('launch arms the watchdog before the hidden host finishes creating, and a stuck host is reopened without a late result taking over', async () => {
  const gate = deferred(); let opens = 0;
  const f = fixture({ hostNavigate: () => (++opens === 1 ? gate.promise : { documentId: 'host-document' }) });
  assert.equal((await f.runner.startEnrolled(selection())).ok, true);
  await flush(() => f.calls.navigate.length === 1);
  assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.equal(f.state.alphaRunner.documentId, null);
  assert.ok(f.calls.alarms.some(item => item.name === 'alpha-player-watchdog'));
  f.advanceClock(61000);
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 2);
  assert.equal(f.state.alphaRunner.running, true);
  assert.equal(f.state.alphaRunner.documentId, 'host-document');
  const token = f.state.alphaRunner.playerToken;
  gate.resolve({ documentId: 'late-document' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.alphaRunner.documentId, 'host-document');
  assert.equal(f.state.alphaRunner.playerToken, token);
  assert.equal(f.state.alphaRunner.running, true);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
  await f.runner.stop();
});

test('a superseded hidden host failure does not stop the recovered run', async () => {
  const gate = deferred(); let opens = 0;
  const f = fixture({ hostNavigate: () => (++opens === 1 ? gate.promise : { documentId: 'host-document' }) });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1);
  f.advanceClock(61000);
  await f.runner.tick();
  gate.reject(new Error('알파 플레이어 이동을 중지했습니다.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.equal(f.calls.notify.length, 0);
  await f.runner.stop();
});

test('repeated ready heartbeats cannot keep unstarted playback loading indefinitely', async () => {
  const f = fixture(); await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.documentId);
  f.advanceClock(30000);
  await f.runner.heartbeat(f.message('ready'), f.sender());
  await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'loading'); assert.equal(f.calls.navigate.length, 1);
  // 1분 안에 재생이 시작되지 않으면 세 번까지 다시 열고, 그래도 안 되면 그 과정을 미뤄 두고 다음 과정을 연다.
  const ids = selection().courseIds;
  for (let count = 2; count <= 4; count++) {
    f.advanceClock(61000);
    await f.runner.heartbeat(f.message('ready'), f.sender());
    await f.runner.tick();
    assert.equal(f.calls.navigate.length, count); assert.equal(f.state.alphaRunner.phase, 'loading');
    assert.equal(f.state.alphaRunner.courseId, ids[0]);
  }
  f.advanceClock(61000);
  await f.runner.heartbeat(f.message('ready'), f.sender());
  await f.runner.tick();
  await flush(() => f.calls.navigate.length === 5 && f.state.alphaRunner.documentId);
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.courseId, ids[1]);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => item.courseId), [ids[0]]);
  assert.match(f.state.alphaRunner.deferredCourses[0].message, /다시 시도/);
  assert.equal(f.calls.enroll, 0);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
  await f.runner.stop();
});

test('a classroom that asks for attention sets the course aside once and the next course plays', async () => {
  const ids = selection().courseIds;
  const f = fixture({ inspect: async course => course.id === ids[0] ? playable() : playable(secondLesson) });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner?.documentId != null);
  const message = { ...f.message('attention'), message: '재생할 영상을 찾지 못했습니다.' }, sender = f.sender();
  // 같은 강의실에서 신호가 거듭 와도 과정은 한 번만 넘긴다.
  assert.deepEqual(await f.runner.heartbeat(message, sender), { active: false });
  await f.runner.heartbeat(message, sender);
  await flush(() => f.calls.navigate.length === 2 && f.state.alphaRunner.documentId);
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)]);
  assert.equal(f.state.alphaRunner.running, true); assert.equal(f.state.alphaRunner.courseId, ids[1]);
  assert.equal(f.state.alphaRunner.courseIndex, 1);
  assert.deepEqual(f.state.alphaRunner.deferredCourses.map(item => [item.courseId, item.reason, item.message]),
    [[ids[0], 'playback', '재생할 영상을 찾지 못했습니다.']]);
  assert.equal(f.calls.notify.length, 0);
  await f.runner.stop();
});

test('cleanup failure still persists attention and never opens a second player', async () => {
  const f = fixture(); await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.documentId);
  f.host.pause = async () => { throw new Error('host unreachable'); };
  await assert.rejects(f.runner.openPlayer(), /중지/);
  assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.state.alphaRunner.phase, 'attention');
  assert.match(f.state.alphaRunner.message, /종료를 확인하지 못/);
  assert.equal(f.state.alphaRunner.cleanupPending, true);
  await assert.rejects(f.runner.retry(), /중지/);
  assert.equal(f.calls.tabCreate.length, 0);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, false);
  f.host.pause = async () => {};
  await f.runner.openPlayer();
  assert.equal(f.state.alphaRunner.cleanupPending, false);
  assert.equal(f.calls.tabCreate.length, 1);
});

test('stop persists its terminal state even when hidden player cleanup rejects', async () => {
  const f = fixture(); await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.documentId);
  await new Promise(resolve => setImmediate(resolve));
  f.host.pause = async () => { throw new Error('host unreachable'); };
  const result = await f.runner.stop();
  assert.equal(result.ok, false);
  assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.state.alphaRunner.phase, 'stopped');
  assert.match(f.state.alphaRunner.message, /종료를 확인하지 못/);
  assert.equal(f.state.alphaRunner.cleanupPending, true);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, false);
  f.host.pause = async () => {};
  assert.equal((await f.runner.stop()).ok, true);
  assert.equal(f.state.alphaRunner.cleanupPending, false);
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 2);
  await f.runner.stop();
});

test('late startup and watchdog failures do not overwrite a manual player handoff', async () => {
  for (const source of ['startup', 'watchdog']) {
    const gate = deferred();
    const f = fixture(source === 'startup' ? { hostNavigate: () => gate.promise } : {});
    await f.runner.startEnrolled(selection());
    await flush(() => f.calls.navigate.length === 1 && (source === 'startup' || f.state.alphaRunner?.documentId));
    let watching;
    if (source === 'watchdog') {
      f.host.isAlive = () => gate.promise;
      watching = f.runner.tick();
      await new Promise(resolve => setImmediate(resolve));
    }
    await f.runner.openPlayer();
    const manual = structuredClone(f.state.alphaRunner);
    if (source === 'startup') gate.reject(new Error('late startup failure'));
    else gate.resolve(false);
    await watching;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.alphaRunner.attentionReason, 'manual');
    assert.equal(f.state.alphaRunner.message, manual.message);
    assert.equal(f.state.alphaRunner.running, false);
    assert.equal(f.calls.tabCreate.length, 1);
  }
});

test('terminal completion and empty-course state survive player cleanup failure', async () => {
  for (const status of ['completed', 'not-enrolled']) {
    const f = fixture({ inspect: async () => ({ status }) });
    f.host.pause = async () => { throw new Error('host unreachable'); };
    await f.runner.startEnrolled(selection());
    await flush(() => ['done', 'idle'].includes(f.state.alphaRunner?.phase) && /종료를 확인하지 못/.test(f.state.alphaRunner.message));
    assert.equal(f.state.alphaRunner.running, false);
    assert.equal(f.state.alphaRunner.phase, status === 'completed' ? 'done' : 'idle');
    assert.equal(f.calls.navigate.length, 0);
  }
});

test('failed initial persistence releases the launch lock without starting login or enrollment', async () => {
  let fail = true;
  const f = fixture({ storageSet: async value => {
    if (value.alphaRunner?.phase === 'login' && fail) { fail = false; throw new Error('storage unavailable'); }
  } });
  await assert.rejects(f.runner.startEnrolled(selection()), /storage unavailable/);
  await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.login, 0);
  assert.equal(f.calls.enroll, 0);
  await new Promise(resolve => setImmediate(resolve));
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1);
  assert.equal(f.calls.login, 1);
  await f.runner.stop();
});

test('failed survey continuation persistence keeps the manual continue action retryable', async () => {
  let fail = true;
  const f = fixture({ initial: surveyState(), storageSet: async value => {
    if (value.alphaRunner?.phase === 'checking-survey' && fail) { fail = false; throw new Error('storage unavailable'); }
  } });
  await assert.rejects(f.runner.continueSurvey(), /storage unavailable/);
  await flush(() => f.state.alphaRunner?.phase === 'attention');
  assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.state.alphaRunner.attentionReason, 'survey');
  assert.equal(f.calls.inspect.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  await f.runner.continueSurvey();
  await flush(() => f.calls.navigate.length === 1);
  assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

// ---------- 근무 시간 · 강의 사이 휴식 (사이드 패널 상단 설정) ----------
const working = (overrides = {}) => ({ allowed: true, resumeAt: 0, resumeLabel: '', rest: null, ...overrides });
const offHours = () => working({ allowed: false, resumeAt: 5000000, resumeLabel: '09:00' });

test('a start outside work hours prepares the lesson, waits, and plays when work hours begin', async () => {
  const plan = offHours();
  const f = fixture({ plan }); await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.phase === 'offhours');
  assert.equal(f.calls.navigate.length, 0); assert.equal(f.state.alphaRunner.running, true);
  assert.match(f.state.alphaRunner.message, /09:00/);
  assert.equal(f.state.alphaRunner.lessonTitle, '테스트 영상');
  assert.ok(f.calls.alarms.some(item => item.name === 'alpha-player-watchdog'));
  await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'offhours'); assert.equal(f.calls.navigate.length, 0);
  Object.assign(plan, working());
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 1); assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.equal(f.calls.login, 2, 'the session is renewed with the saved account after a long wait');
  assert.equal(f.calls.enroll, 0);
  await f.runner.stop();
});

test('work hours ending during playback closes the hidden player and resumes in the next work hours', async () => {
  const plan = working();
  const f = fixture({ plan }); await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.documentId);
  assert.equal((await f.runner.heartbeat(f.message('playing'), f.sender())).active, true);
  const message = f.message('playing'), sender = f.sender();
  Object.assign(plan, offHours());
  await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'offhours'); assert.equal(f.state.alphaRunner.running, true);
  assert.ok(f.calls.hostPause > 0);
  assert.deepEqual(await f.runner.heartbeat(message, sender), { active: false });
  assert.equal(f.calls.notify.length, 0, 'waiting for work hours is not an error');
  Object.assign(plan, working());
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 2); assert.equal(f.state.alphaRunner.phase, 'loading');
  await f.runner.stop();
});

test('a different account after waiting for work hours stops instead of playing', async () => {
  const plan = offHours();
  const f = fixture({ plan }); await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.phase === 'offhours');
  f.setSession({ authenticated: true, loginId: 'someone-else' });
  Object.assign(plan, working());
  await f.runner.tick();
  assert.equal(f.state.alphaRunner.phase, 'attention'); assert.equal(f.state.alphaRunner.running, false);
  assert.equal(f.calls.navigate.length, 0);
});

test('a finished lesson rests for a random time before the next lesson, and only then', async () => {
  const plan = working({ rest: [60, 180] });
  const f = fixture({ plan, inspect: async (course, count) => playable(count === 1 ? firstLesson : secondLesson) });
  await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.documentId);
  assert.equal(f.calls.navigate.length, 1, 'the first lesson starts without a rest');
  await f.runner.heartbeat(f.message('ended'), f.sender());
  await flush(() => f.state.alphaRunner.phase === 'rest');
  assert.equal(f.calls.navigate.length, 1); assert.equal(f.state.alphaRunner.running, true);
  assert.match(f.state.alphaRunner.message, /2분/);
  assert.ok(f.calls.hostPause > 0, 'nothing plays while resting');
  f.advanceClock(119000);
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 1);
  f.advanceClock(2000);
  await f.runner.tick();
  assert.deepEqual(f.calls.navigate, [urlFor(firstLesson), urlFor(secondLesson)]);
  assert.equal(f.state.alphaRunner.phase, 'loading');
  assert.equal(f.calls.login, 1, 'a short rest does not log in again');
  await f.runner.stop();
});

test('turning the rest off while resting continues at once, and stop ends a rest', async () => {
  for (const action of ['setting', 'stop']) {
    const plan = working({ rest: [60, 180] });
    const f = fixture({ plan, inspect: async (course, count) => playable(count === 1 ? firstLesson : secondLesson) });
    await f.runner.startEnrolled(selection());
    await flush(() => f.state.alphaRunner?.documentId);
    await f.runner.heartbeat(f.message('ended'), f.sender());
    await flush(() => f.state.alphaRunner.phase === 'rest');
    if (action === 'setting') {
      plan.rest = null;
      await f.runner.tick();
      assert.equal(f.calls.navigate.length, 2);
      await f.runner.stop();
    } else {
      await f.runner.stop();
      f.advanceClock(600000);
      await f.runner.tick();
      assert.equal(f.calls.navigate.length, 1); assert.equal(f.state.alphaRunner.phase, 'stopped');
    }
  }
});

test('reopening a lost player does not insert a rest', async () => {
  const f = fixture({ hostAlive: false, initial: lostPlayer(), plan: working({ rest: [60, 180] }) });
  await f.runner.tick();
  assert.equal(f.calls.navigate.length, 1); assert.equal(f.state.alphaRunner.phase, 'loading');
  await f.runner.stop();
});

test('a worker restart while resting or waiting for work hours keeps waiting without a player', async () => {
  const resting = fixture({ plan: working({ rest: [60, 180] }),
    initial: { ...lostPlayer(), phase: 'rest', restUntil: 1000000 + 90000, playerToken: null, documentId: null } });
  await resting.runner.tick();
  assert.equal(resting.calls.alarms.length, 1); assert.equal(resting.calls.navigate.length, 0);
  assert.equal(resting.state.alphaRunner.phase, 'rest'); assert.equal(resting.calls.hostAlive.length, 0);
  resting.advanceClock(91000);
  await resting.runner.tick();
  assert.equal(resting.calls.navigate.length, 1);
  await resting.runner.stop();

  const plan = offHours();
  const waiting = fixture({ plan, initial: { ...lostPlayer(), phase: 'offhours', playerToken: null, documentId: null } });
  await waiting.runner.tick();
  assert.equal(waiting.calls.navigate.length, 0); assert.equal(waiting.state.alphaRunner.phase, 'offhours');
  assert.match(waiting.state.alphaRunner.message, /09:00/);
  await waiting.runner.stop();
});

test('a submitted survey is removed from the pending list, and a run waiting on it continues', async () => {
  const ids = selection().courseIds;
  // 모든 과정이 설문만 남아 실행이 끝난 뒤, 과정별 자동 설문으로 하나씩 제출한다.
  const finished = fixture({ inspect: async () => ({ status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' }) });
  await finished.runner.startEnrolled(selection());
  await flush(() => finished.state.alphaRunner?.phase === 'done');
  await finished.runner.surveyDone(ids[0]);
  assert.deepEqual(finished.state.alphaRunner.surveyCourses.map(item => item.courseId), ids.slice(1));
  for (const id of ids.slice(1)) await finished.runner.surveyDone(id);
  assert.deepEqual(finished.state.alphaRunner.surveyCourses, []);
  assert.match(finished.state.alphaRunner.message, /설문을 모두 마쳤습니다/);
  assert.equal(finished.calls.navigate.length, 0);

  // 예전 방식으로 설문에서 멈춰 있던 실행은 그 과정의 설문이 제출되면 다음 과정으로 이어 간다.
  const waiting = fixture({ initial: { ...surveyState(0), mode: 'enrolled' },
    inspect: async course => course.id === ids[0] ? { status: 'completed', registrationId } : playable() });
  await waiting.runner.surveyDone(ids[1]);
  assert.equal(waiting.state.alphaRunner.phase, 'attention', 'another course does not resume it');
  await waiting.runner.surveyDone(ids[0]);
  await flush(() => waiting.calls.navigate.length === 1);
  assert.equal(waiting.state.alphaRunner.running, true); assert.equal(waiting.state.alphaRunner.courseId, ids[1]);
  assert.equal(waiting.calls.enroll, 0);
  await waiting.runner.stop();
});

// ---------- 예약한 자동 설문 ----------
test('a reserved survey is submitted once its course videos are done, then the course completes and the run goes on', async () => {
  const ids = selection().courseIds;
  const submitted = [];
  const f = fixture({
    certificate: async () => ({ status: 'complete' }),
    survey: { reserved: async id => id === ids[0], auto: async course => { submitted.push(course.id); return { submitted: 1, completed: true }; } },
    inspect: async course => course.id !== ids[0] ? playable()
      : submitted.length ? { status: 'completed', registrationId } : { status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' } });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner?.documentId != null);
  assert.deepEqual(submitted, [ids[0]]);
  assert.deepEqual(f.state.alphaRunner.completedCourseIds, [ids[0]]);
  assert.deepEqual(f.state.alphaRunner.surveyCourses, []);
  assert.deepEqual(f.calls.certificates.map(item => item.course.id), [ids[0]], 'the certificate is saved as soon as completion is confirmed');
  assert.equal(f.state.alphaRunner.courseId, ids[1]);
  await f.runner.stop();
});

test('a survey that was not reserved is never submitted by the run', async () => {
  let asked = 0, submitted = 0;
  const f = fixture({ survey: { reserved: async () => { asked++; return false; }, auto: async () => { submitted++; return { submitted: 1 }; } },
    inspect: async () => ({ status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' }) });
  await f.runner.startEnrolled(selection());
  await flush(() => f.state.alphaRunner?.phase === 'done');
  assert.equal(asked, selection().courseIds.length); assert.equal(submitted, 0);
  assert.equal(f.state.alphaRunner.surveyCourses.length, selection().courseIds.length);
});

test('a reserved survey that cannot be submitted is left for the menu and tried only once per run', async () => {
  const ids = selection().courseIds;
  let attempts = 0;
  const f = fixture({ survey: { reserved: async id => id === ids[0], auto: async () => { attempts++; throw new Error('강사별 만족도 문항은 자동으로 답할 수 없습니다.'); } },
    inspect: async course => course.id === ids[0] ? { status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' } : playable() });
  await f.runner.startEnrolled(selection());
  await flush(() => f.calls.navigate.length === 1 && f.state.alphaRunner?.documentId != null);
  assert.equal(attempts, 1);
  assert.deepEqual(f.state.alphaRunner.surveyCourses.map(item => item.courseId), [ids[0]]);
  assert.match(f.state.alphaRunner.surveyNote, /강사별 만족도/);
  assert.equal(f.state.alphaRunner.running, true, 'the other courses still play');
  // 같은 실행에서 설문만 남은 상태를 다시 만나도(제출이 반영되지 않은 경우) 반복해서 보내지 않는다.
  const stuck = fixture({ survey: { reserved: async () => true, auto: async () => { attempts++; return { submitted: 1 }; } },
    inspect: async () => ({ status: 'attention', attentionReason: 'survey', message: '마지막 설문을 진행하세요.' }) });
  attempts = 0;
  await stuck.runner.startEnrolled(selection());
  await flush(() => stuck.state.alphaRunner?.phase === 'done');
  assert.equal(attempts, selection().courseIds.length);
  await f.runner.stop();
});

test('stop while a reserved survey is being submitted prevents any further playback', async () => {
  const gate = deferred(); let submitting = false;
  const f = fixture({ survey: { reserved: async () => true, auto: () => { submitting = true; return gate.promise; } },
    inspect: async (course, count) => count === 1 ? { status: 'attention', attentionReason: 'survey', message: '설문' } : playable() });
  await f.runner.startEnrolled(selection());
  await flush(() => submitting);
  await f.runner.stop(); gate.resolve({ submitted: 1 });
  await flush(() => f.state.alphaRunner.phase === 'stopped');
  assert.equal(f.calls.navigate.length, 0);
});
