const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(deny=false, live=null) {
  let stopped=0, instance;
  const stream={getTracks:()=>[{stop(){stopped++;}}]};
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(s, options) { instance=this; this.mimeType=options.mimeType; this.state='inactive'; }
    start() { this.state='recording'; }
    stop() { this.state='inactive'; this.ondataavailable({data:new Blob(['audio'])}); this.onstop(); }
  }
  const context = {window:{MediaRecorder:Recorder, PomnuLive:live}, MediaRecorder:Recorder, Blob,
    navigator:{mediaDevices:{getUserMedia:async()=>{if(deny) throw Object.assign(new Error('denied'),{name:'NotAllowedError'}); return stream;}}},
    performance, setTimeout, clearTimeout, setInterval, clearInterval};
  vm.createContext(context); vm.runInContext(fs.readFileSync('frontend/assets/voice.js','utf8'),context);
  return {api:context.window.PomnuVoice, stopped:()=>stopped, fail:()=>instance.onerror()};
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

test('recorder error releases microphone and reports failure to UI',async()=>{
  const {api,stopped,fail}=setup(); let error;
  await api.start(()=>{},()=>{}, e=>{error=e;}); fail();
  assert.match(error.message,/не смог записать/); assert.equal(stopped(),1);
  await api.start(()=>{},()=>{}); await api.cancel(); assert.equal(stopped(),2);
});


test('stream failure preserves the independent local recording',async()=>{
  const {api}=setup(false,{connect:async()=>{throw new Error('offline');}}); let status;
  await api.start(()=>{},()=>{},()=>{}, {url:'ws://test',onTranscript:()=>{},onStatus:m=>{status=m;}});
  const out=await api.stop();
  assert.equal(await out.blob.text(),'audio'); assert.equal(out.live,undefined);
  assert.match(status,/после остановки/);
});
test('stop returns local audio before delayed stream completion; cancel tears down stream',async()=>{
  let resolve, cancelled=0;
  const pending=new Promise(r=>{resolve=r;});
  const {api}=setup(false,{connect:async()=>({begin(){},finish:()=>pending,cancel(){cancelled++;resolve(null);}})});
  const options={url:'ws://test',onTranscript:()=>{},onStatus:()=>{}};
  await api.start(()=>{},()=>{},()=>{},options);
  const out=await api.stop(); assert.equal(await out.blob.text(),'audio');
  resolve({text:'Готово',audio:'/media/test.wav'});
  assert.equal((await out.live).text,'Готово');
  await api.start(()=>{},()=>{},()=>{},options); await api.cancel(); assert.equal(cancelled,1);
});
