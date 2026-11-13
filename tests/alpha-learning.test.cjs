const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, parseRegistration, classroomUrl } = require('../src/alpha-learning.js');
const catalog = require('../src/alpha-catalog.js');
const course = catalog.courses[0];
const rid = '12345678-1234-1234-1234-123456789012';
const lid = '11111111-1111-1111-1111-111111111111';
const surveyId = '22222222-2222-2222-2222-222222222222';
const otherRid = '33333333-3333-3333-3333-333333333333';

function lesson(id = lid, type = 2, myStudies = []) {
  return { id, name: type === 12 ? '만족도 설문' : '연구협약 강의', lessonOrder: 1,
    contentPool: { id, name: '학습', type, duration: 600 }, myStudies };
}
function registration() {
  return { id: rid, status: 'APPROVED', sequence: {
    id: course.sequenceId, subject: { id: course.id, type: '4' }, selectionLesson: false,
    modules: [{ id: rid, moduleOrder: 1, lessons: [lesson(surveyId, 12), lesson()] }],
  } };
}
function studied(completed, progress, registrationId = rid) {
  return { id: lid, completed, progress, registration: { id: registrationId } };
}

test('normal classroom link selects the registration and exact lesson', () => {
  const url = new URL(classroomUrl(rid, lid));
  assert.equal(url.origin, 'https://alpha-campus.kr');
  assert.equal(url.pathname, '/my/classRoom/classRoomDetail');
  assert.equal(url.searchParams.get('registrationId'), rid);
  assert.equal(url.searchParams.get('sequenceLessonId'), lid);
  // subject.type=4 is a content classification; the classroom renders only the ONLINE/OFFLINE route modes.
  assert.equal(url.searchParams.get('type'), 'ONLINE');
  assert.throws(() => classroomUrl('untrusted', lid));
});

test('video is chosen before the satisfaction survey and has a normal classroom URL', () => {
  const result = parseRegistration(course, registration());
  assert.equal(result.status, 'ready');
  assert.equal(result.nextLesson.id, lid);
  assert.equal(result.url, classroomUrl(rid, lid));
  assert.equal(result.lessons[0].playable, false);
});

test('nullable histories on unstarted survey and videos select the first video', () => {
  const reg = registration();
  reg.sequence.modules[0].lessons = [
    { ...lesson(surveyId, 12, null), lessonOrder: 0, subLessons: null },
    { ...lesson(lid, 2, null), lessonOrder: 1, subLessons: null },
    { ...lesson(otherRid, 2, null), lessonOrder: 2, subLessons: null },
  ];
  const result = parseRegistration(course, reg);
  assert.equal(result.status, 'ready');
  assert.equal(result.nextLesson.id, lid);
  assert.equal(result.url, classroomUrl(rid, lid));
  assert.deepEqual(result.lessons.map(item => [item.id, item.completed, item.progress, item.studyId]), [
    [surveyId, false, 0, null], [lid, false, 0, null], [otherRid, false, 0, null],
  ]);
});

test('completed history is preserved while the next nullable video history remains unstarted', () => {
  const reg = registration();
  reg.sequence.modules[0].lessons = [
    { ...lesson(surveyId, 12, null), lessonOrder: 0 },
    { ...lesson(lid, 2, [studied(true, 100)]), lessonOrder: 1 },
    { ...lesson(otherRid, 2, null), lessonOrder: 2 },
  ];
  const result = parseRegistration(course, reg);
  assert.equal(result.status, 'ready');
  assert.equal(result.nextLesson.id, otherRid);
  assert.equal(result.url, classroomUrl(rid, otherRid));
  assert.equal(result.lessons[1].completed, true);
  assert.equal(result.lessons[1].progress, 100);
  assert.equal(result.lessons[1].studyId, lid);
  assert.equal(result.lessons[2].completed, false);
});

test('an unstarted nullable survey becomes final survey attention after media completion', () => {
  const reg = registration();
  reg.sequence.modules[0].lessons = [
    lesson(surveyId, 12, null), lesson(lid, 2, [studied(true, 100)]),
  ];
  const result = parseRegistration(course, reg);
  assert.equal(result.status, 'attention');
  assert.equal(result.attentionReason, 'survey');
  assert.equal(result.nextLesson, null);
  assert.equal(result.url, classroomUrl(rid, surveyId));
  assert.equal(result.lessons[0].completed, false);
});

test('non-null invalid or missing history fields still block playback', () => {
  for (const invalid of [{}, '[]', 0, false, undefined]) {
    const reg = registration();
    const video = reg.sequence.modules[0].lessons[1];
    if (invalid === undefined) delete video.myStudies;
    else video.myStudies = invalid;
    const result = parseRegistration(course, reg);
    assert.equal(result.status, 'attention');
    assert.equal(result.nextLesson, null);
    assert.equal(result.attentionReason, undefined);
    assert.match(result.message, /응답 형식/);
  }
});

test('only backend completed marks a lesson finished; percent alone and other registrations do not', () => {
  for (const study of [studied(false, 100), studied(true, 100, otherRid), { ...studied(true, 100), deleted: true }]) {
    const reg = registration();
    reg.sequence.modules[0].lessons[1].myStudies = [study];
    assert.equal(parseRegistration(course, reg).nextLesson.id, lid);
  }
});

test('finished media leaves assessments to the user and does not claim course completion', () => {
  const reg = registration();
  reg.sequence.modules[0].lessons[1].myStudies = [studied(true, 100)];
  const result = parseRegistration(course, reg);
  assert.equal(result.status, 'attention');
  assert.equal(result.nextLesson, null);
  assert.equal(result.attentionReason, 'survey');
  assert.match(result.message, /마지막 설문/);
  reg.status = 'COMPLETED';
  assert.equal(parseRegistration(course, reg).status, 'completed');
});

test('pending approval, future period, expired period and mismatched course cannot start playback', () => {
  let reg = registration();
  reg.status = 'REQUESTED';
  assert.equal(parseRegistration(course, reg).status, 'waiting');
  reg = registration();
  reg.startDateTime = '2027-01-01T00:00:00';
  assert.equal(parseRegistration(course, reg, Date.parse('2026-11-13T12:00:00+09:00')).status, 'waiting');
  reg.startDateTime = '2026-01-01T00:00:00';
  reg.endDateTime = '2026-10-01T23:59:59';
  assert.equal(parseRegistration(course, reg, Date.parse('2026-11-13T12:00:00+09:00')).status, 'attention');
  reg = registration();
  reg.sequence.id = otherRid;
  assert.equal(parseRegistration(course, reg).status, 'attention');
});

test('only a confirmed elapsed study period carries the machine-readable expired reason', () => {
  const reg = registration();
  reg.startDateTime = '2026-01-01T00:00:00';
  reg.endDateTime = '2026-11-13T18:00:00';
  const end = Date.parse('2026-11-13T18:00:00+09:00');
  const expired = parseRegistration(course, reg, end + 1);
  assert.equal(expired.status, 'attention');
  assert.equal(expired.attentionReason, 'expired');
  assert.equal(expired.nextLesson, null);
  assert.equal(parseRegistration(course, reg, end).status, 'ready');
  reg.sequence.modules[0].lessons[1].myStudies = [studied(true, 100)];
  assert.equal(parseRegistration(course, reg, end).attentionReason, 'survey');
  assert.equal(parseRegistration(course, reg, end + 1).attentionReason, 'expired');
  reg.status = 'COMPLETED';
  assert.equal(parseRegistration(course, reg, end + 1).status, 'completed');
  assert.equal(parseRegistration(course, reg, end + 1).attentionReason, undefined);
  reg.status = 'APPROVED';
  reg.sequence.id = otherRid;
  assert.equal(parseRegistration(course, reg, end + 1).attentionReason, undefined);
});

test('a not-completed registration keeps playing within its study period, like the site classroom', () => {
  // 실제 알파 응답(2026-11-13): 첫 강의를 마치면 승인(APPROVED)이 미수료(NOT_COMPLETED)로 바뀐다.
  const reg = registration();
  reg.status = 'NOT_COMPLETED';
  reg.startDateTime = '2026-01-01T00:00:00';
  reg.endDateTime = '2026-11-13T18:00:00';
  const end = Date.parse('2026-11-13T18:00:00+09:00');
  const studying = parseRegistration(course, reg, end);
  assert.equal(studying.status, 'ready');
  assert.ok(studying.nextLesson);
  assert.equal(parseRegistration(course, reg, end + 1).attentionReason, 'expired', 'a final non-completion is never replayed');
  reg.endDateTime = null;
  const unknown = parseRegistration(course, reg, end);
  assert.equal(unknown.status, 'attention'); assert.equal(unknown.nextLesson, null);
  assert.match(unknown.message, /학습 기간을 확인하지 못했습니다/);
  for (const status of ['WAITING_REFUND_ACCOUNT', 'CANCEL_REQUESTED', 'DUPLICATION', 'UNKNOWN']) {
    reg.status = status; reg.endDateTime = '2026-11-13T18:00:00';
    assert.equal(parseRegistration(course, reg, end).status, 'attention', status);
  }
});

test('an authoring-tool ("interactive") lesson is a lecture video and is played like one', () => {
  // 실제 알파 값(2026-11-13): 유형 15는 영상 파일 하나를 저작도구 플레이어로 감싼 강의다.
  const reg = registration();
  reg.sequence.modules[0].lessons = [lesson(surveyId, 12), lesson(otherRid, 2, [studied(true, 100)]), lesson(lid, 15)];
  const result = parseRegistration(course, reg);
  assert.equal(result.status, 'ready');
  assert.equal(result.nextLesson.id, lid); assert.equal(result.nextLesson.type, 15);
  assert.equal(new URL(result.url).searchParams.get('sequenceLessonId'), lid);
  // 다 보면 일반 영상처럼 설문만 남은 상태가 된다.
  reg.sequence.modules[0].lessons[2].myStudies = [studied(true, 100)];
  assert.equal(parseRegistration(course, reg).attentionReason, 'survey');
});

test('unknown content is handed off instead of pretending to finish it', () => {
  const reg = registration();
  reg.sequence.modules[0].lessons = [lesson(lid, 99)];
  const result = parseRegistration(course, reg);
  assert.equal(result.status, 'attention');
  assert.equal(result.nextLesson, null);
  assert.equal(result.attentionReason, 'completion');
});

test('survey attention requires completed video and only unfinished survey content', () => {
  const reg = registration();
  assert.equal(parseRegistration(course, reg).attentionReason, undefined);
  // A 100% figure without backend completion still selects the video.
  reg.sequence.modules[0].lessons[1].myStudies = [studied(false, 100)];
  assert.equal(parseRegistration(course, reg).attentionReason, undefined);
  reg.sequence.modules[0].lessons[1].myStudies = [studied(true, 100)];
  assert.equal(parseRegistration(course, reg).attentionReason, 'survey');
  // Completed exams do not prevent the final-survey indicator.
  reg.sequence.modules[0].lessons.push(lesson(otherRid, 10, [studied(true, 100)]));
  assert.equal(parseRegistration(course, reg).attentionReason, 'survey');
});

test('unfinished exams, reports and unknown content prevent a final-survey indicator', () => {
  for (const [type, reason] of [[10, 'assessment'], [11, 'assessment'], [99, 'completion']]) {
    const reg = registration();
    reg.sequence.modules[0].lessons[1].myStudies = [studied(true, 100)];
    reg.sequence.modules[0].lessons.push(lesson(otherRid, type));
    assert.equal(parseRegistration(course, reg).attentionReason, reason);
  }
});

test('completed coursework, malformed data and missing video evidence do not claim final survey', () => {
  const reg = registration();
  for (const item of reg.sequence.modules[0].lessons) item.myStudies = [studied(true, 100)];
  assert.equal(parseRegistration(course, reg).attentionReason, 'completion');
  reg.status = 'COMPLETED';
  assert.equal(parseRegistration(course, reg).attentionReason, undefined);
  const noVideos = registration();
  noVideos.sequence.modules[0].lessons = [lesson(surveyId, 12)];
  assert.equal(parseRegistration(course, noVideos).attentionReason, 'completion');
  const malformed = registration();
  malformed.sequence.id = otherRid;
  assert.equal(parseRegistration(course, malformed).attentionReason, undefined);
});

test('selected lessons exclude unselected module lessons', () => {
  const reg = registration();
  reg.sequence.selectionLesson = true;
  reg.selectedLessons = [lesson(surveyId, 2)];
  assert.equal(parseRegistration(course, reg).nextLesson.id, surveyId);
});

test('read client uses only queries and verifies the requested sequence and registration', async () => {
  const calls = [];
  const client = createClient({ fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, 'https://alpha-campus.kr/api/graphql');
    assert.equal(options.credentials, 'include');
    assert.ok(body.query.startsWith('query '));
    return { ok: true, json: async () => ({ data: body.operationName === 'AlphaLearningSequence'
      ? { sequences: [{ id: course.sequenceId, subject: { id: course.id }, myRegistration: { id: rid, status: 'APPROVED' } }] }
      : { registration: registration() } }) };
  } });
  const result = await client.inspect(course);
  assert.equal(result.status, 'ready');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].variables, { id: rid });
});

test('missing enrollment never queries or creates a classroom study', async () => {
  let requests = 0;
  const client = createClient({ fetchImpl: async () => {
    requests++;
    return { ok: true, json: async () => ({ data: { sequences: [
      { id: course.sequenceId, subject: { id: course.id }, myRegistration: null },
    ] } }) };
  } });
  assert.equal((await client.inspect(course)).status, 'not-enrolled');
  assert.equal(requests, 1);
});

test('a course click opens the enrolled classroom and falls back when there is none', () => {
  const { courseRoomUrl } = require('../src/alpha-learning.js');
  // 영상이 남은 과정: 다음 차시가 아니라 과정의 강의실.
  assert.equal(courseRoomUrl(parseRegistration(course, registration())), classroomUrl(rid));
  // 설문만 남은 과정: 직접 진행할 그 차시.
  const surveyLeft = registration();
  surveyLeft.sequence.modules[0].lessons[1].myStudies = [studied(true, 100)];
  const survey = parseRegistration(course, surveyLeft);
  assert.equal(survey.attentionReason, 'survey');
  assert.equal(courseRoomUrl(survey), classroomUrl(rid, surveyId));
  // 수료한 과정도 강의실로 연다.
  assert.equal(courseRoomUrl(parseRegistration(course, { ...registration(), status: 'COMPLETED' })), classroomUrl(rid));
  // 승인 대기·미신청·일치하지 않는 등록·형식이 다른 값은 강의실로 열지 않는다.
  assert.equal(courseRoomUrl(parseRegistration(course, { ...registration(), status: 'REQUESTED' })), null);
  assert.equal(courseRoomUrl({ status: 'not-enrolled', registrationId: null, url: course.url }), null);
  const mismatched = registration();
  mismatched.sequence.subject.id = otherRid;
  assert.equal(courseRoomUrl(parseRegistration(course, mismatched)), null);
  assert.equal(courseRoomUrl({ status: 'attention', registrationId: rid, url: classroomUrl(otherRid) }), null);
  assert.equal(courseRoomUrl({ status: 'attention', registrationId: rid, url: 'https://example.com/my/classRoom/classRoomDetail' }), null);
  assert.equal(courseRoomUrl(null), null);
});
