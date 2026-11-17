// e-Hrd(hrd.krs.co.kr) My Credits — 올해 역량필수(C-C)·역량선택(C-E) 학점을 읽는다. 읽기만 한다.
// 2026-11-17 실제 사이트에서 확인한 것:
//  - My Credits 표는 POST CreditsUsrList.do 한 번으로 채워진다 (취득 ccComplPnt / 최소 ccCredits, C-E·S-C 도 같은 꼴).
//  - 로그인이 없으면 같은 요청이 { loginRequired: true } 를 돌려준다.
//  - 로그인은 e-Class 통합 로그인이다. 사이트의 AutoLogin.do 가 하는 것과 같은 두 요청을 보낸다:
//    e-Class 의 로그인 확인(JSONP) → 받은 값을 AutoLoginConfirm.do 로 전달.
// 통합 로그인 값은 요청에만 쓰고 저장하거나 오류 문구에 넣지 않는다.
(function (root) {
  'use strict';
  const ORIGIN = 'https://hrd.krs.co.kr';
  const ECLASS_ORIGIN = 'https://eclass.krs.co.kr';
  const PAGE_URL = `${ORIGIN}/KRS/usr/info/credits/CreditsUsrPage.do`;
  // My Credits 의 "Minimum Requirement Credit Exemption" 버튼이 여는 화면 (최소이수학점 조정·면제 기준)
  const MINIMUM_URL = `${ORIGIN}/KRS/usr/info/credits/modal/CreditsPageModal.do`;
  const ECLASS_LOGIN_URL = `${ECLASS_ORIGIN}/eClassVer4/Account/Login`;
  const LIST_URL = `${ORIGIN}/KRS/usr/info/credits/CreditsUsrList.do`;
  const LOGIN_CHECK_URL = `${ECLASS_ORIGIN}/intra/intranet/Main_N/json/loginCheck_json.aspx`;
  const LOGIN_CONFIRM_URL = `${ORIGIN}/KRS/usr/cmn/login/AutoLoginConfirm.do`;
  const TIMEOUT_MS = 15000;

  function fail(message, code) {
    return Object.assign(new Error(message), { code, hrdError: true });
  }
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  // 사이트 표와 같은 규칙: 최소 학점이 비어 있으면 0, S-C 는 최소 학점이 있을 때만 보인다.
  const pair = (got, need) => ({ got: num(got) ?? 0, need: num(need) ?? 0 });

  // CreditsUsrList.do 응답에서 그 해의 줄을 고른다. 없으면 null
  function parseCredits(rows, year) {
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r) => r && String(r.year) === String(year));
    if (!row) return null;
    return {
      year: String(row.year),
      cc: pair(row.ccComplPnt, row.ccCredits),
      ce: pair(row.ceComplPnt, row.ceCredits),
      sc: num(row.scCredits) === null ? null : pair(row.scComplPnt, row.scCredits)
    };
  }

  // e-Class 로그인 확인은 JSONP 다: cb({"UID": "…", "SID": "…"}). 로그인이 없으면 둘 다 빈 문자열
  function parseLoginCheck(text) {
    const m = /^[^(]*\(([\s\S]*)\)[\s;]*$/.exec(String(text || '').trim());
    if (!m) return null;
    let data;
    try { data = JSON.parse(m[1]); } catch { return null; }
    if (!data || typeof data.UID !== 'string' || typeof data.SID !== 'string') return null;
    return { uid: data.UID, sid: data.SID };
  }

  function createClient({ fetchImpl = root.fetch.bind(root) } = {}) {
    async function request(url, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
          // 사이트는 이 머리글로 화면 요청과 API 요청을 구분한다 (없으면 로그인 화면으로 넘긴다)
          headers: { Accept: 'application/json, text/javascript, */*', 'X-Requested-With': 'XMLHttpRequest',
            ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
        if (!res.ok) throw fail(`e-Hrd 요청 실패 (HTTP ${res.status})`, 'HTTP');
        return await res.text();
      } catch (e) {
        if (e && e.hrdError) throw e;
        if ((e && e.name === 'AbortError') || controller.signal.aborted) throw fail('e-Hrd 응답이 없습니다', 'TIMEOUT');
        throw fail('e-Hrd에 연결하지 못했습니다', 'NETWORK');
      } finally { clearTimeout(timer); }
    }

    // { rows } 또는 { loginRequired: true }
    async function list(year) {
      const text = await request(LIST_URL, { searchBgnYear: String(year), searchEndYear: String(year), pageSize: 25, sortInfo: [] });
      let data;
      // JSON 이 아니면 로그인 화면으로 넘겨진 것이다
      try { data = JSON.parse(text); } catch { return { loginRequired: true }; }
      if (Array.isArray(data)) return { rows: data };
      if (data && (data.loginRequired || data.redirect)) return { loginRequired: true };
      throw fail('e-Hrd 응답을 읽지 못했습니다', 'RESPONSE');
    }

    async function login() {
      const check = parseLoginCheck(await request(`${LOGIN_CHECK_URL}?callback=cb&_=${Date.now()}`));
      if (!check) throw fail('e-Class 응답을 읽지 못했습니다', 'RESPONSE');
      if (!check.uid || !check.sid) throw fail('e-Class 로그인이 필요합니다', 'ECLASS');
      let result;
      try { result = JSON.parse(await request(LOGIN_CONFIRM_URL, { uid: check.uid, sid: check.sid })); } catch (e) {
        if (e && e.hrdError) throw e;
        result = null;
      }
      if (!result || result.errorCount !== 0 || result.loginRequired) throw fail('e-Hrd 로그인에 실패했습니다', 'LOGIN');
    }

    return {
      // 그 해의 학점. 로그인이 끊겨 있으면 통합 로그인을 한 번 하고 다시 읽는다.
      async credits(year = new Date().getFullYear()) {
        let res = await list(year);
        if (res.loginRequired) {
          await login();
          res = await list(year);
          if (res.loginRequired) throw fail('e-Hrd 로그인에 실패했습니다', 'LOGIN');
        }
        const credits = parseCredits(res.rows, year);
        if (!credits) throw fail(`${year}년 학점 정보가 없습니다`, 'EMPTY');
        return credits;
      },
      // 사이트 화면을 탭으로 열기 전에 부른다. 로그인이 끊겨 있으면 통합 로그인을 한다.
      async ensureLoggedIn(year = new Date().getFullYear()) {
        if ((await list(year)).loginRequired) await login();
      }
    };
  }

  root.HrdCredits = Object.freeze({ ORIGIN, PAGE_URL, MINIMUM_URL, ECLASS_LOGIN_URL, createClient, parseCredits, parseLoginCheck });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HrdCredits;
})(globalThis);
