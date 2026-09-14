const fs = require('fs');
const file='node-server/public/js/backtest.js';
let s=fs.readFileSync(file,'utf8');
s=s.replace('    activated: false,','    activated: false,\n    loading: false,');
s=s.replace('const ready = Boolean(state.session);','const ready = Boolean(state.session) && !state.loading;');
const start=s.indexOf('  async function fetchStepBuffer('), end=s.indexOf('  async function newCase()',start);
s=s.slice(0,start)+`  async function fetchStepBuffer(count = 50) {
    if (!state.session || state.serverDone) return;
    if (state.fetchingBuffer) return state.fetchingBuffer;
    const session = state.session;
    const seq = state.requestSeq;
    const request = (async () => {
      try {
        const response = await fetch(\x60/api/backtest/\x24{session.id}/step?count=\x24{count}\x60, { method: "POST", cache: "no-store" });
        const data = await response.json();
        if (state.session !== session || state.requestSeq !== seq) return;
        if (response.ok && data.candles) {
          for (const row of data.candles) state.stepBuffer.push(parseCandle(row));
          if (data.done) state.serverDone = true;
        }
      } catch (_) {} finally {
        if (state.session === session && state.requestSeq === seq) state.fetchingBuffer = false;
      }
    })();
    state.fetchingBuffer = request;
    return request;
  }

`+s.slice(end);
const at=s.indexOf('  async function fetchStepBuffer(');
s=s.slice(0,at)+`  // One prepared session per selected market; never fetch hidden replay bars here.
  const preparedCases = new Map();
  function prepareCase(ex = state.exchange, tf = state.tf) {
    const key = ex + ':' + tf;
    const existing = preparedCases.get(key);
    if (existing && Date.now() - existing.at < 300000) return existing.promise;
    const entry = { at: Date.now() };
    entry.promise = (async () => {
      const response = await fetch(\x60/api/backtest/new?tf=\x24{encodeURIComponent(tf)}&ex=\x24{encodeURIComponent(ex)}\x60, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok || !data.candles?.length) throw new Error(data.error || 'Не удалось подготовить сценарий');
      return data;
    })();
    preparedCases.set(key, entry);
    while (preparedCases.size > 4) preparedCases.delete(preparedCases.keys().next().value);
    entry.promise.catch(() => { if (preparedCases.get(key) === entry) preparedCases.delete(key); });
    return entry.promise;
  }

`+s.slice(at);
s=s.replace('    resetCase();\r\n    setLoading(true,','    stopPlaying();\n    state.loading = true;\n    updateControls();\n    setLoading(true,');
s=s.replace(/      const response = await fetch\(`\/api\/backtest\/new[^\n]+\n      const data = await response.json\(\);/,`      const key = state.exchange + ':' + state.tf;
      const data = await prepareCase();`);
s=s.replace('      if (!response.ok) throw new Error(data.error || "Не удалось создать бэктест");','      preparedCases.delete(key);\n      resetCase();\n      state.loading = false;');
s=s.replace('      // Pre-buffer first batch of candles in background','      prepareCase().catch(() => {});\n      // Pre-buffer first batch of candles in background');
s=s.replace('      if (requestSeq === state.requestSeq) $("bt-new").disabled = false;','      if (requestSeq === state.requestSeq) { state.loading = false; $("bt-new").disabled = false; updateControls(); }');
s=s.replace('if (!state.session || state.done || state.stepping || state.playing', 'if (state.loading || !state.session || state.done || state.stepping || state.playing');
s=s.replace('if (!state.session || state.done) return;', 'if (state.loading || !state.session || state.done) return;');
s=s.replace('    state.stepping = true;\r\n    updateControls();\r\n    try {','    const session = state.session;\n    state.stepping = true;\n    updateControls();\n    try {');
s=s.replace('        await fetchStepBuffer(20);','        await fetchStepBuffer(20);\n        if (state.session !== session || state.loading) return false;');
s=s.replace('      const response = await fetch(`/api/backtest/${state.session.id}/reveal`', '      await state.fetchingBuffer;\n      if (state.session !== session || state.loading) return;\n      const response = await fetch(`/api/backtest/${session.id}/reveal`');
s=s.replace('      if (!response.ok) throw new Error(data.error || "Ошибка раскрытия");','      if (state.session !== session || state.loading) return;\n      if (!response.ok) throw new Error(data.error || "Ошибка раскрытия");');
s=s.replace('    if (!state.session || state.done || state.stepping) return;', '    if (state.loading || !state.session || state.done || state.stepping) return;');
s=s.replace('  function openPosition(direction = state.plannedDirection) {','  function openPosition(direction = state.plannedDirection) {\n    if (state.loading) return;');
s=s.replace('  function selectDirection(direction) {','  function selectDirection(direction) {\n    if (state.loading) return;');
s=s.replace('  window.CryptoBacktest = {','  setTimeout(() => prepareCase().catch(() => {}), 1200);\n  window.addEventListener("appearancechange", draw);\n  window.CryptoBacktest = {');
fs.writeFileSync(file,s);
