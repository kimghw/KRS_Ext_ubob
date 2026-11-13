const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/alpha-player.js'), 'utf8');

const registrationId = '12345678-1234-1234-1234-123456789012';
const lessonId = '11111111-1111-1111-1111-111111111111';
const url = new URL(`https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=${registrationId}&sequenceLessonId=${lessonId}&type=ONLINE`);

// 페이지 영역의 alpha-player-page.js를 대신하는 플레이어 프레임 문서. <video> 없이 명령에만 응답한다.
function sitePlayerDocument(state, { startsOnPlay = true } = {}) {
  const attributes = {}, listeners = {}, commands = [];
  return {
    commands, state,
    documentElement: {
      removeAttribute(name) { delete attributes[name]; },
      getAttribute(name) { return attributes[name] ?? null; },
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, callback) { listeners[type] = callback; },
    dispatchEvent(event) {
      if (event.type !== 'alpha-auto-player-command') return;
      commands.push(event.detail);
      if (event.detail === 'play' && startsOnPlay) state.paused = false;
      if (event.detail === 'pause') state.paused = true;
      attributes['data-alpha-auto-player'] = JSON.stringify(state);
    },
    emit(type) { return listeners['alpha-auto-player-event']?.({ detail: type }); },
  };
}

function setup({ active = true, wrongLesson = false, dialog = false, failPlay = false, iframe = false, loading = false,
  embedded = true, ancestorOrigin = 'chrome-extension://extension-id', playerDocument = null, emptyFrame = false,
  blockedFrame = false } = {}) {
  let clock = 1000000;
  const events = {};
  const media = {
    currentSrc: loading ? '' : 'https://cdn.example/lesson.m3u8', readyState: loading ? 0 : 4, paused: true, ended: false,
    currentTime: 0, duration: 100, muted: false, playbackRate: 2, plays: 0, pauses: 0,
    getAttribute() { return ''; },
    addEventListener(type, callback) { events[type] = callback; },
    async play() {
      this.plays++;
      if (failPlay) throw new Error('NotAllowedError');
      this.paused = false;
    },
    pause() { this.pauses++; this.paused = true; },
  };
  const framed = iframe || !!playerDocument || emptyFrame || blockedFrame;
  const childDoc = playerDocument || {
    querySelectorAll(selector) { return selector === 'video, audio' && !emptyFrame ? [media] : []; },
    querySelector() { return null; },
  };
  // blockedFrame: 사이트 서비스 워커의 저장본으로 응답되어 차단된 프레임. 주소가 바뀌어 네트워크로 다시 열리면 접근할 수 있다.
  const opened = [];
  const frame = {
    address: '/catenoid.html',
    contentDocument: blockedFrame ? null : childDoc,
    contentWindow: { location: { origin: blockedFrame ? 'null' : url.origin } },
    getAttribute(name) { return name === 'src' ? this.address : null; },
    get src() { return new URL(this.address, url.origin).href; },
    set src(value) {
      opened.push(value);
      this.address = value;
      this.contentDocument = childDoc;
      this.contentWindow = { location: { origin: url.origin } };
    },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'video, audio') return framed ? [] : [media];
      if (selector === 'iframe') return framed ? [frame] : [];
      return dialog ? [{ getClientRects: () => [1], getAttribute: () => null }] : [];
    },
  };
  const calls = [];
  let interval;
  let listener;
  const windowEvents = {};
  const window = { addEventListener(type, callback) { windowEvents[type] = callback; } };
  const parent = { postMessage(message, targetOrigin) {
    calls.push(message);
    assert.equal(targetOrigin, 'chrome-extension://extension-id');
    queueMicrotask(() => windowEvents.message({ source: parent, origin: targetOrigin, data: {
      tag: 'alpha-offscreen-player', type: 'response', requestId: message.requestId,
      response: { active, runId: 'run-1', lessonId: wrongLesson ? 'different-lesson' : lessonId, registrationId, muted: true },
    } }));
  } };
  window.top = embedded ? parent : window;
  window.parent = window.top;
  const location = Object.assign(new URL(url.href), { ancestorOrigins: embedded ? [ancestorOrigin] : [] });
  // 재확인 타이머가 테스트 종료를 붙잡지 않게 한다.
  const background = (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; };
  const context = { window, document, location, URL, Date: { now: () => clock }, Set, Map, WeakSet, WeakMap, CustomEvent, queueMicrotask,
    setTimeout: background, clearTimeout,
    setInterval(callback, period) { assert.equal(period, 5000); interval = callback; },
    chrome: { runtime: {
      id: 'extension-id',
      async sendMessage() { assert.fail('The child frame must use the validated host relay'); },
      onMessage: { addListener(callback) { listener = callback; } },
    } },
  };
  vm.runInNewContext(source, context);
  return { media, events, calls, opened, tick: () => interval?.(), advanceClock: ms => { clock += ms; },
    stop: (senderId = 'extension-id') => listener?.({ type: 'alpha-player-stop' }, { id: senderId }, () => {}) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('ordinary classroom tabs and unrelated embedded frames never request or control playback', async () => {
  for (const options of [{ embedded: false }, { ancestorOrigin: 'https://other.example' }]) {
    const h = setup(options);
    await settle();
    assert.equal(h.media.plays, 0); assert.equal(h.media.pauses, 0); assert.equal(h.calls.length, 0);
  }
});

test('only a matching active runner starts the real same-origin iframe video at normal speed', async () => {
  const h = setup({ iframe: true });
  await settle();
  assert.equal(h.media.plays, 1);
  assert.equal(h.media.muted, true);
  assert.equal(h.media.playbackRate, 1);
  await h.tick();
  assert.equal(h.media.plays, 1);
  assert.equal(h.calls.at(-1).kind, 'playing');
  assert.equal(h.calls[0].runId, null);
  assert.equal(h.calls.at(-1).runId, 'run-1');
});

test('a response for another lesson cannot start playback', async () => {
  const h = setup({ wrongLesson: true });
  await settle();
  assert.equal(h.media.plays, 0);
  assert.equal(h.media.pauses, 0);
});

test('stopping pauses only the controlled media and rejects a stale response from that run', async () => {
  const h = setup();
  await settle();
  h.stop();
  assert.equal(h.media.pauses, 1);
  await h.tick();
  assert.equal(h.media.plays, 1);
});

test('native video ended is reported immediately without seeking or writing progress', async () => {
  const h = setup();
  await settle();
  h.media.currentTime = 100;
  h.media.ended = true;
  await h.events.ended();
  assert.equal(h.calls.at(-1).kind, 'ended');
  assert.equal(h.calls.at(-1).currentTime, 100);
  assert.equal(h.media.plays, 1);
});

test('only the extension stop command pauses site autoplay before ownership, and only once', async () => {
  const h = setup({ active: false });
  await settle();
  h.stop('another-extension');
  assert.equal(h.media.pauses, 0);
  h.stop();
  assert.equal(h.media.pauses, 1);
  h.media.paused = false;
  await h.tick();
  assert.equal(h.media.pauses, 1);
});

test('assessment dialogs and autoplay denial are handed to the user', async () => {
  const withDialog = setup({ dialog: true });
  await settle();
  assert.equal(withDialog.calls[0].kind, 'attention');
  assert.equal(withDialog.media.plays, 0);
  const denied = setup({ failPlay: true });
  await settle();
  assert.equal(denied.media.plays, 1);
  assert.equal(denied.calls.at(-1).kind, 'attention');
  assert.match(denied.calls.at(-1).message, /자동 재생/);
});

test('a mounted Video.js player waits for its source without hanging play or reporting a missing video', async () => {
  const h = setup({ iframe: true, loading: true });
  await settle();
  assert.equal(h.media.plays, 0); assert.equal(h.calls.at(-1).kind, 'ready');
  h.media.currentSrc = 'https://cdn.example/lesson.m3u8'; h.media.readyState = 4;
  await h.tick();
  assert.equal(h.media.plays, 1); assert.equal(h.media.muted, true);
});

test('a video with no source distinguishes a file loading failure from an absent player', async () => {
  const h = setup({ iframe: true, loading: true });
  await settle(); h.advanceClock(35000); await h.tick();
  assert.equal(h.calls.at(-1).kind, 'attention');
  assert.match(h.calls.at(-1).message, /영상 파일을 불러오지 못했습니다/);
  assert.equal(h.media.plays, 0);
});

const webVideo = (overrides = {}) => ({ ready: true, tech: 'Youtube', source: true, readyState: 1, paused: true, ended: false,
  currentTime: 0, duration: 120, error: '', ...overrides });
const sent = player => player.commands.filter(command => command !== 'state');

test('a web video without a video element is muted and played through the site player', async () => {
  const player = sitePlayerDocument(webVideo());
  const h = setup({ playerDocument: player });
  await settle();
  assert.deepEqual(sent(player), ['mute', 'rate', 'play']);
  assert.equal(h.media.plays, 0, 'no element is touched');
  player.state.currentTime = 12;
  await h.tick();
  assert.equal(h.calls.at(-1).kind, 'playing');
  assert.equal(h.calls.at(-1).currentTime, 12);
  assert.equal(h.calls.at(-1).duration, 120);
  assert.equal(sent(player).filter(command => command === 'play').length, 1, 'a playing video is not restarted');
});

test('an unauthorized run never commands the site player', async () => {
  const player = sitePlayerDocument(webVideo());
  setup({ playerDocument: player, wrongLesson: true });
  await settle();
  assert.deepEqual(sent(player), []);
});

test('a site player that stays paused is asked to play a few times, then left alone', async () => {
  const player = sitePlayerDocument(webVideo(), { startsOnPlay: false });
  const h = setup({ playerDocument: player });
  await settle();
  for (let i = 0; i < 6; i++) await h.tick();
  assert.equal(sent(player).filter(command => command === 'play').length, 3);
  assert.equal(h.calls.at(-1).kind, 'paused');
});

test('site player end, error and stop are handled like a video element', async () => {
  const ended = sitePlayerDocument(webVideo());
  const h = setup({ playerDocument: ended });
  await settle();
  Object.assign(ended.state, { ended: true, paused: true, currentTime: 120 });
  await ended.emit('ended');
  await settle();
  assert.equal(h.calls.at(-1).kind, 'ended');
  assert.equal(h.calls.at(-1).currentTime, 120);

  const failed = sitePlayerDocument(webVideo({ error: '재생할 수 없는 영상입니다.' }));
  const f = setup({ playerDocument: failed });
  await settle();
  assert.equal(f.calls.at(-1).kind, 'attention');
  assert.match(f.calls.at(-1).message, /영상 재생에 오류가 발생했습니다\(재생할 수 없는 영상입니다\.\)/);
  assert.ok(!failed.commands.includes('play'));

  const stopped = sitePlayerDocument(webVideo());
  const s = setup({ playerDocument: stopped });
  await settle();
  s.stop();
  assert.equal(stopped.commands.at(-1), 'pause');
});

test('a site player that uses a video element stays on direct element control', async () => {
  const player = sitePlayerDocument(webVideo({ tech: 'Html5' }));
  const h = setup({ playerDocument: player });
  await settle();
  assert.deepEqual(sent(player), []);
  assert.equal(h.calls.at(-1).kind, 'ready');
});

test('a player frame blocked by the site service worker copy is reopened through the network once', async () => {
  const h = setup({ blockedFrame: true });
  await settle();
  assert.deepEqual(h.opened, [], 'a frame that may still be loading is left alone');
  assert.equal(h.media.plays, 0);
  h.advanceClock(2000);
  await h.tick();
  assert.deepEqual(h.opened, ['/catenoid.html?reload=1']);
  await h.tick();
  assert.equal(h.media.plays, 1);
  assert.equal(h.media.muted, true);
  await h.tick();
  assert.equal(h.opened.length, 1, 'the reopened frame is not reloaded again');
});

test('a player frame that opened normally is never reloaded', async () => {
  const h = setup({ iframe: true });
  await settle();
  h.advanceClock(10000);
  await h.tick(); await h.tick();
  assert.deepEqual(h.opened, []);
  assert.equal(h.media.plays, 1);
});

test('a classroom without any player reports what the hidden page contains', async () => {
  const h = setup({ emptyFrame: true });
  await settle(); h.advanceClock(35000); await h.tick();
  assert.equal(h.calls.at(-1).kind, 'attention');
  assert.match(h.calls.at(-1).message, /재생할 영상을 찾지 못했습니다/);
  assert.match(h.calls.at(-1).message, /진단: .*프레임 \/catenoid\.html\(플레이어 없음\)/);
  assert.ok(h.calls.at(-1).message.length <= 290);
});
