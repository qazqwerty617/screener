const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const begin = source.indexOf('function drawChart() {');
const end = source.indexOf('  // Calculate active indicators', begin);

test('the hidden main canvas does not paint behind the multichart view', () => {
  let paints=0;
  const ctx={document:{hidden:false},chartW:800,chartH:600,activeView:'screener',screenerView:'multichart',window:{},candles:[{}],isLoadingKlines:false,
    painted(){paints++;}};
  vm.runInNewContext(source.slice(begin,end)+'painted();\n}\ndrawChart();',ctx);
  assert.equal(paints,0);
  ctx.window.isFormationFullChartOpen=()=>true;
  vm.runInNewContext(source.slice(begin,end)+'painted();\n}\ndrawChart();',ctx);
  assert.equal(paints,1,'a borrowed main chart still paints');
});

function clock() {
  let callback, now=1100;
  const ctx={document:{hidden:false},activeView:'screener',screenerView:'chart',window:{},candles:[{}],chartNeedsDraw:false,
    Date:{now:()=>now},drawChart:Object.assign(()=>{}, {lastClockSecond:1}),setInterval(fn){callback=fn;},requestDraw(){ctx.chartNeedsDraw=true;}};
  const start=source.indexOf('  // Periodic safety redraw');
  const end=source.indexOf('  // Refresh only when visible',start);
  assert.ok(start>0&&end>start);
  vm.createContext(ctx);
  if(source.includes('function refreshMainChartClock(')) vm.runInContext(/function refreshMainChartClock\([^]*?\n\}/.exec(source)[0],ctx);
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,run(ms){now=ms;callback();}};
}

test('clock safety updates do not repaint a second already drawn by the live stream', () => {
  const h=clock();h.run(1500);assert.equal(h.ctx.chartNeedsDraw,false);
  h.run(2000);assert.equal(h.ctx.chartNeedsDraw,true);
  h.ctx.chartNeedsDraw=false;h.ctx.drawChart.lastClockSecond=2;
  h.run(2500);assert.equal(h.ctx.chartNeedsDraw,false);
});

test('clock safety skips hidden and multichart canvases while supporting expanded formations', () => {
  const h=clock();h.ctx.screenerView='multichart';h.run(2000);assert.equal(h.ctx.chartNeedsDraw,false);
  h.ctx.activeView='formations';h.ctx.window.isFormationFullChartOpen=()=>true;
  h.run(2000);assert.equal(h.ctx.chartNeedsDraw,true);
  h.ctx.chartNeedsDraw=false;h.ctx.document.hidden=true;h.run(3000);assert.equal(h.ctx.chartNeedsDraw,false);
});
