// 확장 전체(content / background / popup / offscreen)에서 공유하는 상수.
// page.js 는 MAIN world 에서 실행되므로 이 파일을 쓰지 못하고, 설정은 content.js 가 전달한다.
var UBOB_AUTO = {
  TAG: 'ubob-auto',
  DEFAULTS: {
    baseUrl: 'https://krs.ubob.com', // 학습 사이트 주소 (회사별 서브도메인)
    rpBaseUrl: 'https://krs.runningplus.net', // 러닝플러스 주소 (회사별 서브도메인)
    speed: 2,           // 목표 배속 (사이트가 허용하는 최대 배속을 넘지 않음)
    runnerMuted: true,  // 백그라운드 자동 학습 중 소리 끄기
    notify: true,       // 데스크톱 알림
    // ---- 근무 시간에만 자동 학습 ----
    workHoursOnly: false,     // 켜면 아래 시간대 밖에서는 자동 학습을 쉬고, 시간이 되면 이어서 진행
    workStart: '09:00',
    workEnd: '18:00',
    workWeekdaysOnly: true,   // 토·일 제외
    // ---- 세션(강의) 사이 휴식 ----
    restBetween: false,       // 강의가 끝나면 다음 강의(또는 다음 과정)까지 1분 ~ restMaxMin분 사이에서 무작위로 쉰다
    restMaxMin: 3,            // 휴식 최대(분). 최소는 REST_MIN_SEC 로 고정
    // ---- 강의 페이지를 탭에서 직접 볼 때 ----
    enabled: true,      // 탭에서도 배속·다음 강의 자동 진행
    autoNext: true,
    autoStart: true,
    nextDelay: 3,
    muteTab: false,
    overlay: true,
    stall: null         // 멈춤 감지 시간(ms) 재정의 { frozen, notPlaying, noSave } — 기본은 page.js 상수
  },
  REST_MIN_SEC: 60,      // 세션 사이 휴식 최소(초)
  REST_MAX_MIN_LIMIT: 120,   // 팝업에서 입력할 수 있는 최대값(분)
  // 휴식 범위(초) [최소, 최대]. 최대는 설정 restMaxMin(분), 최소보다 작으면 최소로
  restRange(s) {
    const lo = UBOB_AUTO.REST_MIN_SEC;
    const n = Math.round(Number(s && s.restMaxMin));
    const max = Number.isFinite(n) && n > 0 ? Math.min(n, UBOB_AUTO.REST_MAX_MIN_LIMIT) : UBOB_AUTO.DEFAULTS.restMaxMin;
    return [lo, Math.max(lo, max * 60)];
  },
  SPEEDS: [1, 1.25, 1.5, 1.75, 2],
  SERIES_RE: /\/series\/seriesdetail\//i,
  LOGIN_RE: /\/account\/login/i,
  ERROR_RE: /^\/error/i,

  // ---------- 근무 시간 ----------
  // "HH:MM" → 0시부터의 분. 형식이 틀리면 null
  parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  },
  workRange(s) {
    const a = UBOB_AUTO.parseHM(s.workStart), b = UBOB_AUTO.parseHM(s.workEnd);
    return [a == null ? 9 * 60 : a, b == null ? 18 * 60 : b];
  },
  isWorkDay(s, d) { return !s.workWeekdaysOnly || (d.getDay() !== 0 && d.getDay() !== 6); },
  // 지금 자동 학습을 해도 되는 시간인가 (설정이 꺼져 있으면 항상 true). 시작 > 끝이면 자정을 넘는 시간대로 본다.
  inWorkHours(s, now = new Date()) {
    if (!s.workHoursOnly) return true;
    const [a, b] = UBOB_AUTO.workRange(s);
    const t = now.getHours() * 60 + now.getMinutes();
    if (a === b) return UBOB_AUTO.isWorkDay(s, now);
    if (a < b) return UBOB_AUTO.isWorkDay(s, now) && t >= a && t < b;
    // 자정을 넘는 범위: 시작 시각이 속한 날이 근무일이어야 한다
    if (t >= a) return UBOB_AUTO.isWorkDay(s, now);
    return t < b && UBOB_AUTO.isWorkDay(s, new Date(now.getTime() - 864e5));
  },
  // 다음에 근무 시간이 시작되는 시각 (지금이 근무 시간이면 null). 2주 안에 없으면 null
  nextWorkStart(s, now = new Date()) {
    if (UBOB_AUTO.inWorkHours(s, now)) return null;
    const [a] = UBOB_AUTO.workRange(s);
    for (let d = 0; d < 15; d++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, Math.floor(a / 60), a % 60, 0, 0);
      if (at <= now || !UBOB_AUTO.isWorkDay(s, at)) continue;
      return at;
    }
    return null;
  },
  // 시각 표시: 오늘이면 "HH:MM", 다른 날이면 "M/D(요일) HH:MM"
  fmtWhen(t, now = new Date()) {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return hm;
    return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]}) ${hm}`;
  },
  // 초 → "1분 30초" / "45초"
  fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? (s ? `${m}분 ${s}초` : `${m}분`) : `${s}초`;
  }
};
