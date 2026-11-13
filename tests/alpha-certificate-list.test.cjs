const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../src/alpha-certificate-list.js');

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const row = (number, changes = {}) => ({ id: uuid(number), sequenceId: uuid(number + 1000),
  subjectId: uuid(number + 2000), subjectName: `수료 과정 ${number}`, subjectType: 4,
  status: 'COMPLETED', requestInfo: { user: { loginId: 'learner' } }, ...changes });
const rows = count => Array.from({ length: count }, (_, index) => row(index + 1));
const response = data => ({ ok: true, url: 'https://alpha-campus.kr/api/graphql',
  json: async () => ({ data: { registrations: data } }) });
const page = (content, totalElements = content.length, number = 0) => ({ number, size: 20,
  totalElements, totalPages: Math.ceil(totalElements / 20), content });
function fixture(overrides = {}) {
  const calls = [], pages = [], sessions = [];
  const client = createClient({
    api: { session: async () => { sessions.push(true); return { authenticated: true, loginId: 'learner' }; } },
    getCsrfToken: async () => 'test%2Dtoken',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(page([])); },
    ...overrides,
  });
  return { client, calls, pages, sessions,
    list: options => client.listCompleted({ loginId: 'learner', onPage: value => pages.push(value), ...options }) };
}

test('reads every page and year/type without enrollment or broad profile fields', async () => {
  const records = rows(23);
  records[0].subjectType = 1; records[1].subjectType = 2;
  records[2].subjectType = 3; records[4].subjectType = 5;
  const requests = [], sessions = [];
  const f = fixture({
    api: { session: async () => { sessions.push(true); return { authenticated: true, loginId: 'learner' }; } },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body), request = body.variables.request;
      requests.push(request);
      assert.equal(url, 'https://alpha-campus.kr/api/graphql');
      assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'include');
      assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-XSRF-TOKEN'], 'test-token');
      assert.ok(body.query.startsWith('query '));
      assert.doesNotMatch(body.query, /mutation|email|phone|birthday|userName/);
      return response(page(records.slice(request.page.number * 20, request.page.number * 20 + 20), 23, request.page.number));
    },
  });
  const result = await f.list();
  assert.equal(result.length, 23); assert.equal(sessions.length, 4);
  assert.deepEqual(result.slice(0, 5).map(item => item.course.type), [1, 2, 3, 4, 5]);
  assert.deepEqual(requests.map(item => item.page.number), [0, 1]);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ['page', 'statuses', 'subjectText']);
    assert.deepEqual(request.statuses, ['COMPLETED']);
    assert.deepEqual(request.page.sort, [{ property: 'requestInfo.dateTime', direction: 'DESC' }]);
  }
  assert.deepEqual(f.pages, [{ scanned: 20, total: 23 }, { scanned: 23, total: 23 }]);
  assert.deepEqual(result[0], { registrationId: uuid(1), course: { id: uuid(2001), sequenceId: uuid(1001),
    title: '수료 과정 1', type: 1,
    url: `https://alpha-campus.kr/explore/${uuid(2001)}?sequenceId=${uuid(1001)}&tab=ALL` } });
});

test('empty account returns an empty complete result', async () => {
  const f = fixture();
  assert.deepEqual(await f.list(), []);
  assert.equal(f.calls.length, 1); assert.equal(f.sessions.length, 2);
  assert.deepEqual(f.pages, [{ scanned: 0, total: 0 }]);
});

test('duplicate registration ids are skipped while uncompleted rows never become certificates', async () => {
  const records = rows(20).concat(row(1), row(30, { status: 'APPROVED' }), row(31));
  const f = fixture({ fetchImpl: async (_url, options) => {
    const number = JSON.parse(options.body).variables.request.page.number;
    return response(page(records.slice(number * 20, number * 20 + 20), records.length, number));
  } });
  const result = await f.list();
  assert.equal(result.length, 21);
  assert.equal(result.filter(item => item.registrationId === uuid(1)).length, 1);
  assert.equal(result.some(item => item.registrationId === uuid(30)), false);
});

test('login loss or account change prevents the first read', async () => {
  for (const session of [{ authenticated: false }, { authenticated: true, loginId: 'different' }]) {
    const f = fixture({ api: { session: async () => session } });
    await assert.rejects(f.list(), { code: 'ALPHA_ACCOUNT_CHANGED' });
    assert.equal(f.calls.length, 0);
  }
});

test('account changes during a page discard its records and progress', async () => {
  let checked = 0;
  const f = fixture({ api: { session: async () => ({ authenticated: true, loginId: ++checked === 1 ? 'learner' : 'different' }) },
    fetchImpl: async () => response(page([row(1)])) });
  await assert.rejects(f.list(), { code: 'ALPHA_ACCOUNT_CHANGED' });
  assert.deepEqual(f.pages, []);
});

test('records must belong to the current account', async () => {
  for (const requestInfo of [null, { user: { loginId: 'different' } }]) {
    const f = fixture({ fetchImpl: async () => response(page([row(1, { requestInfo })])) });
    await assert.rejects(f.list(), { code: 'ALPHA_ACCOUNT_CHANGED' });
  }
});

test('inconsistent page totals and short responses never return a partial success', async () => {
  for (const second of [page([row(21)], 21, 1), page([row(21)], 22, 1),
    { ...page([row(21), row(22)], 22, 1), number: 0 }]) {
    let calls = 0;
    const f = fixture({ fetchImpl: async () => response(++calls === 1 ? page(rows(20), 22, 0) : second) });
    await assert.rejects(f.list(), { code: 'ALPHA_CERTIFICATE_LIST' });
    assert.equal(calls, 2);
  }
});

test('pagination limit is an explicit failure rather than silent truncation', async () => {
  const f = fixture({ fetchImpl: async () => response(page(rows(20), 10001)) });
  await assert.rejects(f.list(), /범위를 넘었습니다/);
  assert.deepEqual(f.pages, []);
});

test('malformed identity and conflicting duplicate records fail safely', async () => {
  for (const changes of [{ id: 'invalid' }, { sequenceId: null }, { subjectId: 'bad' },
    { subjectName: '' }, { subjectType: 0 }, { subjectType: 6 }, { subjectType: true }, { status: null }]) {
    const f = fixture({ fetchImpl: async () => response(page([row(1, changes)])) });
    await assert.rejects(f.list(), { code: 'ALPHA_CERTIFICATE_LIST' });
  }
  const f = fixture({ fetchImpl: async () => response(page([row(1), row(1, { subjectId: uuid(9999) })])) });
  await assert.rejects(f.list(), /조회 중 변경/);
});

test('cancellation during a request returns no records and performs no next request', async () => {
  let stopped = false, count = 0;
  const f = fixture({ fetchImpl: async () => { count++; stopped = true; return response(page(rows(20), 22)); } });
  await assert.rejects(f.list({ shouldStop: () => stopped }), { code: 'ALPHA_CANCELLED' });
  assert.equal(count, 1); assert.deepEqual(f.pages, []);
  const g = fixture();
  await assert.rejects(g.list({ shouldStop: () => true }), { code: 'ALPHA_CANCELLED' });
  assert.equal(g.calls.length, 0); assert.equal(g.sessions.length, 0);
});

test('cancellation after progress stops pagination', async () => {
  let stopped = false, count = 0;
  const f = fixture({ fetchImpl: async () => { count++; return response(page(rows(20), 22)); } });
  await assert.rejects(f.list({ shouldStop: () => stopped, onPage: () => { stopped = true; } }), { code: 'ALPHA_CANCELLED' });
  assert.equal(count, 1);
});

test('network, GraphQL and redirect failures expose no raw credentials or server text', async () => {
  for (const fetchImpl of [async () => { throw new Error('password=secret token=private'); },
    async () => ({ ok: true, json: async () => ({ errors: [{ message: 'password=secret' }] }) }),
    async () => ({ ok: true, redirected: true, json: async () => ({}) }),
    async () => ({ ok: true, url: 'https://example.com/api/graphql', json: async () => ({}) }),
    async () => ({ ok: true, text: async () => '<html>private</html>' })]) {
    const f = fixture({ fetchImpl });
    await assert.rejects(f.list(), error => error.code === 'ALPHA_CERTIFICATE_LIST' && !/secret|private|password/.test(error.message));
  }
});

test('streamed JSON is bounded and valid streamed pages are supported', async () => {
  const json = JSON.stringify({ data: { registrations: page([row(1)]) } });
  const valid = fixture({ fetchImpl: async () => new Response(json, { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal((await valid.list()).length, 1);
  const large = fixture({ fetchImpl: async () => new Response(' '.repeat(256 * 1024 + 1)) });
  await assert.rejects(large.list(), /너무 큽니다/);
});
