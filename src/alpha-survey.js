// 알파 과정의 설문: 설문 페이지 주소 찾기와, 사용자가 요청한 자동 응답(모든 선택 문항 "그렇다", 서술형 "좋았다").
// 사이트의 설문 페이지(pages/study/[registrationId]/surveyPaper)와 강의실이 보내는 요청을 같은 순서·형식으로 보낸다:
//   BeginStudy(설문 학습 기록이 없을 때) → TakeSurvey → GetSurveyById → SaveSurveyAnswers(submit: true)
// 시험은 다루지 않는다.
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SURVEY_LESSON = 12;
  const AGREE = /^그렇다\.?$/;   // "매우 그렇다"·"그렇지 않다"는 해당하지 않는다.
  const NEUTRAL = /보통/;
  const FREE_TEXT = '좋았다';
  const QUESTION_FIELDS = `id type name isRequired isChild parentQuestionId conditionChoiceId parentChoiceOrder
    choices { id text score etc choiceOrder }`;
  const BEGIN_STUDY = `mutation BeginStudy($request: BeginStudyInput!) {
    study: beginStudy(request: $request) { id }
  }`;
  const TAKE_SURVEY = `mutation TakeSurvey($request: TakeSurveyInput!) {
    survey: takeSurvey(request: $request) { id }
  }`;
  const GET_SURVEY = `query GetSurveyById($id: ID!) {
    survey: getSurveyById(id: $id) {
      id submit surveyPaperId
      questions { ${QUESTION_FIELDS} childQuestions { ${QUESTION_FIELDS} } }
    }
  }`;
  const SAVE_ANSWERS = `mutation SaveSurveyAnswers($request: SaveSurveyAnswersInput!) {
    answers: saveSurveyAnswers(request: $request) { surveyAnswerId }
  }`;
  // 강사별·과목별 만족도는 강의·강사 목록을 함께 보내야 해서 자동 응답하지 않는다.
  const MANUAL_TYPES = { PER_TEACHER: '강사별 만족도', PER_THREAD: '과목별 만족도', PER_THREAD_BLENDED: '과목별 만족도' };
  const GROUPS = { SCALE: 'scaleAnswers', SINGLE_CHOICE: 'singleChoiceAnswers', MULTIPLE_CHOICE: 'multipleChoiceAnswers',
    SUBJECTIVE: 'subjectiveAnswers', BLENDED: 'blendedAnswers' };

  const ordered = choices => [...(choices || [])].sort((a, b) => (Number(a?.choiceOrder) || 0) - (Number(b?.choiceOrder) || 0));

  // 사용자가 정한 답: "그렇다". 그 보기가 없는 척도(예: 매우 만족/만족/보통/불만족)는 점수가 두 번째로 높은 긍정 보기,
  // 점수로 가릴 수 없는 선택 문항은 "보통" 또는 가운데 보기를 고른다. 직접 입력(기타) 보기는 다른 보기가 있으면 피한다.
  function preferredChoice(choices) {
    const list = ordered(choices).filter(choice => choice && choice.id != null);
    const plain = list.filter(choice => !choice.etc);
    const pool = plain.length ? plain : list;
    const agree = pool.find(choice => AGREE.test(String(choice.text || '').trim()));
    if (agree) return agree;
    const scores = pool.map(choice => (choice.score === null || choice.score === undefined || choice.score === '' ? NaN : Number(choice.score)));
    if (pool.length >= 3 && scores.every(Number.isFinite) && new Set(scores).size === pool.length) {
      return [...pool].sort((a, b) => Number(b.score) - Number(a.score))[1];
    }
    return pool.find(choice => NEUTRAL.test(String(choice.text || ''))) || pool[Math.floor((pool.length - 1) / 2)] || null;
  }

  // 사이트 설문 페이지와 같은 규칙: 하위 문항은 상위 문항에서 조건에 해당하는 보기를 골랐을 때만 나타난다.
  function conditionChoiceId(parentChoices, child) {
    const order = Number(child.parentChoiceOrder);
    if (!Number.isFinite(order)) return child.conditionChoiceId ?? null;
    const target = (parentChoices || []).some(choice => Number(choice.choiceOrder) === 0) ? order : order + 1;
    const match = (parentChoices || []).find(choice => Number(choice.choiceOrder) === target);
    return match?.id ?? child.conditionChoiceId ?? null;
  }

  // 설문 문항 → 제출할 응답. 자동으로 답할 수 없는 문항이 있으면 아무것도 제출하지 않도록 이유를 돌려준다.
  function planAnswers(survey) {
    const questions = Array.isArray(survey?.questions) ? survey.questions : null;
    if (!questions) return { ok: false, reason: '설문 문항을 확인하지 못했습니다.' };
    const childIds = new Set(questions.flatMap(question => (question.childQuestions || []).map(child => child.id)));
    const groups = Object.fromEntries(Object.values(GROUPS).map(name => [name, []]));
    const summary = [];
    let problem = '';
    const answer = question => {
      if (problem || !question || question.type === 'INFORMATION') return null;
      if (MANUAL_TYPES[question.type]) { problem = `${MANUAL_TYPES[question.type]} 문항은 자동으로 답할 수 없습니다.`; return null; }
      const group = GROUPS[question.type];
      if (!group) { problem = '알 수 없는 유형의 문항이 있습니다.'; return null; }
      if (question.type === 'SUBJECTIVE') {
        groups[group].push({ questionId: question.id, type: question.type, text: FREE_TEXT });
        summary.push({ question: String(question.name || ''), answer: FREE_TEXT });
        return null;
      }
      const choice = preferredChoice(question.choices);
      if (!choice) { problem = '보기가 없는 선택 문항이 있습니다.'; return null; }
      const entry = { questionId: question.id, type: question.type, choiceId: choice.id };
      if (question.type === 'SCALE') entry.score = Number(choice.score);
      if (question.type === 'BLENDED') entry.etcReason = choice.etc ? FREE_TEXT : '';
      groups[group].push(entry);
      summary.push({ question: String(question.name || ''), answer: String(choice.text || '') });
      return choice;
    };
    for (const question of questions) {
      if (childIds.has(question.id)) continue; // 하위 문항은 상위 문항과 함께 처리한다.
      const choice = answer(question);
      for (const child of question.childQuestions || []) {
        const condition = conditionChoiceId(question.choices, child);
        if (choice && condition != null && String(condition) === String(choice.id)) answer(child);
      }
    }
    if (problem) return { ok: false, reason: problem };
    if (!summary.length) return { ok: false, reason: '답할 문항이 없는 설문입니다.' };
    return { ok: true, groups, summary };
  }

  function surveyUrl(registrationId, surveyPaperId, studyId, surveyId) {
    const url = new URL(`/study/${registrationId}/surveyPaper`, ORIGIN);
    url.searchParams.set('surveyPaperId', surveyPaperId);
    url.searchParams.set('studyId', studyId);
    url.searchParams.set('surveyId', surveyId);
    return url.href;
  }

  function createClient({ fetchImpl = root.fetch.bind(root), getCsrfToken = async () => null, learning } = {}) {
    async function request(operationName, query, variables) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const token = await getCsrfToken();
        if (token) headers['X-XSRF-TOKEN'] = decodeURIComponent(token);
        const response = await fetchImpl(`${ORIGIN}/api/graphql`, {
          method: 'POST', credentials: 'include', cache: 'no-store', headers, signal: controller.signal,
          body: JSON.stringify({ operationName, query, variables }),
        });
        if (response.status === 401 || response.status === 403 || response.redirected) throw new Error('알파 로그인을 다시 확인하세요.');
        if (!response.ok) throw new Error(`알파 설문 요청에 실패했습니다 (HTTP ${response.status}).`);
        const body = await response.json();
        if (body.errors?.length || !body.data) {
          // 사이트가 알려 주는 사유(예: 진도율 부족)를 그대로 보여 준다.
          const reason = String(body.errors?.[0]?.message || '').replace(/java\.lang\.\w+Exception:\s*/g, '').replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 120);
          throw new Error(reason || '알파가 설문 요청을 처리하지 못했습니다.');
        }
        return body.data;
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('알파 설문 요청 시간이 초과되었습니다.');
        throw error;
      } finally { clearTimeout(timeout); }
    }

    // 과정에서 아직 제출하지 않은 설문 강의를 찾는다. 영상이 남아 있는지도 함께 알려 준다.
    async function pending(course) {
      const result = await learning.inspect(course);
      if (!result.registrationId || !UUID.test(result.registrationId)) {
        return { status: result.status, registrationId: null, lessons: [], message: result.message || '수강신청한 과정이 아닙니다.' };
      }
      const lessons = (result.lessons || []).filter(lesson => lesson.type === SURVEY_LESSON && !lesson.completed);
      const mediaLeft = (result.lessons || []).some(lesson => lesson.playable && !lesson.completed);
      // 시험(10)·과제(11)는 직접 응시·제출해야 하며, 사이트는 그 뒤에 설문을 열어 준다.
      const assessmentLeft = (result.lessons || []).some(lesson => [10, 11].includes(lesson.type) && !lesson.completed);
      return { status: result.status, registrationId: result.registrationId, lessons, mediaLeft, assessmentLeft, message: result.message || '' };
    }

    // 사이트 강의실이 설문을 열 때와 같은 절차로 응답지를 만들고(이미 있으면 그대로 받음) 문항을 불러온다.
    async function openSheet(registrationId, lesson) {
      let studyId = lesson.studyId;
      if (!studyId) {
        const begun = await request('BeginStudy', BEGIN_STUDY, { request: { registrationId, sequenceLessonId: lesson.id } });
        studyId = begun.study?.id;
      }
      if (!studyId) throw new Error('설문의 학습 기록을 만들지 못했습니다.');
      const taken = await request('TakeSurvey', TAKE_SURVEY, { request: { studyId } });
      const surveyId = taken.survey?.id;
      if (!surveyId) throw new Error('설문 응답지를 열지 못했습니다.');
      const loaded = await request('GetSurveyById', GET_SURVEY, { id: surveyId });
      if (String(loaded.survey?.id) !== String(surveyId) || !loaded.survey.surveyPaperId) throw new Error('설문 문항을 불러오지 못했습니다.');
      return { studyId, surveyId, survey: loaded.survey,
        url: surveyUrl(registrationId, loaded.survey.surveyPaperId, studyId, surveyId) };
    }

    // 설문 바로가기: 첫 번째 미제출 설문의 설문 페이지 주소.
    async function open(course) {
      const state = await pending(course);
      if (state.status === 'completed') throw new Error('이미 수료한 과정입니다.');
      if (!state.registrationId) throw new Error(state.message);
      if (!state.lessons.length) throw new Error('제출할 설문이 없습니다.');
      if (state.mediaLeft) throw new Error('영상 학습을 먼저 마치세요.');
      if (state.assessmentLeft) throw new Error('시험을 먼저 마치세요.');
      const sheet = await openSheet(state.registrationId, state.lessons[0]);
      return { url: sheet.url, title: state.lessons[0].title };
    }

    // 자동 설문: 미제출 설문마다 모든 문항을 답해 제출한다. dryRun이면 제출하지 않고 답안만 돌려준다.
    async function auto(course, { dryRun = false } = {}) {
      const state = await pending(course);
      if (state.status === 'completed') return { ok: true, submitted: 0, message: '이미 수료한 과정입니다.' };
      if (!state.registrationId) throw new Error(state.message);
      if (!state.lessons.length) return { ok: true, submitted: 0, message: '제출할 설문이 없습니다.' };
      if (state.mediaLeft) throw new Error('영상 학습을 먼저 마치세요.');
      if (state.assessmentLeft) throw new Error('시험을 먼저 마치세요.');
      const plans = [];
      for (const lesson of state.lessons) {
        const sheet = await openSheet(state.registrationId, lesson);
        if (sheet.survey.submit === true) continue; // 이미 제출된 응답지
        const plan = planAnswers(sheet.survey);
        if (!plan.ok) throw new Error(`${plan.reason} 설문 바로가기로 직접 작성하세요.`);
        plans.push({ lesson, sheet, plan });
      }
      if (dryRun) return { ok: true, submitted: 0, plans: plans.map(item => ({ title: item.lesson.title, answers: item.plan.summary })) };
      let submitted = 0;
      const tally = new Map(); // 제출한 답을 결과 문구에 보여 준다 (예: 그렇다 8 · 좋았다 2).
      for (const { sheet, plan } of plans) {
        const saved = await request('SaveSurveyAnswers', SAVE_ANSWERS, { request: {
          surveyId: sheet.surveyId, registrationId: state.registrationId, ...plan.groups,
          perTeacherAnswers: [], perThreadAnswers: [], perThreadBlendedAnswers: [], submit: true,
        } });
        if (!Array.isArray(saved.answers) || !saved.answers.length) throw new Error('설문 응답 저장에 실패했습니다.');
        const check = await request('GetSurveyById', GET_SURVEY, { id: sheet.surveyId });
        if (check.survey?.submit !== true) throw new Error('설문 제출이 확인되지 않았습니다. 설문 바로가기로 확인하세요.');
        submitted++;
        for (const item of plan.summary) tally.set(item.answer, (tally.get(item.answer) || 0) + 1);
      }
      const after = await learning.inspect(course);
      const answers = [...tally].map(([text, count]) => `${text.slice(0, 12)} ${count}`).join(' · ');
      return { ok: true, submitted, completed: after.status === 'completed',
        message: !submitted ? '제출할 설문이 없습니다.'
          : `설문 ${submitted}건 제출(${answers})${after.status === 'completed' ? ' · 수료 확인됨' : ''}` };
    }

    return { open, auto, pending };
  }

  root.AlphaSurvey = { createClient, planAnswers, preferredChoice, conditionChoiceId, surveyUrl, FREE_TEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlphaSurvey;
})(globalThis);
