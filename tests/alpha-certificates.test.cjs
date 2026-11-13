const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/alpha-certificates.js');
const catalog = require('../src/alpha-catalog.js');
const course = catalog.courses[0];
const registrationId = '12345678-1234-1234-1234-123456789012';
const loginId = 'researcher';
const runtimeId = 'certificate-extension';
const time = Date.parse('2026-11-13T12:00:00+09:00');
const pdf = new TextEncoder().encode('%PDF-1.7\noriginal certificate bytes\n%%EOF\n');
const input = () => ({ course, registrationId, loginId, completed: true });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture({ initial, fetchPdf, session, download, search } = {}) {
  const state = initial ? { alphaCertificates: structuredClone(initial) } : {};
  const history = new Map();
  const calls = { fetch: [], downloads: [], sessions: 0, searches: [], writes: [] };
  let attempt = 0;
  let manager;
  const storage = {
    get: async key => ({ [key]: structuredClone(state[key]) }),
    set: async value => {
      calls.writes.push(structuredClone(value));
      Object.assign(state, structuredClone(value));
    },
  };
  const downloads = {
    download: async options => {
      calls.downloads.push(options);
      const item = { id: calls.downloads.length, byExtensionId: runtimeId, state: 'in_progress',
        filename: `C:\\Downloads\\${options.filename.replace(/\//g, '\\')}`, startTime: new Date(time).toISOString(), exists: true };
      if (download) return download({ item, options, history, manager });
      history.set(item.id, item);
      return item.id;
    },
    search: async query => {
      calls.searches.push(query);
      if (search) return search(query, history);
      return [...history.values()].filter(item => query.id == null
        ? (!query.filenameRegex || new RegExp(query.filenameRegex).test(item.filename))
        : item.id === query.id).map(item => structuredClone(item));
    },
  };
  const dependencies = { catalog, storage, downloads, runtimeId, now: () => time, id: () => `attempt-${++attempt}`,
    api: { session: async () => {
      calls.sessions++;
      return session ? session(calls.sessions) : { authenticated: true, loginId };
    } },
    provider: { fetchPdf: async args => {
      calls.fetch.push(args);
      return fetchPdf ? fetchPdf(args) : pdf;
    } },
  };
  manager = create(dependencies);
  return { manager, state, history, calls, restart: () => (manager = create(dependencies)) };
}
function previous(status = 'preparing', stage = 'starting') {
  return { busy: true, items: [{ loginId, registrationId, courseId: course.id, title: course.title,
    status, stage, filename: `알파 수료증/교육_123456789012_old-attempt.pdf`, attemptId: 'old-attempt',
    startedAt: time, updatedAt: time, message: 'preparing' }] };
}
function oldDownload(record, overrides = {}) {
  return { id: 42, byExtensionId: runtimeId, filename: `C:\\Downloads\\${record.filename.replace(/\//g, '\\')}`,
    startTime: new Date(time).toISOString(), state: 'in_progress', exists: true, ...overrides };
}

test('downloaded bytes are the original PDF and completion requires Chrome completion', async () => {
  const f = fixture();
  const result = await f.manager.ensure(input());
  assert.equal(result.status, 'downloading');
  assert.equal(result.downloadId, 1);
  assert.equal(f.calls.sessions, 2);
  assert.equal(f.calls.fetch[0].registrationId, registrationId);
  const options = f.calls.downloads[0];
  assert.equal(options.saveAs, false);
  assert.equal(options.conflictAction, 'uniquify');
  assert.ok(options.filename.startsWith('알파 수료증/'));
  assert.ok(options.filename.endsWith('_123456789012_attempt-1.pdf'));
  assert.deepEqual(Buffer.from(options.url.split(',')[1], 'base64'), Buffer.from(pdf));
  assert.equal(JSON.stringify(f.state).includes('data:application/pdf'), false);
  assert.equal(JSON.stringify(f.state).includes('original certificate bytes'), false);
  const committed = f.calls.writes.find(value => value.alphaCertificates.items[0]?.stage === 'starting');
  assert.equal(committed.alphaCertificates.items[0].downloadId, undefined);
  f.history.get(1).state = 'complete';
  await f.manager.onChanged({ id: 1, state: { current: 'complete' } });
  assert.equal(f.state.alphaCertificates.items[0].status, 'complete');
  assert.equal(f.state.alphaCertificates.busy, false);
});

test('concurrent requests, later runs and worker restarts deduplicate the same registration', async () => {
  const gate = deferred();
  const f = fixture({ fetchPdf: () => gate.promise });
  const first = f.manager.ensure(input());
  const second = f.manager.ensure(input());
  gate.resolve(pdf);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status), ['downloading', 'downloading']);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.downloads.length, 1);
  assert.equal((await f.restart().ensure(input())).status, 'downloading');
  f.history.get(1).state = 'complete';
  await f.manager.reconcile();
  f.history.clear();
  assert.equal((await f.restart().ensure({ ...input(), retry: true })).status, 'complete');
  assert.equal(f.calls.downloads.length, 1);
});

test('restart adopts an owned download created before its ID could be saved', async () => {
  const initial = previous();
  const f = fixture({ initial });
  f.history.set(42, oldDownload(initial.items[0], { state: 'complete' }));
  const result = await f.manager.ensure(input());
  assert.equal(result.status, 'complete');
  assert.equal(result.downloadId, 42);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.downloads.length, 0);
});

test('an unconfirmed start never automatically duplicates; explicit retry checks history first', async () => {
  const initial = previous();
  const f = fixture({ initial });
  // Identical names owned by another extension, or from an older attempt window, are not adopted.
  f.history.set(40, oldDownload(initial.items[0], { id: 40, byExtensionId: 'other-extension' }));
  f.history.set(41, oldDownload(initial.items[0], { id: 41, startTime: new Date(time - 60000).toISOString() }));
  assert.equal((await f.manager.ensure(input())).status, 'unconfirmed');
  assert.equal(f.calls.downloads.length, 0);
  assert.equal((await f.restart().ensure(input())).status, 'unconfirmed');
  assert.equal((await f.manager.ensure({ ...input(), retry: true })).status, 'downloading');
  assert.equal(f.calls.downloads.length, 1);
  assert.notEqual(f.calls.downloads[0].filename, initial.items[0].filename);
});

test('a failed history lookup prevents even explicit retries from duplicating an unknown download', async () => {
  const f = fixture({ initial: previous(), search: async () => { throw new Error('history unavailable'); } });
  assert.equal((await f.manager.ensure({ ...input(), retry: true })).status, 'unconfirmed');
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.downloads.length, 0);
});

test('restart during PDF fetching is a failed preparation, not an ambiguous Chrome download', async () => {
  const initial = previous('preparing', 'fetching');
  Object.assign(initial.items[0], { filename: '', attemptId: undefined, startedAt: undefined });
  const f = fixture({ initial });
  const result = await f.manager.reconcile();
  assert.equal(result.busy, false);
  assert.equal(result.items[0].status, 'failed');
  assert.equal((await f.manager.ensure(input())).status, 'failed');
  assert.equal(f.calls.downloads.length, 0);
  assert.equal((await f.manager.ensure({ ...input(), retry: true })).status, 'downloading');
});

test('completion before download returns is reconciled even when its early event has no stored ID', async () => {
  let event;
  const f = fixture({ download: async ({ item, history, manager }) => {
    item.state = 'complete';
    history.set(item.id, item);
    event = manager.onChanged({ id: item.id, state: { current: 'complete' } });
    return item.id;
  } });
  assert.equal((await f.manager.ensure(input())).status, 'complete');
  await event;
  assert.equal(f.state.alphaCertificates.items[0].status, 'complete');
  assert.equal(f.calls.downloads.length, 1);
});

test('a lost download response adopts the created download without issuing another request', async () => {
  const f = fixture({ download: async ({ item, history }) => {
    history.set(item.id, { ...item, state: 'complete' });
    throw new Error('download response lost');
  } });
  assert.equal((await f.manager.ensure(input())).status, 'complete');
  assert.equal((await f.restart().ensure(input())).status, 'complete');
  assert.equal(f.calls.downloads.length, 1);
});

test('HTML, empty, oversized and non-byte PDF responses fail before browser download', async () => {
  for (const value of [new TextEncoder().encode('<html>login</html>'), new Uint8Array(),
    new Uint8Array(25 * 1024 * 1024 + 1), '%PDF-1.7\ntext']) {
    const f = fixture({ fetchPdf: async () => value });
    const result = await f.manager.ensure(input());
    assert.equal(result.status, 'failed');
    assert.match(result.message, /PDF/);
    assert.equal(f.calls.downloads.length, 0);
    assert.equal(f.state.alphaCertificates.busy, false);
  }
});

test('account mismatch before fetching or after fetching prevents downloading', async () => {
  for (const changeAt of [1, 2]) {
    const f = fixture({ session: count => ({ authenticated: true, loginId: count >= changeAt ? 'someone-else' : loginId }) });
    const result = await f.manager.ensure(input());
    assert.equal(result.status, 'failed');
    assert.match(result.message, /계정/);
    assert.equal(f.calls.fetch.length, changeAt - 1);
    assert.equal(f.calls.downloads.length, 0);
  }
});

test('stopping before fetching or during PDF preparation prevents the next side effect', async () => {
  let stopped = true;
  const before = fixture();
  assert.equal((await before.manager.ensure({ ...input(), shouldStop: () => stopped })).status, 'failed');
  assert.equal(before.calls.sessions, 0);
  assert.equal(before.calls.fetch.length, 0);
  stopped = false;
  const during = fixture({ fetchPdf: async () => { stopped = true; return pdf; } });
  assert.equal((await during.manager.ensure({ ...input(), shouldStop: () => stopped })).status, 'failed');
  assert.equal(during.calls.downloads.length, 0);
});

test('interrupted or user-cancelled downloads do not automatically retry and unrelated events do not alter them', async () => {
  for (const error of ['NETWORK_FAILED', 'USER_CANCELED']) {
    const f = fixture();
    await f.manager.ensure(input());
    Object.assign(f.history.get(1), { state: 'interrupted', error });
    await f.manager.onChanged({ id: 1, state: { current: 'interrupted' }, error: { current: error } });
    const result = await f.manager.ensure(input());
    assert.equal(result.status, 'interrupted');
    assert.equal(f.calls.downloads.length, 1);
    await f.manager.onChanged({ id: 999, state: { current: 'complete' } });
    assert.equal(f.state.alphaCertificates.items[0].status, 'interrupted');
    assert.equal((await f.manager.ensure({ ...input(), retry: true })).status, 'downloading');
    assert.equal(f.calls.downloads.length, 2);
  }
});

test('missing saved files require explicit retry while active downloads remain deduplicated', async () => {
  const f = fixture();
  await f.manager.ensure(input());
  assert.equal((await f.manager.ensure({ ...input(), retry: true })).status, 'downloading');
  assert.equal(f.calls.downloads.length, 1);
  Object.assign(f.history.get(1), { state: 'complete', exists: false });
  await f.manager.onChanged({ id: 1, exists: { current: false } });
  assert.equal((await f.manager.ensure(input())).status, 'missing');
  assert.equal(f.calls.downloads.length, 1);
  assert.equal((await f.manager.ensure({ ...input(), retry: true })).status, 'downloading');
  assert.equal(f.calls.downloads.length, 2);
});

test('provider and browser failures are records, while invalid completion/course identifiers reject', async () => {
  const providerFailure = fixture({ fetchPdf: async () => { throw new Error('원본 수료증 발급 실패'); } });
  assert.equal((await providerFailure.manager.ensure(input())).status, 'failed');
  assert.equal(providerFailure.calls.downloads.length, 0);
  const browserFailure = fixture({ download: async () => { throw new Error('Chrome download failed'); } });
  assert.equal((await browserFailure.manager.ensure(input())).status, 'failed');
  assert.equal((await browserFailure.manager.ensure(input())).status, 'failed');
  assert.equal(browserFailure.calls.downloads.length, 1);
  for (const invalid of [{ completed: false }, { registrationId: 'bad' }, { loginId: '' },
    { course: { ...course, sequenceId: registrationId } }, { course: { ...course, url: 'https://other.example/' } }]) {
    await assert.rejects(browserFailure.manager.ensure({ ...input(), ...invalid }));
  }
  assert.equal(browserFailure.calls.downloads.length, 1);
});

test('unavailable persistent storage fails without fetching or downloading a certificate', async () => {
  let sideEffects = 0;
  const manager = create({ catalog, runtimeId,
    storage: { get: async () => { throw new Error('storage unavailable'); } },
    api: { session: async () => { sideEffects++; } },
    provider: { fetchPdf: async () => { sideEffects++; } },
    downloads: { download: async () => { sideEffects++; } },
  });
  assert.equal((await manager.ensure(input())).status, 'failed');
  assert.equal(sideEffects, 0);
});

test('all-certificates saves historical courses outside the workbook using canonical identifiers', async () => {
  const f = fixture();
  const historical = { id: 'cccccccc-1234-1234-1234-123456789012',
    sequenceId: 'dddddddd-1234-1234-1234-123456789012', title: '  이전 교육 / 수료증  ',
    type: 1, url: 'https://untrusted.example/ignored' };
  assert.equal(catalog.courses.some(item => item.id === historical.id), false);
  const result = await f.manager.ensureListed({ course: historical, registrationId, loginId });
  assert.equal(result.status, 'downloading');
  assert.deepEqual(f.calls.fetch[0].course, { ...historical, title: historical.title.trim(), type: '1',
    url: `${catalog.BASE_URL}/explore/${historical.id}?sequenceId=${historical.sequenceId}&tab=ALL` });
  assert.equal(f.calls.fetch[0].loginId, loginId);
  assert.equal(f.calls.sessions, 2);
  assert.equal(result.courseId, historical.id);
  assert.match(f.calls.downloads[0].filename, /^알파 수료증\/이전 교육 수료증_/);
  assert.equal((await f.manager.ensureListed({ course: historical, registrationId, loginId })).status, 'downloading');
  assert.equal(f.calls.downloads.length, 1);
});

test('selected and all-certificates paths share the same download history', async () => {
  const f = fixture();
  await f.manager.ensure(input());
  f.history.get(1).state = 'complete';
  const saved = await f.manager.ensureListed({ course: { ...course, type: 4 }, registrationId, loginId });
  assert.equal(saved.status, 'complete');
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.downloads.length, 1);
});

test('all-certificates rejects invalid listed metadata and preserves session checks', async () => {
  const f = fixture();
  const valid = { course: { ...course, type: 4 }, registrationId, loginId };
  for (const change of [{ id: 'bad' }, { sequenceId: 'bad' }, { type: 6 }, { type: '4x' },
    { type: undefined }, { title: ' ' }, { title: 'x'.repeat(1001) }]) {
    await assert.rejects(f.manager.ensureListed({ ...valid, course: { ...valid.course, ...change } }));
  }
  await assert.rejects(f.manager.ensureListed({ ...valid, registrationId: 'bad' }));
  await assert.rejects(f.manager.ensureListed({ ...valid, loginId: '' }));
  assert.equal(f.calls.fetch.length, 0);
  const changed = fixture({ session: () => ({ authenticated: true, loginId: 'different-account' }) });
  assert.equal((await changed.manager.ensureListed(valid)).status, 'failed');
  assert.equal(changed.calls.fetch.length, 0);
  assert.equal(changed.calls.downloads.length, 0);
});
