"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const src=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
function harness(){
  const dom=new JSDOM('<div id="grid"></div>');
  const paints=[];
  dom.window.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:(_,key)=>()=>paints.push(key)});
  const listeners=new Map(),originalAdd=dom.window.addEventListener.bind(dom.window),originalRemove=dom.window.removeEventListener.bind(dom.window);
  dom.window.addEventListener=(name,fn,options)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);originalAdd(name,fn,options)};
  dom.window.removeEventListener=(name,fn,options)=>{listeners.get(name)?.delete(fn);originalRemove(name,fn,options)};
  const klass=/class ChartInstance \{[^]*?\n\}/.exec(src)[0];
  const Chart=new Function('window','document',`const activeEx='BN',activeTf='5m',activeView='screener',screenerView='multichart';const getCanvasBgColor=()=> '#000';${klass};return ChartInstance;`)(dom.window,dom.window.document);
  return {dom,listeners,Chart,paints,container:dom.window.document.getElementById('grid')};
}
test('rebuilding twelve-cell grids releases every global pointer listener',()=>{
  const h=harness();
  for(let pass=0;pass<5;pass++){
    const cells=Array.from({length:12},(_,i)=>new h.Chart(h.container,i));
    cells.forEach(cell=>cell.dispose());h.container.innerHTML='';
  }
  assert.equal(h.listeners.get('mousemove')?.size||0,0);
  assert.equal(h.listeners.get('mouseup')?.size||0,0);
  h.dom.window.close();
});
test('disposed grid cell ignores delayed layout paints',()=>{
  const h=harness(),cell=new h.Chart(h.container,0);
  Object.defineProperty(cell.canvas,'clientWidth',{value:400});Object.defineProperty(cell.canvas,'clientHeight',{value:200});
  cell.loadingKlines=true;cell.dispose();cell.draw(true);
  assert.equal(h.paints.length,0);
  h.dom.window.close();
});
test('MEXC ticker startup does not wait for optional contract metadata',async()=>{
  const code=fs.readFileSync(path.join(__dirname,'../exchanges/mexc.js'),'utf8');
  const context={module:{exports:{}},console:{log(){},error(){}},setInterval:()=>1,setTimeout:()=>1};
  vm.runInNewContext(code,context);
  const tickers=new Map(),dirty=new Set();
  const feed=context.module.exports(tickers,dirty,()=>{},async url=>url.endsWith('/detail')?new Promise(()=>{}):{
    success:true,code:0,data:[{symbol:'BTC_USDT',lastPrice:10,riseFallRate:0,amount24:1000}]
  },()=>{});
  let timer;
  const result=await Promise.race([feed.init().then(()=>true),new Promise(r=>timer=setTimeout(()=>r(false),50))]);
  clearTimeout(timer);
  assert.equal(result,true);assert.equal(tickers.get('MX:BTC_USDT').p,10);
});
