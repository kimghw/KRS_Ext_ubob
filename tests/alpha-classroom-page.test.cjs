const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/alpha-classroom-page.js'), 'utf8');

function setup({ ancestors = ['chrome-extension://extension-id'], framed = true, pathname = '/my/classRoom/classRoomDetail' } = {}) {
  const attributes = {};
  let listener;
  const parent = {};
  const window = {};
  window.top = framed ? parent : window;
  window.parent = framed ? parent : window;
  const document = {
    documentElement: { setAttribute(name, value) { attributes[name] = value; } },
    addEventListener(type, callback) { if (type === 'alpha-auto-classroom-command') listener = callback; },
  };
  vm.runInNewContext(source, { window, document, Set, Number, Math, JSON, String,
    location: { origin: 'https://alpha-campus.kr', pathname, ancestorOrigins: ancestors } });
  const ask = () => { listener?.({}); const value = attributes['data-alpha-auto-classroom']; return value ? JSON.parse(value) : null; };
  return { window, ask, active: !!listener };
}

test('the classroom script answers only inside the hidden extension player', () => {
  for (const options of [{ framed: false, ancestors: [] }, { ancestors: ['https://other.example'] },
    { ancestors: ['https://alpha-campus.kr', 'chrome-extension://extension-id'] }, { pathname: '/my/classRoom' }]) {
    assert.equal(setup(options).active, false);
  }
  assert.equal(setup().active, true);
});

test('watched seconds are reported as segments without changing them', () => {
  const h = setup();
  assert.deepEqual(h.ask(), { ready: false }, 'the site has not prepared its record yet');
  const seconds = new Set([21, 19, 20, 0, 1, 2, 688, 5, 5.5, -1, 'x']);
  h.window.currentWatchedSeconds = seconds;
  assert.deepEqual(h.ask(), { ready: true, count: 8, segments: '0[.]3[,]5[.]6[,]19[.]22[,]688[.]689' });
  assert.equal(seconds.size, 11, 'the site record is only read');
  h.window.currentWatchedSeconds = new Set();
  assert.deepEqual(h.ask(), { ready: true, count: 0, segments: '' });
  h.window.currentWatchedSeconds = [1, 2, 3];
  assert.deepEqual(h.ask(), { ready: false }, 'an unexpected shape is not trusted');
});
