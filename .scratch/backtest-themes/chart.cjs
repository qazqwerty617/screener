const fs=require('fs'),file='node-server/public/js/backtest.js';
let s=fs.readFileSync(file,'utf8');
s=s.replace('  function draw() {',`  function chartColor(part, up) {
    const side = up ? 'up' : 'down';
    const settings = part === 'volume' ? window.volumeSettings : window.candleSettings?.[part];
    const color = settings?.[side] || (up ? '#63dbb5' : '#f48b89');
    return color + Math.round((settings?.[side + 'Op'] ?? 100) / 100 * 255).toString(16).padStart(2, '0');
  }
  function draw() {
    const theme = window.AppearanceThemes?.get(document.documentElement.dataset.appearanceTheme);
    const background = typeof getCurrentBgColor === 'function' ? getCurrentBgColor() : theme?.bg || '#101c28';
    const grid = theme?.grid || '#253744';
    const axis = typeof getAxisTextColor === 'function' ? getAxisTextColor() : theme?.muted || '#9fb4c3';`);
const a=s.indexOf('  function draw() {'),b=s.indexOf('\n  function ',a+10);
let d=s.slice(a,b);
d=d.replaceAll('"#0d0f14"','background').replaceAll('"rgba(13, 15, 20, 0.95)"','background').replaceAll('"rgba(18, 20, 29, 0.85)"','background');
for (const color of ['rgba(255,255,255,.045)','rgba(255,255,255,.035)','rgba(255,255,255,.06)','rgba(255, 255, 255, 0.08)']) d=d.replaceAll('"'+color+'"','grid');
for (const color of ['#64748b','#596071','#d1d4dc','rgba(255,255,255,.6)']) d=d.replaceAll('"'+color+'"','axis');
d=d.replace('c.c >= c.o ? "rgba(38,201,122,.85)" : "rgba(255,69,96,.85)"', 'chartColor("volume", c.c >= c.o)');
d=d.replace('ctx.strokeStyle = up ? "#26c97a" : "#ff4560";', 'ctx.strokeStyle = chartColor("wick", up);');
d=d.replace('      ctx.stroke();\r\n\r\n      // Solid filled candle body','      if (window.candleSettings?.wick?.show !== false) ctx.stroke();\n\n      // Solid filled candle body');
d=d.replace('ctx.fillStyle = up ? "#26c97a" : "#ff4560";', 'ctx.fillStyle = chartColor("body", up);');
d=d.replace('      ctx.fillRect(fillX, fillY, fillW, fillH);','      if (window.candleSettings?.body?.show !== false) ctx.fillRect(fillX, fillY, fillW, fillH);\n      if (window.candleSettings?.border?.show !== false) { ctx.strokeStyle = chartColor("border", up); ctx.strokeRect(fillX, fillY, fillW, fillH); }');
d=d.replaceAll('up ? "#26c97a" : "#ff4560"','chartColor("border", up)');
s=s.slice(0,a)+d+s.slice(b);
s=s.replace('const volumeH = state.indicators.has("volume") ?', 'const volumeH = state.indicators.has("volume") && window.volumeSettings?.show !== false ?');
fs.writeFileSync(file,s);
