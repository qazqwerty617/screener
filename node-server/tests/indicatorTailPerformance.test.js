'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const names=['calcEMA','calcBB','calcVolumeSMA','calcVWAP','calcRSI','calcATR','calcMACD','calcCVD','clearCandleCaches'];
const c=vm.createContext({formationDetectionCache:new WeakMap()});
vm.runInContext(names.map(name=>source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n'),c);
const bars=(n=4000)=>Array.from({length:n},(_,i)=>({t:1700000000000+i*60000,o:100+i/100,h:102+i/100,l:98+i/100,c:100+Math.sin(i)+i/100,v:1000+i}));
function compare(actual,expected) {
  const arrays=Array.isArray(actual)?[[actual,expected]]:['macd','signal','hist'].map(k=>[actual[k],expected[k]]);
  for(const [a,b] of arrays) {
    assert.equal(a.length,b.length);
    for(let i=0;i<a.length;i++) {
      if(a[i]===null||b[i]===null) {assert.equal(a[i],b[i]);continue;}
      for(const key of typeof a[i]==='object'?['middle','upper','lower']:[null]) {
        const x=key?a[i][key]:a[i],y=key?b[i][key]:b[i];
        assert.ok(Math.abs(x-y)<=1e-9*Math.max(1,Math.abs(y)),`${i} ${key}: ${x} !== ${y}`);
      }
    }
  }
}
for(const name of names.filter(n=>n.startsWith('calc'))) {
  test(`${name}: 50 live updates reuse closed history and match a full recalculation`,()=>{
    let reads=0;const data=bars().map(bar=>new Proxy(bar,{get(obj,key){reads++;return obj[key];}}));
    c[name](data,20);reads=0;
    const reference=bars();
    for(let i=0;i<50;i++) {
      Object.assign(data.at(-1),{c:140+Math.sin(i),h:143+i/10,l:137-i/10,v:5000+i});
      Object.assign(reference.at(-1),{c:140+Math.sin(i),h:143+i/10,l:137-i/10,v:5000+i});
      compare(c[name](data,20),c[name](reference.map(bar=>({...bar})),20));
    }
    assert.ok(reads<12000,`${reads} candle fields read; closed history was repeatedly recalculated`);
  });
  test(`${name}: prepend, append, rollover and closed-candle correction invalidate cached results`,()=>{
    const data=bars(80);c[name](data,20);
    data.unshift({...data[0],t:data[0].t-60000,c:99});compare(c[name](data,20),c[name](data.map(bar=>({...bar})),20));
    data.push({...data.at(-1),t:data.at(-1).t+60000,c:101});compare(c[name](data,20),c[name](data.map(bar=>({...bar})),20));
    data.shift();compare(c[name](data,20),c[name](data.map(bar=>({...bar})),20));
    data[15].c=120;data[15].h=121;c.clearCandleCaches(data);
    compare(c[name](data,20),c[name](data.map(bar=>({...bar})),20));
  });
}
test('ATR and CVD react when volume or wicks change without a close-price change',()=>{
  const data=bars(60);c.calcATR(data);c.calcCVD(data);
  data.at(-1).h+=5;data.at(-1).v*=2;
  compare(c.calcATR(data),c.calcATR(data.map(bar=>({...bar}))));
  compare(c.calcCVD(data),c.calcCVD(data.map(bar=>({...bar}))));
});
