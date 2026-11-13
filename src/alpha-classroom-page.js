// 알파 강의실(/my/classRoom/classRoomDetail)의 페이지 영역(MAIN world)에서 실행한다.
// 사이트는 영상 차시의 진도를 "실제로 본 초(秒)의 수 ÷ 길이"로 계산하고, 그 초의 집합을 window.currentWatchedSeconds에 둔다.
// alpha-player.js는 격리된 영역이라 이 값을 읽지 못하므로, 이미 본 구간만 읽어서 알려 준다. 진도/시간 값은 바꾸지 않는다.
(() => {
  'use strict';
  const ancestors = location.ancestorOrigins;
  // 사용자가 연 일반 강의실 탭에서는 동작하지 않는다: 숨겨진 확장 페이지의 직접 자식일 때만 응답한다.
  if (location.origin !== 'https://alpha-campus.kr' || location.pathname !== '/my/classRoom/classRoomDetail' ||
      window.top === window || window.parent !== window.top || !ancestors || ancestors.length !== 1 ||
      !String(ancestors[0]).startsWith('chrome-extension://')) return;
  if (window.__alphaAutoClassroomPage) return;
  window.__alphaAutoClassroomPage = true;

  const COMMAND = 'alpha-auto-classroom-command';
  const ATTRIBUTE = 'data-alpha-auto-classroom';

  // 본 초의 집합을 "시작[.]끝[,]시작[.]끝"(끝은 그 구간 다음 초) 형식의 구간으로 바꾼다.
  function watched() {
    const seconds = window.currentWatchedSeconds;
    if (!(seconds instanceof Set)) return { ready: false };
    const sorted = [...seconds].map(Number).filter(value => Number.isInteger(value) && value >= 0).sort((one, two) => one - two);
    const parts = [];
    let start = null, end = null;
    for (const second of sorted) {
      if (start === null) { start = end = second; continue; }
      if (second <= end + 1) { end = Math.max(end, second); continue; }
      parts.push(`${start}[.]${end + 1}`);
      start = end = second;
    }
    if (start !== null) parts.push(`${start}[.]${end + 1}`);
    return { ready: true, count: sorted.length, segments: parts.join('[,]') };
  }

  document.addEventListener(COMMAND, () => {
    let state;
    try { state = watched(); } catch { state = { ready: false }; }
    document.documentElement.setAttribute(ATTRIBUTE, JSON.stringify(state));
  });
})();
