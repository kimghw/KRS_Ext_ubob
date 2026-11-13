// 머리의 GitHub 아이콘 — 확장 폴더(git 저장소)가 GitHub 보다 뒤졌는지 보고, 누르면 받고(git pull), 한 번 더 누르면 확장을 다시 불러온다.
// git 은 같은 PC 의 워크스페이스 확장(kr_ext_workspace) 브릿지가 돌린다 — 받기 전용 네이티브 호스트 com.krs.gitsync.
// 확장이 브릿지에 넘기는 값은 작업 이름뿐이다(어느 폴더인지는 브릿지가 이 확장의 ID 로 찾는다).
// 브릿지가 없으면 머리 아래에 직접 갱신하라는 안내 한 줄이 뜬다.
var UbobGitSync = (() => {
  'use strict';

  const HOST = 'com.krs.gitsync';
  /** 몇 분마다 볼지. 패널이 가려져 있으면 그 차례는 건너뛴다. */
  const CHECK_MS = 10 * 60_000;
  const NO_BRIDGE = '워크스페이스 브릿지 없음 · 직접 갱신하세요';
  /** 받은 뒤 아직 다시 불러오지 않았다는 표시 — session 저장소는 확장을 다시 불러오면 비워지므로 그때 저절로 풀린다. */
  const PENDING_KEY = 'gitReloadPending';
  const SHOW_COMMITS = 5;

  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  /** 브릿지에 한 번 묻는다. 브릿지가 없으면 브라우저가 던진다. 시간이 다 된 것은 브릿지가 있는 것이다(timeout 을 붙여 던진다). */
  async function ask(task, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        chrome.runtime.sendNativeMessage(HOST, { task }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`${timeoutMs / 1000}초 안에 응답 없음`), { timeout: true })), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 확인한 것을 아이콘의 모양으로.
   * mode — idle: 아직 안 봄 · off: 브릿지 없음 · error: 확인 실패 · same: GitHub 과 같음 · new: 새 커밋(누르면 받기) ·
   * blocked: 새 커밋이 고치고 있는 파일과 겹침 · diverged: 여기에만 있는 커밋도 있어 갈라짐 · ahead: 올리지 않은 커밋만 있음.
   * count 는 아이콘 귀퉁이의 숫자(새 커밋 수)다. new 말고는 누르면 다시 확인한다.
   */
  function view(s, at = null) {
    if (!s) return { mode: 'idle', count: '', title: 'GitHub 새 버전 확인' };
    if (s.unreachable) return { mode: 'off', count: '', title: '브릿지 없음 · 눌러서 다시 확인' };
    if (!s.ok) return { mode: 'error', count: '', title: `확인 실패 · ${s.error || '알 수 없는 오류'}` };
    if (s.behind > 0) {
      const count = s.behind > 99 ? '99+' : String(s.behind);
      const list = (s.commits || []).slice(0, SHOW_COMMITS).map((c) => `\n· ${c.subject}`).join('');
      const head = `새 커밋 ${s.behind}개`;
      if (s.ahead > 0) return { mode: 'diverged', count, title: `${head} · 직접 pull 필요${list}` };
      if (s.overlap && s.overlap.length) return { mode: 'blocked', count, title: `${head} · 수정 중 파일과 겹침${list}` };
      return { mode: 'new', count, title: `${head} · 눌러서 받기${list}` };
    }
    if (s.ahead > 0) return { mode: 'ahead', count: '', title: `최신 · 올리지 않은 커밋 ${s.ahead}개` };
    return { mode: 'same', count: '', title: `최신 버전${at ? ` · ${hhmm(at)} 확인` : ''}` };
  }

  const sessionStore = {
    async get() {
      try { return !!(await chrome.storage.session.get({ [PENDING_KEY]: false }))[PENDING_KEY]; } catch { return false; }
    },
    async set(on) {
      try { await chrome.storage.session.set({ [PENDING_KEY]: !!on }); } catch { /* 표시를 못 남겨도 받기는 됐다 */ }
    },
  };

  /**
   * @param {{button: HTMLElement, badge: HTMLElement, notice: HTMLElement, send?: Function, reload?: Function, now?: Function,
   *   hidden?: Function, every?: Function, store?: {get: Function, set: Function}}} o  send 부터는 테스트가 갈아 끼운다
   */
  function create({ button, badge, notice, send = ask, reload = () => chrome.runtime.reload(), now = () => new Date(),
    hidden = () => document.hidden, every = setInterval, store = sessionStore }) {
    // last 는 마지막으로 확인한 것, at 은 그때. busy 는 하는 중인 일의 말, reload 는 받은 것을 반영하려면 다시 불러와야 한다는 표시,
    // fail 은 받지 못한 까닭(안내 줄에 보인다).
    const st = { last: null, at: null, busy: '', reload: false, fail: '' };

    function paint() {
      const v = st.reload ? { mode: 'reload', count: '↻', title: '받음 · 눌러서 다시 불러오기' } : view(st.last, st.at);
      const title = st.busy || v.title;
      button.dataset.mode = v.mode;
      button.classList.toggle('busy', !!st.busy);
      button.title = title;
      button.setAttribute('aria-label', title.split('\n')[0]);
      badge.textContent = v.count;
      badge.hidden = !v.count;
      const text = v.mode === 'off' ? NO_BRIDGE : st.fail;
      notice.textContent = text;
      // 브라우저가 댄 까닭(호스트를 찾지 못함·접근 거부 등)은 풍선 말에 둔다.
      notice.title = v.mode === 'off' ? String(st.last.error || '') : '';
      notice.hidden = !text;
    }

    /** quiet 는 몇 분마다 도는 확인이다 — 패널이 가려져 있으면 건너뛴다. */
    async function check({ quiet = true } = {}) {
      if (st.busy || st.reload || (quiet && hidden())) return;
      st.busy = '확인 중…';
      paint();
      let r;
      try {
        r = await send('gitStatus', 45_000);
      } catch (err) {
        r = { ok: false, error: String((err && err.message) || err), unreachable: !(err && err.timeout) };
      }
      // 브릿지는 있는데 이 확장이 등록돼 있지 않은 것도 쓸 수 없기는 같다.
      if (r && r.code === 'NOT_REGISTERED') r = { ...r, unreachable: true };
      st.last = r || { ok: false, error: '브릿지 응답 없음' };
      st.at = now();
      st.busy = '';
      if (st.last.ok && !st.last.behind) st.fail = '';
      paint();
    }

    async function pull() {
      st.busy = '받는 중…';
      paint();
      let r;
      try {
        r = await send('gitPull', 90_000);
      } catch (err) {
        r = { ok: false, error: String((err && err.message) || err) };
      }
      st.busy = '';
      if (!r || !r.ok) {
        st.fail = `받기 실패 · ${(r && r.error) || '브릿지 응답 없음'}`;
        return check({ quiet: false });
      }
      st.fail = '';
      if (r.pulled && r.reload) {
        st.reload = true;
        await store.set(true);
        paint();
        return;
      }
      return check({ quiet: false });
    }

    async function click() {
      if (st.busy) return;
      if (st.reload) return reload();
      if (view(st.last).mode === 'new') return pull();
      return check({ quiet: false });
    }

    return {
      /** 패널을 열 때 한 번 보고, 그 뒤로는 CHECK_MS 마다 본다. 받아 두고 다시 불러오지 않은 채 패널을 닫았었다면 ↻ 부터 보인다. */
      async start() {
        button.addEventListener('click', click);
        if (await store.get()) {
          st.reload = true;
          paint();
        } else {
          await check({ quiet: false });
        }
        every(() => check(), CHECK_MS);
      },
      check, click, state: st,
    };
  }

  return { HOST, CHECK_MS, NO_BRIDGE, view, create };
})();

globalThis.UbobGitSync = UbobGitSync;
if (typeof module !== 'undefined' && module.exports) module.exports = UbobGitSync;
