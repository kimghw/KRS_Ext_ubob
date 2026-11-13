// Run with Playwright installed, or set PLAYWRIGHT_MODULE to its module path.
// This harness opens only the local popup with mocked Chrome APIs; it never logs in or plays a live course.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const catalog = require('../../src/alpha-catalog.js');
const ids = catalog.defaultsForRole('researcher');
const popupUrl = `${pathToFileURL(path.resolve(__dirname, '../../popup/popup.html'))}?surface=sidepanel`;
const classroomUrl = 'https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=00000000-0000-4000-8000-000000000001&type=ONLINE&sequenceLessonId=00000000-0000-4000-8000-000000000002';
const errors = [];
let browser;

async function fixture(initialRunner = { running: false, phase: 'idle' }) {
  const page = await browser.newPage({ viewport: { width: 380, height: 850 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ ids, initialRunner }) => {
    const listeners = [], requests = [];
    const stores = { local: { popupTab: 'alpha', alphaPreferences: { role: 'researcher', selectedIds: ids },
      alphaRunner: { role: 'researcher', courseIds: ids, mode: 'enrolled', ...initialRunner } }, sync: {}, session: {} };
    const area = name => ({
      async get(keys) {
        const defaults = keys && !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys({ ...defaults, ...stores[name] });
        return Object.fromEntries(names.map(key => [key, key in stores[name] ? stores[name][key] : defaults[key]]));
      },
      async set(values) {
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: stores[name][key], newValue: value }]));
        Object.assign(stores[name], values);
        listeners.forEach(listener => listener(changes, name));
      }
    });
    window.__calls = [];
    window.__reply = (index, response) => requests[index](response);
    window.__setRunner = values => chrome.storage.local.set({ alphaRunner: { ...stores.local.alphaRunner, ...values } });
    window.chrome = {
      storage: { local: area('local'), sync: area('sync'), session: area('session'), onChanged: { addListener(fn) { listeners.push(fn); } } },
      runtime: { sendMessage(message) {
        // 알파 탭을 열 때 보내는 과정별 상태 조회는 실행 제어와 무관하므로 제어 요청 기록에서 뺀다.
        if (message.type === 'alpha-course-status') return Promise.resolve({ ok: true, result: { ok: true } });
        __calls.push(message); return new Promise(resolve => requests.push(resolve));
      } },
      windows: { async getCurrent() { return { id: 1 }; } }, sidePanel: { async open() {} }
    };
  }, { ids, initialRunner });
  await page.goto(popupUrl);
  await page.waitForSelector('.alpha-category');
  return page;
}
const reply = (page, index, response = { ok: true, result: { ok: true } }) => page.evaluate(({ index, response }) => __reply(index, response), { index, response });
const state = (page, values) => page.evaluate(values => __setRunner(values), values);
const calls = page => page.evaluate(() => __calls);

(async () => {
  browser = await chromium.launch({ headless: true });
  const start = await fixture();
  await start.click('#alphaStartEnrolled');
  assert(await start.locator('#alphaStop').isVisible(), 'Stop appears before runner storage updates');
  assert(await start.locator('#alphaStop').isEnabled(), 'Start ACK cannot lock Stop');
  assert(await start.locator('#alphaStartEnrolled').isVisible());
  assert(await start.locator('#alphaStartEnrolled').isDisabled());
  assert.equal(await start.locator('#alphaStartEnrolled').innerText(), '백그라운드 준비 중…');
  await start.locator('#alphaStartEnrolled').dispatchEvent('click');
  assert.equal((await calls(start)).length, 1, 'a duplicate launch is rejected');
  await state(start, { running: true, phase: 'loading', courseTitle: '확인용 과정', lessonTitle: '확인용 강의', message: '영상을 준비합니다.' });
  assert(await start.locator('#alphaPlayerOpen').isDisabled(), 'manual open waits for a known classroom URL');
  await state(start, { url: classroomUrl });
  assert(await start.locator('#alphaPlayerOpen').isEnabled());
  assert(await start.locator('#alphaStop').isEnabled());
  assert(await start.locator('#alphaStartHint').isHidden(), 'no explanatory hint while preparing');
  if (process.env.ALPHA_UI_SCREENSHOT) await start.locator('.alpha-runner').screenshot({ path: process.env.ALPHA_UI_SCREENSHOT });
  await start.click('#alphaStop');
  assert.equal((await calls(start))[1].type, 'alpha-stop');
  assert(await start.locator('#alphaStop').isDisabled(), 'duplicate stop is blocked while stop ACK is pending');
  assert(await start.locator('#alphaPlayerOpen').isDisabled());
  await start.locator('#alphaStop').dispatchEvent('click');
  assert.equal((await calls(start)).length, 2);
  await state(start, { running: false, phase: 'stopped', message: '중지했습니다.' });
  await reply(start, 1);
  await start.waitForFunction(() => !document.getElementById('alphaStartEnrolled').disabled);
  assert.equal(await start.locator('#alphaStartEnrolled').innerText(), '수강 중인 과정 백그라운드 학습');
  await start.click('#alphaStartEnrolled');
  assert.equal((await calls(start)).length, 3, 'confirmed stop allows a fresh launch before stale reply arrives');
  await state(start, { running: true, phase: 'playing', message: '새 실행 재생 중', currentTime: 12, duration: 100 });
  assert.equal(await start.locator('#alphaStartEnrolled').innerText(), '백그라운드 학습 중');
  await reply(start, 0, { ok: false, error: '이전 시작 요청의 늦은 오류' });
  assert(await start.locator('#alphaStartEnrolled').isDisabled(), 'old finally cannot unlock the new launch');
  assert(!(await start.locator('#alphaRunMessage').innerText()).includes('늦은 오류'));
  await start.click('#alphaStop');
  await state(start, { running: false, phase: 'stopped', message: '새 실행 중지됨' });
  await reply(start, 3);
  await reply(start, 2);
  await start.waitForFunction(() => !document.getElementById('alphaStartEnrolled').disabled);
  assert.equal(await start.locator('#alphaRunMessage').innerText(), '새 실행 중지됨');
  await start.close();

  const retry = await fixture({ running: false, phase: 'attention', url: classroomUrl, message: '이전 준비 실패' });
  await retry.click('#alphaRetry');
  assert(await retry.locator('#alphaStop').isVisible());
  assert(await retry.locator('#alphaStop').isEnabled());
  await state(retry, { running: true, phase: 'loading', message: '재시도 준비 중' });
  assert(await retry.locator('#alphaPlayerOpen').isEnabled());
  await retry.click('#alphaPlayerOpen');
  assert.equal((await calls(retry))[1].type, 'alpha-player-open');
  assert(await retry.locator('#alphaPlayerOpen').isDisabled());
  assert(await retry.locator('#alphaStartEnrolled').isDisabled());
  await retry.locator('#alphaPlayerOpen').dispatchEvent('click');
  assert.equal((await calls(retry)).length, 2);
  await state(retry, { running: false, phase: 'attention', message: '학습 화면을 열었습니다.' });
  await reply(retry, 1);
  await retry.waitForFunction(() => !document.getElementById('alphaStartEnrolled').disabled);
  await reply(retry, 0, { ok: false, error: '이전 재시도 응답 오류' });
  assert.equal(await retry.locator('#alphaRunMessage').innerText(), '학습 화면을 열었습니다.');
  assert(await retry.locator('#alphaStartEnrolled').isEnabled());
  await retry.close();

  const failed = await fixture();
  await failed.click('#alphaStart');
  assert(await failed.locator('#alphaStop').isEnabled());
  await reply(failed, 0, { ok: false, error: '시작할 수 없습니다.' });
  await failed.waitForFunction(() => !document.getElementById('alphaStartEnrolled').disabled);
  assert.equal(await failed.locator('#alphaRunMessage').innerText(), '시작할 수 없습니다.');
  assert(await failed.locator('#alphaStop').isHidden());
  await failed.close();

  const cleanup = await fixture({ running: false, phase: 'attention', cleanupPending: true, url: classroomUrl, message: '플레이어 종료 확인이 필요합니다.' });
  assert(await cleanup.locator('#alphaStop').isVisible());
  assert(await cleanup.locator('#alphaStop').isEnabled());
  assert(await cleanup.locator('#alphaStartEnrolled').isDisabled());
  assert(await cleanup.locator('#alphaCertificatesAll').isDisabled());
  assert(await cleanup.locator('#alphaUserName').isDisabled());
  assert(await cleanup.locator('#alphaPlayerOpen').isEnabled(), 'manual open can retry cleanup from attention');
  await cleanup.click('#alphaStop');
  assert.equal((await calls(cleanup))[0].type, 'alpha-stop');
  await state(cleanup, { running: false, phase: 'stopped', cleanupPending: false, message: '플레이어를 종료했습니다.' });
  await reply(cleanup, 0);
  await cleanup.waitForFunction(() => !document.getElementById('alphaStartEnrolled').disabled);
  assert(await cleanup.locator('#alphaStop').isHidden());
  assert(await cleanup.locator('#alphaCertificatesAll').isEnabled());
  await cleanup.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['Stop available during pending start/retry before storage update', 'primary action remains visible with preparing/playing state', 'duplicate launch/stop/open blocked', 'pending manual open requires a classroom URL', 'manual open works while launch is held', 'confirmed stop/open release old launch lock', 'stale responses do not overwrite newer state or clear newer pending launch', 'startup failure restores launch controls', 'cleanupPending keeps Stop accessible and blocks new tasks until confirmed cleanup'], pageErrors: errors }, null, 2));
  await browser.close();
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
