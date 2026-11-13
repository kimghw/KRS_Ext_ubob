// Mirror ALPHA's password-login form without retaining authentication responses.
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const AUTH_PATH = '/auth/realms/kird/login-actions/authenticate';
  const CHALLENGES = {
    cert: '알파에서 본인인증을 완료한 뒤 다시 시도해 주세요.',
    eamilRequiredYn: '알파 내정보에서 소속기관 이메일 인증을 완료해 주세요.',
    dormant: '알파에서 휴면 계정을 해제한 뒤 다시 시도해 주세요.',
    IdAndPassword: '알파 아이디 또는 비밀번호를 확인해 주세요.',
    passwordErrorCount: '로그인 실패 횟수로 제한된 계정입니다. 알파에서 계정을 확인해 주세요.',
    noValue: '알파 아이디와 비밀번호를 모두 입력해 주세요.',
    passwordExpired: '알파에서 비밀번호 변경 안내를 확인한 뒤 다시 시도해 주세요.',
    duplicateLogin: '다른 브라우저에서 접속 중입니다. 알파에서 중복 로그인 안내를 확인해 주세요.',
    loginDifferentEnv: '다른 환경에서 접속 중입니다. 알파에서 로그인 상태를 확인해 주세요.'
  };
  function error(message, code = 'LOGIN', rejected = false) {
    return Object.assign(new Error(message), { code, rejected, alphaAuthError: true });
  }
  function decodeEntities(value) {
    return String(value || '').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&(amp|quot|apos|lt|gt);/gi, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[n.toLowerCase()]);
  }
  function attributes(tag) {
    const out = {};
    for (const m of tag.matchAll(/\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4]);
    }
    return out;
  }
  function loginForm(html) {
    const forms = [...String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)];
    const selected = forms.filter(m => attributes(m[1]).id === 'kc-form-login');
    if (selected.length !== 1) throw error('알파 로그인 화면을 확인해야 합니다. 알파에서 직접 로그인해 주세요.', 'MANUAL');
    const form = attributes(selected[0][1]);
    let action;
    try { action = new URL(form.action, ORIGIN); } catch { throw error('알파 로그인 주소를 확인하지 못했습니다.', 'UNTRUSTED'); }
    if (form.method?.toLowerCase() !== 'post' || action.origin !== ORIGIN || action.pathname !== AUTH_PATH ||
        action.username || action.password || action.hash || action.searchParams.get('client_id') !== 'kird-gateway' ||
        !['session_code', 'execution', 'tab_id'].every(key => action.searchParams.get(key))) {
      throw error('알파 로그인 주소가 예상과 달라 자동 로그인을 중단했습니다.', 'UNTRUSTED');
    }
    const inputs = [...selected[0][2].matchAll(/<input\b[^>]*>/gi)].map(m => attributes(m[0]));
    if (!inputs.some(input => input.name === 'username') || !inputs.some(input => input.name === 'password' && input.type === 'password')) {
      throw error('알파에서 추가 인증이 필요합니다. 로그인 화면을 확인해 주세요.', 'MANUAL');
    }
    if (inputs.some(input => input.name && !['username', 'password', 'credentialId'].includes(input.name))) {
      throw error('알파에서 추가 인증이 필요합니다. 로그인 화면을 확인해 주세요.', 'MANUAL');
    }
    return { action: action.href, credentialId: inputs.find(input => input.name === 'credentialId')?.value || '' };
  }

  function create({ api, storage, cookies, fetchImpl = root.fetch.bind(root) }) {
    let pending = null;
    const saveAuth = auth => storage.set({ alphaAuth: { ...auth, checkedAt: Date.now() } });
    const sameAccount = (a, b) => a?.userName === b?.userName && a?.password === b?.password;

    async function request(url, options = {}) {
      const destination = new URL(url, ORIGIN);
      if (destination.origin !== ORIGIN || destination.username || destination.password) throw error('알파 로그인 주소를 확인하지 못했습니다.', 'UNTRUSTED');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetchImpl(destination.href, { credentials: 'include', cache: 'no-store',
          redirect: options.method === 'POST' ? 'manual' : 'follow', ...options, signal: controller.signal });
        if (response.url && new URL(response.url).origin !== ORIGIN) throw error('알파 외부 인증 화면은 직접 확인해 주세요.', 'UNTRUSTED');
        return response;
      } catch (cause) {
        if (cause?.alphaAuthError) throw cause;
        if (controller.signal.aborted || cause?.name === 'AbortError') throw error('알파 로그인 응답 시간이 초과되었습니다. 알파에서 로그인 상태를 확인해 주세요.', 'TIMEOUT');
        throw error('알파 로그인에 연결하지 못했습니다. 연결 상태를 확인해 주세요.', 'NETWORK');
      } finally { clearTimeout(timeout); }
    }

    async function initBrowserCookie() {
      if ((await cookies.get({ url: ORIGIN, name: 'browser_uuid_v2' }))?.value) return;
      const old = await cookies.get({ url: ORIGIN, name: 'browser_uuid' });
      await cookies.set({ url: ORIGIN, name: 'browser_uuid_v2', value: old?.value || root.crypto.randomUUID(),
        domain: '.alpha-campus.kr', path: '/', secure: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400 });
    }
    async function csrfHeaders() {
      const token = (await cookies.get({ url: ORIGIN, name: 'XSRF-TOKEN' }))?.value;
      if (!token) return {};
      try { return { 'X-XSRF-TOKEN': decodeURIComponent(token) }; }
      catch { throw error('알파 로그인 인증정보를 읽지 못했습니다. 알파에서 다시 로그인해 주세요.', 'CSRF'); }
    }
    function assertSessionUser(session, account) {
      if (session.authenticated && account?.userName && session.loginId !== account.userName) {
        throw error('저장한 계정과 현재 알파 로그인 계정이 다릅니다. 알파에서 계정을 전환해 주세요.', 'ACCOUNT_MISMATCH');
      }
    }
    async function perform({ force = false } = {}) {
      const { alphaAccount: account, alphaAuth: previous } = await storage.get(['alphaAccount', 'alphaAuth']);
      let credentialAttempted = false;
      try {
        let session = await api.session();
        assertSessionUser(session, account);
        if (session.authenticated && session.loginId) {
          await saveAuth({ ok: true, user: session.loginId, rejected: false, message: '알파 로그인됨' });
          return session;
        }
        if (!account?.userName || !account?.password) throw error('알파 계정을 저장하거나 알파에서 먼저 로그인해 주세요.', 'NO_ACCOUNT');
        if (!force && previous?.rejected && previous.user === account.userName) {
          throw error(previous.message || '알파 계정을 확인한 뒤 로그인 확인을 눌러 주세요.', previous.code || 'REJECTED', true);
        }
        await initBrowserCookie();
        const loginPage = await request('/login');
        if (!loginPage.ok) throw error('알파 로그인 화면을 불러오지 못했습니다.', 'HTTP');
        const html = await loginPage.text();
        // A valid Keycloak SSO cookie can complete login during this GET.
        session = await api.session();
        assertSessionUser(session, account);
        if (session.authenticated && session.loginId) {
          await saveAuth({ ok: true, user: session.loginId, rejected: false, message: '알파 로그인됨' });
          return session;
        }
        const form = loginForm(html);
        const current = (await storage.get('alphaAccount')).alphaAccount;
        if (!sameAccount(account, current)) throw error('저장된 알파 계정이 변경되었습니다. 다시 시작해 주세요.', 'ACCOUNT_CHANGED');
        credentialAttempted = true;
        const precheck = await request('/api/memberLogin/check', { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...await csrfHeaders() },
          body: JSON.stringify({ loginId: account.userName, password: account.password }) });
        if (!precheck.ok || precheck.type === 'opaqueredirect' || precheck.redirected) {
          throw error('알파 로그인 확인을 완료하지 못했습니다. 알파에서 로그인 상태를 확인해 주세요.', 'LOGIN_CHECK', true);
        }
        let result;
        try { result = await precheck.json(); } catch { throw error('알파 로그인 확인 응답을 읽지 못했습니다.', 'LOGIN_CHECK', true); }
        if (result?.type !== 'pass') {
          throw error(CHALLENGES[result?.type] || '알파에서 추가 확인이 필요합니다. 로그인 화면을 확인해 주세요.', 'LOGIN_CHALLENGE', true);
        }
        if (!sameAccount(account, (await storage.get('alphaAccount')).alphaAccount)) {
          throw error('저장된 알파 계정이 변경되었습니다. 다시 시작해 주세요.', 'ACCOUNT_CHANGED');
        }
        const body = new URLSearchParams({ username: account.userName, password: account.password, credentialId: form.credentialId });
        const submitted = await request(form.action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        if (submitted.type !== 'opaqueredirect' && !(submitted.status >= 300 && submitted.status < 400) && !submitted.ok) {
          throw error('알파가 로그인을 완료하지 못했습니다. 계정을 확인해 주세요.', 'LOGIN_REJECTED', true);
        }
        const location = submitted.headers?.get('location');
        if (location) {
          const redirect = new URL(location, form.action);
          if (redirect.origin !== ORIGIN || redirect.username || redirect.password) throw error('알파 외부 인증 화면은 직접 확인해 주세요.', 'UNTRUSTED', true);
        }
        // Fetch hides a manual redirect's Location; a fresh SSO GET completes
        // the callback without ever forwarding a password to a redirect target.
        const finish = await request('/login');
        if (!finish.ok) throw error('알파 로그인 연결을 완료하지 못했습니다.', 'LOGIN_REJECTED', true);
        session = await api.session();
        assertSessionUser(session, account);
        if (!session.authenticated || !session.loginId) throw error('알파 로그인을 완료하지 못했습니다. 알파에서 추가 안내를 확인해 주세요.', 'LOGIN_REJECTED', true);
        if (!sameAccount(account, (await storage.get('alphaAccount')).alphaAccount)) throw error('저장된 알파 계정이 변경되었습니다. 다시 시작해 주세요.', 'ACCOUNT_CHANGED');
        await saveAuth({ ok: true, user: session.loginId, rejected: false, message: '알파 로그인됨' });
        return session;
      } catch (cause) {
        const failure = cause?.alphaAuthError ? cause : error('알파 로그인 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.', 'NETWORK');
        // An interrupted request may already have reached the failed-login
        // counter. Retry only after an explicit login test or account change.
        if (credentialAttempted) failure.rejected = true;
        if (sameAccount(account, (await storage.get('alphaAccount')).alphaAccount)) {
          await saveAuth({ ok: false, user: account?.userName || '', message: failure.message, rejected: failure.rejected, code: failure.code });
        }
        throw failure;
      }
    }
    function ensureLoggedIn(options) {
      if (!pending) pending = perform(options).finally(() => { pending = null; });
      return pending;
    }
    async function saveAccount(input) {
      const userName = typeof input?.userName === 'string' ? input.userName.trim() : '';
      const password = input?.password;
      if (!userName || userName.length > 256 || typeof password !== 'string' || !password || password.length > 4096) {
        throw error('알파 아이디와 비밀번호를 모두 입력해 주세요.', 'NO_ACCOUNT');
      }
      if (pending) throw error('알파 로그인 확인이 진행 중입니다. 완료 후 계정을 저장해 주세요.', 'BUSY');
      await storage.set({ alphaAccount: { userName, password }, alphaAuth: { ok: false, user: userName, rejected: false, message: '알파 로그인 확인 중', checkedAt: Date.now() } });
      return ensureLoggedIn({ force: true });
    }
    return { ensureLoggedIn, testAccount: () => ensureLoggedIn({ force: true }), saveAccount };
  }
  root.AlphaAuth = Object.freeze({ create, loginForm });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlphaAuth;
})(globalThis);
