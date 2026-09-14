"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function serverFixture(users) {
  const stored = new Map([['owner:BN', {apiKey:'fixture-public',apiSecret:'fixture-secret'}]]);
  const ctx = vm.createContext({process:{env:{ADMIN_CHAT_ID:'admin-chat'}},userStore:{getAllUsersRaw:()=>users},
    journalCredentials:{get:(id,ex)=>stored.get(`${id}:${ex}`)||null, save:(id,ex,c)=>stored.set(`${id}:${ex}`,c),list:id=>stored.has(`${id}:BN`)?[{exchange:'BN',configured:true}]:[]}});
  vm.runInContext(server.slice(server.indexOf('function findLinkedJournalCredentials('),server.indexOf('async function runJournalSync(')),ctx);
  return {ctx,stored};
}
for (const [label, owner, other] of [
  ['same IP', {lastIp:'192.0.2.1',role:'admin'}, {lastIp:'192.0.2.1',role:'user'}],
  ['VIP role', {telegramId:'admin-chat'}, {role:'VIP Trader'}],
  ['matching profile Telegram field', {telegramId:'shared'}, {telegramId:'shared'}],
]) test(`journal cannot inherit another user's credentials through ${label}`,()=>{
  const {ctx,stored}=serverFixture({owner:{id:'owner',...owner},other:{id:'other',...other}});
  assert.equal(ctx.findLinkedJournalCredentials('other','BN'),null);
  assert.equal(ctx.findLinkedJournalExchanges('other').length,0);
  assert.equal(stored.has('other:BN'),false);
});
function overlayFixture(fetcher) {
  let token='account-A';
  const window={getStoredAuthToken:()=>token,getActiveMarket:()=>({ex:'BN',sym:'BTCUSDT'}),requestMainChartDraw:()=>{}};
  const ctx=vm.createContext({window,document:{addEventListener:()=>{}},localStorage:{getItem:()=>null,setItem:()=>{}},URLSearchParams,AbortController,setTimeout,clearTimeout,fetch:fetcher});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/tradeOverlay.js'),'utf8'),ctx);
  return {overlay:window.TradeOverlay,setToken:t=>token=t};
}
const execution={symbol:'BTCUSDT',time:1700000000000,price:100,qty:1,side:'BUY'};
test('logout removes previously drawn private executions',async()=>{
  const f=overlayFixture(async()=>({ok:true,json:async()=>({executions:[execution]})}));
  await f.overlay.refresh(true); assert.equal(f.overlay.hasExecutions(),true);
  f.setToken(''); await f.overlay.refresh(true);
  assert.equal(f.overlay.hasExecutions(),false);
});
test('late private response from previous login cannot render in new login',async()=>{
  let complete;
  const f=overlayFixture(()=>new Promise(r=>complete=r));
  const pending=f.overlay.refresh(true); f.setToken('account-B');
  complete({ok:true,json:async()=>({executions:[execution]})}); await pending;
  assert.equal(f.overlay.hasExecutions(),false);
});

test('journal must not automatically upload unowned legacy browser API keys',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/js/journal.js'),'utf8');
  const calls=[];
  const ctx=vm.createContext({journalOwner:'',window:{getStoredAuthToken:()=> 'account-B'},apiKeys:{BN:{key:'synthetic-old-key',secret:'synthetic-old-secret'}},configuredExchanges:new Set(),
    journalAuthHeaders:()=>({}),markApiConnected:()=>{},markApiDisconnected:()=>{},saveApiKeys:()=>{},loadStorage:()=>{},updateUI:()=>{},ensureJournalSession:()=> 'account-B',journalToken:()=> 'account-B',
    fetch:async(url,options)=>{calls.push(options?.method||'GET');return {ok:true,json:async()=>({exchanges:[],ownerId:'other'})};}});
  vm.runInContext(source.slice(source.indexOf('  async function hydrateServerCredentials('),source.indexOf('  function formatDuration(')),ctx);
  await ctx.hydrateServerCredentials();
  assert.deepEqual(calls,['GET']);
});

test('local journal ignores unowned legacy records and clears on account switch',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/js/journal.js'),'utf8');
  let token='A';const stored=new Map([['cryptoscreen_journal_trades_v4','[{"id":"legacy-private"}]'],['cryptoscreen_journal_trades_v5:owner','[{"id":"owned"}]']]);
  const ctx=vm.createContext({window:{getStoredAuthToken:()=>token},localStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)},trades:[],apiKeys:{},configuredExchanges:new Set()});
  vm.runInContext(source.slice(source.indexOf('  let currentViewingTrade ='),source.indexOf('  function saveApiKeys(')),ctx);
  ctx.loadStorage();assert.equal(ctx.trades.length,0);
  vm.runInContext("journalOwner='owner';",ctx);ctx.loadStorage();assert.equal(ctx.trades[0].id,'owned');
  token='B';ctx.loadStorage();assert.equal(ctx.trades.length,0);
  assert.equal(stored.has('cryptoscreen_journal_trades_v4'),true);
});
