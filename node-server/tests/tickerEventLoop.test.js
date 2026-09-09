"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {Receiver}=require('ws');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function connectionOptions(){
  let options;class Socket {constructor(url,opts){options=opts;}on(){}terminate(){}}
  const ctx=vm.createContext({WebSocket:Socket,updateExStatus(){},setInterval:()=>1,clearInterval(){},console});
  vm.runInContext(/function mkExWs\([^]*?\n\}/.exec(server)[0],ctx);
  ctx.mkExWs('BN','wss://example.invalid',()=>{});
  return options;
}
test('ticker bursts yield to pending chart work before processing every frame',async()=>{
  const receiver=new Receiver({...connectionOptions(),isServer:false});
  let messages=0;receiver.on('message',()=>messages++);
  const probe=new Promise(resolve=>setImmediate(()=>resolve(messages)));
  const packet=Buffer.concat(Array.from({length:1000},()=>Buffer.from([0x81,2,0x7b,0x7d])));
  const completed=new Promise((resolve,reject)=>receiver.write(packet,e=>e?reject(e):resolve()));
  const beforeProbe=await probe;await completed;receiver.destroy();
  assert.equal(messages,1000,'No exchange messages may be dropped');
  assert.ok(beforeProbe<1000,`Chart work was blocked behind all ${beforeProbe} ticker messages`);
});
