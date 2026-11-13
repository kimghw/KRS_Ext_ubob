const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SharedOffscreen, AlphaHost } = require('../src/alpha-host.js');
const runtimeId = 'extension-id';
const hostUrl = `chrome-extension://${runtimeId}/src/runner.html?host=offscreen`;
const url = 'https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=11111111-1111-1111-1111-111111111111&type=ONLINE&sequenceLessonId=22222222-2222-2222-2222-222222222222';
const binding = { url, runId: 'run-one', playerToken: 'token-one' };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ createGate, closeGate, timeoutMs, messageTimeoutMs } = {}) {
  const saved = {}, calls = { create: 0, close: 0, messages: [], rules: [] };
  let contexts = [], alpha = null, ubob = 'https://learn.ubob.com/old';
  const runtime = { id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}`,
    getContexts: async query => contexts.filter(item => !query.documentUrls || query.documentUrls.includes(item.documentUrl)),
    sendMessage: async message => {
      calls.messages.push(message);
      if (message.target === 'runner') { ubob = message.url; return { ok: true }; }
      if (message.cmd === 'navigate') alpha = { url: message.url, runId: message.runId, playerToken: message.playerToken };
      if (message.cmd === 'clear') alpha = null;
      return { ok: true, ...(alpha || {}) };
    } };
  const storage = { get: async key => ({ [key]: structuredClone(saved[key]) }), set: async value => Object.assign(saved, structuredClone(value)) };
  const offscreen = {
    createDocument: async () => { calls.create++; if (createGate) await createGate.promise; contexts = [{ documentUrl: hostUrl, documentId: `doc-${calls.create}` }]; },
    closeDocument: async () => { calls.close++; if (closeGate) await closeGate.promise; contexts = []; },
  };
  let shared = SharedOffscreen.create({ runtime, storage, offscreen, timeoutMs, messageTimeoutMs });
  const dnr = { updateSessionRules: async rule => { calls.rules.push(rule); } };
  const host = AlphaHost.create({ runtime, shared, dnr, timeoutMs, messageTimeoutMs });
  return { shared, host, runtime, dnr, calls, saved, alpha: () => alpha, ubob: () => ubob,
    replaceContext: value => { contexts = value; },
    restartShared: () => (shared = SharedOffscreen.create({ runtime, storage, offscreen })) };
}

test('concurrent site claims share one document and release only their own lane', async () => {
  const f = fixture();
  await Promise.all([f.shared.ensure('ubob'), f.shared.ensure('alpha')]);
  assert.equal(f.calls.create, 1);
  assert.deepEqual(f.saved.sharedOffscreenOwners.sort(), ['alpha', 'ubob']);
  await f.host.navigate(url, binding);
  await f.shared.release('ubob');
  assert.equal(f.ubob(), 'about:blank');
  assert.equal(f.alpha().url, url);
  assert.equal(f.calls.close, 0);
  assert.equal(await f.shared.owns('ubob'), false);
  await f.host.pause();
  assert.equal(f.alpha(), null);
  assert.equal(f.calls.close, 1);
  assert.deepEqual(f.saved.sharedOffscreenOwners, []);
});

test('a receiver that never acknowledges navigation times out once and stop releases the host', async () => {
  const f = fixture({ messageTimeoutMs: 20 });
  const original = f.runtime.sendMessage;
  let navigations = 0;
  f.runtime.sendMessage = async message => {
    if (message.cmd === 'navigate' && message.target === 'alpha-host') {
      navigations++; await original(message); return new Promise(() => {});
    }
    return original(message);
  };
  const navigating = f.host.navigate(url, binding);
  const failed = assert.rejects(navigating, /시작 명령에 응답하지/);
  for (let count = 0; count < 20 && !navigations; count++) await new Promise(resolve => setImmediate(resolve));
  const stopping = f.host.pause();
  await failed; await stopping;
  assert.equal(navigations, 1);
  assert.equal(f.alpha(), null);
  assert.equal(await f.shared.owns('alpha'), false);
  assert.equal(f.calls.close, 1);
  assert.deepEqual(f.calls.rules.at(-1), { removeRuleIds: [2] });
});

test('a late offscreen creation after timeout and stop leaves no orphan document', async () => {
  const gate = deferred(), f = fixture({ createGate: gate, timeoutMs: 20 });
  await assert.rejects(f.host.navigate(url, binding), /준비 시간이 초과/);
  await f.host.pause();
  assert.equal(await f.shared.owns('alpha'), false);
  assert.equal(f.calls.messages.some(message => message.cmd === 'navigate'), false);
  gate.resolve();
  for (let count = 0; count < 20 && !f.calls.close; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.close, 1);
  assert.equal(await f.shared.hasDocument(), false);
});

test('late creation is shared with a new UBOB claim rather than closed or recreated', async () => {
  const gate = deferred(), f = fixture({ createGate: gate, timeoutMs: 30 });
  await assert.rejects(f.host.navigate(url, binding), /준비 시간이 초과/);
  await f.host.pause();
  const claiming = f.shared.ensure('ubob');
  gate.resolve(); await claiming;
  assert.equal(f.calls.create, 1); assert.equal(f.calls.close, 0);
  assert.equal(await f.shared.hasDocument(), true);
  assert.deepEqual(f.saved.sharedOffscreenOwners, ['ubob']);
});

test('unanswered clear preserves UBOB and an unanswered ping is reported as unavailable', async () => {
  const f = fixture({ messageTimeoutMs: 20 });
  await f.shared.ensure('ubob'); await f.host.navigate(url, binding);
  f.runtime.sendMessage = async message => {
    if (message.target === 'alpha-host') return new Promise(() => {});
    throw new Error('unexpected UBOB command');
  };
  assert.equal(await f.host.isAlive(binding), false);
  await assert.rejects(f.host.pause(), /비우지 못했습니다/);
  assert.equal(f.calls.close, 0);
  assert.equal(await f.shared.owns('ubob'), true);
  assert.equal(f.ubob(), 'https://learn.ubob.com/old');
  assert.deepEqual(f.calls.rules.at(-1), { removeRuleIds: [2] });
});

test('unanswered clear closes an exclusively owned document without waiting forever', async () => {
  const f = fixture({ messageTimeoutMs: 20 });
  await f.host.navigate(url, binding);
  f.runtime.sendMessage = async () => new Promise(() => {});
  await f.host.pause();
  assert.equal(f.calls.close, 1);
  assert.equal(await f.shared.owns('alpha'), false);
});

test('late final close cannot close a newly claimed document', async () => {
  const gate = deferred(), f = fixture({ closeGate: gate, timeoutMs: 20 });
  await f.shared.ensure('alpha');
  await assert.rejects(f.shared.release('alpha'), /종료가 지연/);
  await assert.rejects(f.shared.ensure('ubob'), /준비 시간이 초과/);
  assert.equal(f.calls.create, 1);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await f.shared.ensure('ubob');
  assert.equal(f.calls.create, 2);
  assert.equal(await f.shared.owns('ubob'), true);
  assert.equal(await f.shared.hasDocument(), true);
});

test('a stalled framing update times out and its late completion is followed by removal', async () => {
  const gate = deferred(), f = fixture({ timeoutMs: 20 }), applied = [];
  f.dnr.updateSessionRules = async options => {
    if (options.addRules) await gate.promise;
    applied.push(options.addRules ? 'add' : 'remove');
  };
  await assert.rejects(f.host.navigate(url, binding), /응답하지 않습니다/);
  await assert.rejects(f.host.pause(), /응답하지 않습니다/);
  assert.equal(f.calls.create, 0);
  gate.resolve();
  for (let count = 0; count < 20 && applied.length < 2; count++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, ['add', 'remove']);
  assert.equal(f.calls.create, 0);
});

test('worker restart retains leases without recreating the shared document', async () => {
  const f = fixture();
  await f.shared.ensure('alpha');
  const restarted = f.restartShared();
  assert.equal(await restarted.owns('alpha'), true);
  await restarted.ensure('ubob');
  await restarted.release('alpha');
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.close, 0);
  assert.equal(await restarted.owns('ubob'), true);
});

test('claim racing with final release is serialized and leaves a valid new document', async () => {
  const gate = deferred();
  const f = fixture({ closeGate: gate });
  await f.shared.ensure('ubob');
  const releasing = f.shared.release('ubob');
  const claiming = f.shared.ensure('alpha');
  gate.resolve(); await Promise.all([releasing, claiming]);
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.create, 2);
  assert.equal(await f.shared.hasDocument(), true);
  assert.deepEqual(f.saved.sharedOffscreenOwners, ['alpha']);
});

test('ALPHA framing rule removes only XFO for exact hidden classroom/player paths', async () => {
  const f = fixture();
  assert.deepEqual(await f.host.navigate(url, binding), { documentId: 'doc-1' });
  const rule = f.calls.rules[0].addRules[0];
  assert.equal(rule.id, 2);
  assert.deepEqual(rule.action.responseHeaders, [{ header: 'x-frame-options', operation: 'remove' }]);
  assert.deepEqual(rule.condition.tabIds, [-1]);
  assert.deepEqual(rule.condition.resourceTypes, ['sub_frame']);
  assert.deepEqual(rule.condition.initiatorDomains, [runtimeId, 'alpha-campus.kr']);
  const filter = new RegExp(rule.condition.regexFilter);
  assert.ok(filter.test(url)); assert.ok(filter.test('https://alpha-campus.kr/catenoid.html?id=abc'));
  for (const rejected of ['https://alpha-campus.kr/api/user', 'https://other.example/catenoid.html',
    'https://alpha-campus.kr/my/classRoom/classRoomDetailOther']) assert.equal(filter.test(rejected), false);
  await f.host.pause();
  assert.deepEqual(f.calls.rules.at(-1), { removeRuleIds: [2] });
});

test('relay accepts only current offscreen document and exact authorized navigation', async () => {
  const f = fixture();
  const { documentId } = await f.host.navigate(url, binding);
  const expected = { ...binding, documentId };
  const sender = { id: runtimeId, url: hostUrl, documentId };
  assert.equal(await f.host.accepts(binding, sender, expected), true);
  const offscreenSender = { id: runtimeId, url: hostUrl };
  assert.equal(await f.host.accepts(binding, offscreenSender, expected), true);
  assert.equal(await f.host.accepts(binding, offscreenSender, { ...expected, documentId: null }), false);
  for (const altered of [{ id: 'other' }, { url: 'https://alpha-campus.kr/' }, { documentId: 'old-doc' }, { tab: { id: 4 } }]) {
    assert.equal(await f.host.accepts(binding, { ...sender, ...altered }, expected), false);
  }
  for (const altered of [{ runId: 'old-run' }, { playerToken: 'old-token' }, { url: url.replace('22222222-', '33333333-') }]) {
    assert.equal(await f.host.accepts({ ...binding, ...altered }, sender, expected), false);
  }
  assert.equal(await f.host.isAlive(binding), true);
  assert.equal(await f.host.isAlive({ ...binding, playerToken: 'old' }), false);
  f.replaceContext([{ documentUrl: hostUrl, documentId: 'new-doc' }]);
  assert.equal(await f.host.accepts(binding, sender, expected), false);
  assert.equal(await f.host.accepts(binding, offscreenSender, expected), false);
});

test('pause cancels navigation waiting for document creation before assigning the iframe', async () => {
  const gate = deferred();
  const f = fixture({ createGate: gate });
  const navigating = f.host.navigate(url, binding);
  for (let count = 0; count < 20 && !f.calls.create; count++) await new Promise(resolve => setImmediate(resolve));
  const pausing = f.host.pause();
  gate.resolve();
  await assert.rejects(navigating, /중지/); await pausing;
  assert.equal(f.calls.messages.some(message => message.target === 'alpha-host' && message.cmd === 'navigate'), false);
  assert.equal(await f.shared.owns('alpha'), false);
  assert.equal(await f.shared.hasDocument(), false);
});

function clientFixture({ response, visible = false } = {}) {
  const listeners = {}, relays = [], replies = [];
  let current;
  function makeFrame() {
    return { contentWindow: { postMessage: (message, origin) => replies.push({ message, origin }) },
      replaceWith(next) { current = next; } };
  }
  current = makeFrame();
  const context = vm.createContext({ URL, URLSearchParams, location: { search: `?host=${visible ? 'window' : 'offscreen'}` },
    document: { getElementById: () => current, createElement: () => makeFrame() },
    window: { addEventListener: (kind, callback) => { listeners[kind] = callback; } },
    chrome: { runtime: { id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}`,
      onMessage: { addListener: callback => { listeners.runtime = callback; } },
      sendMessage: async message => { relays.push(message); return response ? response() : { active: true, runId: binding.runId }; } } },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/alpha-host-client.js'), 'utf8'), context);
  const command = (message, sender = { id: runtimeId }) => {
    let result; listeners.runtime?.({ target: 'alpha-host', ...message }, sender, value => { result = value; }); return result;
  };
  const heartbeat = (overrides = {}) => listeners.message?.({ source: current.contentWindow, origin: 'https://alpha-campus.kr',
    data: { tag: 'alpha-offscreen-player', type: 'heartbeat', requestId: 'request-1', url,
      runId: null, kind: 'playing', currentTime: 10, duration: 100 }, ...overrides });
  return { command, heartbeat, listeners, relays, replies, current: () => current };
}

test('host client binds real child window/origin and supplies the current token itself', async () => {
  const f = clientFixture();
  assert.equal(f.command({ cmd: 'navigate', ...binding }).ok, true);
  f.heartbeat({ source: {} }); f.heartbeat({ origin: 'https://other.example' });
  assert.equal(f.relays.length, 0);
  f.heartbeat(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.relays[0].type, 'alpha-host-heartbeat');
  assert.equal(f.relays[0].playerToken, binding.playerToken);
  assert.equal(f.relays[0].runId, binding.runId);
  assert.equal(f.replies[0].origin, 'https://alpha-campus.kr');
  assert.equal(f.replies[0].message.requestId, 'request-1');
  assert.equal(f.replies[0].message.response.active, true);
});

test('new navigation replaces the child window and drops old pending replies', async () => {
  const gate = deferred(), f = clientFixture({ response: () => gate.promise });
  f.command({ cmd: 'navigate', ...binding });
  const previous = f.current(); f.heartbeat();
  f.command({ cmd: 'navigate', ...binding, playerToken: 'new-token' });
  assert.notEqual(f.current().contentWindow, previous.contentWindow);
  f.heartbeat({ source: previous.contentWindow });
  gate.resolve({ active: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.relays.length, 1); assert.equal(f.replies.length, 0);
  f.command({ cmd: 'clear' }); f.heartbeat();
  assert.equal(f.relays.length, 1);
});

test('visible UBOB host and commands from site content cannot control the hidden ALPHA lane', () => {
  const visible = clientFixture({ visible: true });
  assert.equal(visible.listeners.runtime, undefined);
  const f = clientFixture();
  f.command({ cmd: 'navigate', ...binding }, { id: runtimeId, url: 'https://alpha-campus.kr/' });
  f.heartbeat(); assert.equal(f.relays.length, 0);
});
