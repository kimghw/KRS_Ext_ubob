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
// 강의실 탭에 넣는 함수 자리. 실제 버튼 누르기는 alpha-exam.test.cjs에서 확인한다.
function examInPage() {}
function examAnswerInPage() {}
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
function fixture({ authGate, listGate, initial = {}, inspect, capture, prepareOpen } = {}) {
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
    AlphaExam: { openInPage: examInPage, answerInPage: examAnswerInPage, parseAnswers: require('../src/alpha-exam.js').parseAnswers, createClient: () => ({
      capture: async (...args) => { calls.push({ name: 'exam.capture', args }); return capture(...args); },
      prepareOpen: async (...args) => { calls.push({ name: 'exam.prepareOpen', args }); return prepareOpen(...args); } }) },
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
    calls, runtimeErrors, stores, dispatch, ticks: () => ticks, tabs: chrome.tabs, scripting: chrome.scripting,
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

test('the exam shortcut opens the classroom beside the current tab and presses the site buttons that show the exam', async () => {
  const catalog = require('../src/alpha-catalog.js');
  const [courseId] = catalog.defaultsForRole('researcher');
  const examUrl = 'https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=r&type=ONLINE&sequenceLessonId=exam';
  const opened = [], places = [], injected = [];
  const run = async ({ plan, outcome = { ok: true, started: false }, loads = true, extra = {} }) => {
    const f = fixture({ prepareOpen: async (_, options) => plan(options) });
    const listeners = { updated: [], removed: [] };
    f.tabs.query = async () => [{ index: 3, windowId: 7 }];
    f.tabs.create = async value => {
      opened.push(value.url); places.push([value.index, value.windowId, value.active]);
      // 불러오지 못하고 닫힌 탭은 기다리지 않는다.
      if (!loads) setImmediate(() => listeners.removed.forEach(listener => listener(11)));
      return { id: 11 };
    };
    f.tabs.get = async () => ({ id: 11, status: loads ? 'complete' : 'loading', url: loads ? examUrl : '' });
    for (const [name, key] of [['onUpdated', 'updated'], ['onRemoved', 'removed']]) {
      f.tabs[name] = { addListener: fn => listeners[key].push(fn), removeListener: fn => { listeners[key] = listeners[key].filter(item => item !== fn); } };
    }
    f.scripting.executeScript = async details => { injected.push(details); return [{ frameId: 0, result: outcome }]; };
    const response = await f.dispatch({ type: 'alpha-exam-open', courseId, ...extra }).response;
    assert.deepEqual([listeners.updated.length, listeners.removed.length], [0, 0], 'tab listeners are removed once the tab is ready or gone');
    return { response, options: f.calls.find(call => call.name === 'exam.prepareOpen')?.args[1] };
  };

  // 응시 중인 기록이 있으면 이어서 연다: "응시"는 누르지 않게 start 없이 넣는다.
  const resume = await run({ plan: () => ({ ok: true, resume: true, title: '시험', url: examUrl }) });
  assert.equal(resume.response.result.message, '시험 창을 열었습니다.');
  assert.equal(resume.options.start, false);
  assert.deepEqual(opened, [examUrl]);
  assert.deepEqual(places, [[4, 7, true]], 'the classroom opens right next to the tab being viewed');
  assert.equal(injected.length, 1);
  assert.equal(injected[0].target.tabId, 11);
  assert.equal(injected[0].func, examInPage);
  assert.deepEqual([...injected[0].args], ['시험', false]);

  // 응시 중인 기록이 없으면 확인을 받기 전에는 탭도 열지 않는다.
  const ask = await run({ plan: ({ start }) => (start ? { ok: true, resume: false, title: '시험', url: examUrl }
    : { ok: false, needsStart: true, used: 2, limit: 7, message: '한 번 더 누르면 응시 시작 (3/7회)' }) });
  assert.equal(ask.response.result.needsStart, true);
  assert.equal(opened.length, 1, 'nothing is opened before confirmation');
  const confirmed = await run({ plan: ({ start }) => ({ ok: start, resume: false, title: '시험', url: examUrl }),
    outcome: { ok: true, started: true }, extra: { start: true } });
  assert.equal(confirmed.options.start, true);
  assert.equal(confirmed.response.result.message, '응시를 시작해 시험 창을 열었습니다.');
  assert.deepEqual([...injected.at(-1).args], ['시험', true], 'only a confirmed request may press 응시');

  // 강의실에서 버튼을 찾지 못하면 그 이유를 그대로, 탭이 열리지 않으면 넣지 않는다.
  const missing = await run({ plan: () => ({ ok: true, resume: true, title: '시험', url: examUrl }),
    outcome: { ok: false, message: '시험 표를 찾지 못했습니다.' } });
  assert.equal(missing.response.result.ok, false);
  assert.equal(missing.response.result.message, '시험 표를 찾지 못했습니다.');
  const before = injected.length;
  const closed = await run({ plan: () => ({ ok: true, resume: true, title: '시험', url: examUrl }), loads: false });
  assert.match(closed.response.result.message, /강의실이 열리지 않았습니다/);
  assert.equal(injected.length, before, 'nothing is pressed in a tab that did not load');
});

test('every exam content request reads the site again, and content that could not be refreshed is never kept for copying', async () => {
  const catalog = require('../src/alpha-catalog.js');
  const [courseId, otherId] = catalog.defaultsForRole('researcher');
  let reply = async () => ({ ok: true, started: false, examId: 'exam-2', title: '시험', count: 10, text: '새 문항' });
  const f = fixture({ capture: (...args) => reply(...args),
    initial: { alphaExamCapture: { loginId: user.loginId, courseId, examId: 'exam-1', count: 10, text: '지난 문항', capturedAt: 1 } } });
  const ask = extra => f.dispatch({ type: 'alpha-exam-capture', courseId, ...extra }).response;

  const fresh = await ask();
  assert.equal(fresh.result.ok, true); assert.equal(fresh.result.count, 10);
  assert.equal(f.stores.local.alphaExamCapture.text, '새 문항', 'the new attempt replaces the old content');
  assert.equal(f.stores.local.alphaExamCapture.examId, 'exam-2');
  assert.equal(f.stores.local.alphaExamCapture.loginId, user.loginId);
  assert.equal(f.calls.filter(call => call.name === 'exam.capture').at(-1).args[1].start, false);

  // 응시 중 기록이 없어 새로 가져오지 못하면(제출 뒤 등) 지난 내용은 지운다. 확인한 뒤에만 응시를 시작한다.
  reply = async (_, { start }) => (start ? { ok: true, started: true, examId: 'exam-3', count: 10, text: '다시 응시한 문항' }
    : { ok: false, needsStart: true, used: 1, limit: 7, message: '한 번 더 누르면 응시 시작 (2/7회)' });
  assert.equal((await ask()).result.needsStart, true);
  assert.equal(f.stores.local.alphaExamCapture, undefined);
  assert.equal((await ask({ start: true })).result.started, true);
  assert.equal(f.stores.local.alphaExamCapture.text, '다시 응시한 문항');

  // 가져오다 실패해도 지난 내용은 남기지 않는다. 다른 과정의 내용은 건드리지 않는다.
  reply = async () => { throw new Error('알파 시험 요청 시간이 초과되었습니다.'); };
  assert.equal((await ask()).ok, false);
  assert.equal(f.stores.local.alphaExamCapture, undefined);
  f.stores.local.alphaExamCapture = { loginId: user.loginId, courseId: otherId, count: 1, text: '다른 과정' };
  await ask();
  assert.equal(f.stores.local.alphaExamCapture.text, '다른 과정');
  assert.deepEqual(f.runtimeErrors, []);
});

test('typed answers go into the exam window of this course, opening it first when needed, and are never submitted', async () => {
  const catalog = require('../src/alpha-catalog.js');
  const [courseId] = catalog.defaultsForRole('researcher');
  const room = id => `https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=${id}&type=ONLINE`;
  const resumePlan = { ok: true, resume: true, title: '시험', url: room('reg-1'), registrationId: 'reg-1' };
  const run = async ({ text = '1④ 2③ 5 O', plan = resumePlan, tabs = [], answer = () => null }) => {
    const f = fixture({ prepareOpen: async () => plan });
    const injected = [], activated = [], created = [];
    f.tabs.query = async query => (query?.url ? tabs : [{ index: 0, windowId: 1 }]);
    f.tabs.create = async value => { created.push(value.url); return { id: 99 }; };
    f.tabs.get = async () => ({ id: 99, status: 'complete', url: room('reg-1') });
    f.tabs.update = async (id, value) => { activated.push([id, value.active]); return {}; };
    f.tabs.onUpdated = f.tabs.onRemoved = { addListener() {}, removeListener() {} };
    f.scripting.executeScript = async ({ target, func, args }) => {
      injected.push({ tabId: target.tabId, func, args: JSON.parse(JSON.stringify(args)) });
      return [{ result: func === examInPage ? { ok: true, started: false } : answer(target.tabId) }];
    };
    const response = await f.dispatch({ type: 'alpha-exam-answer', courseId, text }).response;
    return { response, injected, activated, created, calls: f.calls };
  };
  const filled = { ok: true, total: 10, done: [1, 2, 5], failed: [] };

  // 같은 과정의 강의실 탭 중 시험 창이 떠 있는 탭을 찾는다(보고 있는 탭부터). 다른 과정의 탭에는 넣지 않는다.
  const found = await run({ tabs: [{ id: 1, url: room('other') }, { id: 2, url: room('reg-1') }, { id: 3, url: room('reg-1'), active: true }],
    answer: tabId => (tabId === 2 ? filled : { ok: false, missing: true }) });
  assert.deepEqual(found.injected.map(item => item.tabId), [3, 2]);
  assert.ok(found.injected.every(item => item.func === examAnswerInPage));
  assert.deepEqual(found.injected[0].args, [[{ number: 1, choice: 4 }, { number: 2, choice: 3 }, { number: 5, choice: 'O' }]]);
  assert.deepEqual(found.activated, [[2, true]], 'the tab with the answers comes to the front for review and submission');
  assert.equal(found.created.length, 0);
  assert.equal(found.response.result.message, '10문항 중 3문항을 넣었습니다. 확인 후 제출하세요.');

  // 시험 창이 없으면 시험 바로가기처럼 이어서 연 뒤 넣고, 넣지 못한 문항은 알려 준다.
  const opened = await run({ answer: tabId => (tabId === 99 ? { ok: true, total: 10, done: [1, 5], failed: [2] } : null) });
  assert.deepEqual(opened.created, [room('reg-1')]);
  assert.deepEqual(opened.injected.map(item => [item.tabId, item.func === examInPage ? 'open' : 'answer']), [[99, 'open'], [99, 'answer']]);
  assert.deepEqual(opened.injected[0].args, ['시험', false], 'opening for answers never presses 응시');
  assert.equal(opened.response.result.ok, false);
  assert.equal(opened.response.result.message, '10문항 중 2문항을 넣었습니다. 2번은 직접 고르세요.');

  // 응시 중인 시험이 없으면 응시를 시작하지 않는다. 읽지 못한 답은 사이트에 묻기 전에 돌려보낸다.
  const none = await run({ plan: { ok: false, needsStart: true, message: '한 번 더 누르면 응시 시작' } });
  assert.match(none.response.result.message, /시험 바로가기로 먼저 응시하세요/);
  assert.equal(none.injected.length + none.created.length, 0);
  const unreadable = await run({ text: '모르겠음' });
  assert.equal(unreadable.response.ok, false);
  assert.match(unreadable.response.error, /답을 읽지 못했습니다/);
  assert.ok(!unreadable.calls.some(call => call.name === 'exam.prepareOpen' || call.name === 'auth.ensureLoggedIn'));
});
