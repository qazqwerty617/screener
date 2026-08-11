'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const pro = { row:null, isFunding:false, tf:'5m', mode:'best', depth:null, klines:null, depthLoading:false, requestId:0, initialized:false };

  function pct(n,d=3){return `${Number(n)>=0?'+':''}${Number(n||0).toFixed(d)}%`;}
  function price(n){n=Number(n)||0;if(n>=1000)return n.toLocaleString('en-US',{maximumFractionDigits:2});if(n>=1)return n.toFixed(4).replace(/0+$/,'').replace(/\.$/,'');return n?n.toPrecision(6).replace(/0+$/,'').replace(/\.$/,''):'—';}
  function money(n){n=Number(n)||0;if(n>=1e9)return `$${(n/1e9).toFixed(1)}B`;if(n>=1e6)return `$${(n/1e6).toFixed(1)}M`;if(n>=1e3)return `$${(n/1e3).toFixed(0)}K`;return `$${n.toFixed(0)}`;}
  function debounce(fn,wait){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),wait);};}
  function fundingDaily(r){if(pro.isFunding)return Number(r.daily)||0;return((Number(r.sellFunding)||0)/(Number(r.sellInterval)||8)-(Number(r.buyFunding)||0)/(Number(r.buyInterval)||8))*24;}
  function legs(r){return pro.isFunding?{buyEx:r.longEx,buyName:r.longName,buySymbol:r.longSymbol,buyPrice:r.longPrice||0,sellEx:r.shortEx,sellName:r.shortName,sellSymbol:r.shortSymbol,sellPrice:r.shortPrice||0}:{buyEx:r.buyEx,buyName:r.buyName,buySymbol:r.buySymbol,buyPrice:r.buyAsk,sellEx:r.sellEx,sellName:r.sellName,sellSymbol:r.sellSymbol,sellPrice:r.sellBid};}

  function init(){
    if(pro.initialized)return;pro.initialized=true;
    $('arb-notional').addEventListener('input',debounce(loadDepth,300));
    $('arb-impact-limit').addEventListener('change',renderDepth);
    document.querySelectorAll('[data-arb-size]').forEach(btn=>btn.addEventListener('click',()=>{$('arb-notional').value=btn.dataset.arbSize;document.querySelectorAll('[data-arb-size]').forEach(x=>x.classList.toggle('on',x===btn));loadDepth();}));
    document.querySelectorAll('[data-arb-tf]').forEach(btn=>btn.addEventListener('click',()=>{pro.tf=btn.dataset.arbTf;document.querySelectorAll('[data-arb-tf]').forEach(x=>x.classList.toggle('on',x===btn));loadCharts();}));
    document.querySelectorAll('[data-spread-mode]').forEach(btn=>btn.addEventListener('click',()=>{pro.mode=btn.dataset.spreadMode;document.querySelectorAll('[data-spread-mode]').forEach(x=>x.classList.toggle('on',x===btn));renderCharts();}));
  }

  function open(row,isFunding){
    init();pro.row=row;pro.isFunding=isFunding;pro.depth=null;pro.klines=null;pro.mode='best';pro.requestId++;
    $('arb-drawer').scrollTop=0;
    $('arb-execution').style.display=isFunding?'none':'block';
    document.querySelectorAll('[data-spread-mode]').forEach(x=>x.classList.toggle('on',x.dataset.spreadMode==='best'));
    const l=legs(row);
    $('arb-buy-chart-title').textContent=`${l.buyName} · ${row.base}`;$('arb-sell-chart-title').textContent=`${l.sellName} · ${row.base}`;
    $('arb-buy-chart-price').textContent=price(l.buyPrice);$('arb-sell-chart-price').textContent=price(l.sellPrice);
    $('arb-chart-current').textContent=pct(isFunding?row.basis:row.net);$('arb-chart-funding').textContent=pct(fundingDaily(row),4);
    $('arb-chart-empty').textContent='Загружаем историю обеих бирж…';$('arb-chart-empty').hidden=false;
    loadCharts();if(!isFunding)loadDepth();
  }

  function close(){pro.row=null;pro.depth=null;pro.klines=null;pro.requestId++;}

  async function loadDepth(){
    const r=pro.row;if(!r||pro.isFunding||pro.depthLoading)return;const requestId=pro.requestId;
    const notional=Math.max(10,Math.min(1000000,Number($('arb-notional').value)||500));
    pro.depthLoading=true;$('arb-depth-state').textContent='СТАКАНЫ…';$('arb-depth-state').className='';
    try{const res=await fetch(`/api/arbitrage/depth?key=${encodeURIComponent(r.key)}&notional=${encodeURIComponent(notional)}`,{cache:'no-store'});const data=await res.json();if(!res.ok)throw new Error(data.detail||data.error||`HTTP ${res.status}`);if(pro.requestId!==requestId)return;pro.depth=data;renderDepth();$('arb-depth-state').textContent=data.complete?'ИСПОЛНИМО':'НЕПОЛНЫЙ ОБЪЁМ';$('arb-depth-state').className=data.complete?'ready':'error';}
    catch(_){if(pro.requestId!==requestId)return;pro.depth=null;renderDepth();$('arb-depth-state').textContent='СТАКАН НЕДОСТУПЕН';$('arb-depth-state').className='error';}
    finally{pro.depthLoading=false;}
  }

  function renderDepth(){
    const d=pro.depth;if(!d){['arb-safe-volume','arb-depth-buy','arb-depth-sell','arb-depth-net','arb-depth-funded','arb-depth-pnl'].forEach(id=>$(id).textContent='—');$('arb-depth-fill').style.width='0';$('arb-depth-marker').style.left='0';return;}
    const impact=Number($('arb-impact-limit').value)||.1,band=d.bands.find(x=>Number(x.impact)===impact)||d.bands[1],safe=Number(band?.notional)||0,requested=Number(d.requestedNotional)||0;
    $('arb-safe-volume').textContent=money(safe);$('arb-depth-buy').textContent=price(d.buy.average);$('arb-depth-buy-impact').textContent=`проскальзывание ${pct(d.buy.impactPct,4)}`;
    $('arb-depth-sell').textContent=price(d.sell.average);$('arb-depth-sell-impact').textContent=`проскальзывание ${pct(d.sell.impactPct,4)}`;
    $('arb-depth-net').textContent=pct(d.netPct);$('arb-depth-funded').textContent=pct(d.netAfterFundingDayPct);$('arb-depth-pnl').textContent=`${d.complete?'≈':'до'} ${money(d.estimatedPnlAfterFundingDay)} PnL`;
    const ratio=safe>0?Math.min(1,requested/safe):1;$('arb-depth-fill').style.width=`${ratio*100}%`;$('arb-depth-marker').style.left=`${Math.min(99,ratio*100)}%`;renderCharts();
  }

  function flatCandles(flat){const out=[];for(let i=0;Array.isArray(flat)&&i+5<flat.length;i+=6){const c={t:+flat[i],o:+flat[i+1],h:+flat[i+2],l:+flat[i+3],c:+flat[i+4],v:+flat[i+5]};if(c.t&&c.o>0&&c.h>0&&c.l>0&&c.c>0)out.push(c);}return out;}
  async function loadCharts(){
    const r=pro.row;if(!r)return;const requestId=pro.requestId,tf=pro.tf,l=legs(r);$('arb-chart-empty').hidden=false;$('arb-chart-empty').textContent='Загружаем историю обеих бирж…';
    try{const [br,sr]=await Promise.all([fetch(`/api/klines?ex=${encodeURIComponent(l.buyEx)}&sym=${encodeURIComponent(l.buySymbol)}&tf=${encodeURIComponent(tf)}&lite=1`,{cache:'no-store'}),fetch(`/api/klines?ex=${encodeURIComponent(l.sellEx)}&sym=${encodeURIComponent(l.sellSymbol)}&tf=${encodeURIComponent(tf)}&lite=1`,{cache:'no-store'})]);if(!br.ok||!sr.ok)throw new Error('klines');const [bf,sf]=await Promise.all([br.json(),sr.json()]);if(pro.requestId!==requestId||pro.tf!==tf)return;pro.klines={buy:flatCandles(bf),sell:flatCandles(sf)};$('arb-chart-empty').hidden=pro.klines.buy.length>1&&pro.klines.sell.length>1;renderCharts();}
    catch(_){if(pro.requestId===requestId){$('arb-chart-empty').textContent='История одной из бирж временно недоступна';$('arb-chart-empty').hidden=false;}}
  }

  function renderCharts(){
    const r=pro.row,k=pro.klines;if(!r||!k)return;const sm=new Map(k.sell.map(c=>[c.t,c]));let points=k.buy.map(b=>{const s=sm.get(b.t);return s&&b.c>0?[b.t,((s.c-b.c)/b.c)*100-(pro.isFunding?0:r.fees)]:null;}).filter(Boolean);
    if(pro.mode==='volume'&&pro.depth&&!pro.isFunding){const offset=pro.depth.netPct-r.net;points=points.map(p=>[p[0],p[1]+offset]);}
    drawSpread($('arb-detail-canvas'),points,fundingDaily(r));drawCandles($('arb-buy-chart'),k.buy,'#2bd98a');drawCandles($('arb-sell-chart'),k.sell,'#ef647a');
  }

  function fit(canvas,height){const dpr=Math.min(2,devicePixelRatio||1),w=Math.max(260,canvas.clientWidth||500);canvas.width=Math.round(w*dpr);canvas.height=Math.round(height*dpr);return{ctx:canvas.getContext('2d'),w:canvas.width,h:canvas.height,dpr};}
  function drawSpread(canvas,points,funding){const{ctx,w,h,dpr}=fit(canvas,220);ctx.clearRect(0,0,w,h);if(points.length<2)return;points=points.slice(-180);const vals=points.map(p=>p[1]),mn=Math.min(...vals,0),mx=Math.max(...vals,0),range=mx-mn||.01,pad={l:42*dpr,r:12*dpr,t:15*dpr,b:24*dpr},x=i=>pad.l+i*(w-pad.l-pad.r)/(points.length-1),y=v=>pad.t+(mx-v)*(h-pad.t-pad.b)/range;ctx.font=`${8*dpr}px Inter`;ctx.strokeStyle='#202632';ctx.fillStyle='#697382';ctx.lineWidth=dpr;for(let i=0;i<5;i++){const v=mx-range*i/4,yy=y(v);ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.fillText(`${v.toFixed(2)}%`,3*dpr,yy+3*dpr);}const zy=y(0);ctx.strokeStyle='#586171';ctx.setLineDash([4*dpr,4*dpr]);ctx.beginPath();ctx.moveTo(pad.l,zy);ctx.lineTo(w-pad.r,zy);ctx.stroke();ctx.setLineDash([]);const grad=ctx.createLinearGradient(pad.l,0,w-pad.r,0);grad.addColorStop(0,'#8b5cf6');grad.addColorStop(1,'#2bd98a');ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(x(i),y(p[1])):ctx.moveTo(x(i),y(p[1])));ctx.strokeStyle=grad;ctx.lineWidth=2*dpr;ctx.stroke();ctx.lineTo(x(points.length-1),h-pad.b);ctx.lineTo(x(0),h-pad.b);ctx.closePath();const fill=ctx.createLinearGradient(0,pad.t,0,h-pad.b);fill.addColorStop(0,'rgba(139,92,246,.2)');fill.addColorStop(1,'rgba(43,217,138,0)');ctx.fillStyle=fill;ctx.fill();ctx.fillStyle='#677181';[0,Math.floor(points.length/2),points.length-1].forEach(i=>ctx.fillText(new Date(points[i][0]).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),x(i)-15*dpr,h-6*dpr));$('arb-chart-current').textContent=pct(vals.at(-1));$('arb-chart-funding').textContent=pct(funding,4);}
  function drawCandles(canvas,candles,accent){const{ctx,w,h,dpr}=fit(canvas,130);ctx.clearRect(0,0,w,h);const list=candles.slice(-70);if(list.length<2)return;const mn=Math.min(...list.map(c=>c.l)),mx=Math.max(...list.map(c=>c.h)),range=mx-mn||1,pad=8*dpr,cw=(w-pad*2)/list.length,y=v=>pad+(mx-v)*(h-pad*2)/range;ctx.strokeStyle='#1d2330';for(let i=1;i<4;i++){const yy=h*i/4;ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(w,yy);ctx.stroke();}list.forEach((c,i)=>{const xx=pad+i*cw+cw/2,up=c.c>=c.o,col=up?'#2bd98a':'#ef647a';ctx.strokeStyle=col;ctx.beginPath();ctx.moveTo(xx,y(c.h));ctx.lineTo(xx,y(c.l));ctx.stroke();ctx.fillStyle=col;const top=Math.min(y(c.o),y(c.c)),bh=Math.max(1.5*dpr,Math.abs(y(c.o)-y(c.c)));ctx.fillRect(xx-Math.max(1,cw*.3),top,Math.max(2,cw*.6),bh);});ctx.fillStyle=accent;ctx.fillRect(w-3*dpr,0,3*dpr,h);}

  window.ArbitragePro={open,close};
})();
