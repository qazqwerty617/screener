(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const en = () => window.ObsidianI18n?.language === 'en';
  const t = (ru, english) => en() ? english : ru;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const n = (value, digits = 8) => {
    if(value == null || !Number.isFinite(value))return '—';
    if(value!==0&&Math.abs(value)<10**-digits)return Math.abs(value)<1e-12?value.toExponential(4):value.toLocaleString('en-US',{maximumSignificantDigits:6});
    return value.toLocaleString('en-US',{maximumFractionDigits:digits});
  };
  const pct = value => value == null ? '—' : `${value >= 0 ? '+' : ''}${n(value,3)}%`;
  const usd = value => value == null ? '—' : `${n(value,2)} USDT`;
  const duration = ms => {
    if(ms==null||!Number.isFinite(ms))return '—';
    const seconds = Math.floor(Math.max(0,ms || 0)/1000);
    if (seconds < 60) return `${seconds}${t('с','s')}`;
    const minutes = Math.floor(seconds/60);
    return minutes < 60 ? `${minutes}${t('м','m')} ${seconds%60}${t('с','s')}` : `${Math.floor(minutes/60)}${t('ч','h')} ${minutes%60}${t('м','m')}`;
  };
  const reasons = {
    buy_depth:['Не хватает глубины покупки','Insufficient buy depth'],sell_depth:['Не хватает глубины продажи','Insufficient sell depth'],
    transfer_unknown:['Нет подтверждённой сети перевода','No confirmed transfer network'],identity_unverified:['Контракт актива не подтверждён обеими биржами','Asset contract not confirmed on both venues'],
    withdraw_fee_unknown:['Биржа не раскрывает комиссию вывода','Withdrawal fee unavailable'],variable_fee:['Есть дополнительная комиссия; её формула не подтверждена','Additional fee formula unconfirmed'],
    withdraw_min:['Сумма ниже минимума вывода','Below minimum withdrawal'],deposit_min:['Сумма ниже минимума депозита','Below minimum deposit'],
    withdraw_fee_exceeds:['Комиссия вывода превышает сумму','Withdrawal fee exceeds amount'],
  };
  let initialized=false,active=false,rows=new Map(),key=null,quote=null,quoteAt=0,sequence=0,controller=null;
  let patch,refresh,hoverTimer,closeTimer,refreshTimer,anchor=null,lastPayload=null,lastFavorites=null;
  const pop = () => $('arb-spot-popover'), dialog = () => $('arb-spot-dialog');
  const isDialog = () => dialog()?.hasAttribute('open');
  function parameters() {
    const inputs=['arb-spot-notional','arb-spot-buy-fee','arb-spot-sell-fee'].map($);
    if(inputs.some(input=>input&&!input.checkValidity()))return null;
    const out={notional:$('arb-spot-notional')?.value || '500'};
    for (const field of ['buyFeePct','sellFeePct']) {
      const value=$(field==='buyFeePct'?'arb-spot-buy-fee':'arb-spot-sell-fee')?.value;
      if(value !== undefined && value !== '') out[field]=value;
    }
    return out;
  }
  function setActive(value) {
    active=value;
    if(!value) close();
    $('arb-spot-controls').hidden=!value;
    if(value) init();
  }
  function init() {
    if(initialized)return;initialized=true;
    const body=$('arb-spot-body');
    body.addEventListener('pointerover',event=>{
      if(event.pointerType==='touch')return;
      const row=event.target.closest('tr[data-spot-key]');
      if(row&&!row.contains(event.relatedTarget))schedule(row);
    });
    body.addEventListener('pointerout',event=>{
      const row=event.target.closest('tr[data-spot-key]');
      if(row&&!row.contains(event.relatedTarget)&&!pop().contains(event.relatedTarget))closeSoon();
    });
    body.addEventListener('focusin',event=>{const row=event.target.closest('tr[data-spot-key]');if(row)schedule(row,0);});
    body.addEventListener('focusout',event=>{if(!body.contains(event.relatedTarget)&&!pop().contains(event.relatedTarget))closeSoon();});
    body.addEventListener('click',event=>{
      if(event.target.closest('[data-fav]'))return;
      const row=event.target.closest('tr[data-spot-key]');if(row)open(row.dataset.spotKey,row);
    });
    body.addEventListener('keydown',event=>{
      if((event.key==='Enter'||event.key===' ')&&event.target.matches('tr[data-spot-key]')){event.preventDefault();open(event.target.dataset.spotKey,event.target);}
    });
    pop().addEventListener('pointerenter',()=>clearTimeout(closeTimer));
    pop().addEventListener('pointerleave',closeSoon);
    pop().addEventListener('click',event=>{if(event.target.closest('[data-spot-open]'))open(key,anchor);});
    dialog().addEventListener('click',event=>{if(event.target===dialog()||event.target.closest('[data-spot-close]'))close();});
    dialog().addEventListener('cancel',()=>close());
    dialog().addEventListener('change',event=>{if(event.target.matches('[data-spot-network]')){quote=null;void load(true);}});
    let inputTimer;
    for(const id of ['arb-spot-notional','arb-spot-buy-fee','arb-spot-sell-fee'])$(id).addEventListener('input',()=>{
      clearTimeout(inputTimer);invalidate();inputTimer=setTimeout(()=>{if(active){refresh?.();if(key)void load(true);}},250);
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});
    window.addEventListener('resize',()=>{if(!isDialog())close();});
    window.addEventListener('obsidian:languagechange',()=>{if(active&&lastPayload)render(lastPayload,lastFavorites);});
  }
  function watch(){
    if(refreshTimer)return;
    refreshTimer=setInterval(()=>{
      if(!active||document.hidden||!key)return;
      const row=rows.get(key);
      if(!row||Date.now()-Math.min(row.buyAt,row.sellAt)>15000){invalidate();paint(t('Котировки устарели. Обновите таблицу.','Quotes expired. Refresh the table.'));return;}
      if(Date.now()-quoteAt>4000)void load(false);
    },2000);
  }
  function invalidate(){sequence++;controller?.abort();controller=null;quote=null;quoteAt=0;}
  function close(){
    clearTimeout(hoverTimer);clearTimeout(closeTimer);clearInterval(refreshTimer);refreshTimer=null;
    invalidate();key=null;anchor=null;pop()?.setAttribute('hidden','');
    if(isDialog()){if(dialog().close)dialog().close();else dialog().removeAttribute('open');}
  }
  function closeSoon(){clearTimeout(hoverTimer);clearTimeout(closeTimer);closeTimer=setTimeout(()=>{if(!isDialog())close();},160);}
  function schedule(row,wait=160){
    clearTimeout(closeTimer);clearTimeout(hoverTimer);if(isDialog())return;
    hoverTimer=setTimeout(()=>show(row.dataset.spotKey,row),wait);
  }
  function show(nextKey,row){
    if(!active||!rows.has(nextKey))return;
    if(key!==nextKey){invalidate();key=nextKey;}
    anchor=row;pop().hidden=false;paint();position();watch();void load(false);
  }
  function open(nextKey,row){
    if(!rows.has(nextKey))return;
    show(nextKey,row);pop().hidden=true;
    if(!isDialog()){if(dialog().showModal)dialog().showModal();else dialog().setAttribute('open','');}
    paint();void load(false);
  }
  function position(){
    if(!anchor||pop().hidden)return;
    const rect=anchor.getBoundingClientRect(),height=pop().offsetHeight,width=pop().offsetWidth;
    pop().style.left=`${Math.max(8,Math.min(rect.left+90,window.innerWidth-width-8))}px`;
    pop().style.top=`${Math.max(8,Math.min(rect.bottom+7,window.innerHeight-height-8))}px`;
  }
  async function load(force){
    if(!active||!key||controller||!force&&quote&&Date.now()-quoteAt<4000)return;
    const values=parameters();if(!values){close();invalidParameters();return;}
    const currentKey=key,version=++sequence,abort=new AbortController();controller=abort;
    const timeout=setTimeout(()=>abort.abort(),12000);
    const params=new URLSearchParams({...values,key:currentKey});
    const network=isDialog()?dialog().querySelector('[data-spot-network]')?.value:null;
    if(network)params.set('network',network);
    let token='';try{token=window.getStoredAuthToken?.()||localStorage.getItem('obsidian_auth_token')||'';}catch(_){}
    try{
      const response=await fetch(`/api/arbitrage/spot/quote?${params}`,{cache:'no-store',signal:abort.signal,headers:token?{Authorization:`Bearer ${token}`}:{}});
      if(!response.ok)throw new Error('quote unavailable');
      const payload=await response.json();
      if(version!==sequence||key!==currentKey||!active)return;
      quote=payload;quoteAt=Date.now();paint();position();
    }catch(error){
      if(version===sequence&&active&&key===currentKey){quote=null;quoteAt=Date.now();paint(t('Стаканы недоступны — итог по объёму не подтверждён.','Books unavailable — size estimate unconfirmed.'));}
    }finally{clearTimeout(timeout);if(controller===abort)controller=null;}
  }
  function content(row,detail,error){
    const flow=row.flow,path=row.path,depth=row.estimate==='depth',expired=Date.now()-(row.generatedAt||Math.min(row.buyAt,row.sellAt))>(depth?5000:15000);
    const confirmed=flow.complete&&depth&&!expired;
    const list=(flow.reasons||[]).map(reason=>t(...(reasons[reason]||[reason,reason])));
    const line=(label,value)=>`<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    const network=path?`${path.network}${path.needTag?' · MEMO/TAG':''}`:t('Не подтверждена','Unconfirmed');
    const links=`<a href="${esc(row.buyUrl)}" target="_blank" rel="noopener noreferrer">${t('Купить на','Buy on')} ${esc(row.buyName)} ↗</a><a href="${esc(row.sellUrl)}" target="_blank" rel="noopener noreferrer">${t('Продать на','Sell on')} ${esc(row.sellName)} ↗</a>`;
    return `<div class="spot-route-head"><div><span>SPOT → SPOT · ${depth?'DEPTH':'BBO'}</span><h3>${esc(row.base)}/USDT</h3><p>${esc(row.buyName)} <i>→</i> ${esc(row.sellName)}</p></div><strong class="${confirmed&&flow.profitUsdt>0?'positive':''}">${confirmed?usd(flow.profitUsdt):t('Оценка','Estimate')}<small>${confirmed?pct(flow.netPct):pct(flow.netPct??flow.preTransferNetPct)}</small></strong></div>
      <div class="spot-route-meta"><span>${t('Спред живёт','Spread observed')} <b>${duration(row.spreadSince==null?null:Date.now()-row.spreadSince)}</b></span><span>BBO ${duration(row.ageMs)} · ${esc(row.spreadSamples)} ${t('набл.','samples')}</span></div>
      <ol class="spot-flow"><li><span class="spot-step">1</span><div><h4>${t('Покупка','Buy')} · ${esc(row.buyName)}</h4>${line(t('Бюджет','Budget'),usd(flow.notional))}${line(t('Средняя цена','Average price'),`${n(flow.buyAverage)} USDT`)}${line(t('Куплено','Bought'),`${n(flow.bought)} ${row.base}`)}${line(t('Комиссия покупки','Buy fee'),`${usd(flow.buyFeeUsdt)} · ${n(flow.buyFeePct,3)}%`)}${line(t('После комиссии','After fee'),`${n(flow.acquired)} ${row.base}`)}</div></li>
      <li><span class="spot-step">2</span><div><h4>${t('Перевод','Transfer')} · ${esc(network)}</h4>${line(t('Комиссия вывода','Withdrawal fee'),`${n(flow.withdrawFee)} ${row.base}${flow.withdrawFeeUsdt===null?'':` ≈ ${usd(flow.withdrawFeeUsdt)}`}`)}${line(t('Придёт на биржу','Arrives at venue'),`${n(flow.received)} ${row.base}`)}${path?.confirmations!=null?line(t('Подтверждения депозита','Deposit confirmations'),String(path.confirmations)):''}${detail&&path?line(t('Минимум вывода / депозита','Min withdrawal / deposit'),`${n(path.minWithdraw)} / ${n(path.minDeposit)} ${row.base}`):''}${flow.dust>0?line(t('Остаток из-за округления','Rounding dust'),`${n(flow.dust,12)} ${row.base}`):''}</div></li>
      <li><span class="spot-step">3</span><div><h4>${t('Продажа','Sell')} · ${esc(row.sellName)}</h4>${line(t('Количество','Quantity'),`${n(flow.sold)} ${row.base}`)}${line(t('Средняя цена','Average price'),`${n(flow.sellAverage)} USDT`)}${line(t('Комиссия продажи','Sell fee'),`${usd(flow.sellFeeUsdt)} · ${n(flow.sellFeePct,3)}%`)}${line(t('Получено после продажи','Net sale proceeds'),expired?'—':usd(flow.proceeds))}</div></li></ol>
      ${detail&&row.paths?.length>1?`<label class="spot-network-choice">${t('Сеть перевода','Transfer network')}<select data-spot-network>${row.paths.map(p=>`<option value="${esc(p.network)}" ${p.network===path?.network?'selected':''}>${esc(p.network)} · ${n(p.fee)} ${esc(row.base)}${p.identity==='unverified'?' · ?':''}</option>`).join('')}</select></label>`:''}
      <div class="spot-result ${confirmed?'confirmed':''}">${line(t('Итог к исходному бюджету','Result versus initial budget'),expired?'—':usd(flow.profitUsdt))}<small>${confirmed?t('Расчёт по свежим стаканам','Calculated from fresh order books'):t('Индикативно. Глубина, сеть или данные ещё не подтверждены.','Indicative. Depth, transfer or data not yet confirmed.')}</small></div>
      ${error||expired||list.length?`<p class="spot-caution">${esc(error|| (expired?t('Данные устарели. Обновляем…','Data expired. Refreshing…'):list.join(' · ')))}</p>`:''}
      <p class="spot-model-note">${t('Комиссии торговли — модель, их можно задать сверху. Расчёт предполагает удержание BUY fee в монете и сохранение цен после перевода. Депозит без комиссии, если API её не сообщает. Время перевода не гарантировано; таймер показывает наблюдаемую жизнь gross-спреда > 0. Лимиты ордеров и тариф аккаунта проверьте на бирже.','Trading fees are modelled; override them above. BUY fee is charged in base. Calculation assumes prices persist after transfer and no deposit fee when not reported. Transfer time is not guaranteed; timer measures observed gross spread > 0. Check order limits and account fees on the venue.')}</p>
      <div class="spot-route-actions">${detail?links:`<button data-spot-open>${t('Открыть расчёт','Open calculation')} ↗</button>`}</div>`;
  }
  function paint(error=''){
    const row=quote||rows.get(key);if(!row)return;
    if(isDialog()){
      const body=dialog().querySelector('.spot-dialog-body'),scroll=body.scrollTop;
      body.innerHTML=content(row,true,error);body.scrollTop=scroll;
    }else pop().innerHTML=`<div data-i18n-skip>${content(row,false,error)}</div>`;
  }
  function render(payload,favorites=new Set()){
    lastPayload=payload;lastFavorites=favorites;rows=new Map((payload.rows||[]).map(row=>[row.key,row]));
    let view=[...rows.values()].filter(row=>Date.now()-Math.min(row.buyAt,row.sellAt)<=15000);
    if($('arb-transfer-only')?.checked)view=view.filter(row=>row.flow.complete);
    if($('arb-favorites-only')?.checked)view=view.filter(row=>favorites.has(row.base));
    const sort=$('arb-sort')?.value;
    if(sort==='freshness')view.sort((a,b)=>a.ageMs-b.ageMs);
    if(sort==='liquidity')view.sort((a,b)=>b.liquidity-a.liquidity);
    if(sort==='gross')view.sort((a,b)=>b.gross-a.gross);
    const html=view.slice(0,400).map(row=>[row.key,`<tr data-spot-key="${esc(row.key)}" tabindex="0" aria-label="${esc(row.base)} ${esc(row.buyName)} → ${esc(row.sellName)}">
      <td><button class="arb-star ${favorites.has(row.base)?'on':''}" data-fav="${esc(row.base)}" aria-label="${t('Избранное','Favorite')}">★</button></td>
      <td><div class="arb-pair"><span class="arb-coin">${esc(row.base.slice(0,4))}</span><div><strong>${esc(row.base)}/USDT</strong><small>SPOT</small></div></div></td>
      <td><div class="spot-table-route"><span>${esc(row.buyName)} <b>${n(row.buyAsk)}</b></span><i>→</i><span>${esc(row.sellName)} <b>${n(row.sellBid)}</b></span></div></td>
      <td class="arb-num">${pct(row.gross)}</td><td class="arb-num">${pct(row.flow.preTransferNetPct)}</td>
      <td><span class="spot-network ${row.flow.complete?'verified':''}">${esc(row.path?.network||t('Нет данных','No data'))}</span><small>${row.path?n(row.path.fee)+' '+esc(row.base):row.transferStatus==='closed'?t('Перевод закрыт','Transfer closed'):t('Требует проверки','Needs verification')}</small></td>
      <td class="arb-num ${row.flow.netPct>0?'positive':''}">${pct(row.flow.netPct)}<small>${usd(row.flow.profitUsdt)}</small></td>
      <td class="arb-num" title="${t('Наблюдаемый gross-спред > 0; сброс при разрыве данных','Observed gross spread > 0; resets on data gap')}">${duration(row.spreadAgeMs)}<small>${row.spreadSamples} ${t('набл.','samples')}</small></td>
      <td class="arb-num">${duration(row.ageMs)}</td><td class="arb-num">${usd(row.liquidity)}</td>
      <td><button class="spot-row-open" aria-label="${t('Открыть расчёт','Open calculation')}">↗</button></td></tr>`]);
    patch($('arb-spot-body'),html);
    $('arb-empty').hidden=view.length>0;
    $('arb-spot-badge').textContent=payload.total??view.length;
    $('arb-shown').textContent=t(`Показано ${view.length} · биржи ${payload.exchangeCount}/12 · рынки ${payload.marketCount} · расчёт на ${n(payload.notional)} USDT`,`Showing ${view.length} · venues ${payload.exchangeCount}/12 · markets ${payload.marketCount} · budget ${n(payload.notional)} USDT`);
    const failed=Object.entries(payload.sources||{}).filter(([,s])=>s.status!=='ok');
    $('arb-spot-source-health').textContent=failed.length?t('Нет свежего потока: ','No fresh feed: ')+failed.map(([,s])=>s.name).join(', '):t('Все спот-потоки доступны','All spot feeds available');
    $('arb-kpi-count').textContent=String(view.filter(r=>r.flow.netPct>0).length);
    const best=view.reduce((best,row)=>row.flow.netPct>0&&(!best||row.flow.netPct>best.flow.netPct)?row:best,null);
    $('arb-kpi-net').textContent=best?pct(best.flow.netPct):'—';
    $('arb-kpi-route').textContent=best?`${best.base} · ${best.buyName} → ${best.sellName}`:t('Нет подтверждённого расчёта','No confirmed calculation');
    $('arb-kpi-funding').textContent='—';$('arb-kpi-funding-sub').textContent=t('Спот без funding','Spot has no funding');
    $('arb-kpi-streams').textContent=String(payload.marketCount||0);
    if(key&&!rows.has(key)){
      const previous=quote;invalidate();
      if(!isDialog())close();
      else if(previous){quote={...previous,generatedAt:0,flow:{...previous.flow,complete:false,profitUsdt:null,proceeds:null,netPct:null}};paint(t('Спред исчез или котировки устарели.','Spread disappeared or quotes expired.'));}
      else close();
    }
    else if(key)paint();
  }
  function invalidParameters(){
    close();patch?.($('arb-spot-body'),[]);
    $('arb-spot-source-health').textContent=t('Проверьте бюджет (10–1 000 000 USDT) и комиссии (0–5%).','Check budget (10–1,000,000 USDT) and fees (0–5%).');
    $('arb-shown').textContent=t('Расчёт приостановлен до исправления параметров','Calculation paused until parameters are valid');
  }
  window.ArbitrageSpot={parameters,setActive,render,close,invalidParameters,configure:options=>{patch=options.patch;refresh=options.refresh;}};
})();
