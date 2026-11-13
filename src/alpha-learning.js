// 실제 강의실의 읽기 API만 사용한다. beginStudy/watch 등 학습 기록은 사이트 플레이어가 처리한다.
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // 15(INTERACTIVE, 사이트 이름 "저작도구")도 재생 대상이다. 실제 값(2026-11-13): 영상 파일 하나를 저작도구 플레이어로
  // 감싼 강의이고 상호작용은 영상 끝의 링크·이미지뿐이다. 숨겨진 플레이어가 그 플레이어의 영상을 재생한다(alpha-embed-player.js).
  const MEDIA_TYPES = new Set([2, 3, 5, 15]);
  // ALPHA _app-1661222066ac702b.js의 contentPool type 매핑:
  // 10 EXAM_PAPER, 11 REPORT, 12 SURVEY (surveyPaper), 15 INTERACTIVE.
  const CONTENT_TYPES = Object.freeze({ EXAM: 10, REPORT: 11, SURVEY: 12, INTERACTIVE: 15 });
  const LESSON_FIELDS = `id name type lessonOrder startDateTime endDateTime
    contentPool { id name type duration }
    myStudies { id progress completed deleted lastModifiedDateTime registration { id } }`;
  const SEQUENCE_QUERY = `query AlphaLearningSequence($request: GetSequenceListInput!) {
    sequences: getSequenceLists(request: $request) { id subject { id } myRegistration { id status } }
  }`;
  const REGISTRATION_QUERY = `query AlphaLearningRegistration($id: ID!) {
    registration: getRegistrationById(id: $id) {
      id status startDateTime endDateTime
      sequence { id selectionLesson subject { id type }
        modules { id moduleOrder lessons { ${LESSON_FIELDS} subLessons { ${LESSON_FIELDS} } } }
      }
      selectedLessons { ${LESSON_FIELDS} subLessons { ${LESSON_FIELDS} } }
    }
  }`;

  function timestamp(value) {
    if (typeof value !== 'string' || !value) return NaN;
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`);
  }

  function classroomUrl(registrationId, lessonId) {
    if (!UUID.test(registrationId) || (lessonId && !UUID.test(lessonId))) throw new Error('알파 강의실 식별자가 올바르지 않습니다.');
    const url = new URL('/my/classRoom/classRoomDetail', ORIGIN);
    url.searchParams.set('registrationId', registrationId);
    // subject.type=4는 조합교육 분류다. 공식 내 강의실은 온라인/조합교육 모두 ONLINE으로 입장한다.
    // classRoomDetail은 숫자 4를 받으면 플레이어 영역을 렌더링하지 않는다.
    url.searchParams.set('type', 'ONLINE');
    if (lessonId) url.searchParams.set('sequenceLessonId', lessonId);
    return url.href;
  }

  // 과정 목록에서 과정을 눌렀을 때 열 내 강의실 주소. 신청하지 않았거나 아직 들어갈 수 없는 과정,
  // 강의실을 확인하지 못한 과정은 null을 돌려준다(교육탐색의 과정 소개를 연다).
  function courseRoomUrl(result) {
    if (!result || ['not-enrolled', 'waiting'].includes(result.status) || !UUID.test(result.registrationId)) return null;
    let url;
    try { url = new URL(result.url); } catch { return null; }
    if (url.origin !== ORIGIN || url.pathname !== '/my/classRoom/classRoomDetail' ||
        url.searchParams.get('registrationId') !== result.registrationId) return null;
    // 영상이 남은 과정은 차시를 지정하지 않고 과정의 강의실로 연다. 백그라운드에서 재생 중인 강의를 탭에서 또 열지 않는다.
    // 설문처럼 직접 진행할 차시가 정해진 과정은 그 차시가 그대로 열린다.
    if (result.status === 'ready') url.searchParams.delete('sequenceLessonId');
    return url.href;
  }

  function parseRegistration(course, registration, now = Date.now()) {
    const result = {
      courseId: course.id, registrationId: registration?.id || null,
      status: 'attention', message: '', lessons: [], nextLesson: null, url: course.url,
    };
    const fail = message => ({ ...result, message });
    if (!registration || !UUID.test(registration.id) || registration.sequence?.id !== course.sequenceId ||
        registration.sequence?.subject?.id !== course.id || String(registration.sequence?.subject?.type) !== '4') {
      return fail('신청한 교육과 강의실 정보가 일치하지 않습니다. 알파에서 확인하세요.');
    }
    result.url = classroomUrl(registration.id);
    if (registration.status === 'COMPLETED') return { ...result, status: 'completed', message: '사이트에서 수료가 확인되었습니다.' };
    if (['REQUESTED', 'WAITING', 'WAITING_PAYMENT'].includes(registration.status)) {
      return { ...result, status: 'waiting', message: '신청 승인 또는 입과를 기다리는 과정입니다.' };
    }
    // 알파는 강의를 하나 마치면 수료 기준을 평가해 승인(APPROVED)을 미수료(NOT_COMPLETED)로 바꾼다.
    // 사이트 강의실(classRoomDetail의 학습 기간 검사)은 두 상태를 똑같이 학습 기간 안에서 수강할 수 있게 한다.
    if (!['APPROVED', 'NOT_COMPLETED'].includes(registration.status)) return fail('현재 수강 상태는 알파 강의실에서 확인해야 합니다.');
    const start = timestamp(registration.startDateTime);
    const end = timestamp(registration.endDateTime);
    // 기간이 끝난 뒤의 미수료는 더 수강할 수 없는 최종 상태이므로, 종료일을 확인할 수 없으면 재생하지 않는다.
    if (registration.status === 'NOT_COMPLETED' && !Number.isFinite(end)) {
      return fail('미수료 과정의 학습 기간을 확인하지 못했습니다. 알파 강의실에서 확인하세요.');
    }
    if (Number.isFinite(start) && now < start) return { ...result, status: 'waiting', message: '아직 학습 기간이 시작되지 않았습니다.' };
    if (Number.isFinite(end) && now > end) return { ...result, attentionReason: 'expired',
      message: '학습 기간이 종료되었습니다. 알파 강의실에서 확인하세요.' };

    const sequence = registration.sequence;
    let lessons;
    if (sequence.selectionLesson === true) {
      if (!Array.isArray(registration.selectedLessons)) return fail('선택한 강의 목록을 확인하지 못했습니다.');
      lessons = [...registration.selectedLessons].sort((a, b) => a.lessonOrder - b.lessonOrder);
    } else if (sequence.selectionLesson === false && Array.isArray(sequence.modules)) {
      lessons = [...sequence.modules].sort((a, b) => a.moduleOrder - b.moduleOrder)
        .flatMap(module => Array.isArray(module.lessons)
          ? [...module.lessons].sort((a, b) => a.lessonOrder - b.lessonOrder) : []);
    } else return fail('강의 선택 조건을 확인하지 못했습니다.');

    const seen = new Set();
    for (const lesson of lessons.flatMap(lesson => [lesson, ...(lesson.subLessons || [])])) {
      if (!lesson || !UUID.test(lesson.id) || !lesson.contentPool ||
          (lesson.myStudies !== null && !Array.isArray(lesson.myStudies))) {
        return fail('강의 또는 학습 이력의 응답 형식이 변경되었습니다.');
      }
      if (seen.has(lesson.id)) continue;
      seen.add(lesson.id);
      // 알파는 아직 시작하지 않은 강의·설문의 myStudies를 null로 반환한다.
      // 공식 강의실처럼 이력이 없는 미학습 상태로 처리하고 실제 재생은 사이트에 맡긴다.
      const studies = (lesson.myStudies ?? []).filter(study => study && study.deleted !== true && study.registration?.id === registration.id);
      // 같은 등록의 복수 기록은 최신 기록을 기준으로 보되, 다른 등록의 수료 기록은 제외한다.
      const study = [...studies].sort((a, b) => (timestamp(b.lastModifiedDateTime) || 0) - (timestamp(a.lastModifiedDateTime) || 0))[0];
      const rawProgress = study?.progress;
      const progress = typeof rawProgress === 'number' && Number.isFinite(rawProgress) ? Math.min(100, Math.max(0, rawProgress)) : 0;
      const type = Number(lesson.contentPool.type);
      result.lessons.push({
        id: lesson.id, title: lesson.name || lesson.contentPool.name || '강의', type,
        duration: Number(lesson.contentPool.duration) || 0,
        progress, completed: study?.completed === true, studyId: study?.id || null,
        playable: MEDIA_TYPES.has(type), url: classroomUrl(registration.id, lesson.id),
      });
    }
    if (!result.lessons.length) return fail('수강할 강의 목록이 비어 있습니다. 알파 강의실에서 확인하세요.');
    // 설문이 목록 첫 항목이어도 영상 학습을 먼저 진행한다. 시험·설문은 자동 응답하지 않는다.
    const nextLesson = result.lessons.find(lesson => lesson.playable && !lesson.completed);
    if (nextLesson) return { ...result, status: 'ready', message: '미완료 강의를 재생할 수 있습니다.', nextLesson, url: nextLesson.url };
    const remaining = result.lessons.filter(lesson => !lesson.completed);
    const mediaLessons = result.lessons.filter(lesson => lesson.playable);
    const surveyOnly = mediaLessons.length > 0 && mediaLessons.every(lesson => lesson.completed) &&
      remaining.length > 0 && remaining.every(lesson => lesson.type === CONTENT_TYPES.SURVEY);
    const attentionReason = surveyOnly ? 'survey'
      : remaining.some(lesson => [CONTENT_TYPES.EXAM, CONTENT_TYPES.REPORT].includes(lesson.type)) ? 'assessment'
      : 'completion';
    const messages = {
      survey: '영상 학습을 마쳤습니다. 마지막 설문을 알파 강의실에서 진행하세요.',
      assessment: '영상 학습을 마쳤습니다. 시험·과제·설문을 알파 강의실에서 진행하세요.',
      completion: remaining.length ? '나머지 학습을 알파 강의실에서 진행하세요.'
        : '강의 학습을 마쳤습니다. 수료 상태와 남은 조건을 알파 강의실에서 확인하세요.',
    };
    return { ...result, status: 'attention', attentionReason, message: messages[attentionReason],
      url: surveyOnly ? remaining[0].url : result.url };
  }

  function createClient({ fetchImpl = root.fetch.bind(root), getCsrfToken = async () => null } = {}) {
    async function query(operationName, queryText, variables) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const token = await getCsrfToken();
        if (token) headers['X-XSRF-TOKEN'] = decodeURIComponent(token);
        const response = await fetchImpl(`${ORIGIN}/api/graphql`, {
          method: 'POST', credentials: 'include', cache: 'no-store', headers, signal: controller.signal,
          body: JSON.stringify({ operationName, query: queryText, variables }),
        });
        if (response.status === 401 || response.status === 403 || response.redirected) throw new Error('알파 로그인을 다시 확인하세요.');
        if (!response.ok) throw new Error(`알파 학습 조회에 실패했습니다 (HTTP ${response.status}).`);
        const body = await response.json();
        if (body.errors?.length || !body.data) throw new Error('알파 학습 정보를 조회하지 못했습니다. 강의실에서 확인하세요.');
        return body.data;
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('알파 학습 조회 시간이 초과되었습니다.');
        throw error;
      } finally { clearTimeout(timeout); }
    }
    async function registration(course, registrationId) {
      if (!UUID.test(course?.id) || !UUID.test(course?.sequenceId) || !UUID.test(registrationId)) throw new Error('알파 교육 식별자가 올바르지 않습니다.');
      const data = await query('AlphaLearningRegistration', REGISTRATION_QUERY, { id: registrationId });
      if (data.registration?.id !== registrationId) throw new Error('신청한 강의실 정보를 확인하지 못했습니다.');
      return parseRegistration(course, data.registration);
    }
    async function inspect(course) {
      if (!UUID.test(course?.id) || !UUID.test(course?.sequenceId)) throw new Error('알파 교육 식별자가 올바르지 않습니다.');
      const data = await query('AlphaLearningSequence', SEQUENCE_QUERY, { request: { subjectId: course.id } });
      if (!Array.isArray(data.sequences)) throw new Error('알파 교육 목록 형식이 변경되었습니다.');
      const matches = data.sequences.filter(sequence => sequence?.id === course.sequenceId && sequence.subject?.id === course.id);
      if (matches.length !== 1) throw new Error('첨부 목록에 지정된 알파 교육 차수를 확인하지 못했습니다.');
      const reg = matches[0].myRegistration;
      if (!reg?.id || ['CANCELLED', 'REJECTED'].includes(reg.status)) return {
        courseId: course.id, registrationId: null, status: 'not-enrolled', message: '먼저 수강신청이 필요한 과정입니다.',
        lessons: [], nextLesson: null, url: course.url,
      };
      return registration(course, reg.id);
    }
    return { inspect, registration };
  }

  root.AlphaLearning = { createClient, parseRegistration, classroomUrl, courseRoomUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlphaLearning;
})(globalThis);
