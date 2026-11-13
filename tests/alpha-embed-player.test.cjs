const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/alpha-embed-player.js'), 'utf8');

const CLASSROOM = 'https://alpha-campus.kr';
const EXTENSION = 'chrome-extension://extension-id';

function setup({ ancestors = [CLASSROOM, EXTENSION], pathname = '/bubble/embed/281', hasVideo = true, failPlay = false } = {}) {
  const events = {};
  const video = {
    currentSrc: 'https://cdn.example/lesson.mp4', readyState: 4, paused: true, ended: false, muted: false, playbackRate: 2,
    currentTime: 0, duration: 1774.4, error: null, plays: 0, pauses: 0,
    getAttribute() { return ''; },
    addEventListener(type, callback) { events[type] = callback; },
    play() {
      this.plays++;
      if (failPlay) return Promise.reject(new Error('NotAllowedError'));
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.pauses++; this.paused = true; },
  };
  const sent = [];
  const parent = { postMessage(message, targetOrigin) { assert.equal(targetOrigin, CLASSROOM); sent.push(message); } };
  let listener, interval;
  const window = { parent, addEventListener(type, callback) { if (type === 'message') listener = callback; } };
  const document = { querySelectorAll(selector) { return selector === 'video' && hasVideo ? [video] : []; } };
  const location = { origin: 'https://make.alpha-campus.kr', pathname, ancestorOrigins: ancestors };
  vm.runInNewContext(source, { window, document, location, Number, WeakSet,
    setInterval(callback, period) { assert.equal(period, 1000); interval = callback; },
    chrome: { runtime: { id: 'extension-id' } } });
  const command = (name, { source: from = parent, origin = CLASSROOM, tag = 'alpha-embed-player', ...extra } = {}) =>
    listener?.({ source: from, origin, data: { tag, type: 'command', command: name, ...extra } });
  return { video, events, sent, command, tick: () => interval?.(), active: !!listener };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the frame script only runs inside the hidden extension player, never in an ordinary classroom tab', () => {
  for (const options of [{ ancestors: [CLASSROOM] }, { ancestors: [CLASSROOM, 'https://other.example'] },
    { ancestors: ['https://other.example', EXTENSION] }, { ancestors: [] }, { pathname: '/bubble/edit/281' }]) {
    const h = setup(options);
    assert.equal(h.active, false); assert.deepEqual(h.sent, []);
  }
});

test('the video state is reported to the classroom and playback is muted at normal speed on request', async () => {
  const h = setup();
  assert.equal(h.sent.at(-1).type, 'state'); assert.equal(h.sent.at(-1).tag, 'alpha-embed-player');
  assert.equal(h.sent.at(-1).source, true); assert.equal(h.sent.at(-1).paused, true); assert.equal(h.sent.at(-1).ended, false);
  assert.equal(h.video.plays, 0, 'nothing plays until the classroom asks');
  h.command('rate'); h.command('play');
  await settle();
  assert.equal(h.video.plays, 1); assert.equal(h.video.muted, true); assert.equal(h.video.playbackRate, 1);
  h.video.currentTime = 30;
  h.tick();
  assert.equal(h.sent.at(-1).paused, false); assert.equal(h.sent.at(-1).currentTime, 30); assert.equal(h.sent.at(-1).duration, 1774.4);
  h.command('pause');
  assert.equal(h.video.pauses, 1);
  assert.equal(h.sent.at(-1).paused, true); assert.equal(h.sent.at(-1).ended, false, 'a pause in the middle is not the end');
});

test('a pause by the closing links at the very end counts as the end, but only after it has played', async () => {
  const h = setup();
  h.video.currentTime = 1774;
  h.tick();
  assert.equal(h.sent.at(-1).ended, false, 'an unplayed video waiting at its last position has not ended');
  h.command('play');
  await settle();
  h.tick();
  h.video.paused = true;
  h.events.pause();
  assert.equal(h.sent.at(-1).ended, true);
  assert.equal(h.sent.at(-1).currentTime, 1774);
});

test('commands from anything but the classroom frame are ignored, and denied playback is reported', async () => {
  const h = setup({ failPlay: true });
  h.command('play', { source: {} });
  h.command('play', { origin: 'https://other.example' });
  h.command('play', { tag: 'something-else' });
  assert.equal(h.video.plays, 0);
  h.command('play');
  await settle();
  assert.equal(h.video.plays, 1);
  assert.match(h.sent.at(-1).error, /자동 재생이 허용되지 않았습니다/);
});

test('a frame without a video reports that it is not ready', () => {
  const h = setup({ hasVideo: false });
  assert.equal(h.sent.at(-1).ready, false); assert.equal(h.sent.at(-1).source, false);
  h.command('play');
  assert.equal(h.sent.at(-1).ready, false);
});

test('playback moves once to the first unwatched part after the site player has resumed elsewhere', async () => {
  const h = setup();
  h.command('play', { from: 0 });
  await settle();
  // 사이트 플레이어가 첫 재생에서 마지막으로 본 위치로 옮긴 뒤 재생 신호가 온다.
  h.video.currentTime = 1048;
  h.events.playing();
  assert.equal(h.video.currentTime, 0);
  h.video.currentTime = 700;
  h.events.playing();
  assert.equal(h.video.currentTime, 700, 'later seeks by the viewer or the site are left alone');

  const near = setup();
  near.command('play', { from: 500 });
  await settle();
  near.video.currentTime = 501.2;
  near.events.playing();
  assert.equal(near.video.currentTime, 501.2, 'already at that point');

  const plain = setup();
  plain.command('play');
  await settle();
  plain.video.currentTime = 1048;
  plain.events.playing();
  assert.equal(plain.video.currentTime, 1048, 'without an unwatched part the site position is kept');
});
