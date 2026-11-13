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
  blockedFrame = false, embed = false, watched = null } = {}) {
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
  // embed: 저작도구 차시의 플레이어 프레임. 출처가 달라 문서에는 닿지 못하고 메시지만 주고받는다.
  const embedCommands = [], embedStarts = [];
  const embedWindow = { postMessage(message, targetOrigin) {
    assert.equal(targetOrigin, 'https://make.alpha-campus.kr');
    assert.equal(message.tag, 'alpha-embed-player'); assert.equal(message.type, 'command');
    embedCommands.push(message.command);
    if (message.command === 'play') embedStarts.push(message.from);
  } };
  const embedFrame = { contentDocument: null, contentWindow: embedWindow,
    getAttribute(name) { return name === 'src' ? 'https://make.alpha-campus.kr/bubble/embed/281' : null; },
    get src() { return this.getAttribute('src'); } };
  // watched: 강의실 페이지 영역(alpha-classroom-page.js)이 알려 주는 "이미 본 구간". null이면 그 스크립트가 없는 화면이다.
  const classroom = { segments: watched };
  const rootAttributes = {};
  const document = {
    ...(watched === null ? {} : {
      documentElement: {
        removeAttribute(name) { delete rootAttributes[name]; },
        getAttribute(name) { return rootAttributes[name] ?? null; },
      },
      dispatchEvent(event) {
        if (event.type !== 'alpha-auto-classroom-command') return;
        rootAttributes['data-alpha-auto-classroom'] = JSON.stringify(classroom.segments === null
          ? { ready: false } : { ready: true, segments: classroom.segments });
      },
    }),
    querySelectorAll(selector) {
      if (selector === 'video, audio') return framed || embed ? [] : [media];
      if (selector === 'iframe') return embed ? [embedFrame] : framed ? [frame] : [];
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
  const embedPlayer = { commands: embedCommands, starts: embedStarts,
    send: (data, source = embedWindow, origin = 'https://make.alpha-campus.kr') => windowEvents.message({ source, origin, data }) };
  return { media, events, calls, opened, classroom, embed: embedPlayer, tick: () => interval?.(), advanceClock: ms => { clock += ms; },
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

// 저작도구 차시(유형 15): 다른 출처의 플레이어 프레임이 알려 주는 상태로 재생을 제어한다.
const embedState = (overrides = {}) => ({ tag: 'alpha-embed-player', type: 'state', ready: true, source: true, readyState: 4,
  paused: true, ended: false, currentTime: 0, duration: 1774, error: '', ...overrides });

test('an authoring-tool lesson waits for the site progress tracker, then is muted and played through its frame', async () => {
  const h = setup({ embed: true });
  await settle();
  assert.deepEqual(h.embed.commands, [], 'nothing is commanded before the frame answers');
  assert.equal(h.calls.at(-1).kind, 'ready');
  h.embed.send(embedState());
  await h.tick();
  assert.deepEqual(h.embed.commands, [], 'playing before tracking is connected would not be recorded by the site');
  h.embed.send({ type: 'loadedState', state: {} });
  await h.tick();
  assert.deepEqual(h.embed.commands, ['mute', 'rate', 'play']);
  assert.equal(h.media.plays, 0, 'no classroom element is touched');
  h.embed.send(embedState({ paused: false, currentTime: 12 }));
  await h.tick();
  assert.equal(h.calls.at(-1).kind, 'playing');
  assert.equal(h.calls.at(-1).currentTime, 12); assert.equal(h.calls.at(-1).duration, 1774);
  assert.equal(h.embed.commands.filter(command => command === 'play').length, 1, 'a playing video is not restarted');
});

test('an authoring-tool lesson reports its end at once, and stop pauses it', async () => {
  const h = setup({ embed: true });
  await settle();
  h.embed.send({ type: 'loadedState', state: {} });
  h.embed.send(embedState());
  await h.tick();
  h.embed.send(embedState({ paused: false, currentTime: 5 }));
  await h.tick();
  const before = h.calls.length;
  h.embed.send(embedState({ paused: true, ended: true, currentTime: 1774 }));
  await settle();
  assert.ok(h.calls.length > before, 'the end does not wait for the next check');
  assert.equal(h.calls.at(-1).kind, 'ended'); assert.equal(h.calls.at(-1).currentTime, 1774);
  h.stop();
  assert.equal(h.embed.commands.at(-1), 'pause');
});

test('an authoring-tool frame that stays paused is asked to play a few times, and its error is handed over', async () => {
  const h = setup({ embed: true });
  await settle();
  h.embed.send({ type: 'loadedState', state: {} });
  h.embed.send(embedState());
  for (let i = 0; i < 6; i++) await h.tick();
  assert.equal(h.embed.commands.filter(command => command === 'play').length, 3);
  h.embed.send(embedState({ error: '자동 재생이 허용되지 않았습니다' }));
  await settle();
  assert.equal(h.calls.at(-1).kind, 'attention');
  assert.match(h.calls.at(-1).message, /자동 재생이 허용되지 않았습니다/);
});

test('messages that do not come from the lesson frame, and an unauthorized run, never control it', async () => {
  const h = setup({ embed: true });
  await settle();
  // 같은 출처라도 강의실에 없는 창에서 온 메시지와, 다른 출처에서 온 메시지는 무시한다.
  h.embed.send({ type: 'loadedState', state: {} }, { postMessage() {} });
  h.embed.send(embedState(), { postMessage() {} });
  h.embed.send({ type: 'loadedState', state: {} }, undefined, 'https://other.example');
  await h.tick();
  assert.deepEqual(h.embed.commands, []);
  assert.equal(h.calls.at(-1).kind, 'ready');

  const other = setup({ embed: true, wrongLesson: true });
  await settle();
  other.embed.send({ type: 'loadedState', state: {} });
  other.embed.send(embedState());
  await other.tick();
  assert.deepEqual(other.embed.commands, []);
});

test('an authoring-tool frame that never becomes ready is reported with what was seen', async () => {
  const h = setup({ embed: true });
  await settle();
  h.embed.send(embedState());
  h.advanceClock(51000);
  await h.tick();
  assert.equal(h.calls.at(-1).kind, 'attention');
  assert.match(h.calls.at(-1).message, /저작도구 플레이어가 준비되지 않았습니다/);
  assert.match(h.calls.at(-1).message, /응답 있음, 진도 추적 대기/);
});

test('an authoring-tool lesson starts from the first part the site has not recorded as watched', async () => {
  // 실제 사례(2026-11-13): 사이트는 17분 28초에서 이어 재생했지만 앞부분은 본 기록이 없어 끝까지 봐도 완료되지 않는다.
  for (const [watched, from] of [['', 0], ['1048[.]1300.5', 0], ['0[.]500.2[,]499[.]900.7', 900], ['900[.]1774.4[,]0[.]901', null],
    ['0[.]1773', null], ['깨진 값', 0]]) {
    const h = setup({ embed: true });
    await settle();
    h.embed.send({ type: 'loadedState', state: { played_segments: watched } });
    h.embed.send(embedState({ duration: 1774.4 }));
    await h.tick();
    assert.deepEqual(h.embed.starts, [from], watched);
  }
});

// 영상 차시: 사이트는 실제로 본 초의 수로 진도를 계산한다. 안 본 구간이 남아 있으면 그 지점으로 되돌아가 본다.
// 실제 영상처럼, 끝난 뒤 앞으로 옮기면 끝난 상태가 풀리도록 흉내 낸다.
function seekable(media) {
  let position = media.currentTime;
  Object.defineProperty(media, 'currentTime', { get: () => position, set(value) { position = value; media.ended = false; } });
  return media;
}

test('playback that resumed past a part the site has not recorded goes back to it once', async () => {
  // 실제 사례(2026-11-14): 25초에서 갑자기 끊긴 강의를 사이트가 19초부터 이어 재생해, 앞부분이 빈 채 97%로 끝났다.
  const h = setup({ watched: '' });
  h.media.duration = 689;
  await settle();
  assert.equal(h.media.plays, 1);
  h.media.currentTime = 24; h.classroom.segments = '19[.]25';
  await h.tick();
  assert.equal(h.media.currentTime, 0, 'the unwatched beginning is played');
  assert.equal(h.calls.at(-1).kind, 'playing');
  h.media.currentTime = 6; h.classroom.segments = '0[.]7[,]19[.]25';
  await h.tick();
  assert.equal(h.media.currentTime, 6, 'playback before the next gap is left alone');
});

test('a new lesson, a normal resume and a screen without the classroom script are never moved', async () => {
  for (const [watched, position] of [['0[.]5', 5], ['0[.]3[,]4[.]6', 6], ['0[.]503', 503], ['', 1.5], [null, 300]]) {
    const h = setup({ watched });
    h.media.duration = 689;
    await settle();
    h.media.currentTime = position;
    await h.tick();
    assert.equal(h.media.currentTime, position, String(watched));
    assert.equal(h.calls.at(-1).kind, 'playing');
  }
});

test('an end that leaves an unwatched part goes back to it instead of reporting the end', async () => {
  const h = setup({ watched: '19[.]689' });
  seekable(h.media).duration = 689;
  await settle();
  h.media.currentTime = 20;
  await h.tick();
  assert.equal(h.media.currentTime, 0, 'first return');
  // 사이트가 다시 끝 위치로 옮겨 곧바로 끝난 경우에도 한 번 더 돌아간다.
  Object.assign(h.media, { paused: true, ended: true }); h.media.currentTime = 689; h.media.ended = true;
  await h.events.ended();
  await settle();
  assert.equal(h.media.currentTime, 0, 'second return');
  assert.equal(h.media.plays, 2, 'playback is started again after the return');
  assert.notEqual(h.calls.at(-1).kind, 'ended');
  // 두 번 돌아가도 남으면 되풀이하지 않고 종료를 알린다(실행 쪽이 사이트 진도를 확인한다).
  Object.assign(h.media, { paused: true }); h.media.currentTime = 689; h.media.ended = true;
  await h.events.ended();
  await settle();
  assert.equal(h.media.currentTime, 689);
  assert.equal(h.calls.at(-1).kind, 'ended');
});

test('a fully watched lesson ends normally', async () => {
  const h = setup({ watched: '0[.]688' });
  seekable(h.media).duration = 689.4;
  await settle();
  Object.assign(h.media, { paused: true }); h.media.currentTime = 689.4; h.media.ended = true;
  await h.events.ended();
  await settle();
  assert.equal(h.media.currentTime, 689.4);
  assert.equal(h.calls.at(-1).kind, 'ended');
});
