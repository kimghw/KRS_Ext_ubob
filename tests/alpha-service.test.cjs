const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/alpha-catalog.js');
const { create } = require('../src/alpha-service.js');

const role = 'researcher';
const courseIds = catalog.defaultsForRole(role);
const selection = { role, courseIds };
const signedIn = { authenticated: true, loginId: 'researcher-a' };
const available = () => ({ status: 'available', canEnroll: true, message: '신청 가능' });
const enrolled = () => ({ status: 'enrolled', canEnroll: false, message: '신청 완료' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ initialState, overrides = {} } = {}) {
  const db = { alphaState: initialState };
  const saves = [];
  const calls = { inspect: [], enroll: [], session: 0 };
  const registered = new Set();
  const storage = {
    async get() { return structuredClone(db); },
    async set(value) {
      Object.assign(db, structuredClone(value));
      saves.push(structuredClone(value.alphaState));
    },
  };
  const api = {
    async session() {
      calls.session++;
      return overrides.session ? overrides.session(calls.session) : signedIn;
    },
    async inspect(course) {
      calls.inspect.push(course.id);
      return overrides.inspect ? overrides.inspect(course, calls.inspect.length)
        : registered.has(course.id) ? enrolled() : available();
    },
    async enroll(course, inspection) {
      calls.enroll.push(course.id);
      if (overrides.enroll) return overrides.enroll(course, inspection, registered);
      registered.add(course.id);
    },
  };
  const service = create({ catalog, api, storage, tabs: {} });
  return { service, calls, db, saves, registered };
}

test('checking the valid five-course plan never submits an enrollment', async () => {
  const h = harness();
  const result = await h.service.check(selection);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.inspect, courseIds);
  assert.deepEqual(h.calls.enroll, []);
  assert.equal(h.db.alphaState.busy, false);
  assert.equal(h.db.alphaState.operation, 'check');
  assert.equal(h.db.alphaState.items.filter(item => item.canEnroll).length, 5);
});

test('wrong-role and incomplete plans fail before any API request', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({ role: 'principal', courseIds }), /역할/);
  await assert.rejects(h.service.enroll({ role, courseIds: courseIds.slice(0, 4) }), /분야별/);
  assert.equal(h.calls.session, 0);
  assert.deepEqual(h.calls.inspect, []);
  assert.deepEqual(h.calls.enroll, []);
});

test('enrollment submits only currently eligible courses and verifies the result', async () => {
  const registered = new Set();
  const h = harness({ overrides: {
    inspect: async course => {
      if (registered.has(course.id)) return enrolled();
      if (course.id === courseIds[1]) return enrolled();
      if (course.id === courseIds[2]) return { status: 'completed', canEnroll: false };
      if (course.id === courseIds[3]) return { status: 'closed', canEnroll: false };
      return available();
    },
    enroll: async course => { registered.add(course.id); },
  } });
  const result = await h.service.enroll(selection);
  assert.equal(result.ok, false); // The closed course still needs attention.
  assert.deepEqual(h.calls.enroll, [courseIds[0], courseIds[4]]);
  assert.equal(h.db.alphaState.items[0].status, 'enrolled');
  assert.equal(h.db.alphaState.items[4].status, 'enrolled');
  assert.equal(h.db.alphaState.items[3].status, 'closed');
});

test('a second click cannot overlap an ongoing enrollment', async () => {
  const entered = deferred();
  const release = deferred();
  const h = harness({ overrides: {
    enroll: async (course, inspection, registered) => {
      if (course.id === courseIds[0]) { entered.resolve(); await release.promise; }
      registered.add(course.id);
    },
  } });
  const first = h.service.enroll(selection);
  await entered.promise;
  await assert.rejects(h.service.enroll(selection), /진행 중/);
  await assert.rejects(h.service.check(selection), /진행 중/);
  assert.equal(h.calls.enroll.length, 1);
  release.resolve();
  assert.equal((await first).ok, true);
  assert.deepEqual(h.calls.enroll, courseIds);
});

test('an account change before submission stops all enrollment', async () => {
  const h = harness({ overrides: {
    session: async count => count === 1 ? signedIn : { authenticated: true, loginId: 'researcher-b' },
  } });
  const result = await h.service.enroll(selection);
  assert.equal(result.ok, false);
  assert.deepEqual(h.calls.enroll, []);
  assert.equal(h.db.alphaState.items[0].status, 'login-required');
  assert.ok(h.db.alphaState.items.every(item => !item.canEnroll));
});

test('checking stops on an account change and invalidates earlier available results', async () => {
  let changed = false;
  const h = harness({ overrides: {
    inspect: async course => {
      if (course.id === courseIds[1]) changed = true;
      return available();
    },
    session: async () => changed ? { authenticated: true, loginId: 'researcher-b' } : signedIn,
  } });
  const result = await h.service.check(selection);
  assert.equal(result.ok, false);
  assert.deepEqual(h.calls.inspect, courseIds.slice(0, 2));
  assert.deepEqual(h.calls.enroll, []);
  assert.ok(h.db.alphaState.items.every(item => !item.canEnroll));
  assert.match(h.db.alphaState.message, /로그인 상태가 변경/);
});

test('a contradictory enrollment flag cannot submit or count as available', async () => {
  const h = harness({ overrides: {
    inspect: async () => ({ status: 'enrolled', canEnroll: true }),
  } });
  const result = await h.service.enroll(selection);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.enroll, []);
  assert.ok(h.db.alphaState.items.every(item => !item.canEnroll));
  assert.equal(h.db.alphaState.message, '신청·수료 확인 5개');
});

test('a lost mutation response is verified and never automatically resubmitted', async () => {
  const h = harness({ overrides: {
    enroll: async (course, inspection, registered) => {
      registered.add(course.id);
      throw new Error('connection lost');
    },
  } });
  const result = await h.service.enroll(selection);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.enroll, courseIds);
  assert.ok(h.db.alphaState.items.every(item => item.status === 'enrolled'));
  await h.service.enroll(selection);
  assert.deepEqual(h.calls.enroll, courseIds); // Fresh inspection finds the existing enrollments.
});

test('an uncertain mutation result stops later submissions and clears busy', async () => {
  const h = harness({ overrides: { enroll: async () => { throw new Error('connection lost'); } } });
  const result = await h.service.enroll(selection);
  assert.equal(result.ok, false);
  assert.deepEqual(h.calls.enroll, [courseIds[0]]);
  assert.equal(h.db.alphaState.items[0].status, 'unconfirmed');
  assert.ok(h.db.alphaState.items.slice(1).every(item => item.status === 'unknown' && !item.canEnroll));
  assert.equal(h.db.alphaState.busy, false);
});

test('account changes during mutation cannot be reported as enrollment success', async () => {
  let changed = false;
  const h = harness({ overrides: {
    session: async () => changed ? { authenticated: true, loginId: 'researcher-b' } : signedIn,
    enroll: async (course, inspection, registered) => { registered.add(course.id); changed = true; },
  } });
  const result = await h.service.enroll(selection);
  assert.equal(result.ok, false);
  assert.equal(h.db.alphaState.items[0].status, 'unconfirmed');
  assert.deepEqual(h.calls.enroll, [courseIds[0]]);
});

test('account changes during verification cannot confirm another account enrollment', async () => {
  let changed = false;
  let submitted = false;
  const h = harness({ overrides: {
    session: async () => changed ? { authenticated: true, loginId: 'researcher-b' } : signedIn,
    inspect: async () => {
      if (submitted) { changed = true; return enrolled(); }
      return available();
    },
    enroll: async () => { submitted = true; },
  } });
  assert.equal((await h.service.enroll(selection)).ok, false);
  assert.equal(h.db.alphaState.items[0].status, 'unconfirmed');
  assert.deepEqual(h.calls.enroll, [courseIds[0]]);
});

test('worker restart recovers stale busy state without replaying a mutation', async () => {
  const h = harness({ initialState: {
    busy: true, operation: 'enroll', role, courseIds,
    items: [
      { courseId: courseIds[0], status: 'submitting', canEnroll: false },
      { courseId: courseIds[1], status: 'checking', canEnroll: true },
      { courseId: courseIds[2], status: 'enrolled', canEnroll: false },
    ],
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.db.alphaState.busy, false);
  assert.deepEqual(h.db.alphaState.items.map(item => item.status), ['unconfirmed', 'unconfirmed', 'enrolled']);
  assert.ok(h.db.alphaState.items.every(item => !item.canEnroll));
  assert.equal(h.calls.session, 0);
  assert.deepEqual(h.calls.inspect, []);
  assert.deepEqual(h.calls.enroll, []);
});

test('unauthenticated sessions neither inspect nor submit', async () => {
  const h = harness({ overrides: { session: async () => ({ authenticated: false }) } });
  assert.equal((await h.service.enroll(selection)).ok, false);
  assert.deepEqual(h.calls.inspect, []);
  assert.deepEqual(h.calls.enroll, []);
  assert.ok(h.db.alphaState.items.every(item => item.status === 'login-required'));
});

test('stop before submission leaves all enrollment requests unsent', async () => {
  const h = harness();
  const result = await h.service.enroll(selection, { shouldStop: () => true });
  assert.equal(result.cancelled, true);
  assert.equal(h.calls.session, 0);
  assert.equal(h.calls.enroll.length, 0);
  assert.equal(h.db.alphaState.busy, false);
  assert.equal(h.db.alphaState.items.some(item => item.canEnroll), false);
});

test('stop during a sent request verifies it and prevents later enrollment', async () => {
  const entered = deferred();
  const release = deferred();
  let stopped = false;
  const h = harness({ overrides: {
    enroll: async (course, inspection, registered) => {
      entered.resolve();
      await release.promise;
      registered.add(course.id);
    },
  } });
  const task = h.service.enroll(selection, { shouldStop: () => stopped });
  await entered.promise;
  stopped = true;
  release.resolve();
  const result = await task;
  assert.equal(result.cancelled, true);
  assert.deepEqual(h.calls.enroll, [courseIds[0]]);
  assert.equal(h.db.alphaState.items[0].status, 'enrolled');
  assert.equal(h.db.alphaState.busy, false);
});

// ---------- 과정 열기: 신청한 과정은 내 강의실, 아니면 교육탐색의 과정 소개 ----------
function openHarness({ classroom, open = [] } = {}) {
  const calls = { created: [], activated: [], focused: [], classroom: [] };
  const tabs = {
    async query() { return open.map((url, index) => ({ id: index + 1, windowId: 7, url })); },
    async create(options) { calls.created.push(options.url); },
    async update(id, options) { calls.activated.push([id, options]); },
  };
  const windows = { async update(id, options) { calls.focused.push([id, options]); } };
  const service = create({ catalog, api: {}, storage: { async get() { return {}; }, async set() {} }, tabs, windows,
    classroom: classroom && (async course => { calls.classroom.push(course.id); return classroom(course); }) });
  return { service, calls };
}
const openCourse = catalog.courses[1];
const room = 'https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=12345678-1234-1234-1234-123456789012&type=ONLINE';

test('an enrolled course opens its classroom instead of the explore page', async () => {
  const h = openHarness({ classroom: () => room });
  await h.service.open({ courseId: openCourse.id });
  assert.deepEqual(h.calls.classroom, [openCourse.id]);
  assert.deepEqual(h.calls.created, [room]);
});

test('courses without a classroom, failed lookups and untrusted answers open the explore page', async () => {
  for (const classroom of [() => null, () => { throw new Error('알파 로그인을 다시 확인하세요.'); },
    () => 'https://example.com/my/classRoom/classRoomDetail?registrationId=x', () => `${catalog.BASE_URL}/explore/other`, undefined]) {
    const h = openHarness({ classroom });
    await h.service.open({ courseId: openCourse.id });
    assert.deepEqual(h.calls.created, [openCourse.url]);
  }
});

test('an open classroom tab of the same course is focused whatever lesson it shows', async () => {
  const other = room.replace('123456789012', '999999999999');
  const h = openHarness({ classroom: () => room,
    open: [openCourse.url, other, `${room}&sequenceLessonId=11111111-1111-1111-1111-111111111111`] });
  await h.service.open({ courseId: openCourse.id });
  assert.deepEqual(h.calls.created, []);
  assert.deepEqual(h.calls.activated, [[3, { active: true }]]);
  assert.deepEqual(h.calls.focused, [[7, { focused: true }]]);
});

test('opening without a course never looks up a classroom and unknown courses are refused', async () => {
  const h = openHarness({ classroom: () => room });
  await h.service.open();
  assert.deepEqual(h.calls.classroom, []);
  assert.deepEqual(h.calls.created, [`${catalog.BASE_URL}/login`]);
  await assert.rejects(h.service.open({ courseId: 'unknown' }), /첨부 목록/);
});
