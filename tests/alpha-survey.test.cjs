const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, planAnswers, preferredChoice, conditionChoiceId, surveyUrl } = require('../src/alpha-survey.js');

const registrationId = 'aaaaaaaa-0000-4000-8000-000000000001';
const course = { id: 'cccccccc-0000-4000-8000-000000000001', sequenceId: 'dddddddd-0000-4000-8000-000000000001', title: '확인용 과정' };
const scale = (id, overrides = {}) => ({ id, type: 'SCALE', name: `문항 ${id}`, isRequired: true, choices: [
  { id: `${id}-1`, text: '매우 그렇다', score: 5, choiceOrder: 1 }, { id: `${id}-2`, text: '그렇다', score: 4, choiceOrder: 2 },
  { id: `${id}-3`, text: '보통이다', score: 3, choiceOrder: 3 }, { id: `${id}-4`, text: '그렇지 않다', score: 2, choiceOrder: 4 },
  { id: `${id}-5`, text: '전혀 그렇지 않다', score: 1, choiceOrder: 5 }], ...overrides });
const subjective = id => ({ id, type: 'SUBJECTIVE', name: '의견을 적어 주세요', isRequired: false, choices: [] });

test('every scale question is answered "그렇다" with its score, and free text is answered "좋았다"', () => {
  const plan = planAnswers({ questions: [{ id: 'info', type: 'INFORMATION', name: '안내' }, scale('q1'), scale('q2'), subjective('q3')] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.groups.scaleAnswers, [
    { questionId: 'q1', type: 'SCALE', choiceId: 'q1-2', score: 4 }, { questionId: 'q2', type: 'SCALE', choiceId: 'q2-2', score: 4 }]);
  assert.deepEqual(plan.groups.subjectiveAnswers, [{ questionId: 'q3', type: 'SUBJECTIVE', text: '좋았다' }]);
  assert.deepEqual(plan.summary.map(item => item.answer), ['그렇다', '그렇다', '좋았다']);
  for (const name of ['singleChoiceAnswers', 'multipleChoiceAnswers', 'blendedAnswers']) assert.deepEqual(plan.groups[name], []);
});

test('"그렇다" is chosen exactly; other scales take the second most positive choice; unscored questions take the middle', () => {
  const scored = texts => texts.map((text, index) => ({ id: index, text, choiceOrder: index + 1, score: texts.length - index }));
  assert.equal(preferredChoice(scored(['매우 그렇다', '그렇다', '보통이다', '그렇지 않다', '전혀 그렇지 않다'])).text, '그렇다');
  // 순서나 점수가 뒤집혀 있어도 글자로 "그렇다"를 찾는다. "매우 그렇다"·"그렇지 않다"와 헷갈리지 않는다.
  assert.equal(preferredChoice(scored(['전혀 그렇지 않다', '그렇지 않다', '보통이다', '그렇다', '매우 그렇다'])).text, '그렇다');
  assert.equal(preferredChoice(scored(['매우 그렇다', '그렇지 않다', '전혀 그렇지 않다'])).text, '그렇지 않다', 'no exact match: second highest score');
  assert.equal(preferredChoice(scored(['매우 만족', '만족', '보통', '불만족', '매우 불만족'])).text, '만족');
  assert.equal(preferredChoice(scored(['매우 불만족', '불만족', '보통', '만족', '매우 만족']).map((choice, index) => ({ ...choice, score: index + 1 }))).text, '만족');
  // 점수로 가릴 수 없는 문항: "보통" 또는 가운데 보기, 직접 입력(기타)은 피한다.
  const plain = texts => preferredChoice(texts.map((text, index) => ({ id: index, text, choiceOrder: index + 1, etc: text === '기타' }))).text;
  assert.equal(plain(['가', '나', '다']), '나');
  assert.equal(plain(['가', '나', '다', '라']), '나');
  assert.equal(plain(['가', '나', '기타']), '가');
  assert.equal(plain(['좋음', '보통', '나쁨', '기타']), '보통');
  assert.equal(preferredChoice([{ id: 9, text: '기타', etc: true, choiceOrder: 1 }]).id, 9);
  assert.equal(preferredChoice([]), null);
  assert.equal(preferredChoice([{ id: 'c', text: '다', choiceOrder: 3 }, { id: 'a', text: '가', choiceOrder: 1 }, { id: 'b', text: '나', choiceOrder: 2 }]).id, 'b');
});

test('choice questions other than scales are answered once in the form the site sends', () => {
  const choices = [{ id: 'a', text: '예', choiceOrder: 1 }, { id: 'b', text: '아니오', choiceOrder: 2 }, { id: 'c', text: '기타', choiceOrder: 3, etc: true }];
  const plan = planAnswers({ questions: [{ id: 's', type: 'SINGLE_CHOICE', choices }, { id: 'm', type: 'MULTIPLE_CHOICE', choices },
    { id: 'b', type: 'BLENDED', choices }, { id: 'e', type: 'BLENDED', choices: [choices[2]] }] });
  assert.deepEqual(plan.groups.singleChoiceAnswers, [{ questionId: 's', type: 'SINGLE_CHOICE', choiceId: 'a' }]);
  assert.deepEqual(plan.groups.multipleChoiceAnswers, [{ questionId: 'm', type: 'MULTIPLE_CHOICE', choiceId: 'a' }]);
  assert.deepEqual(plan.groups.blendedAnswers, [{ questionId: 'b', type: 'BLENDED', choiceId: 'a', etcReason: '' },
    { questionId: 'e', type: 'BLENDED', choiceId: 'c', etcReason: '좋았다' }]);
});

test('a follow-up question is answered only when the chosen answer makes the site show it', () => {
  const parent = scale('p');
  const shown = { ...subjective('child-shown'), isChild: true, parentQuestionId: 'p', parentChoiceOrder: 1 };   // 2번째 보기(그렇다)
  const hidden = { ...subjective('child-hidden'), isChild: true, parentQuestionId: 'p', parentChoiceOrder: 4 };  // 5번째 보기
  const byId = { ...subjective('child-by-id'), isChild: true, parentQuestionId: 'p', parentChoiceOrder: undefined, conditionChoiceId: 'p-2' };
  assert.equal(conditionChoiceId(parent.choices, shown), 'p-2');
  assert.equal(conditionChoiceId(parent.choices, hidden), 'p-5');
  assert.equal(conditionChoiceId(parent.choices, byId), 'p-2');
  // 사이트는 하위 문항을 목록에도 다시 내려 줄 수 있다. 두 번 답하지 않는다.
  const plan = planAnswers({ questions: [{ ...parent, childQuestions: [shown, hidden, byId] }, shown, hidden] });
  assert.deepEqual(plan.groups.subjectiveAnswers.map(item => item.questionId), ['child-shown', 'child-by-id']);
  assert.equal(plan.groups.scaleAnswers.length, 1);
});

test('surveys that cannot be answered safely are refused as a whole', () => {
  for (const [questions, reason] of [
    [[scale('q1'), { id: 't', type: 'PER_TEACHER', choices: scale('t').choices }], /강사별 만족도/],
    [[{ id: 'x', type: 'PER_THREAD_BLENDED', choices: [] }], /과목별 만족도/],
    [[{ id: 'u', type: 'SOMETHING_NEW', choices: [] }], /알 수 없는 유형/],
    [[{ id: 'n', type: 'SCALE', choices: [] }], /보기가 없는/],
    [[{ id: 'info', type: 'INFORMATION' }], /답할 문항이 없는/],
  ]) {
    const plan = planAnswers({ questions });
    assert.equal(plan.ok, false); assert.match(plan.reason, reason); assert.equal(plan.groups, undefined);
  }
  assert.equal(planAnswers({}).ok, false);
});

test('the survey page address matches the route the site classroom opens', () => {
  assert.equal(surveyUrl(registrationId, 'paper-1', 'study-1', 'survey-1'),
    `https://alpha-campus.kr/study/${registrationId}/surveyPaper?surveyPaperId=paper-1&studyId=study-1&surveyId=survey-1`);
});

// ---------- 요청 순서 ----------
function harness({ lessons, status = 'attention', survey = { questions: [scale('q1'), subjective('q2')] }, saveResult = [{ surveyAnswerId: 'a1' }],
  submitAfterSave = true, completeAfter = true, failOn = null } = {}) {
  const calls = [];
  let submitted = false, inspections = 0;
  const learning = { async inspect() {
    inspections++;
    return inspections > 1 && submitted && completeAfter ? { status: 'completed', registrationId, lessons: [] }
      : { status, registrationId, attentionReason: 'survey', lessons };
  } };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ name: body.operationName, variables: body.variables, token: options.headers['X-XSRF-TOKEN'], credentials: options.credentials });
    if (failOn === body.operationName) return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'java.lang.RuntimeException: 진도율이 부족합니다.' }] }) };
    const data = {
      BeginStudy: { study: { id: 'study-new' } },
      TakeSurvey: { survey: { id: 'survey-1' } },
      GetSurveyById: { survey: { id: 'survey-1', submit: submitted && submitAfterSave, surveyPaperId: 'paper-1', ...survey } },
      SaveSurveyAnswers: { answers: saveResult },
    }[body.operationName];
    if (body.operationName === 'SaveSurveyAnswers' && saveResult.length) submitted = true;
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { calls, client: createClient({ fetchImpl, getCsrfToken: async () => 'csrf%20token', learning }), names: () => calls.map(call => call.name) };
}
const surveyLesson = (overrides = {}) => ({ id: 'bbbbbbbb-0000-4000-8000-000000000012', title: '만족도 설문', type: 12, completed: false, studyId: 'study-1', playable: false, ...overrides });
const video = (completed = true) => ({ id: 'bbbbbbbb-0000-4000-8000-000000000001', title: '영상', type: 2, completed, playable: true });

test('the survey shortcut opens the answer sheet the same way the site does and returns the survey page', async () => {
  const existing = harness({ lessons: [video(), surveyLesson()] });
  assert.equal((await existing.client.open(course)).url,
    `https://alpha-campus.kr/study/${registrationId}/surveyPaper?surveyPaperId=paper-1&studyId=study-1&surveyId=survey-1`);
  assert.deepEqual(existing.names(), ['TakeSurvey', 'GetSurveyById']);
  assert.deepEqual(existing.calls[0].variables, { request: { studyId: 'study-1' } });
  assert.equal(existing.calls[0].token, 'csrf token'); assert.equal(existing.calls[0].credentials, 'include');

  const fresh = harness({ lessons: [video(), surveyLesson({ studyId: null })] });
  assert.match((await fresh.client.open(course)).url, /studyId=study-new/);
  assert.deepEqual(fresh.names(), ['BeginStudy', 'TakeSurvey', 'GetSurveyById']);
  assert.deepEqual(fresh.calls[0].variables, { request: { registrationId, sequenceLessonId: surveyLesson().id } });

  await assert.rejects(harness({ lessons: [video()] }).client.open(course), /제출할 설문이 없습니다/);
  const unfinished = harness({ lessons: [video(false), surveyLesson()] });
  await assert.rejects(unfinished.client.open(course), /영상 학습을 먼저/);
  assert.deepEqual(unfinished.names(), [], 'no answer sheet is created before the videos are done');
  // 시험이 남은 과정은 사이트 순서대로 시험 뒤에 설문을 연다.
  const examFirst = harness({ lessons: [video(), { id: 'exam', title: '시험', type: 10, completed: false, playable: false }, surveyLesson()] });
  await assert.rejects(examFirst.client.open(course), /시험을 먼저/);
  await assert.rejects(examFirst.client.auto(course), /시험을 먼저/);
  assert.deepEqual(examFirst.names(), []);
  await assert.rejects(harness({ lessons: [], status: 'completed' }).client.open(course), /이미 수료/);
});

test('auto survey submits every answer once, then confirms the submission and the completion', async () => {
  const h = harness({ lessons: [video(), surveyLesson()] });
  const result = await h.client.auto(course);
  assert.deepEqual(h.names(), ['TakeSurvey', 'GetSurveyById', 'SaveSurveyAnswers', 'GetSurveyById']);
  assert.deepEqual(h.calls[2].variables.request, {
    surveyId: 'survey-1', registrationId,
    scaleAnswers: [{ questionId: 'q1', type: 'SCALE', choiceId: 'q1-2', score: 4 }],
    singleChoiceAnswers: [], multipleChoiceAnswers: [],
    subjectiveAnswers: [{ questionId: 'q2', type: 'SUBJECTIVE', text: '좋았다' }],
    blendedAnswers: [], perTeacherAnswers: [], perThreadAnswers: [], perThreadBlendedAnswers: [], submit: true,
  });
  assert.equal(result.submitted, 1); assert.equal(result.completed, true);
  assert.equal(result.message, '설문 1건 제출(그렇다 1 · 좋았다 1) · 수료 확인됨');
});

test('a dry run shows the planned answers without sending them', async () => {
  const h = harness({ lessons: [video(), surveyLesson()] });
  const result = await h.client.auto(course, { dryRun: true });
  assert.ok(!h.names().includes('SaveSurveyAnswers'));
  assert.deepEqual(result.plans, [{ title: '만족도 설문', answers: [{ question: '문항 q1', answer: '그렇다' }, { question: '의견을 적어 주세요', answer: '좋았다' }] }]);
});

test('nothing is submitted when videos remain, the survey has unsupported questions, or it was already submitted', async () => {
  const unfinished = harness({ lessons: [video(false), surveyLesson()] });
  await assert.rejects(unfinished.client.auto(course), /영상 학습을 먼저/);
  assert.deepEqual(unfinished.names(), []);

  const unsupported = harness({ lessons: [video(), surveyLesson()], survey: { questions: [scale('q1'), { id: 't', type: 'PER_TEACHER', choices: [] }] } });
  await assert.rejects(unsupported.client.auto(course), /강사별 만족도.*설문 바로가기/);
  assert.ok(!unsupported.names().includes('SaveSurveyAnswers'));

  const done = harness({ lessons: [video(), surveyLesson()], survey: { submit: true, questions: [scale('q1')] } });
  // 이미 제출된 응답지는 다시 보내지 않는다.
  const doneClient = createClient({ learning: { inspect: async () => ({ status: 'attention', registrationId, lessons: [video(), surveyLesson()] }) },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); done.calls.push({ name: body.operationName });
      return { ok: true, status: 200, json: async () => ({ data: body.operationName === 'TakeSurvey' ? { survey: { id: 'survey-1' } }
        : { survey: { id: 'survey-1', submit: true, surveyPaperId: 'paper-1', questions: [scale('q1')] } } }) };
    } });
  assert.equal((await doneClient.auto(course)).submitted, 0);
  assert.ok(!done.names().includes('SaveSurveyAnswers'));

  assert.equal((await harness({ lessons: [], status: 'completed' }).client.auto(course)).message, '이미 수료한 과정입니다.');
});

test('a rejected or unconfirmed submission is reported with the site reason', async () => {
  await assert.rejects(harness({ lessons: [video(), surveyLesson()], failOn: 'TakeSurvey' }).client.auto(course), /^Error: 진도율이 부족합니다\.$/);
  await assert.rejects(harness({ lessons: [video(), surveyLesson()], saveResult: [] }).client.auto(course), /응답 저장에 실패/);
  await assert.rejects(harness({ lessons: [video(), surveyLesson()], submitAfterSave: false }).client.auto(course), /제출이 확인되지 않았습니다/);
  const pending = await harness({ lessons: [video(), surveyLesson()], completeAfter: false }).client.auto(course);
  assert.equal(pending.completed, false); assert.equal(pending.message, '설문 1건 제출(그렇다 1 · 좋았다 1)');
});
