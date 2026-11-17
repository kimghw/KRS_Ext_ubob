const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, parseCredits, parseLoginCheck } = require('../src/hrd-credits.js');

// 실제 사이트 응답(2026-11-17)과 같은 꼴
const ROW = { year: '2026', position: 'P2', steps: 2, ccComplPnt: 7.0, ceComplPnt: 6.5, scComplPnt: null,
  ccCredits: 3.0, ceCredits: 5.0, scCredits: null, adjstmntMemo: null, memo: null, etcMemo: null };
const LOGIN_REQUIRED = { redirect: true, jsdirectUrl: null, redirectUrl: '/KRS', fieldErrors: [], responseText: '',
  response: null, loginRequired: true, errorCount: 0 };
const jsonp = (uid, sid) => `cb({\r\n\t"UID": "${uid}",\r\n\t"SID": "${sid}"\r\n})`;
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// 주소별 응답을 순서대로 돌려주는 가짜 fetch. 보낸 요청은 calls 에 남는다.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const next = routes[key].length > 1 ? routes[key].shift() : routes[key][0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

test('학점 줄에서 취득/최소 학점을 읽는다', () => {
  assert.deepEqual(parseCredits([ROW], 2026), { year: '2026', cc: { got: 7, need: 3 }, ce: { got: 6.5, need: 5 }, sc: null });
  // S-C 는 최소 학점이 있을 때만, 비어 있는 값은 0
  assert.deepEqual(parseCredits([{ ...ROW, ccComplPnt: null, ccCredits: null, scComplPnt: null, scCredits: 2 }], '2026'),
    { year: '2026', cc: { got: 0, need: 0 }, ce: { got: 6.5, need: 5 }, sc: { got: 0, need: 2 } });
  // 여러 해가 오면 그 해의 줄만
  assert.equal(parseCredits([{ ...ROW, year: '2025', ccComplPnt: 1 }, ROW], 2026).cc.got, 7);
  assert.equal(parseCredits([{ ...ROW, year: '2025' }], 2026), null);
  assert.equal(parseCredits([], 2026), null);
  assert.equal(parseCredits(LOGIN_REQUIRED, 2026), null);
});

test('e-Class 로그인 확인(JSONP)을 읽는다', () => {
  assert.deepEqual(parseLoginCheck(jsonp('abc%2bdef%3d%3d', 'sid-1')), { uid: 'abc%2bdef%3d%3d', sid: 'sid-1' });
  assert.deepEqual(parseLoginCheck(jsonp('', '')), { uid: '', sid: '' });
  assert.deepEqual(parseLoginCheck('cb({"UID":"a","SID":"b"});\n'), { uid: 'a', sid: 'b' });
  for (const bad of ['', '<html>로그인</html>', 'cb(', 'cb({"UID":1,"SID":"b"})', 'cb(null)']) assert.equal(parseLoginCheck(bad), null, bad);
});

test('로그인돼 있으면 요청 한 번으로 학점을 읽는다', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'CreditsUsrList.do': [reply([ROW])] });
  const credits = await createClient({ fetchImpl }).credits(2026);
  assert.deepEqual(credits, { year: '2026', cc: { got: 7, need: 3 }, ce: { got: 6.5, need: 5 }, sc: null });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://hrd.krs.co.kr/KRS/usr/info/credits/CreditsUsrList.do');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  assert.equal(init.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.deepEqual(JSON.parse(init.body), { searchBgnYear: '2026', searchEndYear: '2026', pageSize: 25, sortInfo: [] });
});

test('로그인이 끊겨 있으면 통합 로그인 뒤 다시 읽는다', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'CreditsUsrList.do': [reply(LOGIN_REQUIRED), reply([ROW])],
    'loginCheck_json.aspx': [reply(jsonp('uid%3d', 'sid-1'))],
    'AutoLoginConfirm.do': [reply({ errorCount: 0 })]
  });
  const credits = await createClient({ fetchImpl }).credits(2026);
  assert.equal(credits.cc.got, 7);
  assert.deepEqual(calls.map((c) => c.url.replace(/[?].*/, '').split('/').pop()),
    ['CreditsUsrList.do', 'loginCheck_json.aspx', 'AutoLoginConfirm.do', 'CreditsUsrList.do']);
  assert.match(calls[1].url, /^https:\/\/eclass\.krs\.co\.kr\/.*[?]callback=cb&_=\d+$/);
  assert.equal(calls[1].init.method, 'GET');
  // 받은 값을 바꾸지 않고 그대로 넘긴다
  assert.deepEqual(JSON.parse(calls[2].init.body), { uid: 'uid%3d', sid: 'sid-1' });
});

test('e-Class 로그인이 없으면 e-Hrd 로그인을 시도하지 않는다', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'CreditsUsrList.do': [reply(LOGIN_REQUIRED)],
    'loginCheck_json.aspx': [reply(jsonp('', ''))]
  });
  await assert.rejects(createClient({ fetchImpl }).credits(2026), (e) => e.code === 'ECLASS' && /e-Class 로그인/.test(e.message));
  assert.equal(calls.some((c) => c.url.includes('AutoLoginConfirm')), false);
});

test('실패는 종류를 구분해 알리고 통합 로그인 값은 문구에 넣지 않는다', async () => {
  const run = (routes) => createClient({ fetchImpl: fakeFetch(routes).fetchImpl }).credits(2026);
  const login = { 'loginCheck_json.aspx': [reply(jsonp('SECRET-UID', 'SECRET-SID'))] };
  const cases = [
    [{ 'CreditsUsrList.do': [reply(LOGIN_REQUIRED)], ...login, 'AutoLoginConfirm.do': [reply({ errorCount: 1 })] }, 'LOGIN'],
    [{ 'CreditsUsrList.do': [reply(LOGIN_REQUIRED)], ...login, 'AutoLoginConfirm.do': [reply('<html></html>')] }, 'LOGIN'],
    // 로그인 응답은 성공인데 여전히 로그인이 필요하다고 하면 되풀이하지 않는다
    [{ 'CreditsUsrList.do': [reply(LOGIN_REQUIRED)], ...login, 'AutoLoginConfirm.do': [reply({ errorCount: 0 })] }, 'LOGIN'],
    [{ 'CreditsUsrList.do': [reply(LOGIN_REQUIRED)], 'loginCheck_json.aspx': [reply('<html>점검 중</html>')] }, 'RESPONSE'],
    [{ 'CreditsUsrList.do': [reply({ message: '?' })] }, 'RESPONSE'],
    [{ 'CreditsUsrList.do': [reply([{ ...ROW, year: '2025' }])] }, 'EMPTY'],
    [{ 'CreditsUsrList.do': [reply('', 500)] }, 'HTTP'],
    [{ 'CreditsUsrList.do': [new TypeError('Failed to fetch')] }, 'NETWORK'],
    [{ 'CreditsUsrList.do': [Object.assign(new Error('aborted'), { name: 'AbortError' })] }, 'TIMEOUT']
  ];
  for (const [routes, code] of cases) {
    await assert.rejects(run(routes), (e) => {
      assert.equal(e.code, code);
      assert.doesNotMatch(e.message, /SECRET/);
      assert.ok(e.message.length < 25, e.message);   // 사이드 패널에 그대로 보이는 문구
      return true;
    });
  }
});

test('화면을 열기 전 확인: 로그인돼 있으면 그대로, 끊겨 있으면 통합 로그인', async () => {
  const on = fakeFetch({ 'CreditsUsrList.do': [reply([ROW])] });
  await createClient({ fetchImpl: on.fetchImpl }).ensureLoggedIn(2026);
  assert.equal(on.calls.length, 1);

  // 화면으로 넘겨져 JSON 이 아닌 응답이 와도 로그인이 필요한 것으로 본다
  const off = fakeFetch({
    'CreditsUsrList.do': [reply("<script>window.location.href = '/KRS/usr/cmn/login/AutoLogin.do';</script>")],
    'loginCheck_json.aspx': [reply(jsonp('u', 's'))],
    'AutoLoginConfirm.do': [reply({ errorCount: 0 })]
  });
  await createClient({ fetchImpl: off.fetchImpl }).ensureLoggedIn(2026);
  assert.equal(off.calls.length, 3);
});
