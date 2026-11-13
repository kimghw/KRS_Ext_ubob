const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createClient, reportUrl, reportPageAction, completionDate } = require('../src/alpha-certificate-api.js');

const course = { id: 'b01f4226-8e02-45e4-b18e-705431e24628', sequenceId: '355065ce-0cd9-4bd7-964d-65d2eb18e0cf', title: 'Test course' };
const registrationId = '9a535b6c-4b45-4b15-a457-4b02ec576b26';
const companyId = '8df138c0-c70a-4e32-ae04-5038b0d06a41';
const input = { course, registrationId, loginId: 'learner' };
const registration = () => ({ id: registrationId, status: 'COMPLETED',
  sequence: { id: course.sequenceId, subject: { id: course.id, type: 4, name: 'Official course' } },
  certificateInfo: { certificateNumber: 'KIRD-2026-12345' }, completionInfo: { dateTime: '2026-11-13T12:00:00' },
  registrationCertificate: { displayType: 'COMMON' }, registrationCertificateMemberCompany: [],
  requestInfo: { companyId, user: { loginId: 'learner' } } });
const pdfText = `%PDF-1.7\n${'issued document '.repeat(20)}\n%%EOF\n`;
const pdfBytes = new TextEncoder().encode(pdfText);
const pdfResult = { status: 'pdf', base64: Buffer.from(pdfBytes).toString('base64') };
const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

function clientHarness({ metadata = registration(), actions = {}, shouldStop = () => false } = {}) {
  const calls = [], removed = [], waits = [];
  let currentTab;
  const tabs = {
    create: async options => { calls.push(['create', options]); currentTab = { id: 40, url: options.url, status: 'complete' }; return currentTab; },
    get: async () => ({ ...currentTab }), remove: async id => removed.push(id),
  };
  const fetchImpl = async (url, options) => {
    calls.push(['metadata', url, options]); return jsonResponse({ data: { registration: metadata } });
  };
  const scripting = { executeScript: async request => {
    assert.equal(request.world, 'MAIN'); assert.equal(request.target.tabId, 40); assert.equal(request.func, reportPageAction);
    const args = request.args[0]; calls.push(['script', args.action]);
    const result = actions[args.action] ? await actions[args.action](args, currentTab)
      : args.action === 'inspect' ? { status: 'ready', reportKey: 'report-own-key' }
      : args.action === 'download' ? pdfResult : { status: 'ready' };
    return [{ frameId: 0, result }];
  } };
  const client = createClient({ fetchImpl, tabs, scripting, getCsrfToken: async () => 'test%2Dcsrf', wait: async ms => waits.push(ms) });
  return { client, calls, removed, waits, run: () => client.fetchPdf({ ...input, shouldStop }), current: () => currentTab };
}

test('certificate uses only the issued exact account/course and production template', () => {
  const url = new URL(reportUrl(input, registration()));
  assert.equal(url.origin, 'https://report.alpha-campus.kr'); assert.equal(url.pathname, '/ClipReport5/report.jsp');
  assert.equal(url.searchParams.get('ID'), registrationId); assert.equal(url.searchParams.get('crfNm'), 'onlinesuryo_new');
  assert.equal(url.searchParams.get('CID'), companyId); assert.equal(url.searchParams.get('URL'), 'alpha-campus.kr');
  for (const change of [{ status: 'APPROVED' }, { certificateInfo: null }, { certificateInfo: { certificateNumber: '' } },
    { requestInfo: { companyId, user: { loginId: 'other' } } }, { id: course.id },
    { sequence: { id: course.id, subject: { id: course.id, type: 4 } } },
    { completionInfo: { dateTime: 'invalid' } }, { registrationCertificate: { displayType: 'UNKNOWN' } }]) {
    assert.throws(() => reportUrl(input, { ...registration(), ...change }));
  }
});

test('all official templates and the Korean legacy cutoff are preserved', () => {
  const mapping = { COMMON: 'onlinesuryo', COMMON_RESEARCH_NUMBER: 'onlinesuryo1', RESEARCH_ETHICS: 'onlinesuryo2',
    RESEARCH_ETHICS_GRADUATE: 'onlinesuryo2', OFFLINE_COMMON: 'offsuryo', OFFLINE_IRIS_LINK: 'offsuryo1' };
  for (const [type, name] of Object.entries(mapping)) {
    const item = registration(); item.registrationCertificate.displayType = type;
    item.completionInfo.dateTime = '2024-07-31T23:59:59+09:00';
    assert.equal(new URL(reportUrl(input, item)).searchParams.get('crfNm'), name);
    item.completionInfo.dateTime = '2024-07-31T15:00:00Z';
    assert.equal(new URL(reportUrl(input, item)).searchParams.get('crfNm'), `${name}_new`);
  }
  assert.ok(Number.isNaN(completionDate('2026-02-30')));
  const item = registration(); item.registrationCertificateMemberCompany = [{ companyId: course.id }];
  assert.equal(new URL(reportUrl(input, item)).searchParams.get('CID'), course.id);
  item.registrationCertificateMemberCompany.push({ companyId });
  assert.throws(() => reportUrl(input, item), /소속 선택/);
});

test('all-certificates verifies the actual course type for historical online and offline courses', () => {
  for (const type of [1, 2, 3, 4, 5]) {
    const item = registration();
    item.sequence.subject.type = type;
    item.registrationCertificate.displayType = type === 1 ? 'OFFLINE_COMMON' : 'COMMON';
    const listed = { ...input, course: { ...course, type } };
    assert.equal(new URL(reportUrl(listed, item)).searchParams.get('crfNm'), type === 1 ? 'offsuryo_new' : 'onlinesuryo_new');
    assert.throws(() => reportUrl({ ...input, course: { ...course, type: type === 1 ? 2 : 1 } }, item));
    assert.throws(() => reportUrl(listed, { ...item, status: 'APPROVED' }));
    assert.throws(() => reportUrl(listed, { ...item, requestInfo: { user: { loginId: 'someone-else' } } }));
  }
  const unsupported = registration(); unsupported.sequence.subject.type = 6;
  assert.throws(() => reportUrl({ ...input, course: { ...course, type: 6 } }, unsupported));
});

test('provider verifies metadata then exports original bytes and closes only its new tab', async () => {
  const h = clientHarness(); const bytes = await h.run();
  assert.deepEqual(bytes, pdfBytes);
  assert.deepEqual(h.calls.filter(x => x[0] === 'script').map(x => x[1]), ['inspect', 'start', 'poll', 'download']);
  assert.deepEqual(h.removed, [40]); assert.equal(h.calls.find(x => x[0] === 'create')[1].active, false);
  const metadata = h.calls[0]; assert.equal(metadata[1], 'https://alpha-campus.kr/api/graphql');
  assert.equal(metadata[2].headers['X-XSRF-TOKEN'], 'test-csrf'); assert.equal(metadata[2].redirect, 'error');
  assert.deepEqual(JSON.parse(metadata[2].body).variables, { id: registrationId });
  assert.match(JSON.parse(metadata[2].body).query, /certificateInfo/);
});

test('not issued or different account metadata never opens the report viewer', async () => {
  for (const metadata of [{ ...registration(), certificateInfo: null },
    { ...registration(), requestInfo: { user: { loginId: 'other' } } }]) {
    const h = clientHarness({ metadata }); await assert.rejects(h.run());
    assert.equal(h.calls.filter(x => x[0] === 'create').length, 0);
  }
});

test('viewer loading and PDF polling are bounded without retrying the export start', async () => {
  let inspected = 0, polled = 0;
  const h = clientHarness({ actions: { inspect: async () => ++inspected < 3 ? { status: 'loading' } : { status: 'ready', reportKey: 'key' },
    poll: async () => ++polled < 3 ? { status: 'pending' } : { status: 'ready' } } });
  await h.run(); assert.equal(inspected, 3); assert.equal(polled, 3);
  assert.equal(h.calls.filter(x => x[0] === 'script' && x[1] === 'start').length, 1);
  const pending = clientHarness({ actions: { poll: async () => ({ status: 'pending' }) } });
  await assert.rejects(pending.run(), /준비 시간이 초과/);
  assert.equal(pending.calls.filter(x => x[0] === 'script' && x[1] === 'poll').length, 30);
  assert.equal(pending.calls.filter(x => x[0] === 'script' && x[1] === 'download').length, 0);
  assert.deepEqual(pending.removed, [40]);
});

test('cancellation between export steps stops further requests and closes own tab', async () => {
  let stop = false;
  const h = clientHarness({ shouldStop: () => stop, actions: { start: async () => { stop = true; return { status: 'ready' }; } } });
  await assert.rejects(h.run(), error => error.code === 'CANCELLED');
  assert.deepEqual(h.calls.filter(x => x[0] === 'script').map(x => x[1]), ['inspect', 'start']);
  assert.deepEqual(h.removed, [40]);
});

test('user navigation is never closed and prevents another export request', async () => {
  const h = clientHarness({ actions: { inspect: async (_args, tab) => {
    tab.pendingUrl = 'https://alpha-campus.kr/my/evidenceDocument'; return { status: 'ready', reportKey: 'key' };
  } } });
  await assert.rejects(h.run(), /페이지가 변경/); assert.deepEqual(h.removed, []);
  assert.deepEqual(h.calls.filter(x => x[0] === 'script').map(x => x[1]), ['inspect']);
});

function runtimeHarness({ viewerChanges = {}, fetchImpl, locationUrl, options = {} } = {}) {
  const expectedUrl = reportUrl(input, registration()), requests = [];
  const viewer = { objReportInfo: { strReportKey: 'own-report-key', isStatus: true, isEndReport: true, nCode: 200 },
    objPageInfo: { nPageCount: 1 }, strServerPath: './report_server.jsp', strDownloadFormMethod: 'post',
    objSaveExportOptionInfo: { pdf: { userpNew: '', textToImage: false, importOriginImage: false, removeHyperlink: false,
      memoExport: false, memoTransparency: 1, useDefaultFont: false, isPDFPrintChartAWT: true, isNotAllowCopy: false } }, ...viewerChanges };
  const location = new URL(locationUrl || expectedUrl);
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout,
    btoa, location, m_reportHashMap: { 'own-report-key': viewer }, ...options,
    fetch: async (url, request) => {
      requests.push([url, request]);
      if (fetchImpl) return fetchImpl(url, request);
      const action = new URLSearchParams(request.body).get('ClipType');
      return action === 'saveExportDownload' ? new Response(pdfBytes, { headers: { 'Content-Type': 'application/pdf' } })
        : jsonResponse({ id: action === 'saveExport' ? 7 : 4, resValue: { status: true, event: 200 } });
    } });
  const invoke = action => vm.runInContext(`(${reportPageAction.toString()})`, context)({ expectedUrl, action,
    reportKey: 'own-report-key', fileName: 'ALPHA_certificate' });
  return { invoke, requests, viewer, expectedUrl };
}

test('fixed MAIN-world script uses actual live viewer key/options and official PDF protocol', async () => {
  const h = runtimeHarness();
  assert.equal((await h.invoke('inspect')).status, 'ready');
  assert.equal((await h.invoke('start')).status, 'ready');
  assert.equal((await h.invoke('poll')).status, 'ready');
  const pdf = await h.invoke('download'); assert.equal(pdf.status, 'pdf'); assert.equal(pdf.base64, pdfResult.base64);
  assert.equal(h.requests.length, 3);
  const [url, request] = h.requests[0]; assert.equal(url, 'https://report.alpha-campus.kr/ClipReport5/report_server.jsp');
  assert.equal(request.method, 'POST'); assert.equal(request.credentials, 'include'); assert.equal(request.redirect, 'error');
  const body = new URLSearchParams(request.body), data = JSON.parse(body.get('ClipData'));
  assert.equal(body.get('ClipType'), 'saveExport'); assert.equal(data.reportkey, 'own-report-key'); assert.equal(data.exportType, 3);
  assert.equal(data.startNum, 1); assert.equal(data.endNum, 1); assert.deepEqual(data.option, h.viewer.objSaveExportOptionInfo.pdf);
  assert.equal(new URLSearchParams(h.requests[1][1].body).get('ClipType'), 'fileDownloadCheck');
  assert.equal(new URLSearchParams(h.requests[2][1].body).get('ClipType'), 'saveExportDownload');
});

test('runtime rejects foreign endpoint, changed page, stale document and failed viewer without requests', async () => {
  for (const settings of [{ viewerChanges: { strServerPath: 'https://elsewhere.example/report_server.jsp' } },
    { viewerChanges: { strServerPath: '/other/report_server.jsp' } }, { locationUrl: 'https://report.alpha-campus.kr/other' },
    { viewerChanges: { objReportInfo: { strReportKey: 'other', isStatus: true, isEndReport: true } } },
    { viewerChanges: { objReportInfo: { strReportKey: 'own-report-key', isStatus: false, isEndReport: true } } }]) {
    const h = runtimeHarness(settings); assert.equal((await h.invoke('start')).status, 'error'); assert.equal(h.requests.length, 0);
  }
});

test('runtime handles pending export, unavailable report and HTML masquerading as PDF', async () => {
  const pending = runtimeHarness({ fetchImpl: async () => jsonResponse({ id: 4, resValue: { status: false, progress: 20 } }) });
  assert.equal((await pending.invoke('poll')).status, 'pending');
  const failed = runtimeHarness({ fetchImpl: async () => jsonResponse({ id: 4, resValue: { status: true, event: 404 } }) });
  assert.equal((await failed.invoke('poll')).status, 'error');
  const html = runtimeHarness({ fetchImpl: async () => new Response('<html>Login needed</html>') });
  assert.equal((await html.invoke('download')).status, 'error');
  const errorPage = clientHarness({ actions: { inspect: async () => ({ status: 'loading' }) } });
  await assert.rejects(errorPage.run(), /뷰어 준비 시간/); assert.deepEqual(errorPage.removed, [40]);
});

test('official optional report parameters remain on the same server and cannot replace ClipData', async () => {
  const h = runtimeHarness({ viewerChanges: { m_postParam: { getParam: () => '&sessionParam=opaque' } },
    options: { mCR_isAddRequestHeader: true, mCR_strRequestHeaderName: 'X-Report-Token', mCR_strRequestHeaderValue: 'opaque' } });
  assert.equal((await h.invoke('start')).status, 'ready');
  assert.equal(new URLSearchParams(h.requests[0][1].body).get('sessionParam'), 'opaque');
  assert.equal(h.requests[0][1].headers['X-Report-Token'], 'opaque');
  const bad = runtimeHarness({ viewerChanges: { m_postParam: { getParam: () => '&ClipData=replace' } } });
  assert.equal((await bad.invoke('start')).status, 'error'); assert.equal(bad.requests.length, 0);
});
