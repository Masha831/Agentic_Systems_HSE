const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(deny=false) {
  let stopped=0;
  const stream={getTracks:()=>[{stop(){stopped++;}}]};
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(s, options) { this.mimeType=options.mimeType; this.state='inactive'; }
    start() { this.state='recording'; }
    stop() { this.state='inactive'; this.ondataavailable({data:new Blob(['audio'])}); this.onstop(); }
  }
  const context = {window:{MediaRecorder:Recorder}, MediaRecorder:Recorder, Blob,
    navigator:{mediaDevices:{getUserMedia:async()=>{if(deny) throw Object.assign(new Error('denied'),{name:'NotAllowedError'}); return stream;}}},
    performance, setTimeout, clearTimeout, setInterval, clearInterval};
  vm.createContext(context); vm.runInContext(fs.readFileSync('frontend/assets/voice.js','utf8'),context);
  return {api:context.window.PomnuVoice, stopped:()=>stopped};
}
test('recording returns actual blob, releases microphone, allows next recording',async()=>{
  const {api,stopped}=setup(); await api.start(()=>{},()=>{});
  await assert.rejects(api.start(()=>{},()=>{}),/уже/);
  const out=await api.stop(); assert.equal(await out.blob.text(),'audio'); assert.equal(stopped(),1);
  await api.start(()=>{},()=>{}); await api.cancel(); assert.equal(stopped(),2);
});
test('permission denial leaves recorder ready for another attempt',async()=>{
  const {api}=setup(true);
  await assert.rejects(api.start(()=>{},()=>{}),/denied/);
  await assert.rejects(api.start(()=>{},()=>{}),/denied/);
});
