// MAIN world 에서 실행 — 사이트 전역(videojs, fnContent, orderContents …)에 직접 접근한다.
// 두 가지 모드로 동작한다.
//  - 탭 모드: 사용자가 강의 페이지를 직접 열었을 때. 배속 + 다음 강의 자동 진행.
//  - 러너 모드: 확장의 플레이어(offscreen 문서 또는 플레이어 창 안의 iframe)에서 과정을 돌릴 때.
//    미완료 강의만 골라(미학습 구간부터) 재생하고, 과정이 끝나면 백그라운드에 알린다.
// 사이트 스크립트(/js/series.js) 동작 요약:
//  - 플레이어: video.js, id="videojsplayer"
//  - 강의 종료 → OnComplete() → $.confirm("다음 콘텐츠 학습을 진행하시겠습니까?") → 확인 시 fnContent(nextId)
//  - 과정의 마지막 강의 종료 → $.alert("강의 끝났습니다.")
//  - 강의별 진도: orderContents[].studyProgress / studyTime / studyTimeList("시작,끝;…")
//  - 배속: localStorage "player.rate", 상한은 maxSpeed, noSpeed == "Y" 이면 1배속 고정
//  - mp4 강의는 소스만 바꾸고 play() 를 호출하지 않으므로 재생 시작은 여기서 한다.
(() => {
  'use strict';
  if (window.__ubobAutoPage) return;
  window.__ubobAutoPage = true;

  // 러너 프레임 = 확장 플레이어 페이지의 "직접" 자식 프레임 (사이트 페이지 안의 중첩 iframe 은 제외)
  const anc = location.ancestorOrigins;
  const IN_RUNNER = window.top !== window && window.parent === window.top && !!anc && anc.length === 1 &&
    anc[0].startsWith('chrome-extension://');
  if (window.top !== window && !IN_RUNNER) return;   // 다른 iframe 은 무시

  const TAG = 'ubob-auto';
  const IS_SERIES = /\/series\/seriesdetail\//i.test(location.pathname);
  const post = (type, payload) =>
    window.postMessage({ [TAG]: 'to-content', type, ...payload }, location.origin);

  const handlers = {};
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'to-page') return;
    const h = handlers[e.data.type];
    if (h) h(e.data);
  });

  if (!IS_SERIES) { post('ready'); return; }

  // =====================================================================
  // 강의 페이지 엔진
  // =====================================================================
  const TRAILER_RE = /seriestrailer/i;
  const USER_INPUT_WINDOW = 1500;   // 사용자 입력 후 이 시간 안의 pause 는 "사용자가 멈춤"으로 본다
  const FALLBACK_NEXT_MS = 20000;   // 종료 후 확인창이 안 뜨면 이 시간 뒤 직접 다음으로
  const MAX_PLAY_ATTEMPTS = 8;
  const MAX_LECTURE_TRIES = 3;      // 러너: 같은 강의를 이만큼 돌려도 진도가 안 차면 건너뜀
  // 러너: 학습이 실제로 되고 있는지 감시 → 아니면 페이지를 다시 불러 달라고 요청
  const FROZEN_MS = 30000;          // 재생 중인데 영상 시간이 멈춤
  const NOT_PLAYING_MS = 90000;     // 재생이 시작되지 않음
  const NO_SAVE_MS = 150000;        // 재생 중인데 사이트가 진도를 저장하지 않음 (사이트는 30초마다 저장)
  const RELOAD_GAP_MS = 60000;

  // ---------- 사이트 전역 접근 (let/var 모두, 선언 전이면 undefined) ----------
  const site = {
    maxSpeed() { try { return typeof maxSpeed !== 'undefined' ? Number(maxSpeed) : NaN; } catch { return NaN; } },
    noSpeed() { try { return typeof noSpeed !== 'undefined' ? noSpeed : undefined; } catch { return undefined; } },
    isContent() { try { return typeof isContent !== 'undefined' ? isContent : undefined; } catch { return undefined; } },
    isLast() { try { return typeof isLast !== 'undefined' ? isLast : undefined; } catch { return undefined; } },
    isSendingLog() { try { return typeof isSendingLog !== 'undefined' ? isSendingLog : false; } catch { return false; } },
    contentId() { try { return typeof _curContentId !== 'undefined' ? String(_curContentId ?? '') : ''; } catch { return ''; } },
    subsId() { try { return typeof _curSubsId !== 'undefined' ? String(_curSubsId ?? '') : ''; } catch { return ''; } },
    order() { try { return typeof orderSeries !== 'undefined' && orderSeries ? orderSeries : null; } catch { return null; } },
    orderStatus() { const o = site.order(); return o ? o.orderStatus : undefined; },
    contents() {
      try { if (typeof contents !== 'undefined' && Array.isArray(contents)) return contents; } catch { /* 무시 */ }
      try { if (typeof series !== 'undefined' && series && Array.isArray(series.Contents)) return series.Contents; } catch { /* 무시 */ }
      return null;
    },
    orderContents() { try { return typeof orderContents !== 'undefined' && Array.isArray(orderContents) ? orderContents : null; } catch { return null; } },
    seriesTitle() { try { return typeof series !== 'undefined' && series ? String(series.Title || '') : ''; } catch { return ''; } },
    // fnGoPosition 은 isContent 를 바꾸지 않으므로 직접 학습 모드로 표시한다 (fnContent 와 같은 효과)
    markContentMode() { try { isContent = true; return true; } catch { return false; } }
  };

  const readLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };
  const fmtRate = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2)));
  const fmtTime = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => !!el && el.isConnected && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;

  function getPlayer() {
    try {
      const p = window.videojs && window.videojs.getPlayer && window.videojs.getPlayer('videojsplayer');
      return p && !p.isDisposed() ? p : null;
    } catch { return null; }
  }
  const videoEl = () => document.querySelector('#videojsplayer video') || document.querySelector('.video-wrap video');
  const hasLectureSource = (v) => !!(v && v.currentSrc && !TRAILER_RE.test(v.currentSrc));
  const currentKey = () => `${site.contentId()}|${site.subsId()}`;

  // ---------- 강의 목록 ----------
  const lectureItems = () => [...document.querySelectorAll('.course-accordion > li[data-id]')];
  function lectureInfo(id = site.contentId()) {
    const items = lectureItems();
    const i = items.findIndex((li) => li.dataset.id === id);
    const title = i >= 0 ? textOf(items[i].querySelector('.accordion-title')).replace(/\[학습중\]/g, '').trim() : '';
    return { index: i + 1, total: items.length, title };
  }
  function nextLectureId() {
    const items = lectureItems();
    const i = items.findIndex((li) => li.dataset.id === site.contentId());
    return i >= 0 && i + 1 < items.length ? items[i + 1].dataset.id : null;
  }
  const lectureProgress = () => {
    const oc = (site.orderContents() || []).find((o) => o.contentId === site.contentId());
    return oc && oc.studyProgress != null && Number.isFinite(Number(oc.studyProgress)) ? Number(oc.studyProgress) : null;
  };
  const seriesProgress = () => {
    const o = site.order();
    if (o && o.studyProgress != null && Number.isFinite(Number(o.studyProgress))) return Number(o.studyProgress);
    const n = parseFloat(textOf(document.querySelector('.status-percent > p')));
    return Number.isFinite(n) ? n : null;
  };

  // ---------- 상태 ----------
  let settings = null;
  let lastKey = null;
  let doneKey = null;          // 종료를 인지한 강의
  let doneAt = 0;
  let advancedFor = null;      // 다음 진행을 이미 시작한 종료 강의
  let seriesDone = false;
  let userPaused = false;      // 사용자가 직접 멈춤 → 자동 재개하지 않음
  let userHold = false;        // 사용자가 카운트다운을 취소함 → 자동 진행 보류
  let autoStartTried = false;
  let awaitingStart = false;   // 러너가 강의를 막 시작시킴 (isLast 가 아직 true 일 수 있음)
  let lastUserInput = 0;
  let lastPlayTry = 0;
  let playAttempts = 0;
  let mutedByUs = false;
  let pending = null;          // { el, plan, at, timer }
  let courseFinished = false;
  const loadedAt = Date.now();
  const recentLog = [];
  const emitted = new Set();
  const dialogKinds = new WeakMap();
  const lectureTries = new Map();  // 러너: contentId → 시작 횟수
  const skippedLectures = new Set();
  // 진도 저장 추적: 사이트는 저장에 성공할 때마다 orderSeries 를 서버 응답으로 바꿔 끼운다
  let lastOrderObj = null;
  let saveCount = 0;
  let lastSaveAt = 0;
  // 멈춤 감시
  let lastCur = null;
  let lastCurChangeAt = Date.now();
  let playingSince = 0;
  let notPlayingSince = 0;
  let lastReloadReq = 0;

  function log(text) {
    recentLog.push({ t: Date.now(), text });
    if (recentLog.length > 8) recentLog.shift();
  }
  function emit(kind, text, onceKey) {
    if (onceKey) {
      if (emitted.has(onceKey)) return;
      emitted.add(onceKey);
    }
    log(text);
    post('event', { event: { kind, text } });
  }

  // ---------- 배속 ----------
  let writtenRate = null;
  function speedInfo() {
    const locked = site.noSpeed() === 'Y';
    const max = site.maxSpeed();
    const cap = Number.isFinite(max) && max > 0 ? max : Infinity;
    const want = Number(settings.speed) || 1;
    return {
      locked,
      max: Number.isFinite(max) ? max : null,
      target: locked ? 1 : Math.min(want, cap),
      capped: !locked && want > cap
    };
  }
  function applySpeed(p) {
    const s = speedInfo();
    if (s.locked) return;   // 사이트가 배속을 막은 과정은 건드리지 않는다
    const stored = readLS('player.rate');
    // 탭 모드: 사이트 배속 버튼(+/-, C/X 키)으로 바꾼 값은 새 설정으로 채택
    if (!settings.runner && writtenRate !== null && stored !== null && stored !== writtenRate &&
        Number(stored) > 0 && Math.abs(Number(stored) - s.target) > 0.01) {
      writtenRate = stored;
      post('speed-changed', { speed: Number(stored) });
      return;
    }
    const t = String(s.target);
    if (stored !== t) writeLS('player.rate', t);
    writtenRate = t;
    try {
      if (Math.abs(p.playbackRate() - s.target) > 0.01) p.playbackRate(s.target);
    } catch { /* 소스 로딩 중 */ }
    const label = document.querySelector('.speedrate');
    if (label && label.textContent !== s.target.toFixed(1)) label.textContent = s.target.toFixed(1);
  }

  // ---------- 러너: 미완료 강의 고르기 ----------
  // studyTimeList("0,120;130,300;") 에서 처음으로 비어 있는 구간의 시작 위치
  function firstGap(list, runningTime) {
    const segs = String(list || '').split(';')
      .map((s) => s.split(',').map(Number))
      .filter((a) => a.length === 2 && a.every(Number.isFinite))
      .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [s, e] of segs) {
      if (s > cursor + 2) break;
      cursor = Math.max(cursor, e);
    }
    if (runningTime && cursor >= runningTime - 2) return 0;   // 기록상 다 봤는데 미완료 → 처음부터
    return Math.max(0, cursor - 3);
  }
  function isLectureDone(c, oc) {
    if (!oc) return false;
    if (Number(oc.studyProgress) >= 100) return true;
    const rt = Number(c.RunningTime) || 0;
    return rt > 0 && Number(oc.studyTime) >= rt - 2;
  }
  function pickTarget() {
    const cs = site.contents();
    if (!cs || !cs.length) return undefined;   // 아직 로딩 전
    const ocs = site.orderContents() || [];
    const order = lectureItems().map((li) => li.dataset.id);
    const sorted = order.length ? [...cs].sort((a, b) => order.indexOf(a.Id) - order.indexOf(b.Id)) : cs;
    for (const c of sorted) {
      if (skippedLectures.has(c.Id)) continue;
      const oc = ocs.find((o) => o.contentId === c.Id);
      if (isLectureDone(c, oc)) continue;
      return { id: c.Id, title: c.Title, pos: oc ? firstGap(oc.studyTimeList, Number(c.RunningTime) || 0) : 0 };
    }
    return null;
  }

  let startRetries = 0;
  function smartStart() {
    if (courseFinished) return;
    autoStartTried = true;
    if (site.orderStatus() !== undefined && site.orderStatus() !== 'OPEN') {
      const o = site.order();
      finishCourse(`학습할 수 없는 과정입니다${o && o.cannotPlayMsg ? ` (${o.cannotPlayMsg})` : ''}`);
      return;
    }
    const t = pickTarget();
    if (t === undefined) {
      if (++startRetries > 15) emit('attention', '강의 정보를 불러오지 못했습니다.', 'no-contents');
      else setTimeout(smartStart, 2000);
      return;
    }
    if (t === null) { finishCourse('모든 강의 학습 완료'); return; }
    const n = (lectureTries.get(t.id) || 0) + 1;
    lectureTries.set(t.id, n);
    if (n > MAX_LECTURE_TRIES) {
      skippedLectures.add(t.id);
      emit('info', `"${t.title}" 은(는) ${MAX_LECTURE_TRIES}번 재생해도 진도가 채워지지 않아 건너뜁니다.`);
      smartStart();
      return;
    }
    startLecture(t);
  }

  function startLecture(t) {
    doneKey = null;
    advancedFor = null;
    seriesDone = false;
    userPaused = false;
    userHold = false;
    playAttempts = 0;
    lastPlayTry = 0;
    awaitingStart = true;
    site.markContentMode();
    const a = document.createElement('a');
    a.setAttribute('data-contentid', t.id);
    a.setAttribute('data-position', String(t.pos));
    if (typeof window.fnGoPosition === 'function') window.fnGoPosition(a);
    else if (typeof window.fnContent === 'function') window.fnContent(t.id);
    const { index, total } = lectureInfo(t.id);
    log(`${total ? `${index}/${total}강 ` : ''}${t.title} 재생${t.pos ? ` (${fmtTime(t.pos)}부터)` : ''}`);
    kick(1500);
  }

  // 강의가 끝나면 사이트가 진도를 서버에 보내고(orderContents 갱신) 난 뒤 다음 미완료 강의를 고른다
  let afterTimer = null;
  function afterLecture() {
    clearTimeout(afterTimer);
    const started = Date.now();
    const wait = () => {
      if (site.isSendingLog() === true && Date.now() - started < 15000) { afterTimer = setTimeout(wait, 500); return; }
      afterTimer = setTimeout(smartStart, 1500);
    };
    wait();
  }

  function finishCourse(reason) {
    if (courseFinished) return;
    courseFinished = true;
    const progress = seriesProgress();
    log(`과정 종료: ${reason}`);
    post('course-finished', { result: { reason, progress, skipped: skippedLectures.size } });
    try { const p = getPlayer(); if (p) p.pause(); } catch { /* 무시 */ }
  }

  // ---------- 사이트 확인창(jquery-confirm) 처리 ----------
  // plan(): 이 창을 어떻게 처리할지. null 이면 사람이 판단해야 하는 창(알림만 보냄)
  const RULES = [
    { kind: 'next', re: /다음 콘텐츠 학습을 진행하시겠습니까/,
      plan: () => settings.runner
        ? { button: '취소', delay: 1, then: afterLecture, label: '다음 미완료 강의로' }
        : settings.autoNext ? { button: '확인', delay: settings.nextDelay, label: '다음 강의 시작' } : null },
    { kind: 'resume', re: /학습중인 과정입니다/,
      plan: () => settings.runner
        ? { button: '취소', delay: 1, then: smartStart, label: '미완료 강의부터 학습' }
        : settings.autoStart ? { button: '확인', delay: 2, label: '이어서 학습' } : null },
    // 신청 전 과정에서도 같은 문구가 뜨므로(확인 = 학습 신청) 수강 중(OPEN)일 때만 처리한다
    { kind: 'start', re: /^학습을 진행하시겠습니까/,
      plan: () => site.orderStatus() !== 'OPEN' ? null
        : settings.runner ? { button: '취소', delay: 1, then: smartStart, label: '미완료 강의부터 학습' }
        : settings.autoStart ? { button: '확인', delay: 2, label: '학습 시작' } : null },
    { kind: 'passed', re: /수료하신 과정입니다/,
      plan: () => settings.runner
        ? { button: '취소', delay: 1, then: () => finishCourse('이미 수료한 과정'), label: '수료 과정 넘어가기' } : null },
    { kind: 'series-done', re: /강의 끝났습니다/,
      plan: () => ({ button: '확인', delay: settings.runner ? 1 : 3, then: settings.runner ? afterLecture : null, label: '완료 알림 닫기' }) },
    // 로그인 만료: 확인을 누르면 사이트가 로그인 페이지로 보내고, 확장이 다시 로그인한다
    { kind: 'login', re: /로그인/,
      plan: () => settings.runner ? { button: '확인', delay: 1, label: '다시 로그인' } : null }
  ];

  const dialogs = () => [...document.querySelectorAll('.jconfirm')].filter((el) => el.isConnected);
  const oathOpen = () => isVisible(document.querySelector('.popup-oath-agree'));
  const attentionDialogOpen = () => dialogs().some((el) => dialogKinds.get(el) === 'attention');

  function scanDialogs() {
    for (const el of dialogs()) {
      const kind = dialogKinds.get(el);
      // 꺼져 있을 때 무시한 창은 다시 켜지면 처리한다
      if (kind && !(kind === 'ignored' && settings.enabled)) continue;
      dialogKinds.set(el, 'reading');
      setTimeout(() => onDialog(el), 300);   // 내용이 채워질 시간을 준다
    }
  }

  function onDialog(el) {
    if (!el.isConnected) return;
    if (!settings.enabled) { dialogKinds.set(el, 'ignored'); return; }
    const title = textOf(el.querySelector('.jconfirm-title'));
    const body = textOf(el.querySelector('.jconfirm-content'));
    const rule = RULES.find((r) => r.re.test(body));

    if (rule && (rule.kind === 'next' || rule.kind === 'series-done')) markLectureDone();
    if (rule && rule.kind === 'series-done' && !settings.runner) {
      seriesDone = true;
      const pct = seriesProgress();
      emit('series-done', `마지막 강의까지 재생했습니다${pct !== null ? ` (진도율 ${pct}%)` : ''}. 시험·설문이 있으면 직접 진행해 주세요.`,
        `series-done:${doneKey}`);
    }

    const plan = rule ? rule.plan() : null;
    if (!plan) {
      dialogKinds.set(el, 'attention');
      emit('attention', `확인이 필요합니다: ${[title, body].filter(Boolean).join(' — ')}`);
      return;
    }
    dialogKinds.set(el, rule.kind);
    if (rule.kind === 'resume' || rule.kind === 'start') autoStartTried = true;
    schedule({ ...plan, kind: rule.kind }, el);
  }

  function schedule(plan, el) {
    cancelPending(false);
    const ms = Math.max(0, Number(plan.delay) || 0) * 1000;
    pending = { el, plan, at: Date.now() + ms, timer: setTimeout(runPending, ms) };
    render();
  }

  function runPending() {
    const job = pending;
    pending = null;
    if (!job || !settings.enabled || !job.el.isConnected) { render(); return; }
    const btn = [...job.el.querySelectorAll('.jconfirm-buttons button')].find((b) => textOf(b) === job.plan.button)
      || (job.plan.button === '취소' ? job.el.querySelector('.jconfirm-closeIcon') : null);
    if (!btn) { render(); return; }
    if (job.plan.kind === 'next' || job.plan.kind === 'series-done') advancedFor = doneKey;
    btn.click();
    log(job.plan.label);
    if (job.plan.then) setTimeout(job.plan.then, 300);
    kick(1500);
  }

  function cancelPending(byUser) {
    if (!pending) return;
    clearTimeout(pending.timer);
    const kind = pending.plan.kind;
    pending = null;
    if (byUser) {
      // 창은 그대로 두고, 이후 판단은 사용자에게 맡긴다
      userHold = true;
      for (const el of dialogs()) if (dialogKinds.get(el) === kind) dialogKinds.set(el, 'held');
      log('자동 진행을 취소했습니다');
    }
    render();
  }

  // ---------- 종료 인지 / 다음 강의 ----------
  function markLectureDone() {
    const key = currentKey();
    if (doneKey === key) return;
    doneKey = key;
    doneAt = Date.now();
    const { index, total, title } = lectureInfo();
    const pos = total ? `${index}/${total} ` : '';
    emit('lecture-done', `${pos}강의 종료: ${title || '(제목 없음)'}`);
  }

  function goNext(reason) {
    const next = nextLectureId();
    if (!next || typeof window.fnContent !== 'function') return false;
    advancedFor = doneKey;
    window.fnContent(next);
    log(reason);
    kick(1500);
    return true;
  }

  // 확인창 없이 끝난 경우(사이트 로직 변경 등)를 대비한 보조 경로
  function fallbackNext() {
    if (!doneKey || doneKey !== currentKey() || advancedFor === doneKey) return;
    if (seriesDone || userHold || pending || dialogs().length) return;
    if (Date.now() - doneAt < FALLBACK_NEXT_MS) return;
    if (settings.runner) {
      advancedFor = doneKey;
      afterLecture();
      return;
    }
    if (!settings.autoNext) return;
    if (!goNext('확인창이 없어 직접 다음 강의로 이동')) {
      advancedFor = doneKey;
      seriesDone = true;
      emit('series-done', '마지막 강의까지 재생했습니다.');
    }
  }

  // ---------- 재생 유지 ----------
  function canResume(p, v) {
    if (!hasLectureSource(v) || v.readyState < 1) return false;   // 로딩 중
    if (doneKey && doneKey === currentKey()) return false;         // 끝난 강의 → 다음 강의 대기
    try {
      const d = p.duration();
      const t = p.currentTime();
      if (d && d - t < 1.5) return false;
    } catch { return false; }
    return true;
  }

  function tryPlay(p) {
    if (Date.now() - lastPlayTry < 4000) return;
    lastPlayTry = Date.now();
    if (++playAttempts > MAX_PLAY_ATTEMPTS) {
      emit('attention', '재생을 시작하지 못했습니다. 페이지에서 재생 버튼을 직접 눌러 주세요.', `stuck:${currentKey()}`);
      return;
    }
    let r;
    try { r = p.play(); } catch { return; }
    if (r && typeof r.catch === 'function') {
      r.catch((err) => {
        if (!err || err.name !== 'NotAllowedError') return;
        // 사용자 조작 없이 소리 있는 재생이 막힌 경우 → 음소거로 재생
        try {
          p.muted(true);
          mutedByUs = true;
          const r2 = p.play();
          if (r2 && r2.catch) r2.catch(() => {});
        } catch { /* 무시 */ }
        emit('info', '브라우저 자동재생 정책 때문에 음소거로 재생합니다. 페이지를 한 번 클릭하면 소리가 켜집니다.', 'muted-autoplay');
      });
    }
  }

  // ---------- 진도 저장 추적 ----------
  // 사이트는 /api/order/setplaylog 응답으로 orderSeries / orderContents 객체를 새로 바꿔 끼운다
  let lastOCObj = null;
  function trackSaves() {
    const o = site.order();
    const oc = site.orderContents();
    if (!o && !oc) return;
    if (lastOrderObj === null && lastOCObj === null) { lastOrderObj = o; lastOCObj = oc; return; }   // 첫 로드
    if (o !== lastOrderObj || oc !== lastOCObj) {
      lastOrderObj = o;
      lastOCObj = oc;
      saveCount++;
      lastSaveAt = Date.now();
    }
  }

  // ---------- 멈춤 감시 (러너) ----------
  const stallMs = (k, d) => (settings.stall && Number(settings.stall[k])) || d;
  function watchStall(p, v) {
    const now = Date.now();
    const contentMode = site.isContent() === true;
    const playing = !!p && contentMode && !p.paused();
    let cur = null;
    try { cur = p ? p.currentTime() : null; } catch { /* 무시 */ }
    if (playing) {
      notPlayingSince = 0;
      if (!playingSince) { playingSince = now; lastCur = cur; lastCurChangeAt = now; }
      if (cur !== lastCur) { lastCur = cur; lastCurChangeAt = now; }
      else if (now - lastCurChangeAt > stallMs('frozen', FROZEN_MS)) {
        return requestReload('재생 중인데 영상 시간이 움직이지 않습니다');
      }
      const sinceSave = saveCount ? now - lastSaveAt : now - playingSince;
      if (sinceSave > stallMs('noSave', NO_SAVE_MS)) {
        return requestReload(saveCount ? '진도 저장이 한동안 없습니다' : '재생 중인데 사이트가 진도를 저장하지 않습니다');
      }
      return;
    }
    playingSince = 0;
    if (userPaused || pending || dialogs().length || oathOpen() || (doneKey && doneKey === currentKey())) {
      notPlayingSince = 0;
      return;
    }
    if (!notPlayingSince) notPlayingSince = now;
    else if (now - notPlayingSince > stallMs('notPlaying', NOT_PLAYING_MS)) {
      requestReload(!p ? '강의 페이지가 열렸지만 플레이어가 나타나지 않습니다'
        : !hasLectureSource(v) ? '강의 영상이 로드되지 않습니다' : '재생이 시작되지 않습니다');
    }
  }
  function requestReload(reason) {
    if (Date.now() - lastReloadReq < RELOAD_GAP_MS) return;
    lastReloadReq = Date.now();
    notPlayingSince = 0;
    playingSince = 0;
    log(`다시 불러오기 요청: ${reason}`);
    post('reload-request', { reason });
  }

  // ---------- 메인 루프 ----------
  function tick() {
    if (!settings) return;
    scanDialogs();
    const p = getPlayer();
    const v = videoEl();
    trackSaves();

    const key = currentKey();
    if (key !== lastKey) {
      lastKey = key;
      userPaused = false;
      userHold = false;
      playAttempts = 0;
      if (key !== doneKey) seriesDone = false;
    }

    if (settings.enabled && !courseFinished) {
      if (p) {
        applySpeed(p);
        if (settings.runner && settings.muted) { try { if (!p.muted()) p.muted(true); } catch { /* 무시 */ } }
      }
      if (oathOpen()) emit('attention', '서약 동의 창이 열려 있습니다. 직접 확인해 주세요.', `oath:${key}`);

      const blocked = pending || dialogs().length || oathOpen();
      if (p && v && !blocked && !seriesDone) {
        const contentMode = site.isContent() === true;
        const paused = p.paused();
        if (contentMode && paused && site.isLast() === true && !awaitingStart) markLectureDone();

        if (contentMode && paused && !userPaused && canResume(p, v)) {
          tryPlay(p);
        } else if (!contentMode && paused && !autoStartTried && Date.now() - loadedAt > 6000) {
          // 확인창 없이 열린 페이지
          if (settings.runner) {
            if (site.orderStatus() !== undefined) smartStart();
          } else if (settings.autoStart && site.orderStatus() === 'OPEN' && typeof window.fnSeriesPlay === 'function') {
            autoStartTried = true;
            window.fnSeriesPlay();   // 마지막으로 보던 강의부터 이어보기
            log('마지막으로 보던 강의부터 이어서 재생');
            kick(1500);
          }
        }
      }
      fallbackNext();
      if (settings.runner) watchStall(p, v);
    }
    report(p, v);
    render();
  }

  // 백그라운드에서는 반복 타이머가 느려질 수 있으므로 미디어 이벤트로도 확인한다
  let kickTimer = null;
  function kick(ms = 200) {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(tick, ms);
  }

  // ---------- 상태 보고 ----------
  function computeState(p) {
    if (!settings.enabled) return 'off';
    if (courseFinished) return 'course-finished';
    if (pending) return pending.plan.kind === 'next' ? 'next-countdown' : 'countdown';
    if (seriesDone) return 'done';
    if (oathOpen() || attentionDialogOpen()) return 'attention';
    if (!p) return 'loading';
    if (!p.paused()) return site.isContent() === true ? 'playing' : 'trailer';
    if (userPaused || userHold) return 'user-paused';
    if (doneKey && doneKey === currentKey()) return 'waiting-next';
    return site.isContent() === true ? 'loading' : 'idle';
  }

  let lastStatus = null;
  function report(p, v) {
    const s = speedInfo();
    const info = lectureInfo();
    let rate = null, cur = null, dur = null, muted = null;
    if (p) {
      try { rate = p.playbackRate(); cur = p.currentTime(); dur = p.duration(); muted = p.muted(); } catch { /* 무시 */ }
    }
    lastStatus = {
      page: 'series',
      runner: !!settings.runner,
      enabled: settings.enabled,
      state: computeState(p),
      course: site.seriesTitle(),
      title: info.title,
      index: info.index,
      total: info.total,
      currentTime: Number.isFinite(cur) ? cur : null,
      duration: Number.isFinite(dur) ? dur : null,
      isLecture: hasLectureSource(v) && site.isContent() === true,
      rate,
      target: s.target,
      speedLocked: s.locked,
      maxSpeed: s.max,
      capped: s.capped,
      muted,
      visibility: document.visibilityState,
      progress: seriesProgress(),
      lectureProgress: lectureProgress(),
      saveCount,
      lastSaveAt: lastSaveAt || null,
      hasPlayer: !!p,
      readyState: v ? v.readyState : null,
      src: v && v.currentSrc ? v.currentSrc.replace(/\?.*$/, '').slice(-60) : null,
      countdown: pending ? Math.max(0, Math.ceil((pending.at - Date.now()) / 1000)) : null,
      countdownLabel: pending ? pending.plan.label : null,
      log: recentLog.slice()
    };
    post('status', { status: lastStatus });
  }

  // ---------- 화면 표시(탭 모드, 우측 하단) ----------
  let ui = null;
  function ensureOverlay() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'ubob-auto-overlay';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .pill{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;
          font:600 13px/1.2 system-ui,-apple-system,"Malgun Gothic",sans-serif;color:#fff;
          background:rgba(24,28,33,.88);box-shadow:0 4px 16px rgba(0,0,0,.25);backdrop-filter:blur(4px)}
        .dot{width:8px;height:8px;border-radius:50%;background:#9bbc00;flex:none}
        .dot.warn{background:#f5a524}.dot.idle{background:#8a9099}.dot.done{background:#4aa3ff}
        button{font:inherit;font-weight:700;color:#181c21;background:#fff;border:0;border-radius:999px;
          padding:4px 10px;cursor:pointer}
        button:hover{background:#e8ecef}
        [hidden]{display:none}
      </style>
      <div class="pill"><span class="dot"></span><span class="txt"></span><button type="button" hidden>취소</button></div>`;
    const btn = root.querySelector('button');
    btn.addEventListener('click', (e) => { e.stopPropagation(); cancelPending(true); });
    document.body.appendChild(host);
    ui = { host, dot: root.querySelector('.dot'), txt: root.querySelector('.txt'), btn };
    return ui;
  }

  const STATE_TEXT = {
    'trailer': '예고편 재생 중',
    'loading': '강의 불러오는 중…',
    'idle': '대기 중',
    'user-paused': '일시정지 (직접 멈춤)',
    'waiting-next': '강의 종료 — 다음 강의 준비 중',
    'done': '과정 마지막 강의 완료',
    'course-finished': '과정 완료',
    'attention': '확인 필요 — 사이트 창을 확인하세요'
  };

  function render() {
    if (!settings) return;
    if (settings.runner || !settings.enabled || settings.overlay === false) {
      if (ui) ui.host.style.display = 'none';
      return;
    }
    const o = ensureOverlay();
    o.host.style.display = '';
    const st = lastStatus ? lastStatus.state : 'loading';
    const s = speedInfo();
    const speedTxt = s.locked ? '1.0x(배속 제한 과정)' : `${fmtRate(s.target)}x`;
    let text;
    if (pending) {
      const sec = Math.max(0, Math.ceil((pending.at - Date.now()) / 1000));
      text = `${sec}초 후 ${pending.plan.label}`;
    } else if (st === 'playing') {
      const { index, total } = lectureInfo();
      text = `자동학습 · ${speedTxt}${total ? ` · ${index}/${total}강` : ''}`;
    } else {
      text = `자동학습 · ${STATE_TEXT[st] || st}`;
    }
    o.txt.textContent = text;
    o.btn.hidden = !pending;
    o.dot.className = 'dot' + (st === 'attention' || st === 'user-paused' ? ' warn'
      : st === 'done' ? ' done' : st === 'playing' || pending ? '' : ' idle');
  }
  setInterval(() => { if (pending) render(); }, 250);

  // ---------- 명령(팝업) ----------
  function command(cmd) {
    const p = getPlayer();
    switch (cmd) {
      case 'play':
        userPaused = false;
        userHold = false;
        playAttempts = 0;
        lastPlayTry = 0;
        if (p && site.isContent() === true && canResume(p, videoEl())) tryPlay(p);
        else if (site.orderStatus() === 'OPEN' && typeof window.fnSeriesPlay === 'function') window.fnSeriesPlay();
        break;
      case 'pause':
        userPaused = true;
        if (p) p.pause();
        break;
      case 'next':
        userHold = false;
        if (pending && pending.plan.kind === 'next') {
          clearTimeout(pending.timer);
          runPending();
        } else {
          cancelPending(false);
          goNext('다음 강의로 이동');
        }
        break;
      case 'cancel':
        cancelPending(true);
        break;
    }
    kick(300);
  }

  // ---------- 이벤트 ----------
  const isPlayerVideo = (t) => t instanceof HTMLVideoElement && t === videoEl();

  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, (e) => {
      if (!e.isTrusted) return;
      lastUserInput = Date.now();
      if (mutedByUs) {
        mutedByUs = false;
        const p = getPlayer();
        if (p) try { p.muted(false); } catch { /* 무시 */ }
      }
    }, true);
  }
  // 미디어 이벤트는 버블링되지 않지만 캡처 단계에서는 document 까지 전달된다 → 플레이어가 재생성돼도 동작
  document.addEventListener('pause', (e) => {
    if (isPlayerVideo(e.target) && Date.now() - lastUserInput < USER_INPUT_WINDOW) userPaused = true;
    kick(500);
  }, true);
  document.addEventListener('play', (e) => {
    if (isPlayerVideo(e.target)) { userPaused = false; userHold = false; }
  }, true);
  document.addEventListener('playing', () => { playAttempts = 0; awaitingStart = false; kick(); }, true);
  for (const type of ['loadedmetadata', 'canplay', 'ended', 'emptied']) {
    document.addEventListener(type, () => kick(300), true);
  }

  new MutationObserver(() => { if (settings) scanDialogs(); }).observe(document.body, { childList: true });

  handlers.settings = (m) => {
    const wasEnabled = settings && settings.enabled;
    settings = m.settings;
    if (wasEnabled && !settings.enabled) cancelPending(false);
    kick(0);
  };
  handlers.command = (m) => { if (settings) command(m.cmd); };

  setInterval(tick, 1000);
  post('ready');
})();
