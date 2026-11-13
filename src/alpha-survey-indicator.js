// 기본 확장 아이콘의 우측 위에 설문 알림을 겹친다. 기존 재생 배지는 그대로 유지한다.
var AlphaSurveyIndicator = (() => {
  function create({ action, runtime }) {
    const normalIcon = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
    const normalTitle = runtime.getManifest().action.default_title;
    let markedIcon;
    let appliedKey = null;
    let revision = 0;
    let chain = Promise.resolve();

    async function drawMarkedIcon() {
      const result = {};
      for (const size of [16, 32]) {
        const response = await fetch(runtime.getURL(normalIcon[size]));
        if (!response.ok) throw new Error('확장 아이콘을 읽지 못했습니다.');
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.scale(size / 16, size / 16);
        ctx.drawImage(bitmap, 0, 0, 16, 16);
        bitmap.close();
        ctx.beginPath();
        ctx.arc(11.5, 4.5, 4.1, 0, Math.PI * 2);
        ctx.fillStyle = '#d97706';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(11.5, 2.3);
        ctx.lineTo(11.5, 4.5);
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(11.5, 6.4, 0.7, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        result[size] = ctx.getImageData(0, 0, size, size);
      }
      return result;
    }

    function update(state) {
      // 설문 확인 대기 중이거나, 영상 학습은 끝났는데 설문이 남은 과정이 있을 때 표시한다.
      const waiting = ['attention', 'checking-survey'].includes(state?.phase) && state.attentionReason === 'survey';
      const left = state?.phase === 'done' ? (state.surveyCourses || []).length : 0;
      const survey = waiting || left > 0;
      const title = waiting
        ? `설문 작성 필요${state.courseTitle ? ` · ${state.courseTitle}` : ''} — 알파 탭에서 자동 설문을 누르세요`
        : left ? `설문이 남은 과정 ${left}개 — 알파 탭에서 자동 설문을 누르세요` : normalTitle;
      const key = survey ? title : 'normal';
      const version = ++revision;
      chain = chain.catch(() => {}).then(async () => {
        if (version !== revision || key === appliedKey) return;
        if (survey) {
          markedIcon ||= drawMarkedIcon().catch(error => { markedIcon = null; throw error; });
          const imageData = await markedIcon;
          if (version !== revision) return;
          await action.setIcon({ imageData });
        } else await action.setIcon({ path: Object.fromEntries(
          Object.entries(normalIcon).map(([size, path]) => [size, runtime.getURL(path)])
        ) });
        await action.setTitle({ title });
        appliedKey = key;
      });
      return chain;
    }
    return { update };
  }
  return { create };
})();
globalThis.AlphaSurveyIndicator = AlphaSurveyIndicator;
