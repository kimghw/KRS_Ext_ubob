// 현재 계정의 실제 수료 이력을 순회한다. 발급·다운로드 검증과 중복 방지는 certificates가 담당한다.
var AlphaCertificateBatch = (() => {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const STATUSES = new Set(['preparing', 'downloading', 'complete', 'failed', 'interrupted', 'missing', 'unconfirmed']);
  const safeMessage = error => String(error?.message || error || '수료증 처리 중 오류가 발생했습니다.')
    .replace(/Bearer\s+[^\s]+/gi, '[인증정보]')
    .replace(/((?:password|token|cookie|authorization|reportkey)\s*[:=]\s*)[^\s&,;]+/gi, '$1[숨김]')
    .replace(/data:[^\s]+/g, '[PDF 데이터]').replace(/[\r\n\t]+/g, ' ').slice(0, 400);

  function create({ api, auth, list, certificates, storage, now = Date.now, id = () => crypto.randomUUID() }) {
    let state = { busy: false, phase: 'idle', runId: null, loginId: null, scanned: 0,
      total: 0, processed: 0, currentTitle: '', items: [], message: '', updatedAt: now() };
    let job = null, starting = false, stopVersion = 0, writes = Promise.resolve();
    const save = () => {
      state.updatedAt = now();
      const snapshot = structuredClone(state);
      writes = writes.catch(() => {}).then(() => storage.set({ alphaCertificateBatch: snapshot }));
      return writes;
    };
    const ready = storage.get('alphaCertificateBatch').then(async value => {
      if (value?.alphaCertificateBatch && typeof value.alphaCertificateBatch === 'object') {
        state = { ...state, ...value.alphaCertificateBatch };
      }
      if (state.busy) {
        state = { ...state, busy: false, phase: 'interrupted', currentTitle: '',
          message: '전체 수료증 저장 작업이 중단되었습니다. 다시 시작하면 다운로드 이력을 확인하고 이어서 처리합니다.' };
        await save();
      }
    });
    // 초기 저장소 오류는 public 메서드 호출 시 전달하되, 그 전까지 미처리 거부가 되지 않게 한다.
    ready.catch(() => {});
    // 올해(한국 시간)에 신청한 수료 과정만 받는다. 지난 연도까지 모두 받으면 너무 많다.
    const koreaYear = () => new Date(now() + 9 * 3600e3).getUTCFullYear();
    const current = (runId, version) => state.runId === runId && state.busy && stopVersion === version;
    async function checkAccount(loginId) {
      const session = await api.session();
      if (!session?.authenticated || session.loginId !== loginId) {
        throw new Error('알파 로그인 계정이 바뀌거나 만료되어 전체 수료증 저장을 중단했습니다.');
      }
    }
    function entriesFrom(value) {
      if (!Array.isArray(value)) throw new Error('수료한 교육 목록의 응답 형식을 확인하지 못했습니다.');
      const found = new Map();
      for (const entry of value) {
        if (!UUID.test(entry?.registrationId) || !UUID.test(entry.course?.id) || !UUID.test(entry.course?.sequenceId)) {
          throw new Error('수료한 교육의 등록 정보를 확인하지 못했습니다.');
        }
        const previous = found.get(entry.registrationId);
        if (previous && (previous.course.id !== entry.course.id || previous.course.sequenceId !== entry.course.sequenceId)) {
          throw new Error('같은 등록의 교육 정보가 서로 달라 수료증 저장을 중단했습니다.');
        }
        if (!previous) found.set(entry.registrationId, entry);
      }
      return [...found.values()];
    }
    async function run(runId, version) {
      const shouldStop = () => !current(runId, version);
      if (shouldStop()) return;
      const user = await auth.ensureLoggedIn();
      if (shouldStop()) return;
      if (!user?.authenticated || typeof user.loginId !== 'string' || !user.loginId) {
        throw new Error('전체 수료증을 조회할 알파 로그인 계정을 확인하지 못했습니다.');
      }
      const loginId = user.loginId;
      state.loginId = loginId; await save();
      if (shouldStop()) return;
      await checkAccount(loginId);
      if (shouldStop()) return;
      const listed = await list.listCompleted({ loginId, year: state.year, shouldStop, onPage: async progress => {
        if (shouldStop() || state.phase !== 'listing') return;
        if (Number.isInteger(progress?.scanned) && progress.scanned >= 0) state.scanned = Math.max(state.scanned, progress.scanned);
        if (Number.isInteger(progress?.total) && progress.total >= 0) state.total = progress.total;
        state.message = `수료 이력에서 ${state.year}년 신청 과정을 찾고 있습니다. ${state.scanned}개 확인`;
        await save();
      } });
      if (shouldStop()) return;
      const entries = entriesFrom(listed);
      await checkAccount(loginId);
      if (shouldStop()) return;
      state.total = entries.length;
      state.scanned = Math.max(state.scanned, entries.length);
      state.phase = 'downloading';
      state.items = entries.map(entry => ({ registrationId: entry.registrationId, courseId: entry.course.id,
        title: entry.course.title || '교육', status: 'pending', message: '저장 대기' }));
      await save();
      for (let index = 0; index < entries.length; index++) {
        if (shouldStop()) return;
        await checkAccount(loginId);
        if (shouldStop()) return;
        const entry = entries[index];
        state.currentTitle = entry.course.title || '교육';
        state.message = `${index + 1}/${entries.length} · ${state.currentTitle} 수료증을 확인합니다.`;
        await save();
        if (shouldStop()) return;
        let result;
        try {
          result = await certificates.ensureListed({ course: entry.course, registrationId: entry.registrationId,
            loginId, shouldStop, retry: true });
        } catch (error) {
          result = { status: 'failed', message: safeMessage(error) };
        }
        // 중지 직전 시작된 다운로드의 실제 결과는 보존하되 다음 과정은 실행하지 않는다.
        if (state.runId !== runId) return;
        const valid = STATUSES.has(result?.status);
        state.items[index] = { ...state.items[index], status: valid ? result.status : 'failed',
          message: valid ? safeMessage(result.message || '수료증 다운로드 상태를 확인하세요.') : '수료증 저장 결과를 확인하지 못했습니다.' };
        state.processed = index + 1;
        await save();
        if (shouldStop()) return;
        await checkAccount(loginId);
        if (shouldStop()) return;
      }
      if (shouldStop()) return;
      const complete = state.items.filter(item => item.status === 'complete').length;
      const downloading = state.items.filter(item => ['preparing', 'downloading'].includes(item.status)).length;
      const failed = state.total - complete - downloading;
      state = { ...state, busy: false, phase: 'done', currentTitle: '',
        message: state.total
          ? `수료증 ${state.total}개 처리 · 저장 완료 ${complete}개 · 다운로드 중 ${downloading}개 · 확인 필요 ${failed}개`
          : `${state.year}년에 수강한 강의 중 수료한 교육이 없습니다.` };
      await save();
    }
    async function start() {
      const version = stopVersion;
      await ready;
      if (version !== stopVersion) return { ok: false, cancelled: true, message: '전체 수료증 저장을 중지했습니다.' };
      if (starting || job || state.busy) throw new Error('전체 수료증 저장 작업이 진행 중입니다.');
      starting = true;
      try {
        const runId = id(), year = koreaYear();
        state = { busy: true, phase: 'listing', runId, year, loginId: null, scanned: 0, total: 0,
          processed: 0, currentTitle: '', items: [], message: `${year}년에 수강한 강의의 수료 이력을 조회합니다.`, updatedAt: now() };
        const initial = save();
        let running;
        running = initial.then(() => run(runId, version)).catch(async error => {
          if (!current(runId, version)) return;
          state = { ...state, busy: false, phase: 'error', currentTitle: '', message: safeMessage(error) };
          await save();
        }).finally(async () => {
          try {
            if (state.runId === runId && stopVersion !== version) {
              state = { ...state, busy: false, phase: 'stopped', currentTitle: '',
                message: `전체 수료증 저장을 중지했습니다. ${state.processed}/${state.total}개 처리했으며 시작된 다운로드는 유지됩니다.` };
              await save();
            }
          } finally { if (job === running) job = null; }
        }).catch(() => {});
        job = running;
        await initial;
        return { ok: true, message: `${year}년 수강한 강의의 수료증 저장을 시작했습니다.` };
      } finally { starting = false; }
    }
    async function stop() {
      stopVersion++;
      await ready;
      const working = !!job || starting;
      state = { ...state, busy: working, phase: working ? 'stopping' : 'stopped',
        message: working ? '처리 중인 수료증 요청을 확인한 뒤 중지합니다.' : '전체 수료증 저장을 중지했습니다.' };
      await save();
      return { ok: true, message: state.message };
    }
    return { start, stop, ready,
      getState: async () => { await ready; return structuredClone(state); },
      isBusy: async () => { await ready; return !!job || starting || state.busy; } };
  }
  return { create };
})();
if (typeof globalThis !== 'undefined') globalThis.AlphaCertificateBatch = AlphaCertificateBatch;
if (typeof module !== 'undefined' && module.exports) module.exports = AlphaCertificateBatch;
