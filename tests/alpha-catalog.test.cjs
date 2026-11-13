const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/alpha-catalog.js');

test('each role selects exactly one appropriate Alpha course in all five categories', () => {
  for (const role of ['principal', 'researcher']) {
    const ids = catalog.defaultsForRole(role);
    const result = catalog.validateSelection(role, ids);
    assert.equal(result.ok, true);
    assert.equal(ids.length, 5);
    assert.deepEqual(result.courses.map(course => course.categoryId), ['funds', 'ethics', 'security', 'performance', 'other']);
    const roleLabel = role === 'principal' ? '연구책임자' : '참여연구원';
    for (const course of result.courses.filter(course => ['ethics', 'security'].includes(course.categoryId))) {
      assert.ok(course.title.startsWith(roleLabel));
    }
  }
});

test('switching roles changes only ethics and security', () => {
  const a = catalog.defaultsForRole('principal');
  const b = catalog.defaultsForRole('researcher');
  assert.deepEqual(a.map((id, index) => id === b[index]), [true, false, false, true, true]);
  assert.equal(catalog.validateSelection('researcher', a).ok, false);
  assert.equal(catalog.validateSelection('principal', b).ok, false);
});

test('missing categories, duplicate courses, duplicate categories and unknown IDs are rejected', () => {
  const ids = catalog.defaultsForRole('researcher');
  assert.equal(catalog.validateSelection('researcher', ids.slice(0, 4)).ok, false);
  assert.equal(catalog.validateSelection('researcher', [...ids, ids[0]]).ok, false);
  const principalEthics = catalog.courses.find(course => course.categoryId === 'ethics' && course.roles.includes('principal'));
  const sameCountWrongCategory = [...ids.slice(0, 4), principalEthics.id];
  const result = catalog.validateSelection('researcher', sameCountWrongCategory);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.startsWith('연구윤리:')));
  assert.ok(result.errors.some(error => error.startsWith('기타:')));
  assert.equal(catalog.validateSelection('researcher', [...ids.slice(0, 4), 'external-course']).ok, false);
});

test('malformed role and selection inputs fail closed', () => {
  assert.deepEqual(catalog.defaultsForRole('unknown'), []);
  assert.equal(catalog.validateSelection('unknown', catalog.defaultsForRole('researcher')).ok, false);
  for (const value of [null, undefined, 'course-id', {}]) {
    assert.equal(catalog.validateSelection('researcher', value).ok, false);
  }
});

test('all enrollment URLs are exact Alpha course links with a workbook sequence', () => {
  assert.equal(catalog.courses.length, 7);
  for (const course of catalog.courses) {
    const url = new URL(course.url);
    assert.equal(url.origin, 'https://alpha-campus.kr');
    assert.equal(url.pathname, `/explore/${course.id}`);
    assert.equal(url.searchParams.get('sequenceId'), course.sequenceId);
    assert.equal(url.searchParams.get('tab'), 'ALL');
  }
  const funds = catalog.courses.find(course => course.categoryId === 'funds');
  assert.equal(funds.id, 'b01f4226-8e02-45e4-b18e-705431e24628');
  assert.equal(funds.duration, '2시간 (5차시)');
});

test('learning accepts a nonempty role-matching subset while enrollment still needs five categories', () => {
  for (const role of ['principal', 'researcher']) {
    const ids = catalog.defaultsForRole(role);
    for (const subset of [[ids[1]], [ids[4], ids[0]], ids]) {
      const result = catalog.validateLearningSelection(role, subset);
      assert.equal(result.ok, true);
      assert.deepEqual(result.courses.map(course => course.id), subset);
    }
    assert.equal(catalog.validateSelection(role, [ids[1]]).ok, false);
    assert.equal(catalog.validateSelection(role, [ids[4], ids[0]]).ok, false);
  }
});

test('learning rejects empty, malformed, unknown, repeated and wrong-role selections', () => {
  const ids = catalog.defaultsForRole('researcher');
  for (const invalid of [[], null, undefined, {}, 'course-id', ['unknown-course'], [ids[0], ids[0]]]) {
    assert.equal(catalog.validateLearningSelection('researcher', invalid).ok, false);
  }
  assert.equal(catalog.validateLearningSelection('unknown-role', [ids[0]]).ok, false);
  const principalEthics = catalog.defaultsForRole('principal')[1];
  const mixed = catalog.validateLearningSelection('researcher', [ids[1], principalEthics]);
  assert.equal(mixed.ok, false);
  assert.ok(mixed.errors.some(message => message.includes('역할')));
  assert.ok(mixed.errors.some(message => message.startsWith('연구윤리:')));
  assert.equal(catalog.validateLearningSelection('principal', [ids[1]]).ok, false);
});
