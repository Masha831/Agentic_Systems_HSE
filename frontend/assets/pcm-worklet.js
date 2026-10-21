/* Mono signed 16-bit little-endian PCM, 100 ms per message. */
class PomnuPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(Math.round(sampleRate / 10) * 2);
    this.view = new DataView(this.buffer); this.offset = 0; this.recording = false;
    this.port.onmessage = ({data}) => {
      if (data === 'start') this.recording = true;
      if (data === 'stop') {
        this.recording = false; this.flush(); this.port.postMessage({type: 'flushed'});
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const data = this.buffer.slice(0, this.offset);
    this.port.postMessage({type: 'pcm', data}, [data]); this.offset = 0;
  }
  process(inputs) {
    if (this.recording && inputs[0]?.length) {
      const channels = inputs[0];
      for (let i = 0; i < channels[0].length; i++) {
        let value = 0;
        for (const channel of channels) value += channel[i];
        value = Math.max(-1, Math.min(1, value / channels.length));
        this.view.setInt16(this.offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        this.offset += 2;
        if (this.offset === this.buffer.byteLength) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pomnu-pcm', PomnuPCM);
