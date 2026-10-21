/* Streaming transport only. A failure must not stop the independent MediaRecorder. */
window.PomnuLive = (() => {
  async function connect(stream, url, onTranscript, onStatus) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !window.AudioWorkletNode || !window.WebSocket) throw new Error('stream unsupported');
    const context = new AudioCtx({sampleRate: 16000});
    let socket, source, processor, timeout, flushResolve;
    let failed = false, settled = false, finishing = false;
    let resolveResult, rejectReady;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const cleanup = () => {
      clearTimeout(timeout);
      if (processor) { processor.port.onmessage = null; processor.disconnect(); }
      if (source) source.disconnect();
      context.close().catch(() => {});
      if (socket && socket.readyState < 2) socket.close();
    };
    const settle = (value) => {
      if (settled) return;
      settled = true; resolveResult(value); cleanup();
    };
    const fail = () => {
      if (settled) return;
      failed = true;
      if (rejectReady) rejectReady(new Error('stream unavailable'));
      onStatus('Живой текст недоступен. Запись продолжается — расшифруем после остановки.');
      settle(null);
    };
    try {
      if (![8000, 16000, 48000].includes(context.sampleRate)) throw new Error('sample rate');
      await context.audioWorklet.addModule('/assets/pcm-worklet.js?v=live-1');
      await context.resume();
      if (context.state !== 'running') throw new Error('audio context suspended');
      processor = new AudioWorkletNode(context, 'pomnu-pcm');
      processor.onprocessorerror = fail;
      socket = new WebSocket(url);
      const ready = new Promise((resolve, reject) => {
        rejectReady = reject;
        socket.onopen = () => socket.send(JSON.stringify({type: 'start', sample_rate: context.sampleRate}));
        socket.onmessage = ({data}) => {
          let message;
          try { message = JSON.parse(data); } catch (_) { fail(); return; }
          if (message.type === 'ready') { clearTimeout(timeout); rejectReady = null; resolve(); }
          else if (message.type === 'transcript') onTranscript(message);
          else if (message.type === 'done' && finishing && message.text && message.audio) settle(message);
          else if (message.type === 'error') fail();
        };
        socket.onerror = fail;
        socket.onclose = () => { if (!settled) fail(); };
        timeout = setTimeout(fail, 5000);
      });
      await ready;
      processor.port.onmessage = ({data}) => {
        if (data.type === 'flushed') { if (flushResolve) flushResolve(); return; }
        if (settled || data.type !== 'pcm') return;
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) { fail(); return; }
        socket.send(data.data);
      };
      source = context.createMediaStreamSource(stream);
      source.connect(processor); processor.connect(context.destination); // Worklet output is silence.
      return {
        begin() { if (!failed) processor.port.postMessage('start'); },
        async finish() {
          if (settled) return result;
          if (finishing) return result;
          finishing = true;
          // Flush the last <100 ms before the ordered WebSocket stop message.
          timeout = setTimeout(fail, 12000);
          const flushed = new Promise(resolve => { flushResolve = resolve; });
          processor.port.postMessage('stop');
          await Promise.race([flushed, result]);
          if (!settled && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'stop'}));
          return result;
        },
        cancel() { settle(null); }
      };
    } catch (error) {
      settle(null);
      throw error;
    }
  }
  return {connect};
})();
