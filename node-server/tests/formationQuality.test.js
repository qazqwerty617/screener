'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const engine = require('../public/js/formationEngine');
function waves(count = 400, scale = 1) {
  return Array.from({length: count}, (_, i) => {
    const c = 100 + 10 * Math.cos(i * Math.PI / 50), o = 100 + 10 * Math.cos((i-1) * Math.PI / 50);
    return {t: 1700000000000 + i * 60000, o: o*scale, h: (Math.max(o,c)+.1)*scale,
      l: (Math.min(o,c)-.1)*scale, c: c*scale, v: 100};
  });
}
const detectors = ['detectHorizontals', 'detectCascades', 'detectTrendlines', 'detectRetests', 'detectApproachingRetests', 'detectRanges'];
for (const fault of ['null', 'NaN', 'Infinity', 'badOHLC', 'duplicate', 'gap', 'reverse']) test(`every detector rejects incomplete or invalid history: ${fault}`, () => {
  const cs = waves();
  if (fault === 'null') cs[250] = null;
  if (fault === 'NaN') cs[250].h = NaN;
  if (fault === 'Infinity') cs[250].h = Infinity;
  if (fault === 'badOHLC') cs[250].h = cs[250].l - 1;
  if (fault === 'duplicate') cs[250].t = cs[249].t;
  if (fault === 'gap') cs.splice(250, 2);
  if (fault === 'reverse') cs.reverse();
  for (const name of detectors) assert.deepEqual(engine[name](cs, 2), [], name);
  for (const rows of Object.values(engine.scanAll(cs, 2))) assert.deepEqual(rows, []);
});
for (const name of ['detectHorizontals', 'detectCascades']) test(`${name} rejects an unconfirmed wick breakout at every price scale`, () => {
  for (const scale of [1, 1e-9, 1e6]) {
    const cs = waves(400, scale); assert.ok(engine[name](cs, 2).length);
    cs.at(-1).h = 120 * scale;
    assert.equal(engine[name](cs, 2).filter(l=>l.direction==='up').length, 0, `wick breakout at scale ${scale}`);
  }
});
test('the primary trendline anchors must be separate visits with a meaningful departure', () => {
  const cs = Array.from({length: 300}, (_, i) => {
    const roof = 105 - .0015 * i;
    return {t: 1700000000000 + i * 60000, o: roof-.075, c: roof-.075, h: roof-.07, l: roof-.09, v: 100};
  });
  for (const i of [70, 220]) cs[i].h = 105 - .0015 * i;
  assert.equal(engine.detectTrendlines(cs, 2).length, 0, 'hovering along the line is not two independent visits');
});

test('an extra pivot beside the second anchor cannot manufacture a third trendline visit',()=>{
  const cs=Array.from({length:90},(_,i)=>({t:1700000000000+i*60000,o:100,c:100,h:100.4,l:99.6}));
  for(const i of [10,50,60]) cs[i].h=105-.01*(i-10);
  for(let i=51;i<60;i++) cs[i].h=105-.01*(i-10)-.04;
  cs.at(-1).c=103.5; cs.at(-1).h=103.5;
  assert.ok(engine.detectTrendlines(cs,2).length,'two genuine visits still form a valid line');
  assert.equal(engine.detectTrendlines(cs,3).length,0,'nearby pivots without a second departure are the same visit');
});

test('pinbar-only retests retain the same reaction at tiny token prices', () => {
  const cs = Array.from({length:75}, (_,i)=>({t:1700000000000+i*60000,o:100,h:100.4,l:99.6,c:100}));
  for (const i of [12,30]) cs[i] = {...cs[i],h:105,c:103.8};
  for (let i=40;i<65;i++) cs[i] = {...cs[i],o:106,h:106.5,l:105.6,c:106};
  cs[40] = {...cs[40],o:104.8,c:106,h:106.2,l:104.7};
  cs[43] = {...cs[43],h:108,c:107};
  cs[65] = {...cs[65],o:105.06,c:105.03,h:105.07,l:104.95};
  for (let i=66;i<75;i++) cs[i] = {...cs[i],o:105.03,c:105.03,h:105.08,l:105};
  assert.ok(engine.detectRetests(cs).some(r=>r.touchIdx===65));
  const small = cs.map(c=>({...c,o:c.o*1e-12,h:c.h*1e-12,l:c.l*1e-12,c:c.c*1e-12}));
  assert.ok(engine.detectRetests(small).some(r=>r.touchIdx===65));
});
test('long history detection keeps original timestamps and bounds its candle work', () => {
  let reads = 0;
  const raw = waves(20000).map(c=>new Proxy(c, {get(o,k) {if(['t','o','h','l','c'].includes(k)) reads++; return o[k];}}));
  const results = engine.scanAll(raw, 2);
  assert.ok(results.ranges.length);
  for (const rows of Object.values(results)) for (const level of rows) {
    for (const [i, time] of (level.touchIndices || level.swingIndices || []).map((i,k)=>[i,level.touchTimes[k]])) {
      assert.equal(raw[i].t, time, 'returned indices must refer to the caller history');
    }
  }
  assert.ok(reads < raw.length * 30, `unbounded historical candle work: ${reads} reads`);
});
