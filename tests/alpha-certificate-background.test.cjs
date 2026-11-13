const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const sourceDirectory = path.join(__dirname, '..', 'src');
const runtimeId = 'certificate-background-test';
const trustedSender = {
  id: runtimeId,
  url: `chrome-extension://${runtimeId}/popup/popup.html?surface=sidepanel`
};
const user = { authenticated: true, loginId: 'fixture-account' };
const selection = { role: 'researcher', courseIds: ['fixture-course'] };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function eventually(check, label) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await check()) return;
    await flush();
  }
  assert.fail(label);
}

// The message listener, concurrency guards, and asynchronous batch job are real.
// Site login/enrollment/playback and Chrome I/O are deterministic external fakes.
function fixture({ authGate, listGate, initial = {}, inspect } = {}) {
  const calls = [], runtimeErrors = [], stores = { local: structuredClone(initial), sync: {}, session: {} };
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const storageChanged = event();
  const area = name => ({
    async get(keys) {
      const defaults = keys && !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys({ ...defaults, ...stores[name] });
      return structuredClone(Object.fromEntries(names.map(key => [key, key in stores[name] ? stores[name][key] : defaults[key]])));
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: stores[name][key], newValue: value }]));
      Object.assign(stores[name], structuredClone(values));
      for (const listener of storageChanged.listeners) {
        try { Promise.resolve(listener(changes, name)).catch(error => runtimeErrors.push(error)); }
        catch (error) { runtimeErrors.push(error); }
      }
    },
    async remove(keys) { for (const key of [].concat(keys)) delete stores[name][key]; }
  });
  const recorded = name => async (...args) => { calls.push({ name, args }); return { ok: true, message: name }; };
  const auth = {
    ensureLoggedIn: async () => {
      calls.push({ name: 'auth.ensureLoggedIn', args: [] });
      return authGate ? authGate.promise : user;
    },
    saveAccount: recorded('auth.saveAccount'), testAccount: recorded('auth.testAccount')
  };
  const service = { check: recorded('service.check'), enroll: recorded('service.enroll'), open: recorded('service.open') };
  const runner = Object.fromEntries(['start', 'startEnrolled', 'retry', 'continueSurvey', 'stop', 'openPlayer', 'heartbeat']
    .map(name => [name, recorded(`runner.${name}`)]));
  // 시작할 때 한 번 도는 플레이어 감시는 메시지 처리와 무관하므로 호출 기록에서 따로 센다.
  let ticks = 0;
  runner.tick = async () => { ticks++; };
  const chrome = {
    runtime: { id: runtimeId, getURL: value => `chrome-extension://${runtimeId}/${value}`,
      onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: area('local'), sync: area('sync'), session: area('session'), onChanged: storageChanged },
    downloads: { onChanged: event() }, cookies: { get: async () => null },
    windows: { onRemoved: event() }, alarms: { onAlarm: event() },
    notifications: { onClicked: event() }, action: {}, tabs: {}, scripting: {}, offscreen: {}, declarativeNetRequest: {}
  };
  const globals = {
    chrome, console, URL, URLSearchParams, Date, Promise, structuredClone, crypto: webcrypto, setTimeout, clearTimeout,
    AlphaSurveyIndicator: { create: () => ({ update: async () => {} }) },
    AlphaAPI: { createClient: () => ({ session: async () => user }) },
    AlphaAuth: { create: () => auth }, AlphaService: { create: () => service },
    AlphaLearning: { createClient: () => ({ inspect: async course => (inspect ? inspect(course) : { status: 'enrolled' }) }) },
    AlphaCertificateAPI: { createClient: () => ({}) },
    AlphaCertificates: { create: () => ({ reconcile: async () => {}, onChanged: async () => {},
      ensureListed: recorded('certificates.ensureListed') }) },
    AlphaCertificateList: { createClient: () => ({ listCompleted: async () => {
      calls.push({ name: 'list.listCompleted', args: [] });
      return listGate ? listGate.promise : [];
    } }) },
    SharedOffscreen: { create: () => ({}) }, AlphaHost: { create: () => ({}) },
    AlphaSurvey: { createClient: () => ({}) },
    AlphaRunner: { ALARM: 'alpha-test-alarm', create: () => runner }
  };
  let context;
  const realImports = new Set(['shared.js', 'alpha-catalog.js', 'alpha-certificate-batch.js']);
  globals.importScripts = (...files) => {
    for (const file of files) {
      assert.ok(fs.existsSync(path.join(sourceDirectory, file)), `background import exists: ${file}`);
      if (realImports.has(file)) vm.runInContext(fs.readFileSync(path.join(sourceDirectory, file), 'utf8'), context, { filename: file });
    }
  };
  context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(sourceDirectory, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  const listener = chrome.runtime.onMessage.listeners[0];
  function dispatch(message, sender = trustedSender) {
    let returned;
    const response = new Promise(resolve => { returned = listener(message, sender, resolve); });
    return { response, returned };
  }
  return {
    calls, runtimeErrors, stores, dispatch, ticks: () => ticks, tabs: chrome.tabs,
    isBusy: () => vm.runInContext('alphaCertificateBatch.isBusy()', context),
    batchState: () => vm.runInContext('alphaCertificateBatch.getState()', context)
  };
}

test('trusted popup starts all certificates without a role and acknowledges before login finishes', async () => {
  const authGate = deferred();
  const f = fixture({ authGate });
  const request = f.dispatch({ type: 'alpha-certificates-all' });
  assert.equal(request.returned, true, 'Chrome response channel stays open');
  const response = await request.response;
  assert.equal(response.ok, true);
  assert.equal(response.result.ok, true);
  assert.equal(await f.isBusy(), true);
  assert.equal((await f.batchState()).phase, 'listing');
  assert.equal(f.calls.filter(call => call.name === 'auth.ensureLoggedIn').length, 1);
  assert.equal(f.calls.some(call => call.name === 'list.listCompleted'), false, 'ACK does not wait for site login');

  const stop = await f.dispatch({ type: 'alpha-certificates-all-stop' }).response;
  assert.equal(stop.ok, true);
  assert.equal((await f.batchState()).phase, 'stopping');
  authGate.resolve(user);
  await eventually(async () => !await f.isBusy(), 'cancelled batch settles');
  assert.equal((await f.batchState()).phase, 'stopped');
  assert.deepEqual(f.runtimeErrors, []);
});

test('async busy guard blocks auth, enrollment and starts; the same actions resume after cancellation', async () => {
  const listGate = deferred();
  const f = fixture({ listGate });
  assert.equal((await f.dispatch({ type: 'alpha-certificates-all' }).response).ok, true);
  await eventually(() => f.calls.some(call => call.name === 'list.listCompleted'), 'batch reaches the held site request');
  const guarded = [
    ['alpha-account-save', 'auth.saveAccount'], ['alpha-account-test', 'auth.testAccount'],
    ['alpha-check', 'service.check'], ['alpha-enroll', 'service.enroll'],
    ['alpha-start', 'runner.start'], ['alpha-start-enrolled', 'runner.startEnrolled'],
    ['alpha-retry', 'runner.retry'], ['alpha-continue-survey', 'runner.continueSurvey']
  ];
  const baseline = f.calls.length;
  for (const [type] of guarded) {
    const response = await f.dispatch({ type, ...selection }).response;
    assert.equal(response.ok, false, `${type} is blocked`);
    assert.match(response.error, /전체 수료증 받기가 진행 중/);
  }
  assert.equal(f.calls.length, baseline, 'blocked actions do not reach auth, service, or playback');
  const stop = await f.dispatch({ type: 'alpha-certificates-all-stop' }).response;
  assert.equal(stop.ok, true, 'stop bypasses the batch guard');
  assert.equal(await f.isBusy(), true, 'in-flight listing still settles before releasing guard');
  listGate.resolve([]);
  await eventually(async () => !await f.isBusy(), 'batch releases its asynchronous busy state');
  for (const [type, downstream] of guarded) {
    const previous = f.calls.filter(call => call.name === downstream).length;
    const response = await f.dispatch({ type, ...selection }).response;
    assert.equal(response.ok, true, `${type} resumes after isBusy resolves false`);
    assert.equal(f.calls.filter(call => call.name === downstream).length, previous + 1);
  }
  assert.deepEqual(f.runtimeErrors, []);
});

test('an asynchronous batch launch failure is persisted without rejecting the acknowledged message', async () => {
  const authGate = deferred();
  const f = fixture({ authGate });
  const response = await f.dispatch({ type: 'alpha-certificates-all' }).response;
  assert.equal(response.ok, true);
  authGate.reject(new Error('fixture login unavailable'));
  await eventually(async () => !await f.isBusy(), 'failed launch settles without an unhandled rejection');
  const state = await f.batchState();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /fixture login unavailable/);
  assert.equal((await f.dispatch({ type: 'alpha-account-test' }).response).ok, true, 'manual guard is released after launch error');
  await flush();
  assert.deepEqual(f.runtimeErrors, []);
});

test('site content scripts and other extensions cannot start or cancel the account-wide job', async () => {
  const f = fixture();
  for (const sender of [
    { id: runtimeId, url: 'https://alpha-campus.kr/my/classRoom/classRoomDetail' },
    { id: 'other-extension', url: trustedSender.url },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/src/runner.html?host=offscreen` }
  ]) {
    for (const type of ['alpha-certificates-all', 'alpha-certificates-all-stop']) {
      const request = f.dispatch({ type }, sender);
      assert.equal(request.returned, undefined);
      const response = await request.response;
      assert.equal(response.ok, false);
      assert.match(response.error, /확장 프로그램의 알파 신청 화면/);
    }
  }
  assert.equal(await f.isBusy(), false);
  assert.equal((await f.batchState()).phase, 'idle');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.runtimeErrors, []);
});

test('the hidden player is checked once as soon as the worker starts, so playback resumes after an extension reload', async () => {
  const f = fixture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ticks(), 1);
});

test('course status for the per-course menus is read for the signed-in account and never opens or submits anything', async () => {
  const catalog = require('../src/alpha-catalog.js');
  const ids = catalog.defaultsForRole('researcher');
  const answers = [{ status: 'completed' }, { status: 'attention', attentionReason: 'survey' },
    { status: 'ready', lessons: [{ completed: true, progress: 100 }, { completed: false, progress: 0 }] },   // 보기 시작한 과정
    { status: 'ready', lessons: [{ completed: false, progress: 0 }] },                                       // 신청만 한 과정
    { status: 'attention', attentionReason: 'assessment' }];
  const f = fixture({ inspect: async course => { if (ids.indexOf(course.id) < 0) throw new Error('unknown'); return answers[ids.indexOf(course.id)]; } });
  const response = await f.dispatch({ type: 'alpha-course-status', courseIds: [...ids, 'not-a-course'] }).response;
  assert.equal(response.ok, true);
  const saved = f.stores.local.alphaCourseStatus;
  assert.equal(saved.loginId, user.loginId);
  assert.deepEqual(ids.map(id => saved.items[id]), ['completed', 'survey', 'learning', 'enrolled', 'exam']);
  assert.deepEqual(f.calls, [], 'no login, enrollment, playback or certificate request');
  // 바로 다시 물으면 사이트에 다시 묻지 않고, 사이트 화면(content script)은 이 조회를 실행할 수 없다.
  assert.equal((await f.dispatch({ type: 'alpha-course-status', courseIds: ids }).response).result.cached, true);
  const outsider = await f.dispatch({ type: 'alpha-course-status', courseIds: ids, force: true },
    { id: 'extension-under-test', url: 'https://alpha-campus.kr/', tab: { id: 1 } }).response;
  assert.equal(outsider.ok, false);
});

test('an auto survey can be reserved and cancelled per course from the panel only', async () => {
  const catalog = require('../src/alpha-catalog.js');
  const [first, second] = catalog.defaultsForRole('researcher');
  const f = fixture();
  assert.equal((await f.dispatch({ type: 'alpha-survey-reserve', courseId: first, on: true }).response).result.message, '영상이 끝나면 제출합니다.');
  await f.dispatch({ type: 'alpha-survey-reserve', courseId: second, on: true }).response;
  await f.dispatch({ type: 'alpha-survey-reserve', courseId: first, on: true }).response;
  assert.deepEqual(f.stores.local.alphaSurveyReserved, [second, first], 'a course is reserved once');
  await f.dispatch({ type: 'alpha-survey-reserve', courseId: first, on: false }).response;
  assert.deepEqual(f.stores.local.alphaSurveyReserved, [second]);
  assert.equal((await f.dispatch({ type: 'alpha-survey-reserve', courseId: 'not-a-course', on: true }).response).ok, false);
  const outsider = await f.dispatch({ type: 'alpha-survey-reserve', courseId: first, on: true },
    { id: runtimeId, url: 'https://alpha-campus.kr/', tab: { id: 1 } }).response;
  assert.equal(outsider.ok, false, 'a site page cannot reserve a submission');
  assert.deepEqual(f.stores.local.alphaSurveyReserved, [second]);
  assert.deepEqual(f.calls, [], 'reserving alone sends nothing to the site');
});

test('the exam shortcut only opens the exam lesson for the user and never answers it', async () => {
  const catalog = require('../src/alpha-catalog.js');
  const [courseId] = catalog.defaultsForRole('researcher');
  const examUrl = 'https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=r&type=ONLINE&sequenceLessonId=exam';
  const lessons = done => [{ type: 2, playable: true, completed: done }, { type: 10, playable: false, completed: false, url: examUrl }];
  const opened = [], places = [];
  const run = async inspectResult => {
    const f = fixture({ inspect: async () => inspectResult });
    f.tabs.query = async () => [{ index: 3, windowId: 7 }];
    f.tabs.create = async value => { opened.push(value.url); places.push([value.index, value.windowId, value.active]); return { id: 1 }; };
    return (await f.dispatch({ type: 'alpha-exam-open', courseId }).response);
  };
  assert.equal((await run({ status: 'attention', attentionReason: 'assessment', lessons: lessons(true) })).result.message, '시험 화면을 열었습니다.');
  assert.deepEqual(opened, [examUrl]);
  assert.deepEqual(places, [[4, 7, true]], 'the exam opens right next to the tab being viewed');
  assert.equal((await run({ status: 'ready', lessons: lessons(false) })).result.message, '영상 학습을 먼저 마치세요.');
  assert.equal((await run({ status: 'completed', lessons: [] })).result.message, '이미 수료한 과정입니다.');
  assert.equal((await run({ status: 'attention', attentionReason: 'survey', lessons: [{ type: 2, playable: true, completed: true }] })).result.message, '응시할 시험이 없습니다.');
  assert.deepEqual(opened, [examUrl], 'nothing else is opened');
});
