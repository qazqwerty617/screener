'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/js/app.js'),'utf8');
const begin=source.indexOf('  let pdSettingsSyncQueue ='),end=source.indexOf('  async function pdLoadFromServer(',begin);
function client(fetch){
  const items=new Map([['obsidian_auth_token','session']]);
  const ctx={fetch,AbortSignal,Promise,window:{addEventListener(){}},localStorage:{getItem:k=>items.get(k)||null,setItem:(k,v)=>items.set(k,v),removeItem:k=>items.delete(k)},
    console,setTimeout,clearTimeout};
  vm.runInNewContext(source.slice(begin,end)+';this.sync=pdSyncToServer',ctx);
  return ctx;
}
test('rapid pump toggles are serialized so an older enabled setting cannot overwrite disabling',async()=>{
  let release;const received=[];
  const ctx=client(async(url,opts)=>{received.push(JSON.parse(opts.body).enabled??JSON.parse(opts.body).pumpDump?.enabled);
    if(received.length===1)await new Promise(r=>release=r);return {ok:true,json:async()=>({success:true})};});
  const first=ctx.sync({enabled:true,tgEnabled:true}),second=ctx.sync({enabled:false,tgEnabled:false});
  await new Promise(r=>setImmediate(r));assert.deepEqual(received,[true]);release();await Promise.all([first,second]);
  assert.equal(received.at(-1),false);
});

test('failed disabling remains pending and retries the exact latest settings',async()=>{
  let fail=true;const received=[];
  const ctx=client(async(url,opts)=>{received.push(JSON.parse(opts.body));return {ok:!fail,json:async()=>({success:!fail})};});
  assert.equal(await ctx.sync({enabled:false,tgEnabled:false}),false);
  assert.equal(JSON.parse(ctx.localStorage.getItem('pump_alert_sync_pending')).body,'{"enabled":false,"tgEnabled":false}');
  fail=false;await vm.runInNewContext('pdRetrySettingsSync()',ctx);
  assert.equal(received.length,2);assert.equal(received[1].enabled,false);assert.equal(ctx.localStorage.getItem('pump_alert_sync_pending'),null);
});

test('account initialization can retry a pending pump settings save through the exported browser API',()=>{
  const ctx=client(async()=>({ok:true,json:async()=>({success:true})}));
  ctx.pdLoad=()=>{};ctx.pdLoadFromServer=()=>{};ctx.pdGetStorageKey=()=>'';
  const exportsStart=source.indexOf('  window.pdLoad = pdLoad;',begin);
  const exportsEnd=source.indexOf('  // ── High-Speed',exportsStart);
  vm.runInNewContext(source.slice(exportsStart,exportsEnd),ctx);
  assert.equal(typeof ctx.window.pdRetrySettingsSync,'function');
});
