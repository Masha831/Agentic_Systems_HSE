const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('PCM sends exact mono samples and flushes the tail on stop without recording extra samples', () => {
  let Processor; const messages=[];
  class Base { constructor(){this.port={postMessage: m=>messages.push(m)};} }
  const ctx={AudioWorkletProcessor:Base,sampleRate:16000,ArrayBuffer,DataView,Math,
    registerProcessor: (_,p)=>{Processor=p;}};
  vm.createContext(ctx); vm.runInContext(fs.readFileSync('frontend/assets/pcm-worklet.js','utf8'),ctx);
  const p=new Processor();
  p.process([[new Float32Array([1])]]); assert.equal(messages.length,0);
  p.port.onmessage({data:'start'});
  p.process([[new Float32Array([1,-1,.5,-.5])]]);
  p.port.onmessage({data:'stop'});
  assert.equal(messages.length,2); assert.equal(messages[1].type,'flushed');
  const values=new DataView(messages[0].data);
  assert.deepEqual([0,2,4,6].map(i=>values.getInt16(i,true)),[32767,-32768,16384,-16384]);
  p.process([[new Float32Array([1])]]); assert.equal(messages.length,2);
});
