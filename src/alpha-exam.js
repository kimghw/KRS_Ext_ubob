// 알파 과정의 시험: 응시 화면에 나오는 문제·보기를 글로 가져온다. 답을 고르거나 제출하지 않는다.
// 사이트 강의실이 시험을 열 때와 같은 순서·형식의 요청만 보낸다:
//   BeginStudy(시험 학습 기록이 없을 때) → TakeExam(응시 중인 기록이 없을 때 — 응시 1회 시작) → GetExamById
// 사이트는 문제를 응시 기록에 붙여 내려 주므로 응시를 시작해야 내용이 나온다. 쪽을 넘기지 않아도 모든 문항이 한 번에 온다.
// 정답·점수(correct, score)와 해설(description)은 요청하지 않는다. 응시자가 응시 화면에서 보는 문제·그림·보기만 가져온다.
// (사이트는 description을 채점 결과 화면에서만 보여 준다 — 같은 조건이 답안 입력란을 읽기 전용으로 만든다.)
(function (root) {
  'use strict';
  const ORIGIN = 'https://alpha-campus.kr';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EXAM_LESSON = 10;
  const TAKEN = 'TAKEN';   // 응시 중(아직 제출하지 않음). 사이트 강의실은 이 기록을 이어서 응시하게 한다.
  const BEGIN_STUDY = `mutation BeginStudy($request: BeginStudyInput!) {
    study: beginStudy(request: $request) { id }
  }`;
  const TAKE_EXAM = `mutation TakeExam($request: TakeExamInput!) {
    exam: takeExam(request: $request) { id }
  }`;
  const EXAM_LIST = `query GetExamListByStudyId($request: GetExamListByStudyIdInput!) {
    exams: getExamListByStudyId(request: $request) { id startDateTime status }
  }`;
  const GET_EXAM = `query GetExamById($id: ID!) {
    exam: getExamById(id: $id) {
      id status
      answers { id
        examQuestion { id type name image { id }
          scorePerQuestion
          choices { id text choiceOrder image { id } } } }
    }
  }`;
  const PAPER_LIMIT = `query AlphaExamPaper($id: ID!) {
    registration: getRegistrationById(id: $id) { id
      sequence { modules { lessons { id
        contentPool { id contents { __typename ... on ExamPaperContentResponse { examPaper { id limitOfTakingExam } } } } } } } }
  }`;
  const MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  // 사이트 편집기로 쓴 문항에는 태그가 섞여 있다. 줄바꿈만 살려 글로 바꾼다.
  function plain(value) {
    return String(value ?? '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ENTITIES[name.toLowerCase()])
      .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
  }
  const indent = text => text.split('\n').join('\n   ');

  // 응시 기록의 문항을 복사해 쓸 수 있는 글로 만든다. 그림은 글로 옮길 수 없어 있다는 표시만 한다.
  function format(exam, title) {
    const answers = Array.isArray(exam?.answers) ? exam.answers.filter(answer => answer?.examQuestion) : [];
    const blocks = answers.map((answer, index) => {
      const question = answer.examQuestion;
      const score = Number(question.scorePerQuestion);
      const lines = [`${index + 1}. ${indent(plain(question.name)) || '(문제 글 없음)'}${question.image?.id ? ' [그림 있음]' : ''}` +
        `${Number.isFinite(score) && score > 0 ? ` (${score}점)` : ''}`];
      const choices = [...(question.choices || [])].sort((one, two) => (Number(one?.choiceOrder) || 0) - (Number(two?.choiceOrder) || 0));
      choices.forEach((choice, order) => {
        lines.push(`   ${MARKS[order] || `${order + 1})`} ${indent(plain(choice?.text))}${choice?.image?.id ? ' [그림 있음]' : ''}`.trimEnd());
      });
      if (!choices.length) lines.push('   (직접 쓰는 문항)');
      return lines.join('\n');
    });
    return { count: answers.length, text: [`${title || '시험'} · ${answers.length}문항`, ...blocks].join('\n\n') };
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
        if (!response.ok) throw new Error(`알파 시험 요청에 실패했습니다 (HTTP ${response.status}).`);
        const body = await response.json();
        if (body.errors?.length || !body.data) {
          // 사이트가 알려 주는 사유(예: 시험 기간 아님, 응시 횟수 초과)를 그대로 보여 준다.
          const reason = String(body.errors?.[0]?.message || '').replace(/java\.lang\.\w+Exception:\s*/g, '').replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 120);
          throw new Error(reason || '알파가 시험 요청을 처리하지 못했습니다.');
        }
        return body.data;
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('알파 시험 요청 시간이 초과되었습니다.');
        throw error;
      } finally { clearTimeout(timeout); }
    }

    // 이 시험의 응시 횟수 제한. 확인하지 못하면 null(사이트가 응시 시작 때 스스로 막는다).
    async function attemptLimit(registrationId, lessonId) {
      try {
        const data = await request('AlphaExamPaper', PAPER_LIMIT, { id: registrationId });
        const lesson = (data.registration?.sequence?.modules || []).flatMap(module => module?.lessons || []).find(item => item?.id === lessonId);
        const limit = Number((lesson?.contentPool?.contents || []).map(content => content?.examPaper?.limitOfTakingExam).find(value => value != null));
        return Number.isInteger(limit) && limit > 0 ? limit : null;
      } catch { return null; }
    }

    // 이 과정의 시험 차시와 응시 기록을 찾는다(읽기만 한다).
    async function locate(course) {
      const result = await learning.inspect(course);
      if (result.status === 'completed') throw new Error('이미 수료한 과정입니다.');
      if (!result.registrationId || !UUID.test(result.registrationId)) throw new Error(result.message || '수강신청한 과정이 아닙니다.');
      const lessons = result.lessons || [];
      const lesson = lessons.find(item => item.type === EXAM_LESSON && !item.completed) || lessons.find(item => item.type === EXAM_LESSON);
      if (!lesson) throw new Error('이 과정에는 시험이 없습니다.');
      if (lessons.some(item => item.playable && !item.completed)) throw new Error('영상 학습을 먼저 마치세요.');
      const exams = lesson.studyId ? (await request('GetExamListByStudyId', EXAM_LIST, { request: { studyId: lesson.studyId } })).exams || [] : [];
      // 응시 중 기록이 여럿이면 가장 최근에 시작한 것을 쓴다(다시 응시하면 문항이 바뀔 수 있다).
      const latest = exams.filter(exam => exam?.status === TAKEN && exam.id)
        .sort((one, two) => (Date.parse(two.startDateTime) || 0) - (Date.parse(one.startDateTime) || 0))[0];
      return { registrationId: result.registrationId, lesson, exams, latest };
    }

    // 응시 중 기록이 없을 때 새 응시를 시작해도 되는지 본다. start가 아니면 needsStart로 돌려보내 사용자의 확인을 받게 한다.
    async function startGate({ registrationId, lesson, exams }, start) {
      if (lesson.completed) throw new Error('이미 응시를 마친 시험입니다.');
      const limit = await attemptLimit(registrationId, lesson.id);
      if (limit && exams.length >= limit) throw new Error(`응시 횟수 ${limit}회를 모두 썼습니다.`);
      if (start) return null;
      return { ok: false, needsStart: true, used: exams.length, limit,
        message: `한 번 더 누르면 응시 시작${limit ? ` (${exams.length + 1}/${limit}회)` : ''}` };
    }

    // 시험 바로가기 준비: 강의실에서 어느 버튼을 누를지 정한다. 여기서는 아무것도 바꾸지 않는다.
    // 응시 중인 기록이 있으면 "이어하기"(횟수를 쓰지 않음), 없으면 확인(start)을 받은 뒤에만 "응시"를 누른다.
    async function prepareOpen(course, { start = false } = {}) {
      const found = await locate(course);
      if (!found.latest) {
        const gate = await startGate(found, start);
        if (gate) return gate;
      }
      return { ok: true, resume: !!found.latest, title: found.lesson.title, url: found.lesson.url, registrationId: found.registrationId };
    }

    // 시험 내용 가져오기. 응시 중인 기록이 있으면 그 문항을 그대로 읽는다(아무것도 바꾸지 않음).
    // 없으면 start가 참일 때만 응시를 시작한다. start가 아니면 needsStart로 돌려보내 사용자의 확인을 받게 한다.
    async function capture(course, { start = false } = {}) {
      const found = await locate(course);
      const { registrationId, lesson, latest } = found;
      let studyId = lesson.studyId || null;
      let examId = latest?.id || null;
      const started = !examId;
      if (!examId) {
        const gate = await startGate(found, start);
        if (gate) return gate;
        if (!studyId) {
          const begun = await request('BeginStudy', BEGIN_STUDY, { request: { registrationId, sequenceLessonId: lesson.id } });
          studyId = begun.study?.id || null;
        }
        if (!studyId) throw new Error('시험의 학습 기록을 만들지 못했습니다.');
        const taken = await request('TakeExam', TAKE_EXAM, { request: { studyId } });
        examId = taken.exam?.id || null;
        if (!examId) throw new Error('응시를 시작하지 못했습니다.');
      }
      const loaded = await request('GetExamById', GET_EXAM, { id: examId });
      if (String(loaded.exam?.id) !== String(examId)) throw new Error('시험 문항을 불러오지 못했습니다.');
      const formatted = format(loaded.exam, lesson.title);
      if (!formatted.count) throw new Error('시험 문항이 비어 있습니다. 시험 바로가기에서 확인하세요.');
      return { ok: true, started, examId, title: lesson.title, count: formatted.count, text: formatted.text,
        message: `${formatted.count}문항을 가져왔습니다.` };
    }

    return { capture, prepareOpen };
  }

  // 시험 바로가기: 강의실 탭 안에서 실행한다(chrome.scripting으로 넣으므로 바깥 변수를 쓰지 않는다).
  // 사이트는 주소로 시험 창을 열지 않는다(시험 차시 주소는 그 차시를 강의처럼 고르기만 한다).
  // 사용자가 누르는 것과 같은 사이트 버튼만 누른다: 시험 표의 "현황" → 응시 현황 창의 "이어하기",
  // 응시 중인 기록이 없으면 start일 때만 "응시"(응시 1회 시작). 답을 고르거나 제출하지 않는다.
  async function openInPage(title, start, waits = {}) {
    const { table: tableMs = 30000, dialog: dialogMs = 4000, list: listMs = 10000, settle: settleMs = 2500,
      exam: examMs = 15000, tick: tickMs = 250, tries = 3 } = waits;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
    const until = async (find, ms) => {
      for (const end = Date.now() + ms; ; await pause(tickMs)) {
        const found = find();
        if (found || Date.now() >= end) return found || null;
      }
    };
    const buttonIn = (root, label) => [...(root?.querySelectorAll('button') || [])].find(button => text(button) === label && !button.disabled) || null;
    const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
    const statusDialog = () => dialogs().find(node => text(node).includes('응시 현황')) || null;
    const examDialog = () => dialogs().find(node => /남은 시간|문제풀이 현황/.test(text(node))) || null;
    // 사이트는 기록을 다시 불러올 때 표의 줄을 새로 그리므로 누를 때마다 다시 찾는다.
    const row = () => {
      const rows = [...document.querySelectorAll('table')]
        .filter(table => [...table.querySelectorAll('th')].some(head => text(head) === '시험명'))
        .flatMap(table => [...table.querySelectorAll('tbody tr')]).filter(tr => buttonIn(tr, '현황'));
      return rows.find(tr => text(tr.querySelectorAll('td')[0]) === title) || (rows.length === 1 ? rows[0] : null);
    };
    const opened = async started => (await until(examDialog, examMs)
      ? { ok: true, started } : { ok: false, message: '시험 창이 열리지 않았습니다. 응시 현황 창에서 확인하세요.' });

    if (!await until(row, tableMs)) return { ok: false, message: '시험 표를 찾지 못했습니다. 강의실 아래 시험 표의 현황을 누르세요.' };
    // 사이트가 학습 정보를 불러오는 중이면 현황을 눌러도 창이 열리지 않아 몇 번 다시 누른다.
    let status = null;
    for (let attempt = 0; attempt < tries && !status; attempt++) {
      buttonIn(row(), '현황')?.click();
      status = await until(statusDialog, dialogMs);
    }
    if (!status) return { ok: false, message: '응시 현황 창이 열리지 않았습니다. 시험 표의 현황을 누르세요.' };
    // 기록을 불러오면 줄마다 이어하기·결과보기가, 새로 응시할 수 있으면 응시 버튼이 생긴다.
    const choose = () => buttonIn(statusDialog(), '이어하기') || buttonIn(statusDialog(), '응시');
    let button = await until(() => choose() || buttonIn(statusDialog(), '결과보기'), listMs);
    // 응시 버튼은 시험지 정보까지 불러와야 생기므로 결과보기만 보이면 잠시 더 기다린다.
    if (button && text(button) === '결과보기') button = await until(choose, settleMs);
    if (!button) return { ok: false, message: '새로 응시할 수 없습니다. 응시 현황 창에서 확인하세요.' };
    if (text(button) === '이어하기') { button.click(); return opened(false); }
    if (!start) return { ok: false, message: '응시 중인 시험이 없습니다. 시험 바로가기를 다시 누르세요.' };
    button.click();
    return opened(true);
  }

  // 사이드 패널에 적은 답을 [{ number, choice }]로 읽는다. choice는 보기 번호(1부터) 또는 'O'·'X'.
  // 번호와 함께: "1④ 2③ 5 O", "1-4, 2-3", 줄마다 "1. ④". 번호 없이 차례대로: "4333144214", "④ ③ ③ …", "4 3 3 O".
  // 읽고 남는 글자가 있거나 번호가 거꾸로 가면 짐작하지 않고 읽지 못했다고 알린다.
  const MARK_O = /^[OoＯｏ○]$/, MARK_X = /^[XxＸｘ×✕]$/;
  const PAIR = /(\d{1,2})\s*(번\s*)?(?:([.):=\-])\s*)?([①-⑩]|[OoＯｏ○XxＸｘ×✕](?![A-Za-z])|\d{1,2}(?!\d))/g;
  const SPACING = /[\s,;/|·、]/g;
  function parseAnswers(text) {
    const source = String(text ?? '').trim();
    const choiceOf = token => (MARKS.includes(token) ? MARKS.indexOf(token) + 1
      : MARK_O.test(token) ? 'O' : MARK_X.test(token) ? 'X' : Number(token));
    const checked = answers => {
      for (const { number, choice } of answers) {
        if (!Number.isInteger(number) || number < 1 || number > 99) throw new Error(`${number}번은 없는 문항입니다.`);
        if (typeof choice === 'number' && !(Number.isInteger(choice) && choice >= 1 && choice <= MARKS.length)) {
          throw new Error(`${number}번 답(${choice})을 확인하세요.`);
        }
      }
      return answers;
    };
    if (!source) throw new Error('답을 적으세요. 예: 1④ 2③');
    const pairs = [];
    let loose = false;
    for (const match of source.matchAll(PAIR)) {
      // 숫자 답은 "1-4", "1. 4", "1번 4"처럼 구분이 있을 때만 받는다("4 3"은 번호 없는 차례로 본다).
      if (/^\d/.test(match[4]) && !match[2] && !match[3]) { loose = true; break; }
      pairs.push({ number: Number(match[1]), choice: choiceOf(match[4]) });
    }
    // "정답은 … 입니다" 같은 말은 남아도 되지만, 읽지 못한 숫자·보기·O/X가 남으면 짐작하지 않는다.
    const stray = /[\d①-⑩]|(?<![A-Za-z])[OoＯｏ○XxＸｘ×✕](?![A-Za-z])/.test(source.replace(PAIR, ' '));
    // 번호가 차례대로 가거나, 답이 모두 보기 기호(①…)라 번호와 헷갈릴 수 없을 때만 번호와 함께 쓴 답으로 본다.
    const increasing = pairs.every((pair, index) => !index || pair.number > pairs[index - 1].number);
    const marked = [...source.matchAll(PAIR)].every(match => MARKS.includes(match[4]));
    if (!loose && pairs.length && !stray && new Set(pairs.map(pair => pair.number)).size === pairs.length && (increasing || marked)) {
      return checked(pairs.sort((one, two) => one.number - two.number));
    }
    const tokens = [...source.replace(SPACING, '')];
    // 차례로 쓴 답은 숫자와 보기 기호를 섞지 않는다("2④1③"은 번호와 답이다).
    const mixed = tokens.some(token => /^\d$/.test(token)) && tokens.some(token => MARKS.includes(token));
    if (tokens.length && !mixed && tokens.every(token => MARKS.includes(token) || /^[1-9]$/.test(token) || MARK_O.test(token) || MARK_X.test(token))) {
      return checked(tokens.map((token, index) => ({ number: index + 1, choice: choiceOf(token) })));
    }
    throw new Error('답을 읽지 못했습니다. 예: 1④ 2③ 5 O');
  }

  // 답 넣기: 강의실 탭의 응시 중인 시험 창에서 실행한다(chrome.scripting으로 넣으므로 바깥 변수를 쓰지 않는다).
  // 사용자가 하듯 "문제풀이 현황"의 n번을 눌러 문제를 열고 보기를 누른다. 사이트는 보기를 누를 때마다 답을 저장한다.
  // 제출·임시 저장은 누르지 않는다(사이트의 임시 저장은 확인 창만 띄우고 따로 저장하지 않는다).
  async function answerInPage(answers, waits = {}) {
    const { move: moveMs = 4000, save: saveMs = 6000, settle: settleMs = 400, tick: tickMs = 100 } = waits;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
    const until = async (find, ms) => {
      for (const end = Date.now() + ms; ; await pause(tickMs)) {
        const found = find();
        if (found || Date.now() >= end) return found || null;
      }
    };
    // 응시 중인 시험 창에만 "남은 시간"이 있다(제출한 시험의 결과 창에는 없다).
    const exam = () => [...document.querySelectorAll('[role="dialog"]')]
      .find(node => text(node).includes('남은 시간') && text(node).includes('문제풀이 현황')) || null;
    const rowOf = number => [...(exam()?.querySelectorAll('tr') || [])].find(tr => text(tr.querySelector('th')) === `${number}번`) || null;
    const showing = number => [...(exam()?.querySelectorAll('div') || [])].some(node => text(node) === `${number}번 문제`);
    if (!exam()) return { ok: false, missing: true };
    const total = [...exam().querySelectorAll('tr')].filter(tr => /^\d+번$/.test(text(tr.querySelector('th')))).length;
    const done = [], failed = [];
    for (const { number, choice } of answers) {
      const row = rowOf(number);
      if (!row) { failed.push(number); continue; }
      row.click();
      if (!await until(() => showing(number), moveMs)) { failed.push(number); continue; }
      // 지금 열린 문제의 보기만 화면에 있다. 객관식은 "1. 보기", O/X 문항은 "O"·"X"로 쓰여 있다.
      const labels = [...exam().querySelectorAll('label[for]')];
      const label = typeof choice === 'number' ? labels[choice - 1]
        : labels.find(node => text(node).replace(/^\d+\.\s*/, '').toUpperCase() === choice);
      const input = label ? document.getElementById(label.htmlFor) : null;
      if (!input) { failed.push(number); continue; }
      // 사이트 화면에는 "답안 작성완료"로 보인다(번역 전 글은 "답안 작성 완료"). 띄어쓰기는 보지 않는다.
      const saved = () => input.checked && /^답안\s*작성\s*완료$/.test(text(rowOf(number)?.querySelector('td')));
      const changed = !input.checked;
      if (changed) label.click();
      // 사이트는 저장이 끝나야 그 줄을 "답안 작성완료"로 바꾼다. 저장 전에 다음 문제로 가면 화면의 기록이 어긋난다.
      if (!await until(saved, saveMs)) { failed.push(number); continue; }
      if (changed) await pause(settleMs);
      done.push(number);
    }
    return { ok: true, total, done, failed };
  }

  root.AlphaExam = { createClient, format, plain, openInPage, parseAnswers, answerInPage };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlphaExam;
})(globalThis);
