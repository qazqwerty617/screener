"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), vm=require("node:vm"), path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"../public/js/app.js"),"utf8");
const slice=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function setup(request) {
  const status={style:{}};
  const context={fetch:request,AbortSignal,Date,console:{error(){}},EX_NAMES:{BN:"Binance"},
    $:()=>status,document:{querySelectorAll:()=>[]},layoutDensityBadges(){},requestDraw(){},requestAnimationFrame(){},drawChart(){}};
  vm.createContext(context);
  vm.runInContext(`var densityData=[],densityHistoryData=[],densityLastUpdate=0,densityReceivedAt=0,densityMeta=null,densityFetchPending=false,densityConnectionError=false,densitySnapshotVersion=0,activeView="map";
    ${slice("function updateDensityStatusUI(meta)","// Fallback polling")}
    function deliver(msg){${slice('if (msg.type === "walls") {','if (msg.type === "snapshot") {')}}`,context);
  return {context,status};
}
test("slow HTTP snapshots cannot overwrite a newer WebSocket snapshot",async()=>{
  let resolve,calls=0;
  const {context:c}=setup(()=>{calls++;return new Promise(r=>resolve=r);});
  const pending=c.fetchWalls(); await c.fetchWalls(); assert.equal(calls,1);
  c.deliver({type:"walls",data:{walls:[{ex:"BN",base:"NEW"}],updatedAt:200,partial:false}});
  resolve({ok:true,json:async()=>({walls:[{ex:"BN",base:"OLD"}],updatedAt:100})});
  await pending; assert.equal(c.densityData[0].base,"NEW"); assert.equal(c.densityFetchPending,false);
});

test("a late HTTP response without a usable timestamp cannot replace newer WebSocket walls",async()=>{
  for (const response of [[{ex:'BN',base:'OLD'}], {walls:[{ex:'BN',base:'OLD'}],updatedAt:'invalid'}]) {
    let resolve;
    const {context:c}=setup(()=>new Promise(r=>resolve=r));
    const pending=c.fetchWalls();
    c.deliver({type:'walls',data:{walls:[{ex:'BN',base:'NEW'}],updatedAt:200}});
    resolve({ok:true,json:async()=>response}); await pending;
    assert.equal(c.densityData[0].base,'NEW');
    assert.equal(c.densityLastUpdate,200);
  }
});

test("a newer timestamped HTTP snapshot still updates the map after a WebSocket snapshot",async()=>{
  let resolve;
  const {context:c}=setup(()=>new Promise(r=>resolve=r));
  const pending=c.fetchWalls();
  c.deliver({type:'walls',data:{walls:[],updatedAt:200}});
  resolve({ok:true,json:async()=>({walls:[{ex:'BN',base:'LATEST'}],updatedAt:300})});
  await pending; assert.equal(c.densityData[0].base,'LATEST');
});
test("an empty authoritative partial snapshot removes disappeared walls instead of retaining ghosts",()=>{
  const {context:c}=setup(()=>{});
  c.deliver({type:"walls",data:{walls:[{ex:"BN",base:"OLD"}],updatedAt:100}});
  c.deliver({type:"walls",data:{walls:[],updatedAt:200,partial:true}});
  assert.equal(c.densityData.length,0);
});

test("malformed WebSocket timestamps cannot corrupt the accepted density snapshot",()=>{
  const {context:c}=setup(()=>{});
  c.deliver({type:'walls',data:{walls:[{ex:'BN',base:'CURRENT'}],updatedAt:200}});
  c.deliver({type:'walls',data:{walls:[],updatedAt:'invalid'}});
  assert.equal(c.densityData[0]?.base,'CURRENT');
  assert.equal(c.densityLastUpdate,200);
});
test("a late HTTP error cannot mark a healthy WebSocket stream offline",async()=>{
  let reject;
  const {context:c}=setup(()=>new Promise((_,r)=>reject=r));
  const pending=c.fetchWalls();
  c.deliver({type:"walls",data:{walls:[],updatedAt:Date.now()}});
  reject(new Error("late timeout")); await pending;
  assert.equal(c.densityConnectionError,false); assert.equal(c.densityFetchPending,false);
});
test("HTTP failures and malformed data are visible; a successful retry recovers",async()=>{
  let response={ok:false,status:502};
  const {context:c,status}=setup(async()=>response);
  await c.fetchWalls(); assert.match(status.textContent,/Нет связи/); assert.equal(c.densityConnectionError,true);
  response={ok:true,json:async()=>({wrong:true})}; await c.fetchWalls(); assert.equal(c.densityConnectionError,true);
  response={ok:true,json:async()=>({walls:[],updatedAt:Date.now(),exchangesReady:1,exchangesTotal:11,exchangeStatuses:{BN:{symbolsTotal:10,symbolsScanned:2,status:"ok"}}})};
  await c.fetchWalls(); assert.equal(c.densityConnectionError,false); assert.match(status.title,/2\/10 стаканов/);
  assert.match(c.densityEmptyMessage(),/Стаканы поступают/);
  c.densityData=[{ex:"BN"}]; assert.match(c.densityEmptyMessage(),/фильтрам/);
});
