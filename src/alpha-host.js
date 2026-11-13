// 한 offscreen 문서를 공유하되 각 사이트의 iframe 소유권과 수명을 분리한다.
function alphaHostDeadline(promise, timeoutMs, message) {
  let timer;
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

var SharedOffscreen = (() => {
  function create({ runtime, offscreen, storage, hostPath = 'src/runner.html?host=offscreen',
    timeoutMs = 10000, messageTimeoutMs = 1500 }) {
    const hostUrl = runtime.getURL(hostPath);
    let owners = new Set();
    let creating = null, closing = null;
    const bounded = (promise, message = '숨겨진 플레이어의 준비 시간이 초과되었습니다.') => alphaHostDeadline(promise, timeoutMs, message);
    const ready = bounded(storage.get('sharedOffscreenOwners')).then(value => {
      owners = new Set((value.sharedOffscreenOwners || []).filter(owner => ['ubob', 'alpha'].includes(owner)));
    });
    ready.catch(() => {});
    let queue = Promise.resolve();
    const serial = fn => {
      const job = queue.catch(() => {}).then(async () => { await ready; return fn(); });
      queue = job.catch(() => {}); return job;
    };
    const save = () => bounded(storage.set({ sharedOffscreenOwners: [...owners] }));
    const contexts = () => bounded(runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    const hasDocument = async () => (await contexts()).some(context => context.documentUrl === hostUrl);
    const validOwner = owner => { if (!['ubob', 'alpha'].includes(owner)) throw new Error('알 수 없는 플레이어입니다.'); };
    async function closeDocument() {
      if (!closing) {
        const pending = Promise.resolve().then(() => offscreen.closeDocument());
        closing = pending;
        pending.then(() => { if (closing === pending) closing = null; }, () => { if (closing === pending) closing = null; });
      }
      await bounded(closing, '숨겨진 플레이어 종료가 지연되고 있습니다. 잠시 후 다시 시도하세요.');
    }
    function createDocument() {
      if (!creating) {
        const pending = Promise.resolve().then(() => offscreen.createDocument({ url: hostPath, reasons: ['IFRAME_SCRIPTING'],
          justification: '로그인된 유밥과 알파 강의실을 각각의 프레임에서 재생합니다.' }));
        creating = pending;
        pending.then(() => {
          if (creating === pending) creating = null;
          // createDocument는 취소할 수 없다. 시간 초과/중지 뒤 늦게 열린 빈 문서는
          // 새 실행이나 유밥이 소유하지 않을 때만 정리한다.
          void serial(async () => { if (!owners.size && await hasDocument()) await closeDocument(); }).catch(() => {});
        }, () => { if (creating === pending) creating = null; });
      }
      return bounded(creating);
    }
    async function ensure(owner) {
      validOwner(owner);
      return serial(async () => {
        const existed = owners.has(owner);
        owners.add(owner);
        try {
          await save();
          // 이전 close가 늦게 끝나 새 실행의 문서를 닫지 않게 직렬화한다.
          if (closing) await bounded(closing);
          const current = await contexts();
          if (current.some(context => context.documentUrl === hostUrl)) return;
          if (current.length) throw new Error('다른 보이지 않는 플레이어 문서가 사용 중입니다.');
          await createDocument();
        } catch (error) {
          if (!existed) { owners.delete(owner); await save(); }
          throw error;
        }
      });
    }
    async function release(owner) {
      validOwner(owner);
      return serial(async () => {
        const remaining = [...owners].filter(value => value !== owner);
        if (await hasDocument()) {
          const command = owner === 'ubob'
            ? { target: 'runner', host: 'offscreen', cmd: 'navigate', url: 'about:blank' }
            : { target: 'alpha-host', cmd: 'clear' };
          let cleared = false;
          try { cleared = (await alphaHostDeadline(runtime.sendMessage(command), messageTimeoutMs,
            '플레이어의 종료 응답이 없습니다.'))?.ok === true; } catch { /* 문서 준비/종료 중 */ }
          if (remaining.length && !cleared) throw new Error('플레이어를 비우지 못했습니다. 잠시 후 다시 시도하세요.');
          if (!remaining.length) await closeDocument();
        }
        owners.delete(owner); await save();
      });
    }
    return { hostUrl, ensure, release, hasDocument,
      owns: owner => serial(() => owners.has(owner)) };
  }
  return { create };
})();

var AlphaHost = (() => {
  const ORIGIN = 'https://alpha-campus.kr';
  const FRAME_RULE_ID = 2;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function identity(value) {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.pathname !== '/my/classRoom/classRoomDetail' || url.username || url.password ||
          url.searchParams.get('type') !== 'ONLINE' || !UUID.test(url.searchParams.get('registrationId')) ||
          !UUID.test(url.searchParams.get('sequenceLessonId'))) return null;
      return `${url.origin}${url.pathname}|${url.searchParams.get('registrationId')}|${url.searchParams.get('sequenceLessonId')}`;
    } catch { return null; }
  }
  const sameUrl = (one, two) => !!identity(one) && identity(one) === identity(two);
  function create({ runtime, dnr, shared, timeoutMs = 10000, messageTimeoutMs = 1500, retryDelayMs = 250 }) {
    let queue = Promise.resolve(), ruleQueue = Promise.resolve(), revision = 0;
    const bounded = promise => alphaHostDeadline(promise, timeoutMs, '알파의 숨겨진 플레이어가 응답하지 않습니다. 다시 시도해 주세요.');
    const serial = fn => {
      const job = queue.catch(() => {}).then(fn); queue = job.catch(() => {}); return job;
    };
    const context = async () => (await bounded(runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [shared.hostUrl] }))).find(item => item.documentUrl === shared.hostUrl);
    async function send(command, check) {
      for (let attempt = 0; attempt < 20; attempt++) {
        check();
        let response;
        // 수신자가 없을 때만 준비를 재시도한다. 응답하지 않는 수신자에게 이동을
        // 반복 전송하면 늦은 명령이 중지 후 실행될 수 있으므로 시간 초과는 즉시 실패한다.
        try { response = runtime.sendMessage({ target: 'alpha-host', ...command }).catch(() => null); }
        catch { response = Promise.resolve(null); }
        const result = await alphaHostDeadline(response, messageTimeoutMs, '알파 플레이어가 시작 명령에 응답하지 않습니다. 다시 시도해 주세요.');
        check();
        if (result?.ok) return result;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
      throw new Error('알파의 보이지 않는 플레이어를 열지 못했습니다.');
    }
    const updateRules = options => {
      // API가 늦게 완료되어도 이전 추가가 새 제거/추가를 덮지 않게 순서를 유지한다.
      ruleQueue = ruleQueue.catch(() => {}).then(() => dnr.updateSessionRules(options));
      return bounded(ruleQueue);
    };
    const removeRule = () => updateRules({ removeRuleIds: [FRAME_RULE_ID] });
    async function navigate(url, { runId, playerToken }) {
      if (!identity(url) || typeof runId !== 'string' || !runId || typeof playerToken !== 'string' || !playerToken) {
        throw new Error('알파 학습용 주소 또는 실행 정보를 확인하지 못했습니다.');
      }
      const version = ++revision;
      return serial(async () => {
        const check = () => { if (version !== revision) throw new Error('알파 플레이어 이동을 중지했습니다.'); };
        check();
        await updateRules({ removeRuleIds: [FRAME_RULE_ID], addRules: [{ id: FRAME_RULE_ID, priority: 1,
          action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }] },
          condition: { regexFilter: '^https://alpha-campus\\.kr/(my/classRoom/classRoomDetail([/?]|$)|catenoid\\.html([?]|$))',
            resourceTypes: ['sub_frame'], tabIds: [-1], initiatorDomains: [runtime.id, 'alpha-campus.kr'] } }] });
        check();
        await shared.ensure('alpha'); check();
        await send({ cmd: 'navigate', url, runId, playerToken }, check); check();
        const active = await context(); check();
        if (!active?.documentId) throw new Error('알파 플레이어 문서를 확인하지 못했습니다.');
        return { documentId: active.documentId };
      });
    }
    function pause() {
      ++revision;
      return serial(async () => {
        try { await shared.release('alpha'); } finally { await removeRule(); }
      });
    }
    async function isAlive({ url, runId, playerToken }) {
      if (!identity(url) || !(await shared.owns('alpha')) || !(await context())) return false;
      try {
        const result = await alphaHostDeadline(runtime.sendMessage({ target: 'alpha-host', cmd: 'ping' }), messageTimeoutMs,
          '알파 플레이어의 상태 응답이 없습니다.');
        return result?.ok === true && result.runId === runId && result.playerToken === playerToken && sameUrl(result.url, url);
      } catch { return false; }
    }
    async function accepts(message, sender, expected) {
      if (sender.id !== runtime.id || sender.tab || sender.url !== shared.hostUrl || !expected.documentId ||
          (sender.documentId && sender.documentId !== expected.documentId) || message.runId !== expected.runId ||
          message.playerToken !== expected.playerToken || !sameUrl(message.url, expected.url)) return false;
      if (!(await shared.owns('alpha'))) return false;
      // Chrome은 offscreen runtime 메시지의 sender.documentId를 생략할 수 있다.
      // 생성 시 저장한 ID와 현재 OFFSCREEN_DOCUMENT의 ID는 계속 일치해야 한다.
      return (await context())?.documentId === expected.documentId;
    }
    return { navigate, pause, isAlive, accepts };
  }
  return { create };
})();
if (typeof globalThis !== 'undefined') Object.assign(globalThis, { SharedOffscreen, AlphaHost });
if (typeof module !== 'undefined' && module.exports) module.exports = { SharedOffscreen, AlphaHost };
