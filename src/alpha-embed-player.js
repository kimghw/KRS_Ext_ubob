// 알파 저작도구 차시(유형 15, 사이트 표기 "인터랙티브")의 플레이어 프레임(make.alpha-campus.kr/bubble/embed/…)에서 실행한다.
// 강의실 프레임과 출처가 달라 alpha-player.js가 <video>에 직접 닿지 못하므로, 상태를 알려 주고 재생·정지 요청만 받는다.
// 진도/시간 값은 건드리지 않는다. 진도는 사이트 플레이어가 강의실에 알리고 강의실이 기록한다.
(() => {
  'use strict';
  const CLASSROOM = 'https://alpha-campus.kr';
  const TAG = 'alpha-embed-player';
  // 영상 끝에 걸린 안내(링크·이미지)가 재생을 멈추면 ended 없이 끝난다. 끝에서 이 시간(초) 안에 멈추면 종료로 본다.
  const END_MARGIN = 3;
  const ancestors = location.ancestorOrigins;
  // 사용자가 연 일반 강의실 탭에서는 동작하지 않는다: 확장 페이지 → 강의실 → 플레이어 프레임 구조에서만 응답한다.
  if (location.origin !== 'https://make.alpha-campus.kr' || !location.pathname.startsWith('/bubble/embed/') ||
      !ancestors || ancestors.length !== 2 || ancestors[0] !== CLASSROOM ||
      ancestors[1] !== `chrome-extension://${chrome.runtime.id}`) return;
  if (window.__alphaEmbedPlayer) return;
  window.__alphaEmbedPlayer = true;

  const wired = new WeakSet();
  let started = false;
  let playError = '';
  // 재생이 시작되면 옮겨 갈 위치(초). 강의실 쪽이 아직 보지 않은 첫 지점을 알려 준다.
  let startFrom = null;

  // 사이트 플레이어는 첫 재생 때 마지막으로 본 위치로 옮긴다. 그 앞에 보지 않은 구간이 남아 있으면 거기서부터 본다.
  // 진도는 그대로 사이트 플레이어가 실제 재생한 구간으로 기록한다.
  function moveToStart(video) {
    if (startFrom === null) return;
    const target = startFrom;
    startFrom = null;
    if (Math.abs(video.currentTime - target) > 2) {
      try { video.currentTime = target; } catch { /* 아직 옮길 수 없는 상태 */ }
    }
  }

  function findVideo(doc = document, depth = 0) {
    const videos = [...doc.querySelectorAll('video')];
    const direct = videos.find(video => video.currentSrc || video.getAttribute('src') || video.readyState > 0) || videos[0];
    if (direct) return direct;
    // 플레이어를 같은 출처의 안쪽 프레임에 그리는 구성도 찾는다.
    if (depth < 1) for (const frame of doc.querySelectorAll('iframe')) {
      let inner = null;
      try { inner = frame.contentDocument; } catch { /* 다른 출처 프레임 */ }
      const video = inner && findVideo(inner, depth + 1);
      if (video) return video;
    }
    return null;
  }

  function report() {
    const video = findVideo();
    if (video && !wired.has(video)) {
      wired.add(video);
      video.addEventListener('playing', () => { moveToStart(video); report(); });
      for (const type of ['pause', 'ended', 'error', 'loadedmetadata']) video.addEventListener(type, report);
    }
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
    const currentTime = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    if (video && !video.paused) { started = true; playError = ''; }
    const ended = !!video && (video.ended || (started && video.paused && duration > 0 && duration - currentTime <= END_MARGIN));
    window.parent.postMessage({
      tag: TAG, type: 'state', ready: !!video,
      source: !!(video && (video.currentSrc || video.getAttribute('src'))),
      readyState: video ? video.readyState : 0,
      paused: !video || video.paused, ended, currentTime, duration,
      error: video?.error ? `재생 오류 ${video.error.code || ''}`.trim() : playError,
    }, CLASSROOM);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== CLASSROOM ||
        event.data?.tag !== TAG || event.data.type !== 'command') return;
    const video = findVideo();
    if (video) {
      const command = event.data.command;
      if (command === 'mute') video.muted = true;
      else if (command === 'unmute') video.muted = false;
      // 사이트가 배속을 허용하지 않으므로 기본 속도만 지정한다.
      else if (command === 'rate') video.playbackRate = 1;
      else if (command === 'pause') video.pause();
      else if (command === 'play') {
        // 소리를 끈 재생만 사용자 동작 없이 허용된다.
        video.muted = true;
        const from = event.data.from;
        if (!started && typeof from === 'number' && Number.isFinite(from) && from >= 0) startFrom = from;
        let playing;
        try { playing = video.play(); } catch { playError = '자동 재생이 허용되지 않았습니다'; }
        if (playing && typeof playing.catch === 'function') {
          playing.catch(() => { if (video.paused) { playError = '자동 재생이 허용되지 않았습니다'; report(); } });
        }
      }
    }
    report();
  });

  setInterval(report, 1000);
  report();
})();
