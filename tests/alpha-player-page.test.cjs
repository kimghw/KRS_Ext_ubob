const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/alpha-player-page.js'), 'utf8');
const ORIGIN = 'https://alpha-campus.kr';

function setup({ ancestors = [ORIGIN, 'chrome-extension://extension-id'], pathname = '/catenoid.html', player = undefined } = {}) {
  const listeners = {}, attributes = {}, events = [], handlers = {};
  const calls = [];
  const sitePlayer = player === null ? null : {
    techName_: 'Youtube', isPaused: true, isEnded: false, time: 3, length: 60, failure: null,
    paused() { return this.isPaused; }, ended() { return this.isEnded; },
    currentTime() { return this.time; }, duration() { return this.length; }, readyState() { return 1; },
    currentSrc() { return 'https://www.youtube.com/watch?v=abc'; }, error() { return this.failure; },
    muted(value) { calls.push(`muted:${value}`); }, playbackRate(value) { calls.push(`rate:${value}`); },
    play() { calls.push('play'); this.isPaused = false; }, pause() { calls.push('pause'); this.isPaused = true; },
    on(type, callback) { handlers[type] = callback; },
    ...player,
  };
  const document = {
    documentElement: { setAttribute(name, value) { attributes[name] = value; } },
    addEventListener(type, callback) { listeners[type] = callback; },
    dispatchEvent(event) { events.push(event); },
  };
  const window = { lxPlayer: sitePlayer ? { player: sitePlayer } : {} };
  vm.runInNewContext(source, { window, document, CustomEvent, WeakSet, JSON, String, Number,
    location: { origin: ORIGIN, pathname, ancestorOrigins: ancestors } });
  const ask = command => {
    listeners['alpha-auto-player-command']({ detail: command });
    return JSON.parse(attributes['data-alpha-auto-player']);
  };
  return { ask, calls, events, handlers, listeners, sitePlayer };
}

test('the page bridge stays inert outside the hidden extension player', () => {
  for (const options of [{ ancestors: [] }, { ancestors: [ORIGIN] }, { ancestors: [ORIGIN, 'https://other.example'] },
    { ancestors: ['https://other.example', 'chrome-extension://extension-id'] }, { pathname: '/my/classRoom/classRoomDetail' }]) {
    assert.deepEqual(Object.keys(setup(options).listeners), []);
  }
});

test('state is reported without changing playback', () => {
  const h = setup();
  assert.deepEqual(h.ask('state'), { ready: true, tech: 'Youtube', source: true, readyState: 1, paused: true, ended: false,
    currentTime: 3, duration: 60, error: '' });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(setup({ player: null }).ask('play'), { ready: false });
});

test('commands only mute, reset the speed, play and pause the site player', () => {
  const h = setup();
  h.ask('mute'); h.ask('rate');
  assert.equal(h.ask('play').paused, false);
  assert.equal(h.ask('pause').paused, true);
  h.ask('seek'); h.ask({ type: 'play' });
  assert.deepEqual(h.calls, ['muted:true', 'rate:1', 'play', 'pause']);
});

test('end and error are announced, and player failures are contained', () => {
  const h = setup();
  h.ask('state');
  h.handlers.ended();
  assert.equal(h.events.at(-1).type, 'alpha-auto-player-event');
  assert.equal(h.events.at(-1).detail, 'ended');
  h.sitePlayer.failure = { code: 1150, message: '재생할 수 없는 영상입니다.' };
  assert.equal(h.ask('state').error, '재생할 수 없는 영상입니다.');

  const broken = setup({ player: { currentTime() { throw new Error('not ready'); }, play() { return Promise.reject(new Error('blocked')); } } });
  assert.equal(broken.ask('play').currentTime, 0);
});
