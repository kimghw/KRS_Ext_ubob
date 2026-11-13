/* ALPHA 신청 UI. 기존 유밥 재생 상태와 독립적으로 저장하고 표시한다. */
(() => {
  'use strict';
  const catalog = globalThis.AlphaCatalog;
  const byId = (id) => document.getElementById(id);
  const roleInputs = [...document.querySelectorAll('input[name="alphaRole"]')];
  let preferences = { role: '', selectedIds: [] };
  let state = { busy: false, items: [] };
  let runner = { running: false, phase: 'idle' };
  let account = null;
  let auth = null;
  let editingAccount = false;
  let accountFormInitialized = false;
  let accountPending = false;
  let accountError = '';
  let controlPending = false;
  let stopPending = false;
  let playerOpenPending = false;
  let controlRevision = 0;
  let controlMessage = '';
  let controlError = false;
  let actionPending = false;
  let localMessage = '';
  let localError = false;
  let categoriesKey = '';
  // 과정별 메뉴(설문 바로가기·자동 설문·수료증 받기)의 진행 상태: { courseId, type, pending, confirm, message, error }
  let courseAction = null;
  // 과정별 수강 상태(learning·survey·completed …). 메뉴는 쓸 수 있는 과정에서만 눌린다.
  let courseStatus = { loginId: '', items: {} };
  let statusRequest = null;
  let runnerProgressKey = '';
  // 자동 설문을 예약한 과정(영상이 끝나면 실행이 설문을 제출한다).
  let reservedSurveys = [];
  let certificates = { busy: false, items: [] };
  let certificateBatch = { busy: false, phase: 'idle', items: [] };
  let certificatePending = false;
  let certificateBatchPending = false;
  let certificateBatchStopPending = false;
  let certificateMessage = '';
  let certificateError = false;

  const labels = {
    unknown: '미확인', available: '자동 신청 가능', enrolled: '신청 완료', completed: '수료 확인',
    'login-required': '로그인 필요', login_required: '로그인 필요', unavailable: '신청 불가',
    error: '확인 실패', manual: '직접 확인 필요', checking: '확인 중', enrolling: '신청 중',
    pending: '대기', failed: '신청 실패', skipped: '신청 제외', 'already-enrolled': '이미 신청됨',
    submitting: '신청 중', unconfirmed: '신청 결과 확인 필요'
  };
  const validRole = (role) => catalog.roles.some((r) => r.id === role);
  const selectedCourses = () => catalog.courses.filter((c) => c.roles.includes(preferences.role) && preferences.selectedIds.includes(c.id));
  const checkedMatches = () => state.role === preferences.role &&
    Array.isArray(state.courseIds) && [...state.courseIds].sort().join('|') === [...preferences.selectedIds].sort().join('|');
  const runnerMatches = () => runner.role === preferences.role &&
    Array.isArray(runner.courseIds) && [...runner.courseIds].sort().join('|') === [...preferences.selectedIds].sort().join('|');
  const busy = () => actionPending || controlPending || stopPending || playerOpenPending || accountPending || certificatePending || certificateBatchPending ||
    certificateBatchStopPending || !!certificates.busy || !!certificateBatch.busy || !!state.busy || !!runner.running || !!runner.cleanupPending;
  const launchPending = () => !!controlPending && ['alpha-start', 'alpha-start-enrolled', 'alpha-retry', 'alpha-continue-survey'].includes(controlPending.type);
  const canOpenPendingPlayer = () => launchPending() && runner.running && ['loading', 'playing'].includes(runner.phase) &&
    typeof runner.url === 'string' && runner.url.startsWith(`${catalog.BASE_URL}/my/classRoom/classRoomDetail?`);
  const selectionValid = () => validRole(preferences.role) && catalog.validateSelection(preferences.role, preferences.selectedIds).ok;
  const learningSelectionValid = () => validRole(preferences.role) && catalog.validateLearningSelection(preferences.role, preferences.selectedIds).ok;
  const certificateLoginId = () => {
    if (!auth?.ok) return '';
    const loginId = typeof auth.user === 'string' ? auth.user : auth.user?.loginId;
    return typeof loginId === 'string' ? loginId : '';
  };
  const safeError = (error, submittedPassword = '') => {
    let text = String(error?.message || error || '요청을 처리하지 못했습니다.');
    for (const secret of [submittedPassword, account?.password]) if (secret) text = text.split(secret).join('[숨김]');
    return text;
  };
  const timeText = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds), hours = Math.floor(total / 3600);
    const minutes = String(Math.floor(total % 3600 / 60)).padStart(2, '0');
    const remainder = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function action(type, extra = {}) {
    try {
      const response = await chrome.runtime.sendMessage({ type, ...extra });
      if (!response || !response.ok) throw new Error(response?.error || '확장 프로그램 응답을 확인하지 못했습니다.');
      return response.result;
    } catch (error) {
      throw new Error(error?.message || String(error));
    }
  }

  async function savePreferences() {
    await chrome.storage.local.set({ alphaPreferences: preferences });
  }

  async function openCourse(courseId) {
    try { await action('alpha-open', courseId ? { courseId } : {}); }
    catch (error) { localMessage = error.message; localError = true; render(); }
  }

  function renderRunner() {
    const phases = {
      idle: '대기 중', login: '로그인 중', enrolling: '필수 과정 신청 중', loading: '강의 준비 중',
      playing: '백그라운드 학습 중', rest: '강의 사이 휴식 중', offhours: '근무 시간 대기 중',
      attention: '확인이 필요합니다', 'checking-survey': '설문 완료 확인 중',
      'checking-enrolled': '수강 중인 과정 확인 중',
      certificate: '수료증 저장 중',
      done: '자동 실행 완료', stopping: '중지 중', stopped: '중지됨'
    };
    const survey = runner.attentionReason === 'survey' && ['attention', 'checking-survey'].includes(runner.phase);
    const matchingSurvey = survey && runnerMatches();
    const canContinueSurvey = matchingSurvey && runner.phase === 'attention';
    byId('alphaRunPhase').textContent = runner.phase === 'attention' && runner.attentionReason === 'survey'
      ? '설문 작성 필요' : phases[runner.phase] || '자동 실행 준비 중';
    byId('alphaRunDot').className = `dot ${runner.phase === 'attention' ? 'warn' : runner.phase === 'done' ? 'done' : runner.running ? 'ok' : ''}`;
    byId('alphaRunMessage').hidden = !(controlMessage || runner.message);
    byId('alphaRunMessage').textContent = controlMessage || runner.message || '';
    byId('alphaRunMessage').className = `msg${controlError || runner.phase === 'attention' ? ' warn' : ''}`;
    const course = runner.courseTitle || catalog.courses.find((item) => item.id === runner.courseId)?.title || '';
    byId('alphaNowPlaying').hidden = !course && !runner.lessonTitle;
    byId('alphaRunCourse').textContent = course;
    byId('alphaRunLesson').hidden = !runner.lessonTitle;
    byId('alphaRunLesson').textContent = runner.lessonTitle || '';
    const timed = Number.isFinite(runner.currentTime) && Number.isFinite(runner.duration) && runner.duration > 0;
    // 재생 위치는 매번 갱신되지만 사이트 진도는 강의 조회 시점 값일 수 있다.
    const progress = timed ? 100 * runner.currentTime / runner.duration : null;
    byId('alphaRunProgress').hidden = progress === null;
    byId('alphaRunBar').style.width = `${Math.max(0, Math.min(100, progress || 0))}%`;
    byId('alphaRunPercent').textContent = progress === null ? '' : `재생 ${Math.round(Math.max(0, Math.min(100, progress)))}%`;
    byId('alphaRunTime').textContent = timed ? `${timeText(runner.currentTime)} / ${timeText(runner.duration)}` : '';
    byId('alphaStart').hidden = !!runner.running || canContinueSurvey;
    byId('alphaStart').disabled = busy() || !selectionValid();
    byId('alphaStartEnrolled').hidden = canContinueSurvey;
    byId('alphaStartEnrolled').disabled = busy() || !learningSelectionValid();
    byId('alphaStartEnrolled').textContent = stopPending || runner.phase === 'stopping' ? '중지 중…'
      : playerOpenPending ? '학습 화면 여는 중…'
        : runner.cleanupPending && !runner.running ? '플레이어 종료 확인 필요'
        : runner.running || launchPending()
          ? ({ playing: '백그라운드 학습 중', rest: '휴식 중', offhours: '근무 시간 대기 중' })[runner.phase] || '백그라운드 준비 중…'
          : '수강 중인 과정 백그라운드 학습';
    byId('alphaStop').hidden = !runner.running && !runner.cleanupPending && !launchPending() && !stopPending;
    byId('alphaStop').disabled = stopPending || playerOpenPending || runner.phase === 'stopping';
    byId('alphaStop').textContent = stopPending || runner.phase === 'stopping' ? '중지 중…' : '중지';
    byId('alphaRetry').hidden = runner.phase !== 'attention' || !runnerMatches() || canContinueSurvey;
    byId('alphaRetry').disabled = busy();
    byId('alphaContinue').hidden = !canContinueSurvey;
    byId('alphaContinue').disabled = busy();
    byId('alphaPlayerOpen').hidden = !runner.running && runner.phase !== 'attention';
    byId('alphaPlayerOpen').disabled = (!!controlPending && !canOpenPendingPlayer()) || stopPending || playerOpenPending;
    byId('alphaPlayerOpen').textContent = survey ? '설문 열기' : '학습 화면 열기';
    byId('alphaPlayerOpen').title = survey ? '설문을 직접 작성할 수 있도록 알파 강의실을 엽니다.' : '학습 화면을 열면 백그라운드 재생을 멈춥니다.';
    // 안내 문구는 버튼이 막힌 이유처럼 꼭 필요한 때만, 25자 미만으로 보여준다.
    const hint = runner.cleanupPending && !runner.running ? '중지를 눌러 다시 정리하세요.'
      : matchingSurvey || runner.running || launchPending() || !validRole(preferences.role) ? ''
        : !learningSelectionValid() ? '학습할 과정을 선택하세요.'
          : !selectionValid() ? '신청하려면 5개 분류를 모두 선택하세요.' : '';
    byId('alphaStartHint').textContent = hint;
    byId('alphaStartHint').hidden = !hint;
    const skipped = runner.mode === 'enrolled' && Array.isArray(runner.skippedCourses) ? runner.skippedCourses : [];
    byId('alphaSkipped').hidden = skipped.length === 0;
    byId('alphaSkippedSummary').textContent = `건너뛴 과정 ${skipped.length}개`;
    byId('alphaSkippedList').replaceChildren(...skipped.map((item) => {
      const li = element('li');
      li.append(element('strong', '', item.title || catalog.courses.find(course => course.id === item.courseId)?.title || '과정'),
        element('span', '', item.message || '현재 학습할 수 없는 과정입니다.'));
      return li;
    }));
  }

  function renderAccount() {
    const hasAccount = !!(account?.userName && account?.password);
    const showForm = !hasAccount || editingAccount;
    const disabled = busy();
    byId('alphaAccountForm').hidden = !showForm;
    byId('alphaAccountView').hidden = showForm;
    byId('alphaEditAccount').hidden = showForm;
    byId('alphaTestLogin').hidden = showForm;
    byId('alphaEditAccount').disabled = disabled;
    byId('alphaCancelAccount').hidden = !hasAccount;
    for (const id of ['alphaUserName', 'alphaPassword', 'alphaSaveAccount', 'alphaCancelAccount', 'alphaTestLogin']) byId(id).disabled = disabled;
    byId('alphaSaveAccount').textContent = accountPending ? '로그인 중…' : '저장 및 로그인';
    byId('alphaAccountError').hidden = !accountError;
    byId('alphaAccountError').textContent = accountError;
    if (showForm && !accountFormInitialized) {
      byId('alphaUserName').value = account?.userName || '';
      byId('alphaPassword').value = '';
      byId('alphaPassword').placeholder = hasAccount ? '저장됨 (변경할 때 입력)' : '';
      byId('alphaPassword').required = !hasAccount;
      accountFormInitialized = true;
    }
    byId('alphaAccountSaved').textContent = account?.userName || '';
    const user = typeof auth?.user === 'string' ? auth.user : auth?.user?.name || auth?.user?.loginId || '';
    byId('alphaAuthText').textContent = accountPending ? '로그인 확인 중…'
      // 아이디는 같은 줄 앞에 이미 보이므로, 다른 이름일 때만 덧붙인다.
      : auth?.ok ? `로그인됨${user && user !== account?.userName ? ` · ${user}` : ''}`
        : auth ? `로그인 확인 필요: ${safeError(auth.message || '계정을 확인하세요.')}` : '아직 로그인을 확인하지 않았습니다.';
    byId('alphaAuthDot').className = `dot ${accountPending ? '' : auth?.ok ? 'ok' : auth ? 'warn' : ''}`;
  }

  function renderCertificates() {
    const loginId = certificateLoginId();
    const matchingBatch = !!loginId && certificateBatch.loginId === loginId;
    const batchItems = matchingBatch && Array.isArray(certificateBatch.items) ? certificateBatch.items : [];
    const ledger = loginId && Array.isArray(certificates.items)
      ? certificates.items.filter(item => item.loginId === loginId) : [];
    const itemKey = item => item.registrationId || `${item.courseId || ''}|${item.title || ''}`;
    const merged = new Map(batchItems.map(item => [itemKey(item), item]));
    for (const item of ledger) merged.set(itemKey(item), { ...merged.get(itemKey(item)), ...item });
    const items = [...merged.values()];
    const labels = {
      pending: '저장 대기', preparing: '발급 준비 중', downloading: '다운로드 중', complete: '저장 완료', failed: '저장 실패',
      interrupted: '다운로드 중단', missing: '파일 없음', unconfirmed: '저장 결과 확인 필요'
    };
    const complete = items.filter(item => item.status === 'complete').length;
    const pending = items.filter(item => ['pending', 'preparing', 'downloading'].includes(item.status)).length;
    const attention = items.length - complete - pending;
    byId('alphaCertificateCount').hidden = items.length === 0;
    byId('alphaCertificateCount').textContent = [`저장 ${complete}개`, pending ? `진행 ${pending}개` : '', attention ? `확인 ${attention}개` : ''].filter(Boolean).join(' · ');
    byId('alphaCertificateDetails').hidden = items.length === 0;
    byId('alphaCertificateList').replaceChildren(...items.map((item) => {
      const li = element('li');
      li.append(element('p', 'alpha-certificate-title', item.title || catalog.courses.find(course => course.id === item.courseId)?.title || '과정'));
      const label = labels[item.status] || '상태 확인 필요';
      li.append(element('p', `alpha-certificate-state ${Object.hasOwn(labels, item.status) ? item.status : ''}`,
        item.message ? `${label} · ${item.message}` : label));
      if (item.filename) li.append(element('p', 'alpha-certificate-file', `파일: ${item.filename}`));
      return li;
    }));
    byId('alphaCertificateEmpty').hidden = items.length > 0 || !loginId;
    renderCertificateBatch(matchingBatch, batchItems.map(item => merged.get(itemKey(item))));
    byId('alphaCertificatesAll').disabled = busy();
    byId('alphaCertificatesAllStop').hidden = !certificateBatch.busy || (!matchingBatch && !!certificateBatch.loginId);
    byId('alphaCertificatesAllStop').disabled = certificateBatchStopPending || certificateBatch.phase === 'stopping';
    byId('alphaCertificatesAllStop').textContent = certificateBatchStopPending || certificateBatch.phase === 'stopping' ? '중지 중…' : '전체 받기 중지';
    byId('alphaCertificateRetry').disabled = busy() || !!certificates.busy || !learningSelectionValid();
    byId('alphaCertificateRetry').textContent = certificatePending || certificates.busy ? '수료증 저장 확인 중…' : '수료증 저장 확인·재시도';
    byId('alphaCertificateResult').hidden = !certificateMessage;
    byId('alphaCertificateResult').textContent = certificateMessage;
    byId('alphaCertificateResult').className = `msg${certificateError ? ' warn' : ''}`;
  }

  function renderCertificateBatch(matching, items) {
    const phase = certificateBatch.phase || 'idle';
    const visible = phase !== 'idle' && (matching || !certificateBatch.loginId);
    byId('alphaCertificateBatch').hidden = !visible;
    if (!visible) return;
    const counts = {
      complete: items.filter(item => item.status === 'complete').length,
      downloading: items.filter(item => item.status === 'downloading').length,
      failed: items.filter(item => ['failed', 'interrupted', 'missing', 'unconfirmed'].includes(item.status)).length
    };
    const phases = {
      listing: '수료한 전체 과정 찾는 중', downloading: '수료증 발급·다운로드 중',
      done: counts.downloading ? '발급 준비 완료 · 다운로드 진행 중' : '전체 수료증 확인 완료',
      stopping: '남은 발급 준비 중지 중', stopped: '전체 받기 중지됨',
      interrupted: '전체 받기 중단됨', error: '전체 수료증 확인 실패'
    };
    byId('alphaCertificateBatchPhase').textContent = phases[phase] || '수료증 확인 중';
    byId('alphaCertificateBatchDot').className = `dot ${['error', 'interrupted'].includes(phase) ? 'warn' : certificateBatch.busy ? 'ok' : phase === 'done' ? 'done' : ''}`;
    const message = phase === 'done' && matching && items.length
      ? `수료증 ${items.length}개 처리 · 저장 완료 ${counts.complete}개 · 다운로드 중 ${counts.downloading}개 · 확인 필요 ${counts.failed}개`
      : [certificateBatch.message, matching ? certificateBatch.currentTitle : ''].filter(Boolean).join(' · ');
    byId('alphaCertificateBatchMessage').hidden = !message;
    byId('alphaCertificateBatchMessage').textContent = message;
    byId('alphaCertificateBatchMessage').className = `msg${['error', 'interrupted'].includes(phase) ? ' warn' : ''}`;
    const number = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const scanned = number(certificateBatch.scanned), total = number(certificateBatch.total), processed = number(certificateBatch.processed);
    byId('alphaCertificateBatchProgress').hidden = !matching;
    byId('alphaCertificateBatchProgress').textContent = phase === 'listing'
      ? `조회 ${scanned}개 · 수료 과정 ${total}개 발견`
      : `발급 확인 ${processed} / ${total}개 · 저장 ${counts.complete}개 · 다운로드 ${counts.downloading}개 · 확인 필요 ${counts.failed}개`;
    byId('alphaCertificateBatchBar').hidden = !matching || total === 0 || phase === 'listing';
    byId('alphaCertificateBatchBar').setAttribute('aria-valuemax', String(total));
    byId('alphaCertificateBatchBar').setAttribute('aria-valuenow', String(Math.min(processed, total)));
    byId('alphaCertificateBatchBarFill').style.width = `${total ? Math.min(100, processed / total * 100) : 0}%`;
  }

  async function runCertificateBatch(stop = false) {
    if (stop ? certificateBatchStopPending || !certificateBatch.busy || certificateBatch.phase === 'stopping' : busy()) return;
    if (stop) certificateBatchStopPending = true;
    else certificateBatchPending = true;
    certificateMessage = '';
    certificateError = false;
    render();
    try {
      const result = await action(stop ? 'alpha-certificates-all-stop' : 'alpha-certificates-all');
      if (result?.ok === false) throw new Error(result.error || result.message || '전체 수료증 요청을 처리하지 못했습니다.');
      certificateMessage = result?.message || '';
    } catch (error) {
      certificateMessage = safeError(error);
      certificateError = true;
    } finally {
      try {
        const saved = await chrome.storage.local.get({ alphaCertificates: { busy: false, items: [] }, alphaCertificateBatch: { busy: false, phase: 'idle', items: [] } });
        certificates = saved.alphaCertificates;
        certificateBatch = saved.alphaCertificateBatch;
      } catch (error) {
        certificateMessage = safeError(error);
        certificateError = true;
      }
      certificateBatchPending = false;
      certificateBatchStopPending = false;
      render();
    }
  }

  async function retryCertificates() {
    if (busy() || certificates.busy || !learningSelectionValid()) return;
    certificatePending = true;
    certificateMessage = '수료 상태와 수료증 저장 내역을 확인하고 있습니다.';
    certificateError = false;
    render();
    try {
      const result = await action('alpha-certificates-retry', { role: preferences.role, courseIds: [...preferences.selectedIds] });
      if (result?.ok === false) throw new Error(result.error || result.message || '수료증 저장 상태를 확인하지 못했습니다.');
      certificateMessage = result?.message || '과정별 수료증 상태를 확인하세요.';
    } catch (error) {
      certificateMessage = safeError(error);
      certificateError = true;
    } finally {
      try {
        const saved = await chrome.storage.local.get({ alphaCertificates: { busy: false, items: [] } });
        certificates = saved.alphaCertificates;
      } catch (error) {
        certificateMessage = safeError(error);
        certificateError = true;
      }
      certificatePending = false;
      render();
    }
  }

  async function stopRun() {
    if (stopPending || playerOpenPending || runner.phase === 'stopping' || (!runner.running && !runner.cleanupPending && !launchPending())) return;
    // 시작 응답을 기다리는 중에도 중지는 별도로 전달한다. 늦은 시작 오류는 중지 상태를 덮지 않는다.
    stopPending = true;
    controlRevision++;
    controlMessage = '';
    controlError = false;
    render();
    try {
      const result = await action('alpha-stop');
      if (result?.ok === false) throw new Error(result.error || result.message || '중지 요청을 처리하지 못했습니다.');
      const saved = await chrome.storage.local.get({ alphaRunner: { running: false, phase: 'idle' } });
      runner = saved.alphaRunner;
      if (!runner.running) controlPending = false;
    } catch (error) {
      controlMessage = safeError(error);
      controlError = true;
    } finally {
      stopPending = false;
      render();
    }
  }

  async function openPlayer() {
    if (playerOpenPending || stopPending || (controlPending && !canOpenPendingPlayer()) ||
        (!runner.running && runner.phase !== 'attention')) return;
    playerOpenPending = true;
    controlRevision++;
    controlMessage = '';
    controlError = false;
    render();
    try {
      // 설문만 남은 상태에서는 강의실이 아니라 설문 페이지를 바로 연다.
      const surveyOnly = !runner.running && runner.phase === 'attention' && runner.attentionReason === 'survey' && runner.courseId;
      const result = surveyOnly ? await action('alpha-survey-open', { courseId: runner.courseId }) : await action('alpha-player-open');
      if (result?.ok === false) throw new Error(result.error || result.message || '학습 화면을 열지 못했습니다.');
      const saved = await chrome.storage.local.get({ alphaRunner: { running: false, phase: 'idle' } });
      runner = saved.alphaRunner;
      if (!runner.running) controlPending = false;
    } catch (error) {
      controlMessage = safeError(error);
      controlError = true;
    } finally {
      playerOpenPending = false;
      render();
    }
  }

  async function runControl(type) {
    if (type === 'alpha-stop') return stopRun();
    if (type === 'alpha-player-open') return openPlayer();
    if (controlPending || stopPending || playerOpenPending || (type === 'alpha-start' && (busy() || !selectionValid())) ||
      (type === 'alpha-start-enrolled' && (busy() || !learningSelectionValid()))) return;
    if (type === 'alpha-continue-survey' && (busy() || runner.phase !== 'attention' || runner.attentionReason !== 'survey' || !runnerMatches())) return;
    if (type === 'alpha-retry' && busy()) return;
    const request = { type, revision: ++controlRevision };
    controlPending = request;
    controlMessage = '';
    controlError = false;
    render();
    try {
      const result = await action(type, ['alpha-start', 'alpha-start-enrolled', 'alpha-continue-survey'].includes(type)
        ? { role: preferences.role, courseIds: [...preferences.selectedIds] } : {});
      if (request.revision !== controlRevision) return;
      if (result?.ok === false) throw new Error(result.error || result.message || '자동 실행 요청을 처리하지 못했습니다.');
      const saved = await chrome.storage.local.get({ alphaRunner: { running: false, phase: 'idle' } });
      if (request.revision === controlRevision) runner = saved.alphaRunner;
    } catch (error) {
      if (request.revision === controlRevision) {
        controlMessage = safeError(error);
        controlError = true;
      }
    } finally {
      if (controlPending === request) controlPending = false;
      render();
    }
  }

  async function accountAction(type, fields = {}) {
    if (accountPending || busy()) return;
    accountPending = true;
    accountError = '';
    render();
    try {
      const result = await action(type, fields);
      if (result?.ok === false) throw new Error(result.error || result.message || '알파 로그인에 실패했습니다.');
      editingAccount = false;
      accountFormInitialized = false;
    } catch (error) {
      accountError = safeError(error, fields.password);
    } finally {
      byId('alphaPassword').value = '';
      try {
        const saved = await chrome.storage.local.get({ alphaAccount: null, alphaAuth: null });
        account = saved.alphaAccount;
        auth = saved.alphaAuth;
      } catch (error) {
        accountError = safeError(error, fields.password);
      }
      accountPending = false;
      render();
    }
  }

  async function runCourse(courseId, type) {
    if (courseAction?.pending) return;
    const working = { 'alpha-survey-open': '설문 페이지를 여는 중…', 'alpha-survey-auto': '설문을 제출하는 중…', 'alpha-course-certificate': '수료증을 확인하는 중…',
      'alpha-exam-open': '시험 화면을 여는 중…' };
    courseAction = { courseId, type, pending: true, message: working[type], error: false };
    render();
    try {
      const result = await action(type, { courseId });
      courseAction = { courseId, type, pending: false, message: result?.message || '완료했습니다.', error: result?.ok === false };
    } catch (error) {
      courseAction = { courseId, type, pending: false, message: safeError(error), error: true };
    }
    render();
  }

  // 로그인한 계정의 상태만 쓴다. 확인하지 못한 과정은 메뉴를 열어 두지 않는다.
  const statusOf = (courseId) => {
    const loginId = certificateLoginId();
    // 화면이 아는 로그인 계정과 조회한 계정이 다르면 쓰지 않는다.
    return loginId && courseStatus?.loginId !== loginId ? undefined : courseStatus?.items?.[courseId];
  };
  function requestCourseStatus(force = false) {
    if (statusRequest || !validRole(preferences.role)) return;
    const courseIds = catalog.courses.filter((course) => course.roles.includes(preferences.role)).map((course) => course.id);
    statusRequest = action('alpha-course-status', { courseIds, force }).catch(() => {}).finally(() => { statusRequest = null; });
  }

  async function reserveSurvey(courseId, on) {
    if (courseAction?.pending) return;
    try {
      const result = await action('alpha-survey-reserve', { courseId, on });
      courseAction = { courseId, type: 'alpha-survey-reserve', pending: false, message: result?.message || '', error: false };
    } catch (error) {
      courseAction = { courseId, type: 'alpha-survey-reserve', pending: false, message: safeError(error), error: true };
    }
    render();
  }

  function autoSurvey(courseId) {
    if (courseAction?.pending) return;
    // 설문 제출은 되돌릴 수 없으므로 한 번 더 눌러야 보낸다.
    if (!(courseAction?.courseId === courseId && courseAction.confirm)) {
      courseAction = { courseId, type: 'alpha-survey-auto', pending: false, confirm: true, message: '한 번 더 누르면 제출합니다.', error: false };
      render();
      return;
    }
    runCourse(courseId, 'alpha-survey-auto');
  }

  function renderCategories() {
    const nextKey = JSON.stringify([preferences.role, preferences.selectedIds, busy(), courseAction,
      catalog.courses.map((course) => statusOf(course.id) || ''), reservedSurveys, runner.running && runner.courseId]);
    if (nextKey === categoriesKey) return;
    categoriesKey = nextKey;
    const focusedCourseId = document.activeElement?.dataset?.alphaCourseId;
    const hasRole = validRole(preferences.role);
    byId('alphaCategories').replaceChildren(...catalog.categories.map((category, index) => {
      const card = element('section', 'card alpha-category');
      const header = element('div', 'row');
      header.append(element('h3', '', `${index + 1}. ${category.label}`), element('span', 'chip', '1과정 필수'));
      card.append(header);
      const courses = hasRole ? catalog.courses.filter((c) => c.categoryId === category.id && c.roles.includes(preferences.role)) : [];
      for (const course of courses) {
        const label = element('label', 'alpha-choice');
        const input = element('input');
        input.type = 'checkbox';
        input.dataset.alphaCourseId = course.id;
        input.checked = preferences.selectedIds.includes(course.id);
        input.disabled = busy();
        input.addEventListener('change', async () => {
          const others = preferences.selectedIds.filter((id) => id !== course.id);
          preferences.selectedIds = input.checked ? [...others, course.id] : others;
          localMessage = '';
          certificateMessage = '';
          certificateError = false;
          render();
          await savePreferences();
        });
        label.append(input, element('span', '', course.title));
        // 과정의 수강 상태를 이름 옆에 짧게 보여 준다(메뉴가 꺼져 있는 이유가 여기서 보인다).
        // 지금 재생 중인 과정은 진도가 아직 기록되지 않았어도 수강중으로 보인다.
        const watching = runner.running && runner.courseId === course.id && ['enrolled', 'learning'].includes(statusOf(course.id));
        const shownState = watching ? 'learning' : statusOf(course.id);
        const stateLabel = { enrolled: '수강신청', learning: '수강중', exam: '시험 남음', survey: '설문 남음', completed: '수료완료',
          'not-enrolled': '미신청', waiting: '승인 대기', attention: '확인 필요' }[shownState];
        if (stateLabel) label.append(element('span', `alpha-course-state ${shownState}`, stateLabel));
        const links = element('div', 'alpha-course-links');
        const open = element('button', 'link', '과정 상세 보기');
        open.type = 'button';
        open.addEventListener('click', () => openCourse(course.id));
        links.append(open);
        // 과정별 메뉴: 백그라운드 재생 중에도 쓸 수 있고, 한 번에 하나만 처리한다.
        const mine = courseAction?.courseId === course.id ? courseAction : null;
        // 설문 메뉴는 영상을 모두 본(설문만 남은) 과정에서만, 수료증은 수료한 과정에서만 눌린다.
        const status = statusOf(course.id);
        const surveyReady = status === 'survey';
        const certificateReady = status === 'completed';
        const surveyWhy = status === 'completed' ? '이미 수료한 과정입니다.' : status === 'exam' ? '시험을 마치면 쓸 수 있습니다.'
          : ['learning', 'enrolled'].includes(status) ? '영상 학습을 마치면 쓸 수 있습니다.' : '수강 상태를 확인하지 못했습니다.';
        // 영상이 남은 과정의 자동 설문은 예약이다: 영상이 끝나면 실행이 설문을 제출한다. 다시 누르면 취소.
        const reservable = status === 'learning' || status === 'enrolled';
        const examReady = status === 'exam';
        const reserved = reservable && reservedSurveys.includes(course.id);
        const menu = [
          ['설문 바로가기', () => runCourse(course.id, 'alpha-survey-open'), surveyReady, surveyReady ? '이 과정의 설문 페이지를 엽니다.' : surveyWhy],
          [mine?.confirm ? '제출 확인' : reserved ? '설문 예약됨' : '자동 설문',
            () => (reservable ? reserveSurvey(course.id, !reserved) : autoSurvey(course.id)), surveyReady || reservable,
            surveyReady ? '모든 문항을 "그렇다", 서술형은 "좋았다"로 제출합니다.'
              : reserved ? '영상이 끝나면 설문을 제출합니다. 누르면 예약을 취소합니다.'
                : reservable ? '누르면 영상이 끝난 뒤 설문을 자동으로 제출합니다.' : surveyWhy, reserved],
          ['수료증 받기', () => runCourse(course.id, 'alpha-course-certificate'), certificateReady,
            certificateReady ? '수료증을 저장합니다.' : '수료한 과정만 받을 수 있습니다.'],
        ];
        // 시험이 있는 과정에만 보인다. 시험은 자동으로 응시하지 않고 시험 화면만 연다.
        if (String(course.completion || '').includes('시험')) {
          menu.splice(2, 0, ['시험 바로가기', () => runCourse(course.id, 'alpha-exam-open'), examReady,
            examReady ? '시험 화면을 열어 직접 응시합니다.' : status === 'completed' ? '이미 수료한 과정입니다.' : '영상 학습을 마치면 쓸 수 있습니다.']);
        }
        for (const [text, handler, enabled, title, active] of menu) {
          const button = element('button', `link${active ? ' on' : ''}`, text);
          button.type = 'button';
          button.title = title;
          if (active) button.setAttribute('aria-pressed', 'true');
          button.disabled = !!courseAction?.pending || !enabled;
          button.addEventListener('click', handler);
          links.append(button);
        }
        card.append(label, links);
        if (mine?.message) {
          const result = element('p', `msg alpha-course-result${mine.error ? ' warn' : ''}`, mine.message);
          result.setAttribute('role', 'status');
          card.append(result);
        }
        if (course.duration || course.completion) card.append(element('p', 'hint alpha-course-detail', [course.duration, course.completion].filter(Boolean).join(' · ')));
        if (course.note) label.title = course.note;
      }
      return card;
    }));
    if (focusedCourseId) {
      const replacement = [...document.querySelectorAll('[data-alpha-course-id]')].find((input) => input.dataset.alphaCourseId === focusedCourseId);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
  }

  function renderSelected() {
    const courses = selectedCourses();
    const matched = checkedMatches();
    byId('alphaSelectedCount').textContent = `${courses.length} / ${catalog.categories.length}개 선택`;
    byId('alphaSelectedEmpty').hidden = courses.length > 0;
    byId('alphaSelected').replaceChildren(...courses.map((course) => {
      const item = matched ? (state.items || []).find((x) => x.courseId === course.id) : null;
      const li = element('li');
      li.append(element('p', 'alpha-item-title', course.title));
      const status = item?.status || 'unknown';
      const statusLabel = labels[status] || '확인 결과';
      li.append(element('p', `alpha-item-status ${Object.hasOwn(labels, status) ? status : ''}`, item?.message ? `${statusLabel} · ${item.message}` : statusLabel));
      return li;
    }));
    const validation = validRole(preferences.role) ? catalog.validateSelection(preferences.role, preferences.selectedIds) : { ok: false };
    const available = matched ? (state.items || []).filter((item) => item.canEnroll && preferences.selectedIds.includes(item.courseId)).length : 0;
    byId('alphaCheck').disabled = busy() || !validation.ok;
    byId('alphaCheck').textContent = actionPending || state.busy ? '처리 중…' : '신청 가능 여부만 확인';
    byId('alphaEnroll').disabled = busy() || !validation.ok || available === 0;
    byId('alphaEnroll').textContent = available ? `신청 가능한 ${available}개 신청만 실행` : '수강신청만 실행';
    const enrollHint = validation.ok && matched && available === 0 ? '자동 신청 가능한 과정이 없습니다.' : '';
    byId('alphaEnrollHint').textContent = enrollHint;
    byId('alphaEnrollHint').hidden = !enrollHint;
  }

  function render() {
    roleInputs.forEach((input) => { input.checked = input.value === preferences.role; input.disabled = busy(); });
    byId('alphaRequirement').hidden = validRole(preferences.role);
    byId('alphaSourceNote').textContent = `${catalog.completionYear}년 수료 · 소속 ${catalog.affiliation} · 제출 기한 ${catalog.deadline}`;
    byId('alphaAuthHint').hidden = !!account?.userName || !!auth?.ok;
    const message = localMessage || (checkedMatches() ? state.message : '') || '';
    byId('alphaResult').textContent = message;
    byId('alphaResult').hidden = !message;
    byId('alphaResult').className = `msg${localError ? ' warn' : ''}`;
    renderRunner();
    renderAccount();
    renderCertificates();
    renderCategories();
    renderSelected();
  }

  async function run(type) {
    if (busy()) return;
    actionPending = true;
    localMessage = type === 'alpha-enroll' ? '선택한 과정의 수강신청을 진행하고 있습니다.' : '알파의 신청 가능 여부를 확인하고 있습니다.';
    localError = false;
    render();
    try {
      const result = await action(type, { role: preferences.role, courseIds: [...preferences.selectedIds] });
      if (result?.ok === false) throw new Error(result.error || result.message || '요청을 처리하지 못했습니다.');
      const saved = await chrome.storage.local.get({ alphaState: { busy: false, items: [] } });
      state = saved.alphaState;
      localMessage = result?.message || state.message || '확인이 끝났습니다. 과정별 결과를 확인하세요.';
    } catch (error) {
      localMessage = error.message;
      localError = true;
    } finally {
      actionPending = false;
      render();
    }
  }

  roleInputs.forEach((input) => input.addEventListener('change', async () => {
    if (!input.checked || !validRole(input.value)) return;
    preferences = { role: input.value, selectedIds: catalog.defaultsForRole(input.value) };
    localMessage = '';
    localError = false;
    controlMessage = '';
    controlError = false;
    certificateMessage = '';
    certificateError = false;
    render();
    await savePreferences();
  }));
  byId('alphaOpen').addEventListener('click', () => openCourse());
  byId('alphaCheck').addEventListener('click', () => run('alpha-check'));
  byId('alphaEnroll').addEventListener('click', () => run('alpha-enroll'));
  byId('alphaStart').addEventListener('click', () => runControl('alpha-start'));
  byId('alphaStartEnrolled').addEventListener('click', () => runControl('alpha-start-enrolled'));
  byId('alphaStop').addEventListener('click', () => runControl('alpha-stop'));
  byId('alphaRetry').addEventListener('click', () => runControl('alpha-retry'));
  byId('alphaContinue').addEventListener('click', () => runControl('alpha-continue-survey'));
  byId('alphaPlayerOpen').addEventListener('click', () => runControl('alpha-player-open'));
  byId('alphaCertificateRetry').addEventListener('click', retryCertificates);
  byId('alphaCertificatesAll').addEventListener('click', () => runCertificateBatch());
  byId('alphaCertificatesAllStop').addEventListener('click', () => runCertificateBatch(true));
  byId('alphaTestLogin').addEventListener('click', () => accountAction('alpha-account-test'));
  byId('alphaEditAccount').addEventListener('click', () => {
    editingAccount = true;
    accountFormInitialized = false;
    accountError = '';
    renderAccount();
    byId('alphaUserName').focus();
  });
  byId('alphaCancelAccount').addEventListener('click', () => {
    editingAccount = false;
    accountFormInitialized = false;
    accountError = '';
    byId('alphaPassword').value = '';
    renderAccount();
  });
  byId('alphaUserName').addEventListener('input', () => {
    byId('alphaPassword').required = !account?.password || byId('alphaUserName').value.trim() !== account.userName;
  });
  byId('alphaAccountForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const userName = byId('alphaUserName').value.trim();
    const password = byId('alphaPassword').value || (userName === account?.userName ? account.password : '');
    if (!userName || !password) {
      accountError = '알파 아이디와 비밀번호를 입력하세요.';
      renderAccount();
      return;
    }
    byId('alphaPassword').value = '';
    accountAction('alpha-account-save', { userName, password });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.alphaState) state = changes.alphaState.newValue || { busy: false, items: [] };
    if (changes.alphaPreferences) preferences = changes.alphaPreferences.newValue || { role: '', selectedIds: [] };
    if (changes.alphaRunner) {
      runner = changes.alphaRunner.newValue || { running: false, phase: 'idle' };
      // 실행이 과정을 넘기거나 끝내면(영상 완료·수료) 과정별 메뉴 상태를 다시 확인한다.
      const key = [runner.courseId, (runner.surveyCourses || []).length, (runner.examCourses || []).length, (runner.completedCourseIds || []).length, runner.phase === 'done'].join('|');
      if (key !== runnerProgressKey) { runnerProgressKey = key; requestCourseStatus(true); }
    }
    if (changes.alphaCourseStatus) courseStatus = changes.alphaCourseStatus.newValue || { loginId: '', items: {} };
    if (changes.alphaSurveyReserved) reservedSurveys = Array.isArray(changes.alphaSurveyReserved.newValue) ? changes.alphaSurveyReserved.newValue : [];
    if (changes.alphaAccount) account = changes.alphaAccount.newValue || null;
    if (changes.alphaAuth) {
      const previousLoginId = certificateLoginId();
      auth = changes.alphaAuth.newValue || null;
      if (previousLoginId !== certificateLoginId()) {
        certificateMessage = '';
        certificateError = false;
      }
    }
    if (changes.alphaCertificates) certificates = changes.alphaCertificates.newValue || { busy: false, items: [] };
    if (changes.alphaCertificateBatch) {
      certificateBatch = changes.alphaCertificateBatch.newValue || { busy: false, phase: 'idle', items: [] };
      if (!certificateError) certificateMessage = '';
    }
    if (changes.alphaAuth || changes.alphaPreferences) requestCourseStatus();
    if (changes.alphaState || changes.alphaPreferences || changes.alphaRunner || changes.alphaAccount || changes.alphaAuth || changes.alphaCertificates ||
        changes.alphaCertificateBatch || changes.alphaCourseStatus || changes.alphaSurveyReserved) render();
  });
  // 알파 탭을 볼 때 과정별 수강 상태를 확인한다(조회만 하며, 로그인되어 있지 않으면 아무것도 하지 않는다).
  new MutationObserver(() => { if (!byId('tabAlpha').hidden) requestCourseStatus(); })
    .observe(byId('tabAlpha'), { attributes: true, attributeFilter: ['hidden'] });
  chrome.storage.local.get({ alphaPreferences: null, alphaState: null, alphaRunner: null, alphaAccount: null, alphaAuth: null, alphaCertificates: null, alphaCertificateBatch: null, alphaCourseStatus: null, alphaSurveyReserved: [] }).then((saved) => {
    if (saved.alphaPreferences && validRole(saved.alphaPreferences.role)) {
      preferences = { role: saved.alphaPreferences.role, selectedIds: Array.isArray(saved.alphaPreferences.selectedIds) ? saved.alphaPreferences.selectedIds : catalog.defaultsForRole(saved.alphaPreferences.role) };
    }
    if (saved.alphaState) state = saved.alphaState;
    if (saved.alphaRunner) runner = saved.alphaRunner;
    account = saved.alphaAccount;
    auth = saved.alphaAuth;
    if (saved.alphaCertificates) certificates = saved.alphaCertificates;
    if (saved.alphaCertificateBatch) certificateBatch = saved.alphaCertificateBatch;
    if (saved.alphaCourseStatus) courseStatus = saved.alphaCourseStatus;
    if (Array.isArray(saved.alphaSurveyReserved)) reservedSurveys = saved.alphaSurveyReserved;
    runnerProgressKey = [runner.courseId, (runner.surveyCourses || []).length, (runner.completedCourseIds || []).length, runner.phase === 'done'].join('|');
    render();
    if (!byId('tabAlpha').hidden) requestCourseStatus();
  }).catch((error) => { localMessage = `저장된 신청 설정을 읽지 못했습니다: ${error.message}`; localError = true; render(); });
})();
