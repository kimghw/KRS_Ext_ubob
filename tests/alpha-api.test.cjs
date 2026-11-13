const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, classifySequence, koreaTimestamp } = require('../src/alpha-api.js');
const course = { id: 'b01f4226-8e02-45e4-b18e-705431e24628', sequenceId: '355065ce-0cd9-4bd7-964d-65d2eb18e0cf' };
const sample = () => ({
  id: course.sequenceId, name: '연구협약 및 연구개발비 관리', cost: 0,
  subject: { id: course.id, type: '4', selectionLesson: false },
  buttonStatus: { status: 'REGISTRABLE' }, myRegistration: null,
  applicationStartDateTime: '2026-08-01T00:00', applicationEndDateTime: '2026-12-31T23:59',
  always: false, autoApproval: true, selectionLesson: false, selectionModuleCount: 0,
  minimalSelectionModuleCount: 0, useTextbook: false, textbookCost: 0,
  modules: [{ id: '4a400d4f-4003-47de-abf9-37969ccb8c11', cost: 0,
    lessons: [{ id: '3a049976-7733-4656-a347-c52bf685cebb', mandatory: false }] }]
});
const now = Date.parse('2026-11-13T10:00:00+09:00');
const response = data => ({ ok: true, status: 200, json: async () => data });

test('only the exact available, free online sequence is eligible', () => {
  assert.equal(classifySequence(sample(), course, now).canEnroll, true);
  assert.equal(classifySequence({ ...sample(), id: course.id }, course, now).canEnroll, false);
  assert.equal(classifySequence(null, course, now).status, 'unavailable');
  for (const change of [{ cost: 1 }, { cost: null }, { useTextbook: true }, { textbookCost: 5 },
    { selectionLesson: true }, { selectionModuleCount: 1 }, { modules: [] },
    { subject: { id: course.id, type: '1', selectionLesson: false } },
    { buttonStatus: { status: 'WAITING' } }, { buttonStatus: { status: 'REREGISTRATION' } },
    { buttonStatus: { status: 'SEQUENCE_PREPARING' } }, { buttonStatus: { status: 'UNKNOWN' } }]) {
    assert.equal(classifySequence({ ...sample(), ...change }, course, now).canEnroll, false, JSON.stringify(change));
  }
});
test('duplicate and completion status prevent another application', () => {
  assert.equal(classifySequence({ ...sample(), myRegistration: { id: course.id, status: 'APPROVED' } }, course, now).status, 'enrolled');
  assert.equal(classifySequence({ ...sample(), buttonStatus: { status: 'ALREADY_COMPLETED' } }, course, now).status, 'completed');
  assert.equal(classifySequence({ ...sample(), myRegistration: { id: course.id, status: 'COMPLETED' } }, course, now).status, 'completed');
  for (const status of ['CANCELLED', 'REJECTED']) {
    assert.equal(classifySequence({ ...sample(), myRegistration: { id: course.id, status } }, course, now).canEnroll, true);
  }
  for (const status of ['NOT_COMPLETED', 'WAITING_PAYMENT', 'WAITING_REFUND_ACCOUNT', 'CANCEL_REQUESTED', 'UNKNOWN']) {
    assert.equal(classifySequence({ ...sample(), myRegistration: { id: course.id, status } }, course, now).status, 'manual');
  }
  assert.equal(classifySequence({ ...sample(), buttonStatus: { status: 'NEED_COMPLETE' } }, course, now).status, 'unavailable');
  // 실제 알파 응답(2026-11-13): 첫 강의를 마친 수강 중 과정은 미수료 + "기존 차수 수료 필요"로 내려온다.
  const studying = classifySequence({ ...sample(), buttonStatus: { status: 'NEED_COMPLETE' },
    myRegistration: { id: course.id, status: 'NOT_COMPLETED' } }, course, now);
  assert.equal(studying.status, 'enrolled'); assert.equal(studying.canEnroll, false);
});
test('Korean application window does not depend on the host timezone', () => {
  assert.equal(koreaTimestamp('2026-11-13T00:00'), Date.parse('2026-11-12T15:00Z'));
  assert.equal(classifySequence(sample(), course, Date.parse('2026-07-31T14:59:59Z')).canEnroll, false);
  assert.equal(classifySequence(sample(), course, Date.parse('2026-12-31T15:00:00Z')).canEnroll, false);
  assert.equal(classifySequence({ ...sample(), applicationEndDateTime: null }, course, now).canEnroll, false);
});
test('malformed or duplicate lesson ids never reach enrollment', () => {
  const s = sample(); s.modules[0].lessons.push(s.modules[0].lessons[0]);
  assert.equal(classifySequence(s, course, now).canEnroll, false);
  s.modules[0].lessons = [{ id: 'unexpected' }];
  assert.equal(classifySequence(s, course, now).canEnroll, false);
});
test('session only exposes login status and login id', async () => {
  const client = createClient({ fetchImpl: async () => response({ authenticated: true, active: true, loginId: 'tester', email: 'private@example.com', phone: 'private' }) });
  assert.deepEqual(await client.session(), { authenticated: true, loginId: 'tester' });
  const inactive = createClient({ fetchImpl: async () => response({ authenticated: true, active: false, loginId: 'tester' }) });
  assert.deepEqual(await inactive.session(), { authenticated: false });
});
test('inspect selects the workbook sequence, not the first archived sequence', async () => {
  const s = sample(); s.always = true;
  const client = createClient({ fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://alpha-campus.kr/api/graphql');
    assert.equal(opts.credentials, 'include'); assert.equal(opts.cache, 'no-store');
    assert.equal(JSON.parse(opts.body).variables.request.subjectId, course.id);
    return response({ data: { sequences: [{ ...s, id: course.id }, s] } });
  } });
  assert.equal((await client.inspect(course)).canEnroll, true);
});
test('enroll sends observed schema once with csrf header', async () => {
  const calls = []; const s = sample(); s.always = true;
  const client = createClient({ getCsrfToken: async () => 'test%2Dcsrf', fetchImpl: async (url, opts) => {
    calls.push(opts); return response({ data: { registration: { id: course.id, status: 'APPROVED' } } });
  } });
  const data = await client.enroll(course, classifySequence(s, course));
  assert.equal(data.registration.status, 'APPROVED'); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-XSRF-TOKEN'], 'test-csrf');
  assert.deepEqual(JSON.parse(calls[0].body).variables.request, { sequenceId: course.sequenceId, staying: false,
    selectedModuleIds: [], selectedLessonIds: ['3a049976-7733-4656-a347-c52bf685cebb'] });
});
test('missing csrf and stale inspections prevent all mutation calls', async () => {
  let calls = 0; const s = sample(); s.always = true;
  const client = createClient({ fetchImpl: async () => { calls++; return response({}); } });
  await assert.rejects(client.enroll(course, classifySequence(s, course)), { code: 'CSRF' });
  await assert.rejects(client.enroll(course, { ...classifySequence(s, course), checkedAt: Date.now() - 61000 }), { code: 'STALE' });
  assert.equal(calls, 0);
});
test('mutation network failure is never automatically retried', async () => {
  let calls = 0; const s = sample(); s.always = true;
  const client = createClient({ getCsrfToken: async () => 'test-csrf', fetchImpl: async () => { calls++; throw new Error('network token=secret'); } });
  await assert.rejects(client.enroll(course, classifySequence(s, course)), { code: 'NETWORK' });
  assert.equal(calls, 1);
});
test('HTTP, GraphQL, and malformed responses fail visibly', async () => {
  const cases = [
    [{ ok: false, status: 403 }, 'AUTH'],
    [{ ok: false, status: 500 }, 'HTTP'],
    [response({ errors: [{ message: '신청 실패 token=secret' }] }), 'API'],
    [response({ data: { sequences: null } }), 'RESPONSE']
  ];
  for (const [reply, code] of cases) {
    const client = createClient({ fetchImpl: async () => reply });
    await assert.rejects(client.inspect(course), error => error.code === code && !error.message.includes('secret'));
  }
});
