/* Микрофон и локальные черновики. Ключей и обращений к Яндексу здесь нет. */
window.PomnuVoice = (() => {
  let active = null;
  let opening = false;
  const MAX_SECONDS = 300;
  async function start(onLevel, onLimit, onError = () => {}, liveOptions = null) {
    if (active || opening) throw new Error('Запись уже идёт');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Микрофон доступен на localhost или HTTPS в браузере с поддержкой записи');
    }
    opening = true;
    let stream, state;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}});
      const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, type ? {mimeType: type} : {});
      const chunks = [];
      let resolve, reject;
      const result = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Ошибку выдаём при остановке; до этого promise не остаётся необработанным.
      result.catch(() => {});
      state = {stream, recorder, chunks, result, started: performance.now(), context: null, timer: null, limit: null, live: null, liveResult: null};
      const release = () => {
        clearInterval(state.timer); clearTimeout(state.limit);
        stream.getTracks().forEach(track => track.stop());
        if (state.context) state.context.close().catch(() => {});
        if (active === state) active = null;
      };
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => {
        const error = new Error('Браузер не смог записать звук. Попробуйте снова.');
        state.live?.cancel(); release(); reject(error); onError(error);
      };
      recorder.onstop = async () => {
        const duration = (performance.now() - state.started) / 1000;
        const blob = new Blob(chunks, {type: recorder.mimeType || type || 'audio/webm'});
        release();
        const live = state.liveResult;
        if (blob.size) resolve({blob, duration, live}); else reject(new Error('Запись пустая. Проверьте микрофон.'));
      };
      if (liveOptions && window.PomnuLive) {
        try {
          state.live = await window.PomnuLive.connect(stream, liveOptions.url, liveOptions.onTranscript, liveOptions.onStatus);
        } catch (_) { liveOptions.onStatus('Живой текст недоступен. Расшифруем запись после остановки.'); }
      }
      state.started = performance.now();
      recorder.start(1000);
      state.live?.begin();
      active = state;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        state.context = new AudioCtx();
        const analyser = state.context.createAnalyser();
        analyser.fftSize = 256;
        state.context.createMediaStreamSource(stream).connect(analyser);
        const values = new Uint8Array(analyser.fftSize);
        state.timer = setInterval(() => {
          analyser.getByteTimeDomainData(values);
          const rms = Math.sqrt(values.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / values.length);
          onLevel(Math.min(1, rms * 5));
        }, 120);
      } catch (_) { /* Уровни необязательны: запись продолжает работать. */ }
      state.limit = setTimeout(onLimit, MAX_SECONDS * 1000);
    } catch (error) {
      state?.live?.cancel();
      if (!active && stream) stream.getTracks().forEach(track => track.stop());
      throw error;
    } finally { opening = false; }
  }
  async function stop() {
    const state = active;
    if (!state) throw new Error('Нет активной записи');
    state.liveResult ||= state.live?.finish();
    if (state.recorder.state !== 'inactive') state.recorder.stop();
    return state.result;
  }
  async function cancel() { if (active) { active.live?.cancel(); try { await stop(); } catch (_) {} } }
  // Сериализуем записи IndexedDB, чтобы старое input-событие не вернуло удалённый черновик.
  let queue = Promise.resolve();
  function draft(action, id, value) {
    const run = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('pomnu-voice-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('drafts', action === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('drafts');
        const op = action === 'put' ? store.put(value, id) : action === 'delete' ? store.delete(id) : store.get(id);
        tx.oncomplete = () => { db.close(); resolve(op.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('Локальное сохранение прервано')); };
      };
    });
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }
  return {start, stop, cancel, draft, MAX_SECONDS};
})();
