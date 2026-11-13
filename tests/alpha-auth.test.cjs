const test = require('node:test');
const assert = require('node:assert/strict');
const { create, loginForm } = require('../src/alpha-auth.js');
const form = `<form id="kc-form-login" method="post" action="https://alpha-campus.kr/auth/realms/kird/login-actions/authenticate?session_code=test&amp;execution=test&amp;client_id=kird-gateway&amp;tab_id=test">
  <input type="hidden" name="credentialId" value=""><input name="username"><input name="password" type="password"></form>`;
function fixture({ account = { userName: 'tester', password: 'test-only-password' }, sessions, replies } = {}) {
  const state = { alphaAccount: account };
  const calls = [], cookieWrites = [];
  let sessionIndex = 0, responseIndex = 0;
  const storage = {
    async get(keys) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.map(key => [key, structuredClone(state[key])])); },
    async set(update) { Object.assign(state, structuredClone(update)); }
  };
  const api = { async session() { const sequence = sessions || [{ authenticated: false }]; return sequence[Math.min(sessionIndex++, sequence.length - 1)]; } };
  const cookies = { async get({ name }) { return name === 'XSRF-TOKEN' ? { value: 'test%2Dcsrf' } : null; }, async set(cookie) { cookieWrites.push(cookie); } };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const sequence = replies || [{ ok: true, text: async () => form }];
    const value = sequence[Math.min(responseIndex++, sequence.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  return { auth: create({ api, storage, cookies, fetchImpl }), state, calls, cookieWrites, storage };
}
const logged = { authenticated: true, loginId: 'tester' };
const anonymous = { authenticated: false };
const page = { ok: true, status: 200, url: 'https://alpha-campus.kr/auth/realms/kird/protocol/openid-connect/auth', text: async () => form };
const passed = { ok: true, status: 200, json: async () => ({ type: 'pass' }) };
const redirected = { ok: false, status: 0, type: 'opaqueredirect' };

test('existing same-account session avoids password requests', async () => {
  const f = fixture({ sessions: [logged] });
  assert.deepEqual(await f.auth.ensureLoggedIn(), logged);
  assert.equal(f.calls.length, 0); assert.equal(f.state.alphaAuth.ok, true);
});
test('browser-only login is accepted when no account is stored', async () => {
  const f = fixture({ account: null, sessions: [logged] });
  assert.deepEqual(await f.auth.ensureLoggedIn(), logged); assert.equal(f.calls.length, 0);
});
test('precheck and same-origin form POST complete the verified login flow', async () => {
  const f = fixture({ sessions: [anonymous, anonymous, logged], replies: [page, passed, redirected, page] });
  assert.deepEqual(await f.auth.ensureLoggedIn(), logged);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[1].url, 'https://alpha-campus.kr/api/memberLogin/check');
  assert.equal(f.calls[1].opts.redirect, 'manual'); assert.equal(f.calls[2].opts.redirect, 'manual');
  assert.equal(f.calls[1].opts.headers['X-XSRF-TOKEN'], 'test-csrf');
  assert.equal(JSON.parse(f.calls[1].opts.body).loginId, 'tester');
  const submitted = new URLSearchParams(f.calls[2].opts.body);
  assert.deepEqual([...submitted.keys()].sort(), ['credentialId', 'password', 'username']);
  assert.equal(f.cookieWrites[0].domain, '.alpha-campus.kr');
  assert.equal(f.cookieWrites[0].name, 'browser_uuid_v2');
  assert.equal(f.cookieWrites[0].secure, true); assert.equal(f.state.alphaAuth.rejected, false);
  assert.equal(JSON.stringify(f.state.alphaAuth).includes('test-only-password'), false);
});
test('untrusted form actions never receive credentials', async () => {
  for (const html of [form.replace('https://alpha-campus.kr/auth', 'https://other.example/auth'), form.replace('login-actions/authenticate', 'other'), form.replace('kird-gateway', 'other')]) {
    assert.throws(() => loginForm(html), { code: 'UNTRUSTED' });
    const f = fixture({ replies: [{ ...page, text: async () => html }] });
    await assert.rejects(f.auth.ensureLoggedIn(), { code: 'UNTRUSTED' });
    assert.equal(f.calls.some(call => call.opts.method === 'POST'), false);
  }
});
test('manual challenge and failed password are not automatically retried', async () => {
  for (const type of ['IdAndPassword', 'passwordErrorCount', 'cert', 'duplicateLogin', 'eamilRequiredYn', 'unknown']) {
    const f = fixture({ replies: [page, { ok: true, json: async () => ({ type, message: 'server echoed test-only-password' }) }] });
    await assert.rejects(f.auth.ensureLoggedIn(), { code: 'LOGIN_CHALLENGE' });
    const firstCalls = f.calls.length;
    await assert.rejects(f.auth.ensureLoggedIn(), { code: 'LOGIN_CHALLENGE' });
    assert.equal(f.calls.length, firstCalls);
    assert.equal(f.state.alphaAuth.rejected, true);
    assert.equal(JSON.stringify(f.state.alphaAuth).includes('test-only-password'), false);
  }
});
test('explicit login test can retry a rejected account', async () => {
  const f = fixture({ replies: [page, { ok: true, json: async () => ({ type: 'IdAndPassword' }) }, page, passed, redirected, page],
    sessions: [anonymous, anonymous, anonymous, anonymous, logged] });
  await assert.rejects(f.auth.ensureLoggedIn());
  assert.deepEqual(await f.auth.testAccount(), logged);
  assert.equal(f.state.alphaAuth.ok, true);
});
test('account mismatch does not log out or send another password', async () => {
  const f = fixture({ sessions: [{ authenticated: true, loginId: 'someone-else' }] });
  await assert.rejects(f.auth.ensureLoggedIn(), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.calls.length, 0);
});
test('foreign redirect after form submission stops without forwarding credentials', async () => {
  const f = fixture({ replies: [page, passed, { ok: false, status: 307, headers: { get: () => 'https://other.example/receive' } }] });
  await assert.rejects(f.auth.ensureLoggedIn(), { code: 'UNTRUSTED' });
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].opts.redirect, 'manual');
});
test('changed saved account clears previous rejection without storing secrets in auth state', async () => {
  const f = fixture({ sessions: [logged] });
  f.state.alphaAuth = { ok: false, user: 'old', rejected: true };
  await f.auth.saveAccount({ userName: ' tester ', password: 'new-test-password' });
  assert.equal(f.state.alphaAccount.userName, 'tester'); assert.equal(f.state.alphaAuth.rejected, false);
  assert.equal('password' in f.state.alphaAuth, false);
});
test('additional OTP input blocks automatic login', () => {
  assert.throws(() => loginForm(form.replace('</form>', '<input name="otp"></form>')), { code: 'MANUAL' });
});
test('uncertain credential request failures are not automatically replayed', async () => {
  const f = fixture({ replies: [page, new Error('network response lost')] });
  await assert.rejects(f.auth.ensureLoggedIn(), { code: 'NETWORK' });
  const firstCalls = f.calls.length;
  await assert.rejects(f.auth.ensureLoggedIn(), { code: 'NETWORK' });
  assert.equal(f.calls.length, firstCalls); assert.equal(f.state.alphaAuth.rejected, true);
});
