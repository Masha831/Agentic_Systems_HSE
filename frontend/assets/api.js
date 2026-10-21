/* Клиент API «Помню». Все вызовы бэкенда — только через этот файл.
   Контракт: docs/contract.md. */
window.API = (function () {
  'use strict';
  async function req(method, url, body, isForm, headers = {}) {
    const opt = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (isForm) opt.body = body;
      else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    }
    const r = await fetch(url, opt);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((data.detail && (data.detail.message || data.detail)) || r.statusText); e.status = r.status; e.data = data.detail; throw e; }
    return data;
  }
  return {
    liveUrl: (sid) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/stories/${encodeURIComponent(sid)}/transcribe/live`,
    health: () => req('GET', '/api/health'),
    state: () => req('GET', '/api/state'),
    createStory: (s) => req('POST', '/api/stories', s),               // {type,title,about,narrator,relation,cover}
    question: (sid) => req('GET', `/api/stories/${sid}/question`),     // → {text,why,topic,topicTitle}
    transcribe(sid, blob) {                                             // → {text,audio,dur}; 502 → e.data.audio сохранён
      const f = new FormData();
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : blob.type.includes('wav') ? 'wav' : blob.type.includes('mpeg') ? 'mp3' : 'webm';
      f.append('audio', blob, `answer.${ext}`);
      return req('POST', `/api/stories/${sid}/transcribe`, f, true);
    },
    retryTranscribe(sid, audio) { const f = new FormData(); f.append('audio', audio); return req('POST', `/api/stories/${sid}/transcribe/retry`, f, true); },
    answer: (sid, a, key) => req('POST', `/api/stories/${sid}/answers`, a, false, key ? {'Idempotency-Key': key} : {}),  // {text,typed,edited,audio,dur,photo} → {sourceId,source,added,question,story}
    skip: (sid, declined) => req('POST', `/api/stories/${sid}/skip`, { declined: !!declined }),
    clarify: (sid, cid, value) => req('POST', `/api/stories/${sid}/clarify/${cid}`, { value }),
    assemble: (sid) => req('POST', `/api/stories/${sid}/chapters`),     // → {chapterId,chapter,story}
    trace: (sid) => req('GET', `/api/stories/${sid}/trace`),
    patch: (coll, id, body) => req('PATCH', `/api/${coll}/${id}`, body), // coll: people|places|chapters|sources|events|stories
    upload(file) { const f = new FormData(); f.append('file', file); return req('POST', '/api/uploads', f, true); }, // → {src,w,h,alt}
    ttsUrl: (text) => `/api/tts?text=${encodeURIComponent(text)}`
  };
})();
