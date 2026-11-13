// 알파 플레이어 프레임(/catenoid.html)의 페이지 영역(MAIN world)에서 실행한다.
// 웹영상(유튜브 등)은 사이트 플레이어가 <video> 없이 재생하므로 alpha-player.js가 DOM만으로는 제어할 수 없다.
// 이 스크립트는 사이트 플레이어의 상태 조회·재생·정지만 중계하고, 진도/시간 값은 건드리지 않는다.
(() => {
  'use strict';
  const ancestors = location.ancestorOrigins;
  // 사용자가 연 일반 강의실 탭에서는 동작하지 않는다: 확장 페이지 → 강의실 → 플레이어 프레임 구조에서만 응답한다.
  if (location.origin !== 'https://alpha-campus.kr' || location.pathname !== '/catenoid.html' ||
      !ancestors || ancestors.length !== 2 || ancestors[0] !== location.origin ||
      !String(ancestors[1]).startsWith('chrome-extension://')) return;
  if (window.__alphaAutoPlayerPage) return;
  window.__alphaAutoPlayerPage = true;

  const COMMAND = 'alpha-auto-player-command';
  const EVENT = 'alpha-auto-player-event';
  const ATTRIBUTE = 'data-alpha-auto-player';
  const wired = new WeakSet();
  const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const attempt = action => { try { return action(); } catch { return undefined; } };

  function sitePlayer() {
    const player = window.lxPlayer && window.lxPlayer.player;
    return player && typeof player.paused === 'function' && typeof player.play === 'function' ? player : null;
  }

  function state(player) {
    if (!player) return { ready: false };
    if (!wired.has(player) && typeof player.on === 'function') {
      wired.add(player);
      // 종료·오류는 다음 확인 주기를 기다리지 않고 바로 알린다.
      for (const type of ['ended', 'error']) {
        attempt(() => player.on(type, () => document.dispatchEvent(new CustomEvent(EVENT, { detail: type }))));
      }
    }
    const error = attempt(() => player.error && player.error());
    return {
      ready: true,
      tech: String(player.techName_ || ''),
      source: !!attempt(() => player.currentSrc && player.currentSrc()),
      readyState: number(attempt(() => player.readyState())),
      paused: attempt(() => player.paused()) !== false,
      ended: attempt(() => player.ended()) === true,
      currentTime: number(attempt(() => player.currentTime())),
      duration: number(attempt(() => player.duration())),
      error: error ? String(error.message || error.code || '재생 오류').slice(0, 120) : '',
    };
  }

  document.addEventListener(COMMAND, event => {
    const player = sitePlayer();
    if (player) {
      const command = event.detail;
      if (command === 'mute') attempt(() => player.muted(true));
      else if (command === 'unmute') attempt(() => player.muted(false));
      // 사이트가 배속을 허용하지 않으므로 기본 속도만 지정한다.
      else if (command === 'rate') attempt(() => player.playbackRate(1));
      else if (command === 'pause') attempt(() => player.pause());
      else if (command === 'play') {
        const playing = attempt(() => player.play());
        if (playing && typeof playing.catch === 'function') playing.catch(() => {});
      }
    }
    document.documentElement.setAttribute(ATTRIBUTE, JSON.stringify(state(player)));
  });
})();
