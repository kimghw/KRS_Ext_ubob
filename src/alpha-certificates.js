// 서버가 수료를 확인한 과정의 원본 PDF만 저장한다. 다운로드 완료는 Chrome 이력으로 확인한다.
var AlphaCertificates = (() => {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  const clone = value => structuredClone(value);
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const messageOf = error => String(error?.message || '수료증을 저장하지 못했습니다.')
    .replace(/data:[^\s]+/g, '[PDF 데이터]').slice(0, 400);

  function filenameFor(course, registrationId, attemptId) {
    const title = [...String(course.title || '교육').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')].slice(0, 80).join('') || '교육';
    return `알파 수료증/${title}_${registrationId.slice(-12)}_${attemptId}.pdf`;
  }
  function filenameRegex(filename) {
    const normalized = filename.replace(/\\/g, '/');
    return `(?:^|[/\\\\])${escapeRegex(normalized.slice(0, -4)).replace(/\//g, '[/\\\\]')}(?: \\(\\d+\\))?\\.pdf$`;
  }
  function pdfUrl(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > MAX_PDF_BYTES ||
        String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
      throw new Error('알파에서 정상 PDF 수료증을 받지 못했습니다. 강의실에서 수료증을 확인하세요.');
    }
    // 각 조각의 길이를 3의 배수로 유지하여 중간 base64 패딩이 생기지 않게 한다.
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 3 * 16384) {
      chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 3 * 16384))));
    }
    return `data:application/pdf;base64,${chunks.join('')}`;
  }

  function create({ catalog, api, provider, storage, downloads, runtimeId,
    now = Date.now, id = () => crypto.randomUUID() }) {
    let ledger = { busy: false, items: [] };
    const ready = storage.get('alphaCertificates').then(value => {
      if (Array.isArray(value?.alphaCertificates?.items)) {
        ledger = { busy: false, items: value.alphaCertificates.items.filter(item => item && typeof item === 'object') };
      }
    });
    let queue = Promise.resolve();
    const serialize = operation => {
      const task = queue.catch(() => {}).then(async () => { await ready; return operation(); });
      queue = task.catch(() => {});
      return task;
    };
    const save = () => storage.set({ alphaCertificates: clone(ledger) });
    const update = (record, fields) => Object.assign(record, fields, { updatedAt: now() });
    const hasAttempt = record => typeof record.filename === 'string' && !!record.attemptId && Number.isFinite(record.startedAt);
    const matches = (record, item) => item?.byExtensionId === runtimeId &&
      new RegExp(filenameRegex(record.filename)).test(item.filename || '') &&
      Number.isFinite(Date.parse(item.startTime)) && Date.parse(item.startTime) >= record.startedAt - 1000;

    function applyDownload(record, item) {
      if (item.state === 'complete') {
        update(record, { downloadId: item.id, stage: 'finished',
          status: item.exists === false ? 'missing' : 'complete',
          message: item.exists === false ? '저장했던 수료증 파일이 삭제되었습니다. 다시 저장할 수 있습니다.' : '수료증 PDF를 다운로드 폴더에 저장했습니다.' });
      } else if (item.state === 'interrupted') {
        update(record, { downloadId: item.id, stage: 'finished', status: 'interrupted',
          message: item.error === 'USER_CANCELED' ? '수료증 다운로드를 취소했습니다.'
            : '수료증 다운로드가 중단되었습니다. 다운로드 상태를 확인한 뒤 다시 저장하세요.' });
      } else if (item.state === 'in_progress') {
        update(record, { downloadId: item.id, stage: 'downloading', status: 'downloading',
          message: item.paused ? '수료증 다운로드가 일시 중지되어 있습니다. Chrome 다운로드에서 확인하세요.' : '수료증 PDF를 다운로드하고 있습니다.' });
      } else {
        update(record, { status: 'unconfirmed', message: '수료증 다운로드 상태를 확인하지 못했습니다. Chrome 다운로드를 확인하세요.' });
      }
    }

    // 다운로드 시작과 ID 저장은 하나의 원자적 작업이 아니다. 이름·확장 ID로 복구하고 불확실하면 재시작하지 않는다.
    async function reconcileRecord(record) {
      if (!hasAttempt(record)) {
        if (record.status === 'preparing') update(record, { status: 'failed', stage: 'finished',
          message: '수료증 준비가 중단되었습니다. 다시 저장하면 원본 PDF부터 확인합니다.' });
        return true;
      }
      try {
        let items;
        if (Number.isInteger(record.downloadId)) {
          items = await downloads.search({ id: record.downloadId });
          items = items.filter(item => item.byExtensionId === runtimeId);
        } else {
          items = await downloads.search({ filenameRegex: filenameRegex(record.filename),
            startedAfter: new Date(record.startedAt - 1000).toISOString(), limit: 0 });
          items = items.filter(item => matches(record, item));
        }
        if (items.length) {
          const item = items.find(item => item.state === 'complete' && item.exists !== false) ||
            items.find(item => item.state === 'in_progress') || items[0];
          applyDownload(record, item);
        } else if (!['complete', 'missing', 'failed', 'interrupted'].includes(record.status)) {
          update(record, { status: 'unconfirmed', message: '이전 수료증 다운로드 결과가 불확실합니다. Chrome 다운로드를 확인한 뒤 필요하면 다시 저장하세요.' });
        }
        return true;
      } catch {
        if (record.status !== 'complete') update(record, { status: 'unconfirmed',
          message: 'Chrome 다운로드 이력을 확인하지 못했습니다. 잠시 후 다시 확인하세요.' });
        return false;
      }
    }

    async function reconcileAll() {
      for (const record of ledger.items) await reconcileRecord(record);
      ledger.busy = false;
      await save();
      return clone(ledger);
    }

    function ensure({ course, registrationId, loginId, completed, shouldStop = () => false, retry = false }) {
      const known = catalog.courses.find(item => item.id === course?.id);
      if (!known || known.sequenceId !== course.sequenceId || known.url !== course.url || !UUID.test(registrationId) ||
          typeof loginId !== 'string' || !loginId.trim() || completed !== true || typeof shouldStop !== 'function' || typeof retry !== 'boolean') {
        return Promise.reject(new Error('수료증을 저장할 과정·계정·수료 상태를 확인하지 못했습니다.'));
      }
      return saveCertificate({ known, registrationId, loginId, shouldStop, retry });
    }

    // 전체 받기는 공식 수료 내역에서 조회한 과정도 허용한다. 발급 직전 provider가
    // 등록 ID·과정·차수·계정·수료 상태를 서버에서 다시 검증하므로 목록만으로 발급하지 않는다.
    function ensureListed({ course, registrationId, loginId, shouldStop = () => false, retry = true }) {
      const type = String(course?.type ?? '');
      if (!UUID.test(course?.id) || !UUID.test(course?.sequenceId) || !UUID.test(registrationId) ||
          !/^[1-5]$/.test(type) || typeof course?.title !== 'string' || !course.title.trim() || course.title.length > 1000 ||
          typeof loginId !== 'string' || !loginId.trim() || typeof shouldStop !== 'function' || typeof retry !== 'boolean') {
        return Promise.reject(new Error('전체 수료증 목록의 과정 또는 계정 정보를 확인하지 못했습니다.'));
      }
      const known = { id: course.id, sequenceId: course.sequenceId, title: course.title.trim(), type,
        url: `${catalog.BASE_URL}/explore/${course.id}?sequenceId=${course.sequenceId}&tab=ALL` };
      return saveCertificate({ known, registrationId, loginId, shouldStop, retry });
    }

    function saveCertificate({ known, registrationId, loginId, shouldStop, retry }) {
      return serialize(async () => {
        let record = ledger.items.find(item => item.loginId === loginId && item.registrationId === registrationId);
        if (record) {
          const checked = await reconcileRecord(record);
          await save();
          if (!checked || ['complete', 'downloading'].includes(record.status) || !retry) return clone(record);
        } else {
          record = { loginId, registrationId, courseId: known.id, title: known.title,
            status: 'preparing', filename: '', message: '', updatedAt: now() };
          ledger.items.push(record);
        }
        let invoked = false;
        try {
          update(record, { status: 'preparing', stage: 'fetching', message: '알파 원본 수료증 PDF를 준비합니다.',
            filename: '', downloadId: undefined, attemptId: undefined, startedAt: undefined });
          ledger.busy = true;
          await save();
          const checkStopped = () => {
            if (shouldStop()) throw new Error('수료증 저장을 중지했습니다.');
          };
          const checkAccount = async () => {
            const session = await api.session();
            if (!session?.authenticated || session.loginId !== loginId) throw new Error('알파 로그인 계정이 바뀌거나 만료되어 수료증 저장을 중지했습니다.');
          };
          checkStopped();
          await checkAccount();
          checkStopped();
          const bytes = await provider.fetchPdf({ course: known, registrationId, loginId, shouldStop });
          checkStopped();
          const url = pdfUrl(bytes);
          await checkAccount();
          checkStopped();
          const attemptId = String(id()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
          if (!attemptId) throw new Error('수료증 다운로드 식별자를 만들지 못했습니다.');
          update(record, { stage: 'starting', attemptId, startedAt: now(), filename: filenameFor(known, registrationId, attemptId) });
          await save();
          checkStopped();
          invoked = true;
          const downloadId = await downloads.download({ url, filename: record.filename, saveAs: false, conflictAction: 'uniquify' });
          if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error('Chrome에서 수료증 다운로드를 시작하지 못했습니다.');
          update(record, { downloadId, status: 'downloading', stage: 'downloading', message: '수료증 PDF를 다운로드하고 있습니다.' });
          await save();
          // 아주 작은 PDF는 download()가 반환되기 전에 완료 이벤트가 발생할 수 있다.
          await reconcileRecord(record);
        } catch (error) {
          if (invoked && hasAttempt(record)) {
            const checked = await reconcileRecord(record);
            if (checked && !['complete', 'downloading', 'interrupted', 'missing'].includes(record.status)) {
              update(record, { status: 'failed', message: messageOf(error) });
            }
          } else update(record, { status: 'failed', stage: 'finished', message: messageOf(error) });
        } finally {
          ledger.busy = false;
          await save().catch(() => {});
        }
        return clone(record);
      }).catch(() => ({ loginId, registrationId, courseId: known.id, title: known.title,
        status: 'failed', filename: '', updatedAt: now(),
        message: '수료증 저장 기록을 읽거나 저장하지 못했습니다. 확장 프로그램을 다시 확인하세요.' }));
    }

    function onChanged(delta) {
      return serialize(async () => {
        if (!Number.isInteger(delta?.id)) return;
        for (const record of ledger.items) {
          if (record.downloadId === delta.id || (!Number.isInteger(record.downloadId) && hasAttempt(record))) {
            await reconcileRecord(record);
          }
        }
        await save();
      });
    }
    return { ensure, ensureListed, reconcile: () => serialize(reconcileAll), onChanged };
  }
  return { create };
})();
if (typeof globalThis !== 'undefined') globalThis.AlphaCertificates = AlphaCertificates;
if (typeof module !== 'undefined' && module.exports) module.exports = AlphaCertificates;
