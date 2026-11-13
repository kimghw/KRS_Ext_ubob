// 신청은 사용자 버튼으로만 시작한다. 저장된 조회 결과를 신뢰해 재신청하지 않는다.
var AlphaService = (() => {
  'use strict';

  function create({ catalog, api, storage, tabs, windows }) {
    let active = false;
    // 워커 종료 중 전송된 요청을 자동 재전송하지 않고 사이트에서 다시 확인한다.
    const ready = storage.get('alphaState').then(async ({ alphaState }) => {
      if (!alphaState?.busy) return;
      await storage.set({ alphaState: {
        ...alphaState, busy: false,
        message: '이전 작업이 중단되었습니다. 신청 가능 여부를 다시 확인하세요.',
        items: (alphaState.items || []).map(item => ({ ...item, canEnroll: false,
          status: ['submitting', 'checking'].includes(item.status) ? 'unconfirmed' : item.status })),
      } });
    });

    const publicItem = (course, result) => ({
      courseId: course.id, status: result.status || 'unknown',
      message: result.message || '',
      canEnroll: result.status === 'available' && result.canEnroll === true,
    });
    const failure = (course, message, status = 'error') => publicItem(course, { status, message });
    const errorText = error => error?.message || '알파캠퍼스 요청을 처리하지 못했습니다.';
    const sameUser = (a, b) => a?.authenticated && b?.authenticated &&
      !!a.loginId && a.loginId === b.loginId;

    async function run({ role, courseIds }, enroll, { shouldStop = () => false } = {}) {
      await ready;
      if (active) throw new Error('알파캠퍼스 작업이 진행 중입니다. 완료 후 다시 시도하세요.');
      const selection = catalog.validateSelection(role, courseIds);
      if (!selection.ok) throw new Error(selection.errors.join('\n'));
      active = true;
      const state = {
        role, courseIds: selection.courses.map(c => c.id), busy: true,
        checkedAt: null, operation: enroll ? 'enroll' : 'check',
        message: enroll ? '신청 가능 여부를 확인하고 순서대로 신청합니다.' : '알파캠퍼스에서 신청 가능 여부를 확인합니다.',
        items: selection.courses.map(c => failure(c, '확인 대기', 'checking')),
      };
      const save = () => storage.set({ alphaState: structuredClone(state) });
      const cancelled = () => {
        state.items = state.items.map(item => ({ ...item, canEnroll: false,
          ...(item.status === 'checking' ? { status: 'unknown', message: '자동 실행을 중지했습니다.' } : {}) }));
        state.message = '자동 실행을 중지했습니다. 전송된 신청은 취소하지 않습니다.';
        return { ok: false, cancelled: true, message: state.message };
      };
      let currentIndex = -1;
      try {
        await save();
        if (shouldStop()) return cancelled();
        const user = await api.session();
        if (!user.authenticated || !user.loginId) {
          state.items = selection.courses.map(c => failure(c, '알파캠퍼스에 로그인한 뒤 다시 확인하세요.', 'login-required'));
          state.message = '알파캠퍼스 로그인이 필요합니다.';
          return { ok: false, message: state.message };
        }
        for (let index = 0; index < selection.courses.length; index++) {
          if (shouldStop()) return cancelled();
          currentIndex = index;
          const course = selection.courses[index];
          let inspected;
          try {
            inspected = await api.inspect(course);
            state.items[index] = publicItem(course, inspected);
          } catch (error) {
            state.items[index] = failure(course, errorText(error));
          }
          // 조회 결과도 동일 계정의 결과여야 한다. 계정이 바뀌면 기존 신청 가능 표시는 모두 비운다.
          if (!sameUser(user, await api.session())) {
            state.items = state.items.map(item => ({ ...item, canEnroll: false }));
            state.items[index] = failure(course, '로그인 계정이 바뀌거나 세션이 만료되었습니다. 다시 확인하세요.', 'login-required');
            for (let next = index + 1; next < state.items.length; next++) {
              state.items[next] = failure(selection.courses[next], '계정 변경으로 작업을 중단했습니다.', 'unknown');
            }
            state.message = '로그인 상태가 변경되어 작업을 중단했습니다. 현재 계정으로 다시 확인하세요.';
            return { ok: false, message: state.message };
          }
          await save();
          if (!enroll || !state.items[index].canEnroll) continue;
          if (shouldStop()) return cancelled();

          state.items[index] = failure(course, '신청 요청 중…', 'submitting');
          await save();
          if (shouldStop()) {
            state.items[index] = failure(course, '신청을 전송하기 전에 중지했습니다.', 'unknown');
            return cancelled();
          }
          let submissionError;
          try {
            await api.enroll(course, inspected);
          } catch (error) {
            submissionError = error;
          }
          // 응답 유실도 있을 수 있으므로 변이 결과만으로 성공/실패를 단정하지 않는다.
          let verified;
          try {
            if (sameUser(user, await api.session())) {
              const result = await api.inspect(course);
              // 확인 요청 도중 계정이 바뀐 경우에도 다른 계정의 신청 내역을 성공으로 표시하지 않는다.
              if (sameUser(user, await api.session())) verified = result;
            }
          } catch { /* 아래에서 결과 미확인으로 표시 */ }
          if (verified && ['enrolled', 'completed'].includes(verified.status)) {
            state.items[index] = publicItem(course, verified);
          } else {
            state.items[index] = failure(course,
              submissionError ? `${errorText(submissionError)} 사이트의 신청 내역을 확인하세요.`
                : '요청을 보냈지만 신청 내역을 확인하지 못했습니다. 사이트에서 확인한 뒤 다시 조회하세요.',
              'unconfirmed');
            // 미확인 제출 이후에는 연속 제출하지 않는다. 자동 재시도도 하지 않는다.
            for (let next = index + 1; next < state.items.length; next++) {
              state.items[next] = failure(selection.courses[next], '앞선 과정의 신청 결과를 먼저 확인하세요.', 'unknown');
            }
            state.message = '신청 결과 확인이 필요해 나머지 신청을 중단했습니다.';
            return { ok: false, message: state.message };
          }
          await save();
        }
        const available = state.items.filter(item => item.canEnroll).length;
        const enrolled = state.items.filter(item => ['enrolled', 'completed'].includes(item.status)).length;
        const attention = state.items.length - available - enrolled;
        state.message = enroll
          ? `신청·수료 확인 ${enrolled}개${attention ? ` · 확인 필요 ${attention}개` : ''}`
          : `자동 신청 가능 ${available}개 · 신청·수료 확인 ${enrolled}개${attention ? ` · 확인 필요 ${attention}개` : ''}`;
        return { ok: attention === 0, message: state.message };
      } catch (error) {
        state.message = errorText(error);
        state.items = state.items.map((item, index) =>
          ['checking', 'submitting'].includes(item.status)
            ? failure(selection.courses[index], state.message, index === currentIndex && enroll ? 'unconfirmed' : 'error')
            : { ...item, canEnroll: false });
        throw error;
      } finally {
        state.busy = false;
        state.checkedAt = Date.now();
        try { await save(); } finally { active = false; }
      }
    }

    async function open({ courseId } = {}) {
      const course = courseId && catalog.courses.find(c => c.id === courseId);
      if (courseId && !course) throw new Error('첨부 목록의 알파캠퍼스 과정만 열 수 있습니다.');
      const url = course ? course.url : `${catalog.BASE_URL}/login`;
      const existing = (await tabs.query({ url: `${catalog.BASE_URL}/*` }))
        .find(tab => tab.url === url);
      if (existing) {
        await tabs.update(existing.id, { active: true });
        if (windows && existing.windowId != null) await windows.update(existing.windowId, { focused: true });
      } else await tabs.create({ url });
    }

    return { check: (msg, options) => run(msg, false, options), enroll: (msg, options) => run(msg, true, options), open };
  }

  return { create };
})();
globalThis.AlphaService = AlphaService;
if (typeof module !== 'undefined' && module.exports) module.exports = AlphaService;
