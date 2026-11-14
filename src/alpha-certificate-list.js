// Official evidenceDocument pagination; only reads the signed-in learner's records.
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PAGE_SIZE = 20;
  const MAX_PAGES = 500;
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const QUERY = `query AlphaCompletedCertificateList($request: SearchMyRegistrationDocumentInput) {
    registrations: searchMyRegistrationDocument(request: $request) {
      number size totalPages totalElements
      content { id sequenceId subjectId subjectName subjectType status requestInfo { dateTime user { loginId } } }
    }
  }`;

  function failure(message, code = 'ALPHA_CERTIFICATE_LIST') {
    return Object.assign(new Error(message), { code, alphaCertificateListError: true });
  }

  function createClient({ fetchImpl = root.fetch, getCsrfToken = async () => null, api } = {}) {
    if (typeof fetchImpl !== 'function' || typeof api?.session !== 'function') {
      throw new Error('알파 수료 목록 조회에 필요한 연결이 없습니다.');
    }

    // year를 주면 그해에 신청한(알파 신청일 기준) 수료 과정만 돌려준다. 사이트의 year 조건은 실제로 걸러지지 않아
    // (2026-11 실계정 확인) 목록을 모두 읽은 뒤 신청일(requestInfo.dateTime, 한국 시간)로 거른다.
    async function listCompleted({ loginId, year, shouldStop = () => false, onPage } = {}) {
      if (typeof loginId !== 'string' || !loginId.trim()) throw failure('알파 로그인 계정을 확인해 주세요.');
      if (year !== undefined && !(Number.isInteger(year) && year >= 2000 && year <= 9999)) throw failure('수료증을 받을 연도를 확인하지 못했습니다.');
      const deadline = Date.now() + 120000;
      const check = () => {
        if (shouldStop()) throw failure('수료증 목록 조회를 중지했습니다.', 'ALPHA_CANCELLED');
        if (Date.now() >= deadline) throw failure('수료 목록 조회 시간이 초과되었습니다. 다시 시도해 주세요.');
      };
      const verifySession = async () => {
        check();
        let session;
        try { session = await api.session(); }
        catch { check(); throw failure('알파 로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요.'); }
        check();
        if (!session?.authenticated || session.loginId !== loginId) {
          throw failure('알파 로그인 계정이 변경되었거나 로그아웃되었습니다. 다시 확인해 주세요.', 'ALPHA_ACCOUNT_CHANGED');
        }
      };
      const pageRequest = async number => {
        check();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(15000, deadline - Date.now()));
        try {
          const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
          const token = await getCsrfToken();
          check();
          if (token != null && token !== '') {
            if (typeof token !== 'string' || token.length > 4096) throw failure('알파 인증 정보를 다시 확인해 주세요.');
            let decoded;
            try { decoded = decodeURIComponent(token); }
            catch { throw failure('알파 인증 정보를 다시 확인해 주세요.'); }
            if (/[\r\n]/.test(decoded)) throw failure('알파 인증 정보를 다시 확인해 주세요.');
            headers['X-XSRF-TOKEN'] = decoded;
          }
          // Omitting year/type/subjectType includes every year and course type (year is not honored anyway).
          // No isAdmin/memberId override is sent: the API uses its current learner.
          const response = await fetchImpl(`${ORIGIN}/api/graphql`, {
            method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error', headers,
            signal: controller.signal,
            body: JSON.stringify({ operationName: 'AlphaCompletedCertificateList', query: QUERY,
              variables: { request: { page: { number, size: PAGE_SIZE,
                sort: [{ property: 'requestInfo.dateTime', direction: 'DESC' }] },
              subjectText: '', statuses: ['COMPLETED'] } } }),
          });
          check();
          if (!response.ok || response.redirected || (response.url && response.url !== `${ORIGIN}/api/graphql`)) {
            throw failure('알파 수료 목록을 불러오지 못했습니다. 로그인 상태를 확인해 주세요.');
          }
          if (Number(response.headers?.get?.('Content-Length')) > MAX_RESPONSE_BYTES) {
            throw failure('알파 수료 목록 응답이 너무 큽니다. 알파에서 직접 확인해 주세요.');
          }
          let body;
          if (response.body?.getReader) {
            const reader = response.body.getReader(), chunks = []; let length = 0;
            while (true) {
              check();
              const { done, value } = await reader.read();
              if (done) break;
              length += value.byteLength;
              if (length > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw failure('알파 수료 목록 응답이 너무 큽니다. 알파에서 직접 확인해 주세요.');
              }
              chunks.push(value);
            }
            const bytes = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            body = JSON.parse(new TextDecoder().decode(bytes));
          } else if (typeof response.text === 'function') {
            const text = await response.text();
            if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw failure('알파 수료 목록 응답이 너무 큽니다.');
            body = JSON.parse(text);
          } else {
            body = await response.json();
            if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_RESPONSE_BYTES) throw failure('알파 수료 목록 응답이 너무 큽니다.');
          }
          check();
          if (body.errors?.length || !body.data?.registrations) throw failure('알파 수료 목록 응답을 확인하지 못했습니다.');
          return body.data.registrations;
        } catch (error) {
          controller.abort();
          check();
          if (error?.alphaCertificateListError) throw error;
          throw failure('알파 수료 목록 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        } finally { clearTimeout(timer); }
      };

      const result = [], seen = new Map();
      let totals, scanned = 0;
      for (let number = 0; number < MAX_PAGES; number++) {
        await verifySession();
        const page = await pageRequest(number);
        await verifySession();
        if (page.number !== number || !Number.isInteger(page.size) || page.size < 1 || page.size > PAGE_SIZE ||
            !Number.isInteger(page.totalPages) || page.totalPages < 0 ||
            !Number.isInteger(page.totalElements) || page.totalElements < 0 ||
            !Array.isArray(page.content) || page.content.length > page.size ||
            page.totalPages !== Math.ceil(page.totalElements / page.size)) {
          throw failure('알파 수료 목록의 페이지 형식이 변경되었습니다. 알파에서 확인해 주세요.');
        }
        if (page.totalPages > MAX_PAGES || page.totalElements > MAX_PAGES * PAGE_SIZE) {
          throw failure('수료 목록이 한 번에 조회할 수 있는 범위를 넘었습니다. 알파에서 확인해 주세요.');
        }
        const currentTotals = `${page.size}:${page.totalPages}:${page.totalElements}`;
        if (totals && totals !== currentTotals) throw failure('조회 중 수료 목록이 변경되었습니다. 전체 목록을 다시 조회해 주세요.');
        totals = currentTotals;
        const expectedCount = Math.min(page.size, Math.max(0, page.totalElements - number * page.size));
        if (page.content.length !== expectedCount) throw failure('수료 목록 일부를 받지 못했습니다. 전체 목록을 다시 조회해 주세요.');
        for (const row of page.content) {
          if (!row || typeof row.status !== 'string') throw failure('알파 수료 상태를 확인하지 못했습니다.');
          if (row.requestInfo?.user?.loginId !== loginId) throw failure('수료 이력의 계정 정보가 현재 계정과 다릅니다.', 'ALPHA_ACCOUNT_CHANGED');
          if (row.status !== 'COMPLETED') continue;
          if (!UUID.test(row.id) || !UUID.test(row.subjectId) || !UUID.test(row.sequenceId) ||
              typeof row.subjectName !== 'string' || !row.subjectName.trim() || row.subjectName.length > 1000 ||
              ![1, 2, 3, 4, 5].includes(Number(row.subjectType)) || !/^[1-5]$/.test(String(row.subjectType))) {
            throw failure('수료한 과정의 식별 정보를 확인하지 못했습니다. 알파에서 확인해 주세요.');
          }
          const identity = `${row.subjectId}:${row.sequenceId}:${row.subjectType}`;
          if (seen.has(row.id)) {
            if (seen.get(row.id) !== identity) throw failure('수료 이력이 조회 중 변경되었습니다. 다시 조회해 주세요.');
            continue;
          }
          seen.set(row.id, identity);
          if (year !== undefined) {
            const requested = /^(\d{4})-\d{2}-\d{2}T/.exec(String(row.requestInfo?.dateTime || ''));
            if (!requested) throw failure('수료 과정의 신청일을 확인하지 못했습니다. 알파에서 확인해 주세요.');
            if (Number(requested[1]) !== year) continue;
          }
          result.push({ registrationId: row.id, course: { id: row.subjectId, sequenceId: row.sequenceId,
            title: row.subjectName.trim(), type: Number(row.subjectType),
            url: `${ORIGIN}/explore/${row.subjectId}?sequenceId=${row.sequenceId}&tab=ALL` } });
        }
        scanned += page.content.length;
        check();
        if (onPage) await onPage({ scanned, total: page.totalElements });
        check();
        if (number + 1 >= page.totalPages) return result;
      }
      throw failure('전체 수료 목록을 조회하지 못했습니다. 알파에서 확인해 주세요.');
    }
    return Object.freeze({ listCompleted });
  }
  const exported = Object.freeze({ createClient });
  root.AlphaCertificateList = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
