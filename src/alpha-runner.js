// 알파 자동 실행: 정상 로그인/신청 뒤 숨겨진 확장 호스트의 강의실에서 실제 영상을 재생한다.
// 진도 기록은 사이트 플레이어가 담당하며, 이 모듈은 조회 결과로만 다음 강의를 선택한다.
var AlphaRunner = (() => {
  'use strict';
  const ALARM = 'alpha-player-watchdog';
  const PLAYER_PATH = '/my/classRoom/classRoomDetail';
  // 숨겨진 플레이어가 사라지거나 멈췄을 때 사용자 확인 없이 다시 여는 횟수 제한 (10분 안에 3번까지).
  const RECOVERY_LIMIT = 3;
  const RECOVERY_WINDOW = 10 * 60 * 1000;
  // 로그인이 만료됐을 때 사용자 확인 없이 다시 로그인하는 횟수 제한 (30분 안에 3번까지).
  const RELOGIN_LIMIT = 3;
  const RELOGIN_WINDOW = 30 * 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const WATCHED = ['loading', 'playing', 'rest', 'offhours'];
  const durationText = seconds => {
    const minutes = Math.floor(seconds / 60), rest = seconds % 60;
    return minutes ? (rest ? `${minutes}분 ${rest}초` : `${minutes}분`) : `${rest}초`;
  };

  // schedule(): 사이드 패널 상단의 근무 시간·휴식 설정. allowed가 false면 근무 시간 밖, rest는 휴식 범위(초) [최소, 최대].
  function create({ catalog, api, auth, service, learning, certificates, host, storage, tabs, windows, alarms,
    notify = async () => {}, now = Date.now, id = () => crypto.randomUUID(),
    schedule = async () => ({ allowed: true, resumeAt: 0, resumeLabel: '', rest: null }), random = Math.random,
    // survey: 과정별 "자동 설문" 예약. reserved(courseId)가 참이면 영상이 끝난 과정의 설문을 auto(course)로 제출한다.
    survey = null }) {
    let state = { running: false, phase: 'idle', message: '' };
    let job = null;
    let advancing = null;
    let renewing = null;
    let stopped = false;
    let stopVersion = 0;
    let writes = Promise.resolve();
    const save = () => {
      const snapshot = structuredClone(state);
      writes = writes.catch(() => {}).then(() => storage.set({ alphaRunner: snapshot }));
      return writes;
    };
    const ready = storage.get('alphaRunner').then(async result => {
      state = result.alphaRunner || state;
      if (state.running && ['login', 'enrolling', 'stopping', 'checking-survey', 'checking-enrolled', 'certificate'].includes(state.phase)) {
        const checkingSurvey = state.phase === 'checking-survey';
        state = { ...state, running: false, phase: 'attention',
          message: checkingSurvey ? '설문 완료 확인이 중단되었습니다. 완료 확인 후 계속 버튼을 다시 눌러 주세요.'
            : '자동 실행 준비가 중단되었습니다. 다시 시도하면 현재 신청 내역부터 확인합니다.' };
        await save();
      } else if (state.running && ['loading', 'playing'].includes(state.phase)) {
        if (state.transport !== 'offscreen') {
          state = { ...state, running: false, phase: 'attention', attentionReason: null,
            message: '알파 재생 방식이 숨겨진 백그라운드 플레이어로 변경되었습니다. 다시 시도를 눌러 시작하세요.' };
          await save();
        } else await alarms.create(ALARM, { periodInMinutes: 0.5 });
      } else if (state.running && ['rest', 'offhours'].includes(state.phase)) {
        // 휴식·근무 시간 대기 중에는 플레이어가 없다. 감시 알람만 되살려 때가 되면 이어서 재생한다.
        await alarms.create(ALARM, { periodInMinutes: 0.5 });
      }
    });
    const current = runId => state.runId === runId && state.running && !stopped;
    const validClassroomUrl = value => {
      try {
        const url = new URL(value);
        return url.origin === catalog.BASE_URL && url.pathname === PLAYER_PATH &&
          !url.username && !url.password && url.searchParams.get('type') === 'ONLINE' &&
          UUID.test(url.searchParams.get('registrationId')) &&
          (!url.searchParams.has('sequenceLessonId') || UUID.test(url.searchParams.get('sequenceLessonId')));
      } catch { return false; }
    };
    const validPlayerUrl = value => validClassroomUrl(value) &&
      UUID.test(new URL(value).searchParams.get('sequenceLessonId'));
    const samePlayerUrl = (a, b) => {
      if (!validPlayerUrl(a) || !validPlayerUrl(b)) return false;
      const one = new URL(a), two = new URL(b);
      return ['registrationId', 'sequenceLessonId'].every(key => one.searchParams.get(key) === two.searchParams.get(key));
    };
    const pause = async () => {
      await host.pause();
    };
    async function attention(message, runId = state.runId, reason = null) {
      if (!current(runId)) return false;
      state = { ...state, running: false, phase: 'attention', attentionReason: reason, cleanupPending: true, message };
      // 플레이어 응답이 없어도 화면의 실행 잠금부터 해제한다.
      await save();
      if (runId !== state.runId || stopped) return false;
      let paused = true;
      try { await pause(); } catch { paused = false; }
      if (runId !== state.runId || stopped) return false;
      await alarms.clear(ALARM).catch(() => {});
      state.cleanupPending = !paused;
      if (!paused) {
        state.message += ' 숨겨진 플레이어 종료를 확인하지 못했습니다. 중지를 다시 누르거나 확장을 새로고침하세요.';
      }
      await save();
      await notify('알파 자동 실행 확인 필요', state.message).catch(() => {});
      return paused;
    }
    // 로그인이 만료되면 멈추지 않고 저장한 계정으로 다시 로그인한다. 사이드 패널의 "로그인 확인"과 같은 로그인이지만
    // 강제하지 않으므로, 직전에 거절된 계정은 다시 보내지 않는다(실패 횟수 제한·중복 로그인 안내로 잠기지 않게).
    // 이어 가도 되면 true. 로그인하지 못했거나 다른 계정이면 로그인 쪽이 알려 준 이유로 멈추고 false를 돌려준다.
    // 다른 기기의 로그인이 이쪽 세션을 계속 끊는 경우에 되풀이하지 않도록 횟수를 제한한다.
    function relogin(runId, reason = null) {
      // 감시와 다음 강의 확인이 같은 만료를 함께 발견해도 한 번만 로그인한다.
      if (renewing?.runId === runId) return renewing.promise;
      const promise = (async () => {
        if (!current(runId)) return false;
        const recent = (state.reloginAt || []).filter(time => now() - time < RELOGIN_WINDOW);
        if (recent.length >= RELOGIN_LIMIT) {
          await attention('알파 로그인이 계속 끊깁니다. 다른 기기의 로그인을 확인한 뒤 다시 시도하세요.', runId, reason);
          return false;
        }
        state.reloginAt = [...recent, now()];
        state.message = '알파 로그인이 만료되어 다시 로그인합니다.';
        await save();
        if (!current(runId)) return false;
        let user, failure = '';
        try { user = await auth.ensureLoggedIn(); }
        catch (error) { failure = error?.message || '다시 로그인하지 못했습니다.'; }
        if (!current(runId)) return false;
        if (!failure && !user?.authenticated) failure = '다시 로그인하지 못했습니다.';
        if (failure) {
          await attention(`알파 로그인이 만료되었습니다. ${failure}`, runId, reason);
          return false;
        }
        if (user.loginId === state.loginId) return true;
        await attention('알파 로그인 계정이 바뀌었습니다. 다시 시도하기 전에 계정을 확인하세요.', runId, reason);
        return false;
      })().finally(() => { if (renewing?.promise === promise) renewing = null; });
      renewing = { runId, promise };
      return promise;
    }
    async function openPlayer() {
      await ready;
      if (state.running) {
        const paused = await attention('숨겨진 재생을 멈추고 학습 화면을 엽니다. 확인 후 다시 시도하면 백그라운드에서 이어집니다.', state.runId, 'manual');
        if (!paused) throw new Error('백그라운드 재생의 중지를 확인하지 못해 학습 화면을 열지 못했습니다. 중지를 다시 시도하세요.');
      } else {
        try { await pause(); state.cleanupPending = false; }
        catch (error) { state.cleanupPending = true; await save(); throw error; }
        await save();
      }
      if (state.tabId != null) {
        try {
          const tab = await tabs.get(state.tabId);
          if (new URL(tab.url).origin === catalog.BASE_URL) {
            await tabs.update(tab.id, { active: true,
              ...(validClassroomUrl(state.url) && tab.url !== state.url ? { url: state.url } : {}) });
            state.manualUrl = validClassroomUrl(state.url) ? state.url : tab.url;
            await save();
            if (windows) await windows.update(tab.windowId, { focused: true });
            return { ok: true };
          }
        } catch { /* 닫힌 탭은 아래에서 다시 연다 */ }
      }
      const course = catalog.courses.find(item => item.id === state.courseId);
      const tab = await tabs.create({ url: validClassroomUrl(state.url) ? state.url : course?.url || catalog.BASE_URL, active: true });
      state.tabId = tab.id;
      state.manualUrl = validClassroomUrl(state.url) ? state.url : course?.url || catalog.BASE_URL;
      await save();
      return { ok: true };
    }
    async function navigate(url, runId) {
      if (!validPlayerUrl(url)) throw new Error('알파의 학습용 강의실 주소를 확인하지 못했습니다.');
      if (!current(runId)) return;
      // 직접 확인하려고 열었던 탭은 같은 화면에 머물러 있을 때만 닫아 중복 재생을 막는다.
      if (state.tabId != null) {
        try {
          const previous = await tabs.get(state.tabId);
          if (validClassroomUrl(state.manualUrl) && (previous.pendingUrl || previous.url) === state.manualUrl) await tabs.remove(previous.id);
        } catch { /* 이미 닫았거나 사용자가 다른 화면으로 이동한 탭은 그대로 둔다. */ }
        state.tabId = null;
        state.manualUrl = null;
      }
      if (!current(runId)) return;
      const playerToken = id();
      state = { ...state, url, transport: 'offscreen', playerToken, phase: 'loading', message: '숨겨진 알파 플레이어에서 영상을 준비합니다.',
        navigatedAt: now(), lastHeartbeatAt: 0, lastPositionAt: now(), endedAt: 0,
        currentTime: 0, duration: 0, documentId: null, lastVerifiedAt: 0 };
      await save();
      if (!current(runId)) return;
      // 호스트 생성 자체가 지연되는 경우도 감시한다.
      await alarms.create(ALARM, { periodInMinutes: 0.5 });
      if (!current(runId)) return;
      let opened;
      try { opened = await host.navigate(url, { runId, playerToken }); }
      catch (error) {
        // 자동 복구가 같은 실행에서 플레이어를 다시 열었다면, 밀려난 이전 이동의 실패는 무시한다.
        if (current(runId) && state.playerToken !== playerToken) return;
        throw error;
      }
      if (!current(runId)) { await pause(); return; }
      if (state.playerToken !== playerToken) return;
      state.documentId = opened?.documentId || state.documentId;
      await save();
      if (!current(runId)) await pause();
    }
    // 자동으로 더 진행할 수 없는 과정을 미뤄 두고 다음 과정으로 넘긴다(저장은 부르는 쪽에서 한다).
    // 미뤄 둔 과정은 다른 과정의 영상을 모두 본 뒤 실행 끝에서 한꺼번에 확인을 요청한다.
    function defer(course, reason, message, url) {
      state.deferredCourses = [...(state.deferredCourses || []).filter(item => item.courseId !== course.id), {
        courseId: course.id, title: course.title, reason, message: String(message).slice(0, 300),
        url: url && validClassroomUrl(url) ? url : null,
      }];
      state.courseIndex = (state.courseIndex || 0) + 1;
      state.lessonId = null;
      state.lessonTitle = '';
      state.endedAt = 0;
      state.attentionReason = null;
    }
    async function next(runId, { verifyEnd = false, surveyCourseId = null } = {}) {
      if (!current(runId)) return;
      while ((state.courseIndex || 0) < state.courseIds.length) {
        const course = catalog.courses.find(item => item.id === state.courseIds[state.courseIndex || 0]);
        if (!course) throw new Error('선택한 교육 목록을 다시 확인하세요.');
        const checkingSurvey = course.id === surveyCourseId;
        state.courseId = course.id;
        state.courseTitle = course.title;
        // 로그인이 만료됐으면 저장한 계정으로 다시 로그인해 이어 간다. 계정이 바뀌었으면 다른 계정으로 학습하지 않도록 멈춘다.
        const user = await api.session();
        if (!current(runId)) return;
        if (!user.authenticated) {
          if (!await relogin(runId, checkingSurvey ? 'survey' : null)) return;
        } else if (user.loginId !== state.loginId) {
          await attention('알파 로그인 계정이 바뀌었습니다. 다시 시도하기 전에 계정을 확인하세요.', runId,
            checkingSurvey ? 'survey' : null);
          return;
        }
        let result, expired = false;
        try { result = await learning.inspect(course); }
        catch (error) {
          // 조회하는 사이 로그인이 만료돼 실패한 것인지 확인한다. 만료가 아니면 조회 실패로 멈춘다.
          if (!current(runId)) return;
          try { expired = !(await api.session()).authenticated; } catch { /* 확인하지 못하면 조회 실패로 본다 */ }
          if (!current(runId)) return;
          if (!expired) throw error;
        }
        if (!current(runId)) return;
        if (!expired) {
          const checkedUser = await api.session();
          if (!current(runId)) return;
          if (checkedUser.authenticated && checkedUser.loginId !== state.loginId) {
            await attention('강의 조회 중 로그인 계정이 바뀌었습니다. 현재 계정으로 다시 시도하세요.', runId,
              checkingSurvey ? 'survey' : null);
            return;
          }
          expired = !checkedUser.authenticated;
        }
        if (expired) {
          // 만료된 로그인으로 받은 조회 결과는 쓰지 않는다. 다시 로그인해 이 과정부터 다시 조회한다.
          if (!await relogin(runId, checkingSurvey ? 'survey' : null)) return;
          continue;
        }
        if (result.status === 'completed') {
          state.completedCourseIds = [...new Set([...(state.completedCourseIds || []), course.id])];
          if (certificates) {
            state.phase = 'certificate';
            state.message = '수료가 확인되어 수료증을 저장합니다.';
            state.attentionReason = null;
            await pause();
            await alarms.clear(ALARM);
            await save();
            if (!current(runId)) return;
            try {
              await certificates.ensure({ course, registrationId: result.registrationId, loginId: state.loginId,
                completed: true, shouldStop: () => !current(runId) });
            } catch {
              // 수료증 저장 실패로 다음 과정의 학습을 막지 않는다. 저장 상태에서 재시도할 수 있다.
              state.certificateWarning = '일부 수료증을 저장하지 못했습니다. 수료증 저장 확인·재시도를 눌러 주세요.';
            }
            if (!current(runId)) return;
          }
          state.courseIndex = (state.courseIndex || 0) + 1;
          state.lessonId = null;
          state.lessonTitle = '';
          state.endedAt = 0;
          state.attentionReason = null;
          await save();
          continue;
        }
        if (state.mode === 'enrolled' && (['not-enrolled', 'waiting'].includes(result.status) ||
            (result.status === 'attention' && result.attentionReason === 'expired'))) {
          state.skippedCourses = [...(state.skippedCourses || []).filter(item => item.courseId !== course.id), {
            courseId: course.id, title: course.title,
            status: result.attentionReason === 'expired' ? 'expired' : result.status,
            message: result.message,
          }];
          state.courseIndex = (state.courseIndex || 0) + 1;
          state.lessonId = null;
          state.lessonTitle = '';
          state.endedAt = 0;
          state.attentionReason = null;
          await save();
          continue;
        }
        // 영상을 모두 본 과정에 설문만 남았으면 멈추지 않고 다음 과정의 강의로 넘어간다.
        // 설문은 과정 목록의 "설문 바로가기 · 자동 설문"으로 따로 진행한다.
        if (result.status === 'attention' && result.attentionReason === 'survey' && !checkingSurvey) {
          // 사용자가 이 과정의 자동 설문을 예약해 두었으면 지금 제출하고, 수료를 다시 확인한다(한 실행에서 과정당 한 번만).
          if (survey && !(state.surveyTried || []).includes(course.id) && await survey.reserved(course.id)) {
            if (!current(runId)) return;
            state.surveyTried = [...(state.surveyTried || []), course.id];
            state.message = '예약한 설문을 제출합니다.';
            await save();
            let submitted = false;
            try {
              const done = await survey.auto(course);
              submitted = !!(done?.submitted || done?.completed);
            } catch (error) {
              // 자동으로 답할 수 없는 설문 등: 이 과정은 설문을 남겨 두고 넘어간다.
              state.surveyNote = String(error?.message || '설문을 제출하지 못했습니다.').slice(0, 120);
            }
            if (!current(runId)) return;
            if (submitted) { await save(); continue; }
          }
          state.surveyCourses = [...(state.surveyCourses || []).filter(item => item.courseId !== course.id),
            { courseId: course.id, title: course.title }];
          state.courseIndex = (state.courseIndex || 0) + 1;
          state.lessonId = null;
          state.lessonTitle = '';
          state.endedAt = 0;
          state.attentionReason = null;
          await save();
          continue;
        }
        // 영상을 모두 본 과정에 시험이 남은 경우도 멈추지 않는다. 시험은 과정 목록의 "시험 바로가기"로 직접 응시한다.
        if (result.status === 'attention' && result.attentionReason === 'assessment' && !checkingSurvey) {
          state.examCourses = [...(state.examCourses || []).filter(item => item.courseId !== course.id),
            { courseId: course.id, title: course.title }];
          state.courseIndex = (state.courseIndex || 0) + 1;
          state.lessonId = null;
          state.lessonTitle = '';
          state.endedAt = 0;
          state.attentionReason = null;
          await save();
          continue;
        }
        if (checkingSurvey && (result.status !== 'ready' || !result.nextLesson?.url)) {
          if (result.url && validClassroomUrl(result.url)) state.url = result.url;
          const reason = result.attentionReason || 'survey';
          const message = result.attentionReason === 'survey'
            ? '아직 설문 제출이 확인되지 않았습니다. 설문을 제출한 뒤 완료 확인 후 계속을 다시 눌러 주세요.'
            : result.message || '시험·설문 또는 수강 상태를 알파 강의실에서 확인하세요.';
          await attention(message, runId, reason);
          return;
        }
        // 자동으로 더 진행할 수 없는 과정(수강 상태를 확인할 수 없는 과정 등)에서 멈추지 않는다.
        // 그 과정은 미뤄 두고 다른 과정의 영상을 먼저 수강한 뒤, 끝에서 한꺼번에 확인을 요청한다.
        if (result.status !== 'ready' || !result.nextLesson?.url) {
          defer(course, result.attentionReason || result.status || null,
            result.message || '수강 상태를 알파 강의실에서 확인하세요.', result.url);
          await save();
          continue;
        }
        const lesson = result.nextLesson;
        if (verifyEnd && state.lessonId === lesson.id && state.endedAt) {
          if (now() - state.endedAt > 90000) {
            // 끝까지 재생했는데도 사이트가 완료로 기록하지 않았다. 같은 강의를 되풀이하지 않고 과정을 미뤄 둔다.
            defer(course, 'unsaved', '영상은 끝났지만 사이트에서 진도 저장을 확인하지 못했습니다. 강의실을 확인한 뒤 다시 시도하세요.', lesson.url);
            await save();
            continue;
          }
          state.phase = 'loading';
          state.message = '영상 재생이 끝나 사이트의 진도 저장을 확인하고 있습니다.';
          await save();
          return;
        }
        state.lessonId = lesson.id;
        state.lessonTitle = lesson.title || '';
        state.progress = lesson.progress;
        state.attentionReason = null;
        // 강의를 열기 직전에 근무 시간과 강의 사이 휴식을 확인한다.
        const plan = await schedule();
        if (!current(runId)) return;
        if (!plan.allowed) { await hold(runId, 'offhours', offHoursMessage(plan), { resumeAt: plan.resumeAt || 0 }); return; }
        if (state.restDue && plan.rest) {
          const [shortest, longest] = plan.rest;
          const seconds = Math.round(shortest + random() * Math.max(0, longest - shortest));
          await hold(runId, 'rest', `다음 강의까지 ${durationText(seconds)} 쉽니다.`, { restUntil: now() + seconds * 1000 });
          return;
        }
        state.restDue = false;
        await navigate(lesson.url, runId);
        return;
      }
      if (!current(runId)) return;
      const completedCount = (state.completedCourseIds || []).length;
      const skippedCount = (state.skippedCourses || []).length;
      const surveyCount = (state.surveyCourses || []).length;
      const examCount = (state.examCourses || []).length;
      const enrolledOnly = state.mode === 'enrolled';
      // 미뤄 둔 과정이 있으면 다른 과정을 모두 본 지금 확인을 요청한다(학습 화면 열기는 첫 번째 미룬 과정을 연다).
      const deferred = state.deferredCourses || [];
      const noCourses = enrolledOnly && completedCount === 0 && surveyCount === 0 && examCount === 0 && !deferred.length;
      const excluded = skippedCount ? ` 미신청·대기·기간 종료 과정 ${skippedCount}개는 제외했습니다.` : '';
      state = { ...state, running: false, phase: noCourses ? 'idle' : deferred.length ? 'attention' : 'done', cleanupPending: true,
        ...(deferred.length ? { attentionReason: 'deferred', courseId: deferred[0].courseId, courseTitle: deferred[0].title,
          lessonId: null, lessonTitle: '', url: deferred[0].url, currentTime: 0, duration: 0 } : {}),
        message: surveyCount || examCount || deferred.length
          ? `영상 학습을 마쳤습니다.${deferred.length ? ` 직접 진행할 과정 ${deferred.length}개는 건너뛴 과정에서 확인하세요.` : ''}${examCount ? ` 시험이 남은 과정 ${examCount}개는 시험 바로가기로 직접 응시하세요.` : ''}${surveyCount ? ` 설문이 남은 과정 ${surveyCount}개는 과정 목록의 자동 설문으로 진행하세요.` : ''}${completedCount ? ` 수료 확인 ${completedCount}개.` : ''}${excluded}`
          : enrolledOnly
            ? noCourses ? '지금 자동 학습할 수강 중인 과정이 없습니다. 제외된 과정의 상태를 확인하세요.'
              : `수강 중인 과정 ${completedCount}개의 수료를 사이트에서 확인했습니다.${excluded}`
            : '선택한 5개 과정의 수료를 사이트에서 확인했습니다.' };
      if (certificates && completedCount) state.message += ' 수료증 저장 결과는 아래 수료증 목록에서 확인하세요.';
      if (state.certificateWarning) state.message += ` ${state.certificateWarning}`;
      await save();
      if (state.runId !== runId || stopped) return;
      let paused = true;
      try { await pause(); } catch { paused = false; }
      if (state.runId !== runId || stopped) return;
      await alarms.clear(ALARM).catch(() => {});
      state.cleanupPending = !paused;
      if (!paused) {
        state.message += ' 숨겨진 플레이어 종료를 확인하지 못했습니다. 중지를 다시 누르거나 확장을 새로고침하세요.';
      }
      await save();
      await notify(noCourses ? '알파 수강 상태 확인' : deferred.length ? '알파 자동 실행 확인 필요' : '알파 자동 실행 완료', state.message).catch(() => {});
    }
    // 숨겨진 플레이어가 사라지거나(확장 새로고침 등) 응답·재생이 멈춘 경우에는 확인을 기다리지 않고 다시 연다.
    // 사이트에 저장된 진도를 다시 조회해 이어 볼 강의를 정하므로 로그인·수강신청은 반복하지 않는다.
    // 짧은 시간에 되풀이되면 같은 문제가 계속되는 것이므로 확인 요청으로 넘긴다.
    async function recover(failure, runId) {
      if (!current(runId) || advancing) return;
      const recent = (state.recoveredAt || []).filter(time => now() - time < RECOVERY_WINDOW);
      if (recent.length >= RECOVERY_LIMIT) { await setAside(failure, runId); return; }
      state.recoveredAt = [...recent, now()];
      await reopen(runId, '재생이 멈춰 숨겨진 플레이어를 다시 엽니다.');
    }
    // 지금 과정의 강의를 재생하지 못한다(영상을 찾지 못함·응답 화면·되풀이되는 멈춤). 실행을 멈추지 않고
    // 그 과정을 미뤄 둔 뒤 다른 과정의 영상을 먼저 수강한다.
    async function setAside(message, runId) {
      if (!current(runId) || advancing) return;
      const course = catalog.courses.find(item => item.id === state.courseId);
      if (!course) { await attention(message, runId); return; }
      // 이미 다음 과정으로 넘기는 중이면(같은 강의실에서 늦게 온 신호) 한 번 더 넘기지 않는다.
      if ((state.courseIds || [])[state.courseIndex || 0] !== course.id) return;
      defer(course, 'playback', message, state.url);
      state.recoveredAt = [];
      state.restDue = false;
      await reopen(runId, '재생하지 못한 과정을 미뤄 두고 다음 과정을 확인합니다.');
    }
    // 사이트의 진도를 다시 조회해 이어 볼 강의를 연다. before가 false를 돌려주면 열지 않는다.
    async function reopen(runId, message, before = null) {
      if (!current(runId) || advancing) return;
      // 여는 동안 감시가 같은 이유로 다시 끼어들지 않도록 기준 시각을 새로 잡는다.
      state = { ...state, phase: 'loading', message, navigatedAt: now(), lastHeartbeatAt: 0, restUntil: 0, resumeAt: 0 };
      await save();
      if (!current(runId) || advancing) return;
      advancing = (async () => { if (!before || await before()) await next(runId); })()
        .catch(error => attention(error.message || '알파 재생을 이어 가지 못했습니다.', runId)).finally(() => { advancing = null; });
      await advancing;
    }
    const offHoursMessage = plan => `근무 시간이 되면 이어서 재생합니다${plan.resumeLabel ? ` (${plan.resumeLabel} 시작)` : ''}.`;
    // 근무 시간 밖이거나 강의 사이 휴식일 때 숨겨진 플레이어를 닫고 기다린다. 감시 알람(30초)이 때가 되면 깨운다.
    async function hold(runId, phase, message, extra) {
      if (!current(runId)) return;
      state = { ...state, phase, message, restUntil: 0, resumeAt: 0, ...extra, restDue: false, endedAt: 0 };
      await save();
      if (!current(runId)) return;
      await alarms.create(ALARM, { periodInMinutes: 0.5 });
      // 닫지 못한 플레이어도 이 상태에서는 재생 허가를 받지 못해 멈춘다. 다음 이동이나 중지에서 정리된다.
      try { await pause(); } catch { /* 위 설명 참고 */ }
    }
    async function wake(runId) {
      let plan;
      try { plan = await schedule(); } catch { return; }
      if (!current(runId) || !WATCHED.slice(2).includes(state.phase)) return;
      if (!plan.allowed) {
        // 쉬는 사이 근무 시간이 끝났으면 근무 시간까지 기다리고, 시작 시각이 바뀌었으면 안내만 고친다.
        const message = offHoursMessage(plan);
        if (state.phase !== 'offhours' || state.message !== message) {
          state = { ...state, phase: 'offhours', message, resumeAt: plan.resumeAt || 0, restUntil: 0 };
          await save();
        }
        return;
      }
      // 휴식은 정한 시각까지. 쉬는 중에 휴식 설정을 끄면 바로 이어 간다.
      if (state.phase === 'rest' && plan.rest && now() < (state.restUntil || 0)) return;
      const waited = state.phase === 'offhours';
      await reopen(runId, '이어서 재생할 강의를 확인합니다.', !waited ? null : async () => {
        // 오래 기다린 뒤에는 로그인이 만료됐을 수 있다. 저장한 계정으로 다시 로그인하되 계정이 달라졌으면 멈춘다.
        const user = await auth.ensureLoggedIn();
        if (!current(runId)) return false;
        if (user.loginId === state.loginId) return true;
        await attention('알파 로그인 계정이 바뀌었습니다. 다시 시도하기 전에 계정을 확인하세요.', runId);
        return false;
      });
    }
    function advance(runId) {
      if (advancing || !current(runId)) return advancing;
      if (state.lastVerifiedAt && now() - state.lastVerifiedAt < 15000) return null;
      state.lastVerifiedAt = now();
      advancing = next(runId, { verifyEnd: true }).catch(error => attention(error.message, runId))
        .finally(() => { advancing = null; });
      return advancing;
    }
    async function prepare(runId, selection) {
      try {
        const user = await auth.ensureLoggedIn();
        if (!current(runId)) return;
        state.loginId = user.loginId;
        if (state.mode === 'enrolled') {
          state.phase = 'checking-enrolled';
          state.message = '이미 수강신청된 과정의 미완료 강의를 확인합니다.';
          await save();
          if (current(runId)) await next(runId);
          return;
        }
        state.phase = 'enrolling';
        state.message = '기존 신청 내역을 확인하고 미신청 과정을 순서대로 신청합니다.';
        await save();
        if (!current(runId)) return;
        const result = await service.enroll(selection, { shouldStop: () => !current(runId) });
        if (!current(runId) || result.cancelled) return;
        if (!result.ok) {
          await attention(result.message || '수강신청 결과를 확인하세요.', runId);
          return;
        }
        await next(runId);
      } catch (error) {
        await attention(error.message || '알파 자동 실행을 준비하지 못했습니다.', runId);
      } finally {
        if (stopped && state.runId === runId) {
          state.running = false;
          state.phase = 'stopped';
          state.message = '자동 실행을 중지했습니다. 이미 신청한 과정은 유지됩니다.';
          await save();
        }
      }
    }
    async function start(selection, { enrolledOnly = false } = {}) {
      const version = stopVersion;
      await ready;
      if (job || advancing || state.running || state.cleanupPending) throw new Error('알파 자동 실행이 진행 중입니다. 먼저 중지하세요.');
      const validate = enrolledOnly ? catalog.validateLearningSelection : catalog.validateSelection;
      const validation = validate(selection.role, selection.courseIds);
      if (!validation.ok) throw new Error(validation.errors.join('\n'));
      const { alphaState } = await storage.get('alphaState');
      if (version !== stopVersion) return { ok: false, cancelled: true, message: '자동 실행을 중지했습니다.' };
      if (job || advancing || state.running || state.cleanupPending) throw new Error('알파 자동 실행이 진행 중입니다. 먼저 중지하세요.');
      if (alphaState?.busy) throw new Error('수강신청 조회·처리가 끝난 뒤 시작하세요.');
      stopped = false;
      const runId = id();
      state = { running: true, phase: 'login', message: '알파 로그인 상태를 확인합니다.',
        transport: 'offscreen',
        mode: enrolledOnly ? 'enrolled' : 'enroll-and-learn', skippedCourses: [], completedCourseIds: [], surveyCourses: [], surveyTried: [], examCourses: [], deferredCourses: [],
        runId, role: selection.role, courseIds: [...selection.courseIds], courseIndex: 0,
        tabId: state.tabId ?? null, manualUrl: state.manualUrl || state.url || null,
        courseId: null, courseTitle: '', lessonTitle: '', url: null };
      // 시작 버튼에 즉시 응답하고 상태는 저장소를 통해 팝업·사이드 패널에 전달한다.
      const initial = save().catch(async error => {
        if (state.runId === runId) {
          state = { ...state, running: false, phase: stopped ? 'stopped' : 'attention', cleanupPending: false,
            message: '실행 준비 상태를 저장하지 못했습니다. 다시 시도해 주세요.' };
          await save().catch(() => {});
        }
        throw error;
      });
      job = initial.then(() => prepare(runId, selection)).finally(() => { job = null; });
      job.catch(() => {});
      await initial;
      return { ok: true, message: enrolledOnly ? '수강 중인 과정의 자동 학습을 시작했습니다.' : '알파 자동 실행을 시작했습니다.' };
    }
    async function stop() {
      stopVersion++;
      await ready;
      stopped = true;
      const runId = state.runId;
      state = { ...state, running: !!job, phase: job ? 'stopping' : 'stopped', cleanupPending: true,
        message: job ? '처리 중인 요청을 확인한 뒤 중지합니다.' : '자동 실행을 중지했습니다.' };
      await save();
      if (runId !== state.runId || !stopped) return { ok: false, message: '실행 상태가 변경되었습니다. 현재 상태를 확인하세요.' };
      let pauseError = false;
      try { await pause(); } catch { pauseError = true; }
      if (runId !== state.runId || !stopped) return { ok: false, message: '실행 상태가 변경되었습니다. 현재 상태를 확인하세요.' };
      await alarms.clear(ALARM).catch(() => {});
      state.cleanupPending = pauseError;
      if (pauseError) {
        state.message = '후속 재생은 중지했지만 숨겨진 플레이어 종료를 확인하지 못했습니다. 중지를 다시 누르거나 확장을 새로고침하세요.';
        await save();
        return { ok: false, message: state.message };
      }
      await save();
      return { ok: true, message: state.message };
    }
    async function retry() {
      await ready;
      return start({ role: state.role, courseIds: state.courseIds || [] }, { enrolledOnly: state.mode === 'enrolled' });
    }
    async function continueSurvey(selection) {
      const version = stopVersion;
      await ready;
      const assertWaiting = () => {
        if (job || advancing || state.running || state.cleanupPending) throw new Error('알파 작업이 진행 중입니다. 완료 후 다시 시도하세요.');
        if (state.phase !== 'attention' || state.attentionReason !== 'survey') {
          throw new Error('설문 작성 대기 상태에서만 계속 진행할 수 있습니다.');
        }
        if (selection && (selection.role !== state.role || !Array.isArray(selection.courseIds) ||
            [...selection.courseIds].sort().join('|') !== [...(state.courseIds || [])].sort().join('|'))) {
          throw new Error('교육 대상 또는 과정 선택이 변경되었습니다. 현재 선택으로 새로 시작하세요.');
        }
        const validate = state.mode === 'enrolled' ? catalog.validateLearningSelection : catalog.validateSelection;
        const validation = validate(state.role, state.courseIds);
        if (!validation.ok || !Number.isInteger(state.courseIndex) || state.courseIndex < 0 ||
            state.courseIds[state.courseIndex] !== state.courseId || !state.loginId) {
          throw new Error('이전 실행 정보를 확인하지 못했습니다. 교육 대상을 확인하고 다시 시작하세요.');
        }
      };
      assertWaiting();
      const { alphaState } = await storage.get('alphaState');
      if (version !== stopVersion) return { ok: false, cancelled: true, message: '자동 실행을 중지했습니다.' };
      assertWaiting();
      if (alphaState?.busy) throw new Error('수강신청 조회·처리가 끝난 뒤 계속 진행하세요.');
      stopped = false;
      const runId = id();
      const surveyCourseId = state.courseId;
      state = { ...state, runId, running: true, phase: 'checking-survey',
        message: '사이트에서 설문 제출과 수료 상태를 확인합니다.', endedAt: 0, lastVerifiedAt: 0 };
      // 수강신청을 다시 하지 않고 멈춘 과정의 서버 기록부터 확인한다.
      const initial = save().catch(async error => {
        if (state.runId === runId) {
          state = { ...state, running: false, phase: stopped ? 'stopped' : 'attention', cleanupPending: false,
            attentionReason: 'survey', message: '설문 완료 확인 상태를 저장하지 못했습니다. 완료 확인 후 계속을 다시 눌러 주세요.' };
          await save().catch(() => {});
        }
        throw error;
      });
      job = initial.then(() => next(runId, { surveyCourseId }))
        .catch(error => attention(error.message || '설문 완료 여부를 확인하지 못했습니다.', runId,
          state.courseId === surveyCourseId ? 'survey' : null))
        .finally(async () => {
          try {
            if (stopped && state.runId === runId) {
              state.running = false;
              state.phase = 'stopped';
              state.message = '계속 진행을 중지했습니다.';
              await save();
            }
          } finally { job = null; }
        });
      job.catch(() => {});
      await initial;
      return { ok: true, message: '설문 완료 여부를 확인하고 이어서 진행합니다.' };
    }
    async function heartbeat(message, sender) {
      await ready;
      const acceptedRun = state.runId;
      if (!state.running || stopped || state.transport !== 'offscreen' ||
          !samePlayerUrl(message.url, state.url) || message.runId !== state.runId ||
          message.playerToken !== state.playerToken ||
          !['loading', 'playing'].includes(state.phase)) return { active: false };
      if (!await host.accepts(message, sender, { url: state.url, runId: state.runId,
        playerToken: state.playerToken, documentId: state.documentId }) || !current(acceptedRun)) return { active: false };
      if (sender.documentId) state.documentId ||= sender.documentId;
      const runId = state.runId;
      state.lastHeartbeatAt = now();
      const position = Number(message.currentTime), duration = Number(message.duration);
      if (Number.isFinite(position) && position >= 0) {
        if (Math.abs(position - (state.currentTime || 0)) > 0.2) state.lastPositionAt = now();
        state.currentTime = position;
      }
      if (Number.isFinite(duration) && duration > 0) state.duration = duration;
      if (message.kind === 'attention') {
        await save();
        // 다음 과정을 여는 동안 강의실의 응답을 붙잡아 두지 않는다.
        void setAside(String(message.message || '강의실에서 확인이 필요합니다.').slice(0, 300), runId);
        return { active: false };
      }
      if (message.kind === 'ended') {
        state.endedAt ||= now();
        // 강의를 끝까지 본 뒤 다음 강의(또는 다음 과정)로 넘어갈 때만 휴식한다.
        state.restDue = true;
        state.message = '재생 완료 · 사이트 진도 확인 중';
        await save();
        void advance(runId);
        return { active: false };
      }
      if (message.kind === 'playing' && !state.endedAt) {
        state.phase = 'playing';
        state.message = '숨겨진 알파 플레이어에서 1배속으로 재생 중입니다.';
      }
      await save();
      return { active: current(runId) && !state.endedAt, runId, courseId: state.courseId,
        lessonId: state.lessonId, muted: true };
    }
    async function tick() {
      await ready;
      if (!state.running || stopped || !WATCHED.includes(state.phase)) return;
      const runId = state.runId;
      if (state.phase === 'rest' || state.phase === 'offhours') { await wake(runId); return; }
      let user;
      try { user = await api.session(); }
      catch (error) {
        await attention(error.message || '알파 로그인 상태를 확인하지 못했습니다.', runId);
        return;
      }
      if (!current(runId)) return;
      if (!user.authenticated) {
        // 로그인 만료: 다시 로그인한 뒤, 만료된 로그인으로 열려 있던 숨겨진 플레이어를 다시 열어 사이트 진도부터 확인한다.
        if (await relogin(runId)) await reopen(runId, '다시 로그인해 이어서 재생할 강의를 확인합니다.');
        return;
      }
      if (user.loginId !== state.loginId) {
        await attention('알파 로그인 계정이 변경되어 재생을 멈췄습니다.', runId);
        return;
      }
      // 재생 중에 근무 시간이 끝나면 플레이어를 닫고 다음 근무 시간까지 기다린다.
      let plan = null;
      try { plan = await schedule(); } catch { /* 설정을 읽지 못하면 재생을 유지한다 */ }
      if (!current(runId)) return;
      if (plan && !plan.allowed) { await hold(runId, 'offhours', offHoursMessage(plan), { resumeAt: plan.resumeAt || 0 }); return; }
      if (state.endedAt) { await advance(runId); return; }
      // ready 응답만 계속 오는 경우에도 무한히 '강의 준비 중'에 머무르지 않는다.
      // 아래 네 경우는 먼저 자동으로 다시 열고(recover), 되풀이될 때만 이 안내로 확인을 요청한다.
      if (state.phase === 'loading' && now() - (state.navigatedAt || now()) >= 60000) {
        await recover('백그라운드 영상 준비가 1분 안에 완료되지 않았습니다. 다시 시도를 누르거나 학습 화면에서 로딩 상태를 확인하세요.', runId);
        return;
      }
      const playerToken = state.playerToken;
      let alive = false;
      try { alive = await host.isAlive({ url: state.url, runId, playerToken }); } catch { /* 아래에서 복구 */ }
      // 확인하는 사이 다른 강의로 이동했다면 이전 플레이어의 결과로 판단하지 않는다.
      if (!current(runId) || state.playerToken !== playerToken) return;
      if (!alive) { await recover('숨겨진 알파 플레이어가 종료되었습니다. 다시 시도를 누르면 백그라운드에서 이어집니다.', runId); return; }
      if (now() - (state.lastHeartbeatAt || state.navigatedAt || now()) > 60000) {
        await recover('알파 강의실이 응답하지 않습니다. 플레이어 화면에서 로그인·로딩 상태를 확인하세요.', runId);
      } else if (state.phase === 'playing' && now() - (state.lastPositionAt || now()) > 120000) {
        await recover('영상 재생이 멈췄습니다. 플레이어 화면에서 확인한 뒤 다시 시도하세요.', runId);
      }
    }
    // 과정 목록의 자동 설문 등으로 설문이 제출됐을 때: 남은 설문 목록에서 빼고,
    // 그 과정의 설문을 기다리며 멈춰 있었다면 확인 후 다음 과정으로 이어 간다.
    async function surveyDone(courseId) {
      await ready;
      if ((state.surveyCourses || []).some(item => item.courseId === courseId)) {
        state.surveyCourses = state.surveyCourses.filter(item => item.courseId !== courseId);
        if (!state.running && state.phase === 'done' && !state.surveyCourses.length) state.message = '영상 학습과 설문을 모두 마쳤습니다.';
        await save();
      }
      if (!state.running && !state.cleanupPending && !job && !advancing &&
          state.phase === 'attention' && state.attentionReason === 'survey' && state.courseId === courseId) {
        await continueSurvey();
      }
    }
    return { start, startEnrolled: selection => start(selection, { enrolledOnly: true }),
      stop, retry, continueSurvey, surveyDone, openPlayer, heartbeat, tick };
  }
  return { create, ALARM };
})();
globalThis.AlphaRunner = AlphaRunner;
if (typeof module !== 'undefined' && module.exports) module.exports = AlphaRunner;
