// ALPHA's issued certificates are rendered/exported by its official ClipReport server.
// The extension never builds certificate content or changes completion records.
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const REPORT_ORIGIN = 'https://report.alpha-campus.kr';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_PDF_BYTES = 10 * 1024 * 1024;
  const TEMPLATES = Object.freeze({ COMMON: 'onlinesuryo', COMMON_RESEARCH_NUMBER: 'onlinesuryo1',
    RESEARCH_ETHICS: 'onlinesuryo2', RESEARCH_ETHICS_GRADUATE: 'onlinesuryo2',
    OFFLINE_COMMON: 'offsuryo', OFFLINE_IRIS_LINK: 'offsuryo1' });
  const REGISTRATION_QUERY = `query AlphaCertificateRegistration($id: ID!) {
    registration: getRegistrationById(id: $id) {
      id status sequence { id subject { id type name } }
      certificateInfo { certificateNumber } completionInfo { dateTime }
      registrationCertificate { displayType }
      registrationCertificateMemberCompany { companyId }
      requestInfo { companyId user { loginId } }
    }
  }`;

  function failure(message, code = 'ALPHA_CERTIFICATE') {
    const error = new Error(message); error.code = code; return error;
  }

  function completionDate(value) {
    if (typeof value !== 'string') return NaN;
    const match = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
    if (!match || !Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`)) ||
        new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) return NaN;
    const text = value.trim().replace(' ', 'T');
    return Date.parse(text.length === 10 ? `${text}T00:00:00+09:00`
      : /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}+09:00`);
  }

  function reportUrl({ course, registrationId, loginId }, registration) {
    const expectedType = String(course?.type ?? '4');
    if (!UUID.test(course?.id) || !UUID.test(course?.sequenceId) || !UUID.test(registrationId) ||
        !loginId || registration?.id !== registrationId || registration.sequence?.id !== course.sequenceId ||
        registration.sequence?.subject?.id !== course.id || !/^[1-5]$/.test(expectedType) ||
        String(registration.sequence?.subject?.type) !== expectedType) {
      throw failure('수료증의 교육 정보가 선택한 과정과 일치하지 않습니다.');
    }
    if (registration.requestInfo?.user?.loginId !== loginId) {
      throw failure('수료증의 계정 정보가 현재 알파 계정과 일치하지 않습니다.');
    }
    if (registration.status !== 'COMPLETED') throw failure('알파에서 수료 처리된 과정만 수료증을 받을 수 있습니다.');
    const number = registration.certificateInfo?.certificateNumber;
    if (typeof number !== 'string' || !number.trim()) throw failure('아직 수료번호가 발급되지 않았습니다. 알파에서 수료증 발급 상태를 확인하세요.');
    const completedAt = completionDate(registration.completionInfo?.dateTime);
    const template = TEMPLATES[registration.registrationCertificate?.displayType];
    if (!Number.isFinite(completedAt) || !template) throw failure('수료증 양식 또는 수료일을 확인할 수 없습니다. 알파에서 수료증을 확인하세요.');
    const companies = registration.registrationCertificateMemberCompany;
    if (companies != null && (!Array.isArray(companies) || companies.length > 1)) {
      throw failure('수료증에 표시할 소속 선택이 필요합니다. 알파에서 수료증을 발급하세요.');
    }
    // The official evidenceDocument page uses the single recorded certificate company.
    const companyId = companies?.length === 1 ? companies[0]?.companyId : registration.requestInfo?.companyId;
    if (companyId != null && !UUID.test(companyId)) throw failure('수료증 소속 정보를 확인할 수 없습니다.');
    const url = new URL('/ClipReport5/report.jsp', REPORT_ORIGIN);
    url.searchParams.set('crfNm', template + (completedAt >= Date.parse('2024-08-01T00:00:00+09:00') ? '_new' : ''));
    url.searchParams.set('ID', registrationId);
    url.searchParams.set('name', (registration.sequence.subject.name || course.title || '').replace(/"/g, '\\"'));
    url.searchParams.set('CID', companyId ?? 'null');
    url.searchParams.set('URL', 'alpha-campus.kr');
    return url.href;
  }

  // Runs only in the newly created official report tab, in MAIN world. No extension
  // credentials cross this boundary. The official library's live instance supplies
  // the report key, endpoint, options and optional report-server request parameters.
  async function reportPageAction({ expectedUrl, action, reportKey, fileName, deadline }) {
    const error = message => ({ status: 'error', message });
    const matchesPage = () => {
      try { return location.origin === 'https://report.alpha-campus.kr' && new URL(location.href).href === expectedUrl; }
      catch { return false; }
    };
    if (!matchesPage()) return error('수료증 페이지 주소가 변경되었습니다.');
    let instances;
    try {
      const registry = globalThis.m_reportHashMap;
      instances = registry ? Object.keys(registry).map(key => registry[key])
        .filter(value => value && typeof value === 'object' && value.objReportInfo?.strReportKey) : [];
    } catch { return error('알파 수료증 뷰어를 확인하지 못했습니다.'); }
    if (!instances.length) return { status: 'loading' };
    if (instances.length !== 1) return error('수료증 뷰어가 여러 문서를 표시하여 자동 저장을 중단했습니다.');
    const viewer = instances[0], info = viewer.objReportInfo;
    if (info.isStatus !== true || (Number.isFinite(info.nCode) && info.nCode >= 400)) return error('알파에서 수료증 원본을 만들지 못했습니다.');
    if (info.isEndReport !== true) return { status: 'loading' };
    if (typeof info.strReportKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(info.strReportKey) ||
        !Number.isInteger(viewer.objPageInfo?.nPageCount) || viewer.objPageInfo.nPageCount < 1 || viewer.objPageInfo.nPageCount > 100) {
      return error('수료증 원본의 문서 정보를 확인하지 못했습니다.');
    }
    if (action === 'inspect') return { status: 'ready', reportKey: info.strReportKey };
    if (info.strReportKey !== reportKey) return error('수료증 문서가 변경되었습니다. 다시 시도하세요.');
    let server;
    try {
      server = new URL(viewer.strServerPath, location.href);
      if (server.origin !== 'https://report.alpha-campus.kr' || !server.pathname.startsWith('/ClipReport5/') ||
          server.username || server.password || server.hash || /%2f|%5c/i.test(server.pathname)) throw new Error();
    } catch { return error('알파 수료증 서버 주소를 확인하지 못했습니다.'); }
    if (!['start', 'poll', 'download'].includes(action)) return error('지원하지 않는 수료증 요청입니다.');
    const options = viewer.objSaveExportOptionInfo?.pdf;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return error('수료증 PDF 저장 옵션을 확인하지 못했습니다.');
    const data = { reportkey: reportKey, startNum: 1, endNum: viewer.objPageInfo.nPageCount,
      fileName: btoa(encodeURIComponent(fileName)), isIE: false, isEdge: false,
      exportType: 3, option: options, isSmartphone: false };
    const clipType = action === 'start' ? 'saveExport' : action === 'poll' ? 'fileDownloadCheck' : 'saveExportDownload';
    const clipData = action === 'poll' ? { reportkey: reportKey, s_time: `t${Date.now() % 1000}` } : data;
    let body;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: action === 'download' ? 'application/pdf' : 'application/json' };
    try {
      body = new URLSearchParams({ ClipType: clipType, ClipData: JSON.stringify(clipData) });
      if (viewer.m_postParam != null) {
        if (typeof viewer.m_postParam.getParam !== 'function') throw new Error();
        const extra = viewer.m_postParam.getParam();
        if (typeof extra !== 'string' || extra.length > 16384) throw new Error();
        for (const [key, value] of new URLSearchParams(extra.replace(/^&/, ''))) {
          if (['ClipType', 'ClipData'].includes(key)) throw new Error();
          body.append(key, value);
        }
      }
      if (globalThis.mCR_isAddRequestHeader === true) {
        const name = globalThis.mCR_strRequestHeaderName, value = globalThis.mCR_strRequestHeaderValue;
        if (typeof name !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 8192) throw new Error();
        headers[name] = value;
      }
    } catch { return error('수료증 서버의 요청 형식이 변경되었습니다. 알파에서 직접 저장하세요.'); }
    const remaining = Math.min(15000, Number.isFinite(deadline) ? deadline - Date.now() : 15000);
    if (remaining <= 0) return error('수료증 준비 시간이 초과되었습니다.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    try {
      // ClipReport sendData uses GET only when the configured endpoint has a query.
      // Its final download form defaults to POST.
      const method = action === 'download' ? String(viewer.strDownloadFormMethod || 'post').toUpperCase()
        : server.search ? 'GET' : 'POST';
      if (!['POST', 'GET'].includes(method)) return error('지원하지 않는 수료증 서버 요청 방식입니다.');
      const requestUrl = new URL(server.href);
      if (method === 'GET') for (const [key, value] of body) requestUrl.searchParams.append(key, value);
      const response = await fetch(requestUrl.href, { method, credentials: 'include', cache: 'no-store', redirect: 'error',
        headers, ...(method === 'POST' ? { body: body.toString() } : {}), signal: controller.signal });
      if (!matchesPage()) return error('수료증 페이지가 변경되어 저장을 중단했습니다.');
      if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== server.origin)) return error('알파 수료증 서버 요청에 실패했습니다.');
      const maxBytes = action === 'download' ? 10 * 1024 * 1024 : 128 * 1024;
      if (Number(response.headers.get('Content-Length')) > maxBytes) return error('수료증 응답 크기가 허용 범위를 넘었습니다.');
      const chunks = []; let length = 0;
      const reader = response.body?.getReader();
      if (!reader) return error('수료증 파일 응답을 읽을 수 없습니다.');
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > maxBytes) { await reader.cancel(); return error('수료증 응답 크기가 허용 범위를 넘었습니다.'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (action === 'download') {
        if (length < 100 || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-' ||
            !new TextDecoder().decode(bytes.slice(-2048)).includes('%%EOF')) return error('알파에서 정상적인 PDF 수료증을 받지 못했습니다.');
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        return { status: 'pdf', base64: btoa(binary) };
      }
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return error('알파 수료증 서버의 응답을 확인하지 못했습니다.'); }
      const result = parsed?.resValue;
      if (parsed?.id !== (action === 'start' ? 7 : 4) || !result || typeof result.status !== 'boolean' ||
          (Number.isFinite(Number(result.event)) && Number(result.event) >= 400)) return error('알파에서 수료증 PDF를 만들지 못했습니다.');
      if (action === 'start' && result.status !== true) return error('알파에서 수료증 PDF 저장을 시작하지 못했습니다.');
      return { status: result.status ? 'ready' : 'pending' };
    } catch { return error('알파 수료증 서버 응답이 없거나 연결이 중단되었습니다. 다시 시도하세요.'); }
    finally { clearTimeout(timer); }
  }

  function createClient({ fetchImpl = root.fetch.bind(root), getCsrfToken = async () => null,
    tabs = root.chrome?.tabs, scripting = root.chrome?.scripting, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    async function fetchPdf({ course, registrationId, loginId, shouldStop = () => false }) {
      const deadline = Date.now() + 60000; let tabId = null, expectedUrl = null;
      const check = async () => {
        if (await shouldStop()) throw failure('수료증 자동 저장을 중단했습니다.', 'CANCELLED');
        if (Date.now() > deadline) throw failure('수료증 준비 시간이 초과되었습니다. 알파에서 수료증을 확인한 뒤 다시 시도하세요.');
      };
      await check();
      if (!UUID.test(course?.id) || !UUID.test(course?.sequenceId) || !UUID.test(registrationId) || typeof loginId !== 'string' || !loginId) {
        throw failure('수료증을 조회할 교육 또는 계정 정보가 없습니다.');
      }
      if (!tabs?.create || !tabs?.get || !tabs?.remove || !scripting?.executeScript) throw failure('수료증 자동 저장에 필요한 브라우저 기능을 사용할 수 없습니다. 확장 프로그램을 새로고침하세요.');
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
      let registration;
      try {
        const token = await getCsrfToken(); await check();
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        if (token) headers['X-XSRF-TOKEN'] = decodeURIComponent(token);
        const response = await fetchImpl(`${ORIGIN}/api/graphql`, { method: 'POST', credentials: 'include',
          cache: 'no-store', redirect: 'error', headers, signal: controller.signal,
          body: JSON.stringify({ operationName: 'AlphaCertificateRegistration', query: REGISTRATION_QUERY, variables: { id: registrationId } }) });
        if (!response.ok || response.redirected || (response.url && response.url !== `${ORIGIN}/api/graphql`)) throw failure('알파 수료증 발급 정보를 조회하지 못했습니다. 로그인을 확인하세요.');
        const body = await response.json();
        if (body.errors?.length || !body.data?.registration) throw failure('알파 수료증 발급 정보를 조회하지 못했습니다.');
        registration = body.data.registration;
      } catch (error) {
        if (error.code) throw error;
        throw failure('알파 수료증 발급 정보 조회에 실패했습니다. 다시 시도하세요.');
      } finally { clearTimeout(timeout); }
      expectedUrl = reportUrl({ course, registrationId, loginId }, registration);
      await check();
      try {
        const tab = await tabs.create({ url: expectedUrl, active: false });
        tabId = tab?.id;
        if (!Number.isInteger(tabId)) throw failure('수료증 뷰어를 열지 못했습니다.');
        const execute = async (action, reportKey) => {
          await check();
          const tab = await tabs.get(tabId);
          const currentUrl = tab.pendingUrl || tab.url;
          if (currentUrl !== expectedUrl) {
            if (action === 'inspect' && (!currentUrl || currentUrl === 'about:blank') && tab.pendingUrl === expectedUrl) return { status: 'loading' };
            throw failure('수료증 페이지가 변경되어 자동 저장을 중단했습니다.');
          }
          if (action === 'inspect' && tab.status === 'loading') return { status: 'loading' };
          let responses;
          try {
            responses = await scripting.executeScript({ target: { tabId }, world: 'MAIN', func: reportPageAction,
              args: [{ expectedUrl, action, reportKey, fileName: 'ALPHA_certificate', deadline }] });
          } catch { throw failure('알파 수료증 뷰어에 연결하지 못했습니다. 알파에서 수료증을 확인하세요.'); }
          await check();
          const result = responses?.find(item => item.frameId === 0)?.result;
          if (!result || result.status === 'error') throw failure(result?.message || '알파 수료증 뷰어 응답을 확인하지 못했습니다.');
          return result;
        };
        let prepared;
        for (let attempt = 0; attempt < 40; attempt++) {
          prepared = await execute('inspect');
          if (prepared.status === 'ready') break;
          if (prepared.status !== 'loading') throw failure('알파 수료증 뷰어가 정상적으로 준비되지 않았습니다.');
          await wait(500);
        }
        if (prepared?.status !== 'ready' || !prepared.reportKey) throw failure('수료증 뷰어 준비 시간이 초과되었습니다. 알파에서 수료증 발급 상태를 확인하세요.');
        const started = await execute('start', prepared.reportKey);
        if (started.status !== 'ready') throw failure('수료증 PDF 저장을 시작하지 못했습니다.');
        let exported;
        for (let attempt = 0; attempt < 30; attempt++) {
          await wait(500); exported = await execute('poll', prepared.reportKey);
          if (exported.status === 'ready') break;
          if (exported.status !== 'pending') throw failure('수료증 PDF 준비 상태를 확인하지 못했습니다.');
        }
        if (exported?.status !== 'ready') throw failure('수료증 PDF 준비 시간이 초과되었습니다. 다시 시도하세요.');
        const pdf = await execute('download', prepared.reportKey);
        if (pdf.status !== 'pdf' || typeof pdf.base64 !== 'string' || pdf.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf.base64)) throw failure('수료증 PDF 파일을 확인하지 못했습니다.');
        const binary = root.atob(pdf.base64), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (bytes.length < 100 || bytes.length > MAX_PDF_BYTES || binary.slice(0, 5) !== '%PDF-' || !binary.slice(-2048).includes('%%EOF')) throw failure('수료증 PDF 파일이 올바르지 않습니다.');
        await check(); return bytes;
      } finally {
        // Never close a preexisting tab or one the user has navigated elsewhere.
        if (Number.isInteger(tabId)) {
          try { const tab = await tabs.get(tabId); if ((tab.pendingUrl || tab.url) === expectedUrl) await tabs.remove(tabId); } catch { /* tab already closed */ }
        }
      }
    }
    return Object.freeze({ fetchPdf });
  }
  const api = Object.freeze({ createClient, reportUrl, reportPageAction, completionDate, REPORT_ORIGIN });
  root.AlphaCertificateAPI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
