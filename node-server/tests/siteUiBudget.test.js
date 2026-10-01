'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf8');
const block = (source, name) => new RegExp(`  function ${name}\\([^]*?\\n  \\}`).exec(source)?.[0] || '';

function arbitrage(t) {
  const dom = new JSDOM('<table><tbody id="arb-spreads-body"></tbody><tbody id="arb-funding-body"></tbody></table>', {pretendToBeVisual:true});
  t.after(() => dom.window.close());
  const source = read('arbitrage.js');
  const c = { document: dom.window.document, $: id => dom.window.document.getElementById(id),
    window: {}, state: { active: true, mode: 'spreads', favorites: new Set(), transferByKey: new Map(), trail: new Map() },
    esc: String, price: String, money: String, pct: String, pctMaybe: String, durationHours: String,
    pairCell: r => r.base, routeCell: (a,b) => a+b, routeLeg: (...a) => a.join(' '), fundingHourly: () => 0,
    transferCell: () => '', sparkCell: r => `<canvas data-spark="${r.key}"></canvas>`, scoreCell: r => r.score,
    countdown: String, requestAnimationFrame() {}, drawSparks() {}, scheduleSparks() {} };
  vm.createContext(c);
  vm.runInContext(block(source,'observeSparks')+'\n'+block(source,'patchTableRows')+'\n'+block(source,'renderSpreads')+'\n'+block(source,'renderFunding'), c);
  const rows = Array.from({length:400}, (_,i) => ({key:'route'+i,base:'TOKEN'+i,buyEx:'BN',sellEx:'BB',buyName:'Binance',sellName:'Bybit',
    buyAsk:100,sellBid:101,net:1,roundTripNet:.8,closeNowNet:.7,liquidity:1e6,score:80}));
  return {c, rows, body:c.$('arb-spreads-body')};
}

test('arbitrage polling retains all 400 unchanged rows and their sparklines', t => {
  const {c,rows,body} = arbitrage(t); c.renderSpreads(rows);
  const retained = [...body.children], canvases = [...body.querySelectorAll('canvas')];
  for(let i=0;i<5;i++) c.renderSpreads(rows);
  assert.ok([...body.children].every((row,i) => row === retained[i]), 'unchanged polling must not recreate the table');
  assert.ok([...body.querySelectorAll('canvas')].every((canvas,i) => canvas === canvases[i]));
});

test('arbitrage changing a quote retains unrelated cells, focus and row order', t => {
  const {c,rows,body} = arbitrage(t); c.renderSpreads(rows);
  const row = body.children[0], star = row.querySelector('button'), spark = row.querySelector('canvas'); star.focus();
  rows[0].buyAsk=103;c.renderSpreads(rows);
  assert.equal(body.children[0],row); assert.equal(row.querySelector('button'),star);
  assert.equal(row.querySelector('canvas'),spark); assert.equal(c.document.activeElement,star);
  assert.match(row.textContent,/103/);
  c.renderSpreads([rows[1],rows[0]]);
  assert.equal(body.children.length,2); assert.equal(body.children[1],row);
});

test('journal interaction does not reallocate same-sized canvas backings on every paint', () => {
  let allocations=0,width=0,height=0;
  const canvas = {get width(){return width;},set width(v){width=Math.trunc(v);allocations++;},
    get height(){return height;},set height(v){height=Math.trunc(v);allocations++;},
    getBoundingClientRect:()=>({width:317,height:243}),getContext:()=>({scale(){},setTransform(){},clearRect(){},fillRect(){}})};
  const c={chartState:{canvas,candles:[]},window:{devicePixelRatio:1.25},document:{hidden:false}};
  vm.createContext(c);vm.runInContext(block(read('journal.js'),'renderInteractiveChart'),c);
  for(let i=0;i<100;i++)c.renderInteractiveChart();
  assert.equal(allocations,2,`same canvas dimensions allocated ${allocations} times`);
  c.window.devicePixelRatio=2;c.renderInteractiveChart();assert.equal(allocations,4);
});

test('backtest draw bursts coalesce into one display frame and hidden views do not paint', () => {
  let paints=0;const queued=[];
  const source=read('backtest.js'), start=source.indexOf('  function draw() {'), stop=source.indexOf('    // Dynamic price scale grid',start);
  const c={window:{},document:{hidden:false,documentElement:{dataset:{}}},state:{},canvas:{},volCv:null,vCtx:null,
    $:id=>id==='backtest-view'?{style:{display:'flex'}}:null,
    metrics:()=>({w:800,h:600}),ctx:{clearRect(){},fillRect(){paints++;}},requestAnimationFrame:fn=>{queued.push(fn);return queued.length;}};
  vm.createContext(c);
  const scheduler=source.includes('  function paint() {')?source.slice(start,source.indexOf('  function paint() {',start)):'';
  const paintStart=source.includes('  function paint() {')?source.indexOf('  function paint() {'):start;
  const paint=source.slice(paintStart,stop)+'\n  }';
  vm.runInContext('let drawQueued = false;\n'+scheduler+paint,c);
  for(let i=0;i<100;i++)c.draw();
  assert.equal(paints,0,'events should invalidate, not synchronously repaint');assert.equal(queued.length,1);
  queued.shift()();assert.equal(paints,1);
  c.document.hidden=true;c.draw();queued.splice(0).forEach(fn=>fn());assert.equal(paints,1);
});

test('events search bursts preserve the calendar until one frame paints the latest query', async t => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,frames=[];
  w.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};
  w.EventSource=class{addEventListener(){}close(){}};
  w.fetch=async()=>({ok:true,json:async()=>({news:[],listings:[],unlocks:{rows:[]}})});
  w.eval(read('events.js'));w.document.getElementById('events-view').style.display='block';w.ObsidianEvents.activate();
  await new Promise(resolve=>setImmediate(resolve));w.document.getElementById('events-tab-unlocks').click();
  const calendar=w.document.getElementById('events-unlocks-calendar'), retained=calendar.firstElementChild;
  const input=w.document.getElementById('events-unlocks-search');
  for(let i=0;i<30;i++){input.value='TOKEN'+i;input.dispatchEvent(new w.Event('input',{bubbles:true}));}
  assert.equal(calendar.firstElementChild,retained,'typing must not rebuild the calendar synchronously');
  assert.equal(frames.length,1);frames.shift()();assert.notEqual(calendar.firstElementChild,retained);
  w.ObsidianEvents.stopAlerts();
});

test('closed diagnostics do not rebuild hidden DOM or enumerate the symbol dictionary',()=>{
  const source=read('app.js'),start=source.indexOf('    // Patch ws after connect'),end=source.indexOf('  })();',start);
  let timer,writes=0,enumerations=0;
  const c={connectWS(){},ws:{readyState:1},dbg:{style:{display:'none'},set innerHTML(v){writes++;}},
    document:{hidden:false},coins:new Map(),dirty:new Set(),idToKey:new Proxy({},{ownKeys(){enumerations++;return[];}}),
    msgCount:0,binCount:0,lastWsMsg:0,setInterval(fn){timer=fn;}};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);
  for(let i=0;i<100;i++)timer();assert.equal(writes,0);assert.equal(enumerations,0);
  c.dbg.style.display='block';timer();assert.equal(writes,1);assert.equal(enumerations,1);
});

test('equity hover reuses current filtered trades and canvas memory without hiding changed totals',()=>{
  let queries=0,allocations=0,width=0,height=0;
  const ctx=new Proxy({createLinearGradient:()=>({addColorStop(){}}),measureText:()=>({width:10})},{get:(target,key)=>key in target?target[key]:()=>{}});
  const canvas={get width(){return width;},set width(v){width=Math.trunc(v);allocations++;},get height(){return height;},set height(v){height=Math.trunc(v);allocations++;},
    getContext:()=>ctx,getBoundingClientRect:()=>({width:800,height:240})};
  const c={window:{devicePixelRatio:1.25},document:{getElementById:()=>canvas},equityHoverIndex:-1,
    attachEquityCanvasListeners(){},drawSmoothPath(){},getFilteredTrades(){queries++;return[{pnl:10,date:'2026-10-01',symbol:'BTCUSDT',side:'long',pnlPercent:1}];}};
  const source=read('journal.js');vm.createContext(c);
  vm.runInContext(block(source,'getEquityPoints')+'\n'+block(source,'drawEquityChart'),c);
  c.drawEquityChart();for(let i=0;i<30;i++)c.drawEquityChart(true);
  assert.equal(queries,1,'hover must not refilter and resort unchanged trades');assert.equal(allocations,2);
  c.getFilteredTrades=()=>[{pnl:25,date:'2026-10-01',symbol:'BTCUSDT',side:'long',pnlPercent:2.5}];
  c.drawEquityChart();assert.equal(canvas._equityPoints.at(-1).pnl,25,'normal data invalidation rebuilds totals');
});

test('screener panel resizing coalesces forced chart layout reads per display frame',()=>{
  let layouts=0;const frames=[];const source=read('app.js');
  const start=source.indexOf('  window.onmousemove = (e) => {',source.indexOf('// Resizer logic'));
  const end=source.indexOf('  window.onmouseup',start);
  const c={window:{},document:{hidden:false},requestAnimationFrame:fn=>frames.push(fn),resizeChart(){layouts++;},
    isDragging:true,startX:100,startWidth:400,RP_MIN_WIDTH:120,RP_MAX_WIDTH:1100,rp:{style:{}},main:{classList:{add(){},remove(){}}}};
  vm.createContext(c);
  const queue=/function queueChartResize\([^]*?\n\}/.exec(source)?.[0]||'';
  vm.runInContext('let chartResizeQueued = false;\n'+queue+'\n'+source.slice(start,end),c);
  for(let i=0;i<100;i++)c.window.onmousemove({clientX:101+i});
  assert.equal(layouts,0,'pointer events must not force synchronous layout');assert.equal(frames.length,1);
  frames.shift()();assert.equal(layouts,1);assert.equal(c.rp.style.width,'300px');
});

test('arbitrage sparklines paint only intersecting rows and release removed canvases',t=>{
  const {c,rows,body}=arbitrage(t);let callback,paints=0;const observed=new Set(),frames=[];
  c.window.IntersectionObserver=class{constructor(fn){callback=fn;}observe(canvas){observed.add(canvas);}unobserve(canvas){observed.delete(canvas);}};
  c.requestAnimationFrame=fn=>frames.push(fn);c.drawLine=()=>{paints++;};
  const source=read('arbitrage.js');
  vm.runInContext('let sparkObserver = null, sparkDrawQueued = false; const visibleSparks = new Set();\n'+block(source,'scheduleSparks')+'\n'+block(source,'drawSparks'),c);
  c.renderSpreads(rows);const canvases=[...body.querySelectorAll('canvas')];
  assert.equal(observed.size,400);callback(canvases.map((target,i)=>({target,isIntersecting:i<8})));
  frames.splice(0).forEach(fn=>fn());assert.equal(paints,8,'the other 392 sparklines are off screen');
  c.renderSpreads([]);assert.equal(observed.size,0);
});

test('journal pointer bursts coalesce and a closed or replaced chart cannot paint late',()=>{
  let paints=0;const frames=[],canvas={isConnected:true,clientWidth:800,clientHeight:400};
  const c={chartState:{canvas},document:{hidden:false},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},renderInteractiveChart(){paints++;}};
  vm.createContext(c);vm.runInContext('let interactiveDrawFrame = null, interactiveDrawCanvas = null;\n'+block(read('journal.js'),'requestInteractiveChartDraw'),c);
  for(let i=0;i<100;i++)c.requestInteractiveChartDraw();assert.equal(frames.length,1);assert.equal(paints,0);
  frames.shift()();assert.equal(paints,1);
  c.requestInteractiveChartDraw();canvas.isConnected=false;frames.shift()();assert.equal(paints,1);
  canvas.isConnected=true;c.requestInteractiveChartDraw();c.chartState.canvas={};frames.shift()();assert.equal(paints,1);
});
