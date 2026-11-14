const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, format, plain, openInPage, parseAnswers, answerInPage } = require('../src/alpha-exam.js');

const registrationId = 'aaaaaaaa-0000-4000-8000-000000000001';
const examLessonId = 'bbbbbbbb-0000-4000-8000-000000000010';
const course = { id: 'cccccccc-0000-4000-8000-000000000001', title: '확인용 과정' };
const question = (n, overrides = {}) => ({ id: `q${n}`, type: 'SINGLE_CHOICE', name: `<p>문제 ${n}</p>`, scorePerQuestion: 10,
  description: { text: '' }, choices: [3, 1, 2, 4].map(order => ({ id: `q${n}-${order}`, text: `보기 ${order}`, choiceOrder: order })),
  ...overrides });
const examData = count => ({ id: 'exam-1', status: 'TAKEN', answers: Array.from({ length: count }, (_, index) => ({ id: `a${index}`, examQuestion: question(index + 1) })) });
const lessons = ({ studyId = 'study-1', completed = false, videoLeft = false } = {}) => [
  { id: 'v1', type: 2, playable: true, completed: !videoLeft, progress: videoLeft ? 50 : 100 },
  { id: examLessonId, type: 10, playable: false, completed, studyId, title: '확인용 시험', url: 'https://alpha-campus.kr/exam-lesson' },
  { id: 's1', type: 12, playable: false, completed: false },
];

function fixture({ inspect = { status: 'ready', registrationId, lessons: lessons() }, exams = [], limit = 7, exam = examData(10) } = {}) {
  const calls = [];
  const replies = {
    GetExamListByStudyId: () => ({ exams }),
    AlphaExamPaper: () => ({ registration: { id: registrationId, sequence: { modules: [{ lessons: [{ id: examLessonId,
      contentPool: { id: 'pool', contents: [{ __typename: 'ExamPaperContentResponse', examPaper: { id: 'paper', limitOfTakingExam: limit } }] } }] }] } } }),
    BeginStudy: () => ({ study: { id: 'study-new' } }),
    TakeExam: () => ({ exam: { id: 'exam-1' } }),
    GetExamById: variables => ({ exam: { ...exam, id: variables.id } }),
  };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ name: body.operationName, variables: body.variables, query: body.query });
    assert.equal(url, 'https://alpha-campus.kr/api/graphql');
    assert.ok(replies[body.operationName], `unexpected request ${body.operationName}`);
    return { ok: true, status: 200, json: async () => ({ data: replies[body.operationName](body.variables) }) };
  };
  const client = createClient({ fetchImpl, learning: { inspect: async () => structuredClone(inspect) } });
  return { client, calls, names: () => calls.map(call => call.name) };
}

test('without an attempt in progress, nothing is started until the user confirms', async () => {
  const f = fixture({ exams: [{ id: 'old', status: 'MARKED' }] });
  const result = await f.client.capture(course);
  assert.equal(result.ok, false); assert.equal(result.needsStart, true);
  assert.equal(result.used, 1); assert.equal(result.limit, 7);
  assert.match(result.message, /2\/7회/);
  assert.deepEqual(f.names(), ['GetExamListByStudyId', 'AlphaExamPaper']);
});

test('a confirmed capture starts one attempt and reads every question without answering or submitting', async () => {
  const f = fixture();
  const result = await f.client.capture(course, { start: true });
  assert.equal(result.ok, true); assert.equal(result.started, true); assert.equal(result.count, 10);
  assert.deepEqual(f.names(), ['GetExamListByStudyId', 'AlphaExamPaper', 'TakeExam', 'GetExamById']);
  assert.deepEqual(f.calls.find(call => call.name === 'TakeExam').variables, { request: { studyId: 'study-1' } });
  for (const call of f.calls) assert.doesNotMatch(call.query, /WriteExamAnswer|SubmitExam|correct|score\b|description/, 'no answers, submission, answer key or explanation');
  assert.match(result.text, /^확인용 시험 · 10문항/);
  assert.match(result.text, /\n\n10\. 문제 10 \(10점\)/);
});

test('an attempt already in progress is read as it is, without starting another', async () => {
  const f = fixture({ exams: [{ id: 'old', status: 'MARKED' }, { id: 'exam-1', status: 'TAKEN' }] });
  const result = await f.client.capture(course);
  assert.equal(result.ok, true); assert.equal(result.started, false);
  assert.deepEqual(f.names(), ['GetExamListByStudyId', 'GetExamById']);
  assert.deepEqual(f.calls[1].variables, { id: 'exam-1' });
});

test('with several attempts in progress, the most recently started one is read', async () => {
  const f = fixture({ exams: [
    { id: 'first', status: 'TAKEN', startDateTime: '2026-11-14T09:00:00' },
    { id: 'marked', status: 'MARKED', startDateTime: '2026-11-14T12:00:00' },
    { id: 'latest', status: 'TAKEN', startDateTime: '2026-11-14T10:00:00' },
  ] });
  const result = await f.client.capture(course);
  assert.equal(result.examId, 'latest');
  assert.deepEqual(f.calls.at(-1).variables, { id: 'latest' });
});

test('an exam lesson never opened gets its study record the way the classroom does', async () => {
  const f = fixture({ inspect: { status: 'ready', registrationId, lessons: lessons({ studyId: null }) } });
  const first = await f.client.capture(course);
  assert.equal(first.needsStart, true); assert.equal(first.used, 0);
  assert.deepEqual(f.names(), ['AlphaExamPaper'], 'no record is created before confirmation');
  const result = await f.client.capture(course, { start: true });
  assert.equal(result.ok, true);
  assert.deepEqual(f.names().slice(1), ['AlphaExamPaper', 'BeginStudy', 'TakeExam', 'GetExamById']);
  assert.deepEqual(f.calls.find(call => call.name === 'BeginStudy').variables,
    { request: { registrationId, sequenceLessonId: examLessonId } });
  assert.deepEqual(f.calls.find(call => call.name === 'TakeExam').variables, { request: { studyId: 'study-new' } });
});

test('used-up attempts, unfinished videos, finished exams and other courses are refused before anything is sent', async () => {
  const used = fixture({ exams: Array.from({ length: 7 }, (_, index) => ({ id: `e${index}`, status: 'MARKED' })) });
  await assert.rejects(used.client.capture(course, { start: true }), /응시 횟수 7회를 모두 썼습니다/);
  assert.ok(!used.names().includes('TakeExam'));
  for (const [inspect, pattern] of [
    [{ status: 'ready', registrationId, lessons: lessons({ videoLeft: true }) }, /영상 학습을 먼저/],
    [{ status: 'attention', registrationId, lessons: lessons({ completed: true }) }, /이미 응시를 마친/],
    [{ status: 'completed', registrationId, lessons: lessons() }, /이미 수료한/],
    [{ status: 'not-enrolled', registrationId: null, lessons: [], message: '먼저 수강신청이 필요한 과정입니다.' }, /수강신청이 필요/],
    [{ status: 'ready', registrationId, lessons: lessons().filter(lesson => lesson.type !== 10) }, /시험이 없습니다/],
  ]) {
    const f = fixture({ inspect });
    await assert.rejects(f.client.capture(course, { start: true }), pattern);
    assert.ok(!f.names().includes('TakeExam'));
  }
});

test('questions become copyable text: tags removed, choices in order, pictures marked', () => {
  assert.equal(plain('<p>A &amp; B<br>둘째 줄&nbsp;</p><div>셋째</div>'), 'A & B\n둘째 줄\n셋째');
  const formatted = format({ answers: [
    // 해설(description)은 채점 결과 화면에서만 보이므로, 응답에 섞여 와도 옮기지 않는다.
    { examQuestion: question(1, { image: { id: 'img' }, description: { text: '<p>해설</p>', image: null } }) },
    { examQuestion: question(2, { choices: [], scorePerQuestion: 0 }) },
    { examQuestion: null },
  ] }, '시험');
  assert.equal(formatted.count, 2);
  assert.equal(formatted.text, [
    '시험 · 2문항',
    '1. 문제 1 [그림 있음] (10점)\n   ① 보기 1\n   ② 보기 2\n   ③ 보기 3\n   ④ 보기 4',
    '2. 문제 2\n   (직접 쓰는 문항)',
  ].join('\n\n'));
});

test('the exam shortcut resumes an attempt in progress and starts a new one only after confirmation, sending nothing itself', async () => {
  const resume = fixture({ exams: [{ id: 'old', status: 'MARKED' }, { id: 'exam-1', status: 'TAKEN' }] });
  assert.deepEqual(await resume.client.prepareOpen(course),
    { ok: true, resume: true, title: '확인용 시험', url: 'https://alpha-campus.kr/exam-lesson', registrationId });
  assert.deepEqual(resume.names(), ['GetExamListByStudyId']);

  const fresh = fixture({ exams: [{ id: 'old', status: 'MARKED' }, { id: 'old-2', status: 'MARKED' }] });
  const ask = await fresh.client.prepareOpen(course);
  assert.equal(ask.needsStart, true);
  assert.match(ask.message, /3\/7회/);
  const confirmed = await fresh.client.prepareOpen(course, { start: true });
  assert.equal(confirmed.ok, true); assert.equal(confirmed.resume, false);
  // 응시는 강의실의 사이트 버튼이 시작한다. 여기서는 기록을 만들거나 응시를 시작하지 않는다.
  assert.ok(!fresh.names().some(name => ['BeginStudy', 'TakeExam', 'GetExamById'].includes(name)));

  const used = fixture({ exams: Array.from({ length: 7 }, (_, index) => ({ id: `e${index}`, status: 'MARKED' })) });
  await assert.rejects(used.client.prepareOpen(course, { start: true }), /응시 횟수 7회를 모두 썼습니다/);
  const videos = fixture({ inspect: { status: 'ready', registrationId, lessons: lessons({ videoLeft: true }) } });
  await assert.rejects(videos.client.prepareOpen(course), /영상 학습을 먼저/);
});

// 강의실의 시험 표 · 응시 현황 창 · 시험 창만 흉내 낸 작은 화면. 사이트처럼 [role="dialog"] 창이 뜨고 닫힌다.
function classroom({ title = '확인용 시험', rows = [['다른 시험', 'other'], ['확인용 시험', 'mine']], status = ['이어하기', '결과보기'],
  later = [], ignore = 0, examOpens = true, table = true } = {}) {
  const pressed = [];
  const node = (tag, { text = '', role, id, onClick } = {}, children = []) => {
    const item = { tag, text, role, id, disabled: false, children: [], parent: null,
      get textContent() { return [this.text, ...this.children.map(child => child.textContent)].join(' '); },
      append(...more) { for (const child of more) { child.parent = this; this.children.push(child); } },
      remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
      querySelectorAll(selector) {
        const all = [];
        const walk = parent => parent.children.forEach(child => { all.push(child); walk(child); });
        walk(this);
        if (selector === '[role="dialog"]') return all.filter(child => child.role === 'dialog');
        if (selector === 'tbody tr') return all.filter(child => child.tag === 'tr' && child.parent.tag === 'tbody');
        return all.filter(child => child.tag === selector);
      },
      click() { pressed.push(id || text); onClick?.(); } };
    item.append(...children);
    return item;
  };
  const body = node('body');
  const examWindow = () => node('div', { role: 'dialog' }, [node('div', { text: '문제풀이 현황' }), node('span', { text: '남은 시간 59:00' })]);
  const choose = label => node('button', { text: label, onClick: () => {
    if (label === '결과보기') return;
    dialog.remove();
    if (examOpens) body.append(examWindow());
  } });
  const dialog = node('div', { role: 'dialog' }, [node('div', { text: '응시 현황' }), node('button', { text: '닫기' }), ...status.map(choose)]);
  const openStatus = () => {
    if (ignore-- > 0) return;   // 학습 정보를 불러오는 동안은 사이트가 창을 열지 않는다
    body.append(dialog);
    if (later.length) setTimeout(() => dialog.append(...later.map(choose)), 20);
  };
  if (table) {
    body.append(node('table', {}, [node('thead', {}, [node('tr', {}, [node('th', { text: '시험명' }), node('th', { text: '현황' })])]),
      node('tbody', {}, rows.map(([name, id]) => node('tr', {}, [node('td', { text: name }),
        node('td', {}, [node('button', { text: '현황', id, onClick: id === 'mine' || rows.length === 1 ? openStatus : undefined })])])))]));
  }
  return { document: body, pressed, title };
}
const quick = { table: 120, dialog: 60, list: 200, settle: 200, exam: 120, tick: 5 };
async function press(page, start) {
  const previous = globalThis.document;
  globalThis.document = page.document;
  try { return await openInPage(page.title, start, quick); }
  finally { globalThis.document = previous; }
}

test('in the classroom, the shortcut opens the status window of this exam and continues the attempt in progress', async () => {
  const page = classroom();
  assert.deepEqual(await press(page, false), { ok: true, started: false });
  assert.deepEqual(page.pressed, ['mine', '이어하기'], 'the row of this exam, then 이어하기 — never 응시');
});

test('in the classroom, 응시 is pressed only when the user confirmed starting a new attempt', async () => {
  const unconfirmed = classroom({ status: ['응시', '결과보기'] });
  const refused = await press(unconfirmed, false);
  assert.equal(refused.ok, false); assert.match(refused.message, /다시 누르세요/);
  assert.deepEqual(unconfirmed.pressed, ['mine']);

  const confirmed = classroom({ status: ['응시', '결과보기'] });
  assert.deepEqual(await press(confirmed, true), { ok: true, started: true });
  assert.deepEqual(confirmed.pressed, ['mine', '응시']);

  // 시험지 정보가 늦게 와서 응시 버튼이 결과보기보다 늦게 생겨도 기다렸다가 누른다.
  const late = classroom({ status: ['결과보기'], later: ['응시'] });
  assert.deepEqual(await press(late, true), { ok: true, started: true });
  assert.deepEqual(late.pressed, ['mine', '응시']);
});

test('in the classroom, a busy page is retried and every dead end is reported instead of guessed', async () => {
  const busy = classroom({ rows: [['확인용 시험', 'mine']], ignore: 1 });
  assert.deepEqual(await press(busy, false), { ok: true, started: false });
  assert.deepEqual(busy.pressed, ['mine', 'mine', '이어하기']);

  for (const [options, pattern] of [
    [{ table: false }, /시험 표를 찾지 못했습니다/],
    [{ ignore: 9 }, /응시 현황 창이 열리지 않았습니다/],
    [{ status: ['결과보기'] }, /새로 응시할 수 없습니다/],
    [{ examOpens: false }, /시험 창이 열리지 않았습니다/],
  ]) {
    const page = classroom(options);
    const result = await press(page, true);
    assert.equal(result.ok, false); assert.match(result.message, pattern);
    assert.ok(!page.pressed.includes('결과보기'));
  }
});

test('typed answers are read in the usual forms, and anything ambiguous is refused instead of guessed', () => {
  const read = text => parseAnswers(text).map(({ number, choice }) => `${number}:${choice}`).join(' ');
  const ten = '1:4 2:3 3:3 4:3 5:O 6:4 7:4 8:2 9:O 10:4';
  assert.equal(read('1④ 2③ 3③ 4③ 5 O 6④ 7④ 8② 9 O 10④'), ten);
  assert.equal(read('정답은 1④ 2③ 3③ 4③ 5 O 6④ 7④ 8② 9 O 10④입니다.'), ten);
  assert.equal(read('4 3 3 3 O 4 4 2 O 4'), ten);
  assert.equal(read('1-4, 2-3\n5. o\n6) ④\n9번 X'), '1:4 2:3 5:O 6:4 9:X');
  assert.equal(read('4333144214'), '1:4 2:3 3:3 4:3 5:1 6:4 7:4 8:2 9:1 10:4');
  assert.equal(read('④ ③ ③'), '1:4 2:3 3:3');
  assert.equal(read('2④ 1③'), '1:3 2:4', 'circled answers cannot be mistaken for question numbers');
  assert.equal(read('3④ 5○'), '3:4 5:O');
  for (const [text, pattern] of [['', /답을 적으세요/], ['모르겠음', /읽지 못했습니다/], ['1④ 2③ (3번은 모르겠음)', /읽지 못했습니다/],
    ['1④ 1③', /읽지 못했습니다/], ['1-0', /1번 답\(0\)/], ['1-11', /1번 답\(11\)/]]) {
    assert.throws(() => parseAnswers(text), pattern, text);
  }
});

// 응시 중인 시험 창만 흉내 낸 작은 화면: 지금 문제의 보기, "문제풀이 현황" 표, 임시 저장·다음 문제·제출 버튼.
// 사이트처럼 보기를 누르면 바로 골라지고, 저장이 끝난 뒤에 그 줄이 "답안 작성완료"로 바뀐다.
function examWindow({ kinds = ['choice', 'choice', 'ox'], saved = {}, saveDelay = 10, saveFails = [], open = true } = {}) {
  const pressed = [], selected = { ...saved }, stored = { ...saved };
  const node = (tag, { text = '', role, id, htmlFor, onClick } = {}, children = []) => {
    const item = { tag, text, role, id, htmlFor, checked: false, children: [], parent: null,
      get textContent() { return [this.text, ...this.children.map(child => child.textContent)].join(' '); },
      append(...more) { for (const child of more) { child.parent = this; this.children.push(child); } },
      clear() { this.children = []; },
      querySelectorAll(selector) {
        const all = [];
        const walk = parent => parent.children.forEach(child => { all.push(child); walk(child); });
        walk(this);
        if (selector === '[role="dialog"]') return all.filter(child => child.role === 'dialog');
        if (selector === 'label[for]') return all.filter(child => child.tag === 'label' && child.htmlFor);
        return all.filter(child => child.tag === selector);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      click() { pressed.push(this.pressName || this.text); onClick?.(); } };
    item.append(...children);
    return item;
  };
  const body = node('body');
  const question = node('div');
  const cells = {};
  const show = number => {
    question.clear();
    const kind = kinds[number - 1];
    const choices = kind === 'ox' ? ['O', 'X'] : [1, 2, 3, 4].map(order => `${order}. 보기 ${order}`);
    question.append(node('div', { text: `${number}번 문제` }), node('div', { text: kind === 'ox' ? 'OX퀴즈' : '객관식' }));
    choices.forEach((label, index) => {
      const id = `q${number}-c${index + 1}`;
      const input = node('input', { id });
      input.checked = selected[number] === index + 1;
      const tag = node('label', { text: label, htmlFor: id, onClick: () => {
        selected[number] = index + 1;
        for (const other of question.querySelectorAll('input')) other.checked = other.id === id;
        if (!saveFails.includes(number)) setTimeout(() => { stored[number] = index + 1; cells[number].text = '답안 작성완료'; }, saveDelay);
      } });
      tag.pressName = `${number}:${label}`;
      question.append(node('div', {}, [input, tag]));
    });
  };
  const rows = kinds.map((_, index) => {
    const number = index + 1;
    cells[number] = node('td', { text: stored[number] ? '답안 작성완료' : '-' });
    const row = node('tr', { onClick: () => setTimeout(() => show(number), 5) }, [node('th', { text: `${number}번` }), cells[number]]);
    row.pressName = `${number}번`;
    return row;
  });
  show(1);
  if (open) {
    body.append(node('div', { role: 'dialog' }, [node('div', { text: '응시' }), node('div', { text: '남은 시간 00:37:10' }), question,
      node('div', { text: '문제풀이 현황' }), node('table', {}, [node('tbody', {}, rows)]),
      node('button', { text: '임시 저장' }), node('button', { text: '다음 문제' }), node('button', { text: '제출' })]));
  }
  const document = Object.assign(body, { getElementById: id => body.querySelectorAll('input').find(input => input.id === id) || null });
  return { document, pressed, stored };
}
async function fill(page, answers) {
  const previous = globalThis.document;
  globalThis.document = page.document;
  try { return await answerInPage(answers, { move: 150, save: 150, settle: 5, tick: 5 }); }
  finally { globalThis.document = previous; }
}

test('answers are chosen the way the user would, question by question, waiting for each to be saved, and never submitted', async () => {
  const page = examWindow();
  const result = await fill(page, [{ number: 1, choice: 4 }, { number: 3, choice: 'O' }, { number: 2, choice: 2 }]);
  assert.deepEqual(result, { ok: true, total: 3, done: [1, 3, 2], failed: [] });
  assert.deepEqual(page.pressed, ['1번', '1:4. 보기 4', '3번', '3:O', '2번', '2:2. 보기 2']);
  assert.deepEqual(page.stored, { 1: 4, 2: 2, 3: 1 });
  assert.ok(!page.pressed.some(name => ['제출', '임시 저장', '다음 문제'].includes(name)));
});

test('an answer already chosen is left alone, and answers that cannot be placed or saved are reported', async () => {
  const same = examWindow({ saved: { 1: 4 } });
  assert.deepEqual(await fill(same, [{ number: 1, choice: 4 }]), { ok: true, total: 3, done: [1], failed: [] });
  assert.deepEqual(same.pressed, ['1번'], 'the saved choice is not pressed again');

  const page = examWindow({ saveFails: [2] });
  const result = await fill(page, [{ number: 1, choice: 5 }, { number: 2, choice: 1 }, { number: 3, choice: 'X' }, { number: 4, choice: 1 }]);
  assert.deepEqual(result.done, [3]);
  assert.deepEqual(result.failed, [1, 2, 4], 'no 5th choice, save never finished, no 4th question');

  assert.deepEqual(await fill(examWindow({ open: false }), [{ number: 1, choice: 1 }]), { ok: false, missing: true });
});

test('the reply format that copied exam content asks for ("1: 4" on each line) is always readable', () => {
  // 사이드 패널은 복사한 시험 내용 끝에 "한 줄에 한 문항씩 "1: 4"처럼" 답해 달라고 붙인다(popup/alpha.js examClipboard).
  const reply = '1: 4\n2: 3\n3: 3\n4: 3\n5: 1\n6: 4\n7: 4\n8: 2\n9: 1\n10: 4';
  const ten = '1:4 2:3 3:3 4:3 5:1 6:4 7:4 8:2 9:1 10:4';
  const read = text => parseAnswers(text).map(({ number, choice }) => `${number}:${choice}`).join(' ');
  for (const text of [reply, `\`\`\`\n${reply}\n\`\`\``, reply.replace(/: (\d+)$/gm, ': $1번'), reply.replace(/: 4$/gm, ': ④'), `정답\n${reply}`]) {
    assert.equal(read(text), ten, text);
  }
});
