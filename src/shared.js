// 확장 전체(content / background / popup / offscreen)에서 공유하는 상수.
// page.js 는 MAIN world 에서 실행되므로 이 파일을 쓰지 못하고, 설정은 content.js 가 전달한다.
var UBOB_AUTO = {
  TAG: 'ubob-auto',
  DEFAULTS: {
    baseUrl: 'https://krs.ubob.com', // 학습 사이트 주소 (회사별 서브도메인)
    speed: 2,           // 목표 배속 (사이트가 허용하는 최대 배속을 넘지 않음)
    runnerMuted: true,  // 백그라운드 자동 학습 중 소리 끄기
    notify: true,       // 데스크톱 알림
    // ---- 강의 페이지를 탭에서 직접 볼 때 ----
    enabled: true,      // 탭에서도 배속·다음 강의 자동 진행
    autoNext: true,
    autoStart: true,
    nextDelay: 3,
    muteTab: false,
    overlay: true,
    stall: null         // 멈춤 감지 시간(ms) 재정의 { frozen, notPlaying, noSave } — 기본은 page.js 상수
  },
  SPEEDS: [1, 1.25, 1.5, 1.75, 2],
  SERIES_RE: /\/series\/seriesdetail\//i,
  LOGIN_RE: /\/account\/login/i,
  ERROR_RE: /^\/error/i
};
