// 보이지 않는 플레이어(offscreen 문서)와 "플레이어 화면 보기" 창이 같은 페이지를 쓴다.
// 열리면 백그라운드에 "준비됨"을 알리고 지금 열어야 할 주소를 받아온다 (백그라운드가 밀어주는 navigate 와 병행).
const HOST = new URLSearchParams(location.search).get('host') === 'window' ? 'window' : 'offscreen';
document.body.className = HOST;
const frame = document.getElementById('runner');
const $ = (id) => document.getElementById(id);

let lastSet = { url: '', at: 0 };
let loadedAt = 0;

function setSrc(url) {
  if (url === lastSet.url && Date.now() - lastSet.at < 5000) return;   // 같은 주소 연속 요청은 한 번만
  lastSet = { url, at: Date.now() };
  loadedAt = 0;
  frame.src = url;
  render();
}
frame.addEventListener('load', () => { loadedAt = Date.now(); render(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'runner' || msg.host !== HOST) return;
  if (msg.cmd === 'navigate') {
    setSrc(msg.url);
    sendResponse({ ok: true });
  } else if (msg.cmd === 'ping') {
    sendResponse({ ok: true, src: lastSet.url, setAt: lastSet.at, loadedAt });
  }
});

chrome.runtime.sendMessage({ type: 'runner-host-ready', host: HOST })
  .then((res) => { if (res && res.url) setSrc(res.url); })
  .catch(() => {});

// ---------- 상태 표시 (창 모드) ----------
const fmtTime = (sec) => {
  if (!Number.isFinite(sec)) return '--:--';
  sec = Math.floor(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}초 전` : '없음');

async function render() {
  if (HOST !== 'window') return;
  const [{ runner }, ss] = await Promise.all([
    chrome.storage.local.get('runner'),
    chrome.storage.session.get(['runnerStatus', 'pageAt', 'navAt'])
  ]);
  const st = ss.runnerStatus;
  const reported = ss.pageAt && lastSet.at && ss.pageAt >= lastSet.at - 1000;
  const now = Date.now();
  let state = '대기 중', cls = '', detail = '', warn = '';

  if (!runner || !runner.running) {
    state = '자동 학습이 실행 중이 아닙니다';
  } else if (!lastSet.url) {
    state = '열어야 할 주소를 기다리는 중';
  } else if (!loadedAt) {
    state = '페이지 불러오는 중…';
    cls = 'ok';
    if (now - lastSet.at > 20000) warn = '20초가 지나도 페이지가 열리지 않습니다. 팝업의 "진단"을 눌러 주세요.';
  } else if (!reported) {
    state = '페이지가 열렸지만 아직 응답이 없습니다';
    cls = 'warn';
    if (now - loadedAt > 10000) {
      warn = '페이지는 열렸는데 확장이 강의 페이지를 인식하지 못합니다. 화면이 비어 있다면 사이트가 프레임 안에서 내용을 숨기는 것일 수 있습니다. 팝업의 "진단"을 눌러 주세요.';
    }
  } else if (st) {
    const LABEL = {
      playing: '재생 중', loading: '강의 불러오는 중', idle: '대기 중', trailer: '예고편 재생 중', 'user-paused': '일시정지',
      'waiting-next': '다음 강의 준비 중', 'next-countdown': '다음 강의 준비 중', countdown: '자동 진행 중',
      done: '과정 마지막 강의 완료', 'course-finished': '과정 완료 → 다음 과정으로', attention: '확인 필요'
    };
    state = LABEL[st.state] || st.state;
    cls = st.state === 'attention' ? 'warn' : 'ok';
    const parts = [];
    if (st.title) parts.push(`${st.total ? `${st.index}/${st.total}강 ` : ''}${st.title}`);
    if (st.isLecture && st.duration) parts.push(`${fmtTime(st.currentTime)} / ${fmtTime(st.duration)} · ${st.rate ? `${st.rate}x` : ''}`);
    parts.push(`진도 저장 ${st.saveCount || 0}회${st.lastSaveAt ? ` (${ago(st.lastSaveAt)})` : ''}`);
    if (st.lectureProgress != null) parts.push(`이 강의 ${st.lectureProgress}%`);
    if (st.progress != null) parts.push(`과정 ${st.progress}%`);
    detail = parts.join(' · ');
    if (st.state === 'loading' && !st.hasPlayer && now - loadedAt > 15000) warn = '플레이어(video.js)가 페이지에 나타나지 않습니다.';
  } else {
    state = '강의 페이지 확인됨 · 상태 대기 중';
    cls = 'ok';
  }
  $('dot').className = `dot ${cls}`;
  $('state').textContent = state;
  $('url').textContent = lastSet.url;
  $('detail').textContent = detail;
  $('warn').textContent = warn;
}

if (HOST === 'window') {
  chrome.storage.onChanged.addListener(() => render());
  setInterval(render, 2000);
  render();
}
