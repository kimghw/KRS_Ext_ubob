// ALPHA Campus public learner API. Schema verified from the live explore page.
// Keep profile details and CSRF tokens out of extension storage and error output.
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const INSPECTION_TTL = 60 * 1000;
  const SEQUENCE_QUERY = `query GetSequenceList($request: GetSequenceListInput!) {
    sequences: getSequenceLists(request: $request) {
      id name cost subject { id type selectionLesson }
      buttonStatus { status } myRegistration { id status }
      applicationStartDateTime applicationEndDateTime studyStartDateTime studyEndDateTime
      always autoApproval selectionLesson selectionModuleCount minimalSelectionModuleCount
      useTextbook textbookCost modules { id cost lessons { id mandatory } }
    }
  }`;
  const APPLY_MUTATION = `mutation applyRegistration($request: ApplyRegistrationInput!) {
    registration: applyRegistration(request: $request) { id status }
  }`;
  const STATUS_MESSAGES = {
    SEQUENCE_PREPARING: '개설 준비 중입니다.',
    NO_OPENED_SEQUENCE: '현재 개설된 차수가 없습니다.',
    NO_MODULES: '교육 구성이 준비되지 않았습니다.',
    NO_LESSONS: '신청할 강의가 없습니다.',
    NO_CERTIFICATE: '수료증 설정이 준비되지 않았습니다.',
    IS_TUTOR: '이 과정의 강사는 수강 신청할 수 없습니다.',
    NOT_IN_PERIOD: '수강 신청 기간이 아닙니다.',
    CAPACITY_FULL: '신청 정원이 마감되었습니다.',
    WAITING: '대기 신청은 알파 과정 페이지에서 확인해 주세요.',
    REREGISTRATION: '재수강 신청은 알파 과정 페이지에서 확인해 주세요.',
    NEED_COMPLETE: '기존 차수를 수료한 뒤 신청할 수 있습니다.',
    MICRO_LEARNING: '바로학습 과정은 알파 과정 페이지에서 이용해 주세요.'
  };

  function fail(message, code = 'API') {
    return Object.assign(new Error(message), { code, alphaApiError: true });
  }
  function safeMessage(value) {
    return String(value || '알파가 요청을 처리하지 못했습니다.')
      .replace(/java\.lang\.\w+Exception:\s*/g, '')
      .replace(/<[^>]*>/g, ' ').replace(/[\r\n\t]+/g, ' ')
      .replace(/(?:Bearer\s+)[\w.+\/-]+/gi, '[인증정보]')
      .replace(/((?:password|token|cookie|authorization)\s*[:=]\s*)\S+/gi, '$1[숨김]')
      .slice(0, 240).trim();
  }
  // API timestamps have no offset and represent Korean local time.
  function koreaTimestamp(value) {
    if (typeof value !== 'string' || !value) return NaN;
    const text = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`;
    return Date.parse(text);
  }
  function validCourse(course) {
    return course && UUID.test(course.id) && UUID.test(course.sequenceId);
  }
  function classifySequence(sequence, course, now = Date.now()) {
    const result = (status, message, canEnroll = false) => ({
      courseId: course && course.id, status, message, canEnroll,
      checkedAt: now, sequence: sequence || null
    });
    if (!validCourse(course)) return result('manual', '교육 식별자가 올바르지 않습니다.');
    if (!sequence || sequence.id !== course.sequenceId || sequence.subject?.id !== course.id) {
      return result('unavailable', '엑셀에 지정된 차수를 찾지 못했습니다. 과정 페이지에서 확인해 주세요.');
    }
    const status = sequence.buttonStatus?.status;
    const registrationStatus = sequence.myRegistration?.status;
    if (status === 'ALREADY_COMPLETED' || registrationStatus === 'COMPLETED') {
      return result('completed', '이미 수료한 차수입니다.');
    }
    if (status === 'ALREADY_IN_PROGRESS' || (sequence.myRegistration?.id &&
        ['REQUESTED', 'APPROVED', 'WAITING'].includes(registrationStatus))) {
      return result('enrolled', '이미 신청했거나 수강 중인 차수입니다.');
    }
    // 수강 중 강의를 마치면 승인이 미수료(NOT_COMPLETED)로 바뀌고, 사이트는 "기존 차수를 수료해야 함"(NEED_COMPLETE)으로
    // 표시한다. 아직 수강 중인 차수이므로 다시 신청하지 않는다. 기간이 끝난 미수료는 이 버튼 상태가 아니라 아래에서 확인 대상이 된다.
    if (sequence.myRegistration?.id && registrationStatus === 'NOT_COMPLETED' && status === 'NEED_COMPLETE') {
      return result('enrolled', '수강 중인 차수입니다(미수료, 학습 진행 중).');
    }
    if (sequence.myRegistration?.id && !['CANCELLED', 'REJECTED'].includes(registrationStatus)) {
      return result('manual', '기존 수강 이력을 알파 과정 페이지에서 확인해 주세요.');
    }
    if (status !== 'REGISTRABLE') {
      const manual = ['WAITING', 'REREGISTRATION', 'MICRO_LEARNING'].includes(status) || !STATUS_MESSAGES[status];
      return result(manual ? 'manual' : 'unavailable', STATUS_MESSAGES[status] || '신청 가능 여부를 알파 과정 페이지에서 확인해 주세요.');
    }
    if (String(sequence.subject.type) !== '4') return result('manual', '온라인 교육 유형을 확인해야 합니다.');
    if (sequence.always !== true) {
      const start = koreaTimestamp(sequence.applicationStartDateTime);
      const end = koreaTimestamp(sequence.applicationEndDateTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return result('manual', '수강 신청 기간을 확인하지 못했습니다.');
      }
      if (now < start || now > end) return result('unavailable', '수강 신청 기간이 아닙니다.');
    }
    if (sequence.cost !== 0 || sequence.useTextbook !== false || sequence.textbookCost !== 0) {
      return result('manual', '교육비 또는 교재 조건은 알파 과정 페이지에서 확인해 주세요.');
    }
    if (sequence.selectionLesson !== false || sequence.subject.selectionLesson !== false ||
        sequence.selectionModuleCount !== 0 || sequence.minimalSelectionModuleCount !== 0) {
      return result('manual', '강의 선택이 필요한 과정은 알파 과정 페이지에서 신청해 주세요.');
    }
    const modules = sequence.modules;
    if (!Array.isArray(modules) || !modules.length || modules.some(m =>
      !m || !UUID.test(m.id) || m.cost !== 0 || !Array.isArray(m.lessons))) {
      return result('manual', '강의 구성 또는 비용 정보를 확인하지 못했습니다.');
    }
    const lessonIds = modules.flatMap(m => m.lessons.map(l => l?.id));
    if (!lessonIds.length || lessonIds.some(id => !UUID.test(id)) ||
        new Set(lessonIds).size !== lessonIds.length || new Set(modules.map(m => m.id)).size !== modules.length) {
      return result('manual', '신청할 강의 정보를 확인하지 못했습니다.');
    }
    return result('available', '무료 온라인 교육 · 자동 신청 가능', true);
  }

  function createClient({ fetchImpl = root.fetch.bind(root), getCsrfToken = async () => null } = {}) {
    async function request(path, body, { mutation = false } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const headers = { Accept: 'application/json' };
        if (body) {
          headers['Content-Type'] = 'application/json';
          const token = await getCsrfToken();
          if (mutation && !token) throw fail('알파 로그인 페이지를 연 뒤 로그인 상태를 다시 확인해 주세요. 신청 인증정보가 없습니다.', 'CSRF');
          if (token) {
            try { headers['X-XSRF-TOKEN'] = decodeURIComponent(token); }
            catch { throw fail('알파 신청 인증정보를 읽지 못했습니다. 알파에서 다시 로그인해 주세요.', 'CSRF'); }
          }
          if (controller.signal.aborted) throw fail('알파 응답 시간이 초과되었습니다.', 'TIMEOUT');
        }
        const response = await fetchImpl(`${ORIGIN}${path}`, {
          method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
          headers, signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {})
        });
        if (response.status === 401 || response.status === 403 || response.redirected) {
          throw fail('알파 로그인이 만료되었거나 요청 인증에 실패했습니다. 알파에서 로그인한 뒤 다시 확인해 주세요.', 'AUTH');
        }
        if (!response.ok) throw fail(`알파 요청에 실패했습니다 (HTTP ${response.status}).`, 'HTTP');
        let data;
        try { data = await response.json(); } catch { throw fail('알파 응답을 읽지 못했습니다. 잠시 후 다시 확인해 주세요.', 'RESPONSE'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('알파 응답 형식이 변경되었습니다.', 'RESPONSE');
        if (Array.isArray(data.errors) && data.errors.length) throw fail(safeMessage(data.errors[0]?.message));
        return data;
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) throw fail('알파 응답 시간이 초과되었습니다. 신청 결과는 목록을 새로고침해 확인해 주세요.', 'TIMEOUT');
        if (error?.alphaApiError) throw error;
        throw fail('알파에 연결하지 못했습니다. 연결 상태를 확인해 주세요.', 'NETWORK');
      } finally { clearTimeout(timer); }
    }
    return {
      async session() {
        const data = await request('/api/user');
        return { authenticated: data.authenticated === true && data.active !== false,
          ...(data.authenticated === true && data.active !== false && typeof data.loginId === 'string' ? { loginId: data.loginId } : {}) };
      },
      async inspect(course) {
        if (!validCourse(course)) throw fail('교육 식별자가 올바르지 않습니다.', 'COURSE');
        const data = await request('/api/graphql', { operationName: 'GetSequenceList', query: SEQUENCE_QUERY,
          variables: { request: { subjectId: course.id } } });
        if (!Array.isArray(data.data?.sequences)) throw fail('알파 교육 목록 응답 형식이 변경되었습니다.', 'RESPONSE');
        const matches = data.data.sequences.filter(s => s?.id === course.sequenceId);
        if (matches.length > 1) throw fail('교육 차수가 중복되어 자동 신청할 수 없습니다.', 'RESPONSE');
        return classifySequence(matches[0], course);
      },
      async enroll(course, inspection) {
        if (!validCourse(course) || inspection?.courseId !== course.id || !inspection.canEnroll ||
            !Number.isFinite(inspection.checkedAt) || Date.now() - inspection.checkedAt > INSPECTION_TTL ||
            inspection.checkedAt > Date.now() || !classifySequence(inspection.sequence, course).canEnroll) {
          throw fail('신청 가능 상태를 다시 확인한 뒤 신청해 주세요.', 'STALE');
        }
        const data = await request('/api/graphql', { operationName: 'applyRegistration', query: APPLY_MUTATION,
          variables: { request: { sequenceId: course.sequenceId, staying: false, selectedModuleIds: [],
            selectedLessonIds: inspection.sequence.modules.flatMap(m => m.lessons.map(l => l.id)) } } }, { mutation: true });
        if (!UUID.test(data.data?.registration?.id) || typeof data.data.registration.status !== 'string') {
          throw fail('신청 결과를 확인하지 못했습니다. 목록을 새로고침해 신청 상태를 확인해 주세요.', 'UNCERTAIN');
        }
        return data.data;
      }
    };
  }
  root.AlphaAPI = Object.freeze({ ORIGIN, createClient, classifySequence, koreaTimestamp });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlphaAPI;
})(globalThis);
