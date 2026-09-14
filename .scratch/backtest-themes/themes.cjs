const fs=require('fs');
let file='node-server/public/js/app.js', s=fs.readFileSync(file,'utf8');
const a=s.indexOf('  // Theme switching'), b=s.indexOf('  // ═══ Formations Overlay',a);
s=s.slice(0,a)+s.slice(b);
const anchor='    function refreshCharts() {';
s=s.replace(anchor,`    function selectAppearanceTheme(id) {
      const theme = window.AppearanceThemes.applyShell(id);
      localStorage.setItem('screener-appearance-theme', theme.id);
      pendingBg = theme.bg; pendingOpacity = 100;
      pendingAxisColor = theme.muted; pendingAxisOpacity = 100;
      updateBgColor(theme.bg, 100, true);
      updateAxisColor(theme.muted, 100, true);
      updateScreenerBgColor(theme.panel, true);
      updateScreenerHeaderColor(theme.raised, true);
      for (const type of ['body', 'border', 'wick']) {
        Object.assign(candleState[type], { show: true, up: type === 'body' ? theme.up : theme.wickUp, down: type === 'body' ? theme.down : theme.wickDown, upOp: 100, downOp: 100 });
        if ($('set-candle-' + type)) $('set-candle-' + type).checked = true;
        for (const side of ['up', 'down']) pickers['candle-' + side + '-' + type]?.setColor(candleState[type][side], 100);
      }
      Object.assign(volumeState, { show: true, up: theme.volumeUp, down: theme.volumeDown, upOp: 85, downOp: 85 });
      if ($('set-show-volume')) $('set-show-volume').checked = true;
      for (const side of ['up', 'down']) pickers['volume-' + side]?.setColor(volumeState[side], 85);
      pickers['screener-bg']?.setColor(theme.panel, 100);
      pickers['screener-header']?.setColor(theme.raised, 100);
      localStorage.setItem('screener-candle-settings', JSON.stringify(candleState));
      localStorage.setItem('screener-volume-settings', JSON.stringify(volumeState));
      if (bgPreview) bgPreview.style.backgroundColor = theme.bg;
      if (axisPreview) axisPreview.style.backgroundColor = theme.muted;
      if (opacitySlider) opacitySlider.value = 100;
      if (opacityVal) opacityVal.textContent = '100%';
      if (axisOpacitySlider) axisOpacitySlider.value = 100;
      if (axisOpacityVal) axisOpacityVal.textContent = '100%';
      document.querySelectorAll('.theme-opt').forEach(button => {
        const selected = button.dataset.theme === theme.id;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      refreshCharts();
    }
    const themeGrid = document.querySelector('.theme-grid');
    if (themeGrid && window.AppearanceThemes) {
      const saved = localStorage.getItem('screener-appearance-theme');
      const selected = window.AppearanceThemes.get(saved).id;
      themeGrid.innerHTML = window.AppearanceThemes.themes.map(theme => '<button type="button" class="theme-opt' + (theme.id === selected ? ' active' : '') + '" data-theme="' + theme.id + '" aria-pressed="' + (theme.id === selected) + '">' + window.AppearanceThemes.preview(theme) + '<span class="theme-name">' + theme.name + '</span><span class="theme-description">' + theme.description + '</span></button>').join('');
      themeGrid.querySelectorAll('button').forEach(button => button.onclick = () => selectAppearanceTheme(button.dataset.theme));
      if (!saved) selectAppearanceTheme(selected);
    }

`+anchor);
s=s.replace(anchor,anchor+'\n      window.dispatchEvent(new Event("appearancechange"));');
const resetStart=s.indexOf('        // 1. Reset theme and background'), resetEnd=s.indexOf('        // 5. Reset compact',resetStart);
s=s.slice(0,resetStart)+'        selectAppearanceTheme("aurora");\n\n'+s.slice(resetEnd);
s=s.replace('document.documentElement.style.setProperty("--bg2", rgba);','document.documentElement.style.setProperty("--bg2", window.AppearanceThemes ? window.AppearanceThemes.get(document.documentElement.dataset.appearanceTheme).panel : rgba);');
fs.writeFileSync(file,s);
file='node-server/public/index.html';s=fs.readFileSync(file,'utf8');
s=s.replace(/<div class="theme-grid">[\s\S]*?<\/div>/,'<div class="theme-grid" aria-label="Готовые цветовые схемы"></div>');
s=s.replace('</head>','    <script src="/js/appearanceThemes.js?v=1"></script>\n</head>');
s=s.replaceAll('app.js?v=2087','app.js?v=2088').replaceAll('app.css?v=1011','app.css?v=1012').replace('backtest.js?v=2009','backtest.js?v=2010');
fs.writeFileSync(file,s);
