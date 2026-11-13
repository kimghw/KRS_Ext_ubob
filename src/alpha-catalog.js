// 첨부 교육 안내의 알파캠퍼스 과정만 수록한다. 과정명/회차 링크는 원문 그대로 유지한다.
// popup, service worker(importScripts), content script에서 같은 선택 규칙을 사용한다.
var AlphaCatalog = (() => {
  'use strict';

  const BASE_URL = 'https://alpha-campus.kr';
  const source = '붙임1. 온라인 교육 링크 및 이수 현황표 양식(연구책임자 및 연구자).xlsx';
  const roles = [
    { id: 'principal', label: '연구책임자' },
    { id: 'researcher', label: '참여연구원' },
  ];
  const categories = [
    { id: 'funds', label: '연구비 집행', description: '알파캠퍼스의 본 과정 1개' },
    { id: 'ethics', label: '연구윤리', description: '본인 역할에 맞는 과정 1개' },
    { id: 'security', label: '보안관리', description: '본인 역할에 맞는 과정 1개' },
    { id: 'performance', label: '성과관리', description: '필수 1개' },
    { id: 'other', label: '기타', description: '필수 1개' },
  ];
  const commonRoles = ['principal', 'researcher'];
  const standardCompletion = '진도율 90% 이상 + 설문';
  const courses = [
    {
      id: 'b01f4226-8e02-45e4-b18e-705431e24628',
      sequenceId: '355065ce-0cd9-4bd7-964d-65d2eb18e0cf',
      categoryId: 'funds', title: '연구협약 및 연구개발비 관리', roles: [...commonRoles],
      duration: '2시간 (5차시)', completion: standardCompletion,
      note: '같은 이름의 [시각/청각장애지원] 과정(1시간)이 아닌 본 과정으로 수강',
      alternatives: [], sourceRef: '교육 안내!A5:H5',
    },
    {
      id: '2f25a31a-b196-41cc-b81e-9c2f3ecf3b94',
      sequenceId: '795f5f05-b24f-4a0f-a354-45671d8cf6cc',
      categoryId: 'ethics', title: '연구책임자를 위한 연구윤리(이공계)', roles: ['principal'],
      duration: '2시간 (5차시)', completion: standardCompletion,
      note: '연구책임자용. 부실학술활동 근절 차시 포함',
      alternatives: [], sourceRef: '교육 안내!A7:H7',
    },
    {
      id: '405bed02-408d-4a1d-a046-44b3aad8240d',
      sequenceId: 'ffb2dc14-4695-43d4-86eb-8db5bd693f12',
      categoryId: 'ethics', title: '참여연구원을 위한 연구윤리(이공계)', roles: ['researcher'],
      duration: '2시간 (5차시)', completion: standardCompletion,
      note: '참여연구원용', alternatives: ['사례로 배우는 연구부정행위(2시간)'],
      sourceRef: '교육 안내!A8:H8',
    },
    {
      id: 'd6d248a5-eee9-47a3-8277-e037882abf78',
      sequenceId: '9ce6c53d-0f9a-4292-bac5-51e30f712342',
      categoryId: 'security', title: '연구책임자를 위한 연구보안(연구보안 리더십과 책임)', roles: ['principal'],
      duration: '2시간 (6차시)', completion: standardCompletion,
      note: '연구책임자용', alternatives: [], sourceRef: '교육 안내!A9:H9',
    },
    {
      id: 'a23f7104-88e3-48f0-b395-23dae74b281d',
      sequenceId: '89fcd977-f986-4714-a271-5357f1f1953f',
      categoryId: 'security', title: '참여연구원을 위한 연구보안(안전한 연구환경 만들기)', roles: ['researcher'],
      duration: '2시간 (6차시)', completion: standardCompletion,
      note: '참여연구원용', alternatives: [], sourceRef: '교육 안내!A10:H10',
    },
    {
      id: '1b87008d-37ba-4d01-8be8-c71e4b3a623c',
      sequenceId: '43568cea-c519-4baf-b477-5491ab38f035',
      categoryId: 'performance', title: '국가연구개발사업 성과관리활용 실무', roles: [...commonRoles],
      duration: '3시간 (12차시)', completion: standardCompletion,
      note: '',
      alternatives: ['기술마케팅의 이해(2시간)', 'R&D 성과확산(2시간)', '연구자를 위한 특허명세서 이해(3시간)'],
      sourceRef: '교육 안내!A11:H11',
    },
    {
      id: '1bdbcff0-f32d-42d3-affc-8247b9f40a76',
      sequenceId: '9fef22c9-da28-48c3-959d-05e0fa13f8c8',
      categoryId: 'other', title: '연구실안전-안전관리 기본', roles: [...commonRoles],
      duration: '2시간 (3차시)', completion: '진도율 100% + 시험 60점 이상 + 설문',
      note: '',
      alternatives: ['연구노트(1시간)', '원병묵 교수의 논문 작성 매뉴얼(2시간)', '연구데이터분석-기초통계의 이해(2시간)'],
      sourceRef: '교육 안내!A12:H12',
    },
  ].map(course => ({
    ...course,
    url: `${BASE_URL}/explore/${course.id}?sequenceId=${course.sequenceId}&tab=ALL`,
  }));

  function defaultsForRole(role) {
    if (!roles.some(item => item.id === role)) return [];
    return categories.map(category => courses.find(course =>
      course.categoryId === category.id && course.roles.includes(role)).id);
  }

  // 5개 분야에 하나씩 선택되어야 한다. 개수만 맞거나 다른 역할의 과정이 포함되면 거절한다.
  function validateSelection(role, ids) {
    const errors = [];
    const selected = [];
    if (!roles.some(item => item.id === role)) errors.push('연구책임자 또는 참여연구원을 선택하세요.');
    if (!Array.isArray(ids)) return { ok: false, errors: [...errors, '신청할 과정 목록을 확인하세요.'], courses: [] };
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        errors.push('같은 과정을 두 번 선택할 수 없습니다.');
        continue;
      }
      seen.add(id);
      const course = courses.find(item => item.id === id);
      if (!course) {
        errors.push('첨부 목록의 알파캠퍼스 과정만 신청할 수 있습니다.');
        continue;
      }
      selected.push(course);
      if (!course.roles.includes(role)) errors.push(`${course.title}: 선택한 역할에 맞지 않는 과정입니다.`);
    }
    for (const category of categories) {
      const count = selected.filter(course => course.categoryId === category.id).length;
      if (count !== 1) errors.push(`${category.label}: 분야별 1개 과정을 선택하세요.`);
    }
    return { ok: errors.length === 0, errors: [...new Set(errors)], courses: selected };
  }

  // 이미 신청한 과정의 학습은 1개 이상만 선택해도 된다. 신청의 5분야 규칙은 그대로 둔다.
  function validateLearningSelection(role, ids) {
    const errors = [];
    const selected = [];
    if (!roles.some(item => item.id === role)) errors.push('연구책임자 또는 참여연구원을 선택하세요.');
    if (!Array.isArray(ids)) return { ok: false, errors: [...errors, '학습할 과정 목록을 확인하세요.'], courses: [] };
    if (ids.length === 0) errors.push('학습할 과정을 1개 이상 선택하세요.');
    const seen = new Set();
    const seenCategories = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        errors.push('같은 과정을 두 번 선택할 수 없습니다.');
        continue;
      }
      seen.add(id);
      const course = courses.find(item => item.id === id);
      if (!course) {
        errors.push('첨부 목록의 알파캠퍼스 과정만 학습할 수 있습니다.');
        continue;
      }
      selected.push(course);
      if (!course.roles.includes(role)) errors.push(`${course.title}: 선택한 역할에 맞지 않는 과정입니다.`);
      if (seenCategories.has(course.categoryId)) {
        const category = categories.find(item => item.id === course.categoryId);
        errors.push(`${category.label}: 분야별 1개 과정만 선택하세요.`);
      }
      seenCategories.add(course.categoryId);
    }
    return { ok: errors.length === 0, errors: [...new Set(errors)], courses: selected };
  }

  return {
    BASE_URL, source, roles, categories, courses,
    deadline: '2026-12-18', completionYear: 2026, affiliation: '한국선급',
    defaultsForRole, validateSelection, validateLearningSelection,
  };
})();

globalThis.AlphaCatalog = AlphaCatalog;
if (typeof module !== 'undefined' && module.exports) module.exports = AlphaCatalog;
