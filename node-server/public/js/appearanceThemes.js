(function (root) {
  'use strict';
  const themes = [
    { id: 'aurora', name: 'Северное сияние', description: 'Ночной синий · мята и коралл', bg: '#101c28', panel: '#162635', raised: '#1e3344', hover: '#294255', text: '#e0edf3', muted: '#9fb4c3', border: '#354b5b', accent: '#58b6ce', onAccent: '#102029', up: '#63dbb5', down: '#f48b89', wickUp: '#91efd1', wickDown: '#ffb5ae', volumeUp: '#439d8e', volumeDown: '#be6b78', grid: '#253744', light: false },
    { id: 'silver', name: 'Серебро', description: 'Серо-белая · чистый графит', bg: '#edf0f3', panel: '#ffffff', raised: '#e2e6eb', hover: '#d3dae2', text: '#232b35', muted: '#596675', border: '#bdc6d0', accent: '#46576b', onAccent: '#ffffff', up: '#ffffff', down: '#505c6b', wickUp: '#66788a', wickDown: '#384756', volumeUp: '#a0afbd', volumeDown: '#586b7e', grid: '#d6dce3', light: true },
    { id: 'dune', name: 'Тёплый песок', description: 'Слоновая кость · нефрит и терракота', bg: '#f4efe4', panel: '#fffaf0', raised: '#eae1d1', hover: '#ded2be', text: '#393d33', muted: '#706b5c', border: '#cfc4af', accent: '#586a48', onAccent: '#ffffff', up: '#348578', down: '#bf654c', wickUp: '#256458', wickDown: '#944933', volumeUp: '#7da294', volumeDown: '#cd9277', grid: '#e0d7c8', light: true },
    { id: 'orchid', name: 'Орхидея', description: 'Глубокая слива · лаванда и золото', bg: '#201a2b', panel: '#2b2338', raised: '#382e49', hover: '#493959', text: '#efe4f5', muted: '#b8a3c6', border: '#51415f', accent: '#c4a2ec', onAccent: '#271b36', up: '#b9a0ed', down: '#e7ad65', wickUp: '#d4c1fa', wickDown: '#f4ce93', volumeUp: '#8268ae', volumeDown: '#a88254', grid: '#372d42', light: false },
  ];
  const get = id => themes.find(theme => theme.id === id) || themes[0];
  function applyShell(id) {
    const theme = get(id), el = root.document?.documentElement;
    if (!el) return theme;
    el.dataset.appearanceTheme = theme.id;
    el.dataset.appearanceLight = String(theme.light);
    el.style.colorScheme = theme.light ? 'light' : 'dark';
    const vars = { bg: theme.bg, bg2: theme.panel, bg3: theme.raised, bgh: theme.hover, bgh2: theme.hover, bd: theme.border, bd2: theme.border, t1: theme.text, t2: theme.muted, t3: theme.muted, ac: theme.accent, gr: theme.light ? theme.wickUp : theme.up, rd: theme.down, 'on-accent': theme.onAccent, 'chart-grid': theme.grid, 'screener-bg': theme.panel, 'screener-header-bg': theme.raised, acglow: theme.accent + '22', grglow: theme.up + '22', rdglow: theme.down + '22' };
    for (const [key,value] of Object.entries(vars)) el.style.setProperty('--' + key, value);
    return theme;
  }
  function preview(theme) {
    let bars = '';
    const heights = [17,24,16,31,22,27,38,28,35,21,32,42];
    heights.forEach((height,i) => {
      const up = i % 4 !== 2, x = 70+i*12, y = 94-height-i*2;
      bars += `<path d="M${x+3} ${y-7}v${height+14}" stroke="${up ? theme.wickUp : theme.wickDown}"/><rect x="${x}" y="${y}" width="6" height="${height}" fill="${up ? theme.up : theme.down}" stroke="${up ? theme.wickUp : theme.wickDown}"/><rect x="${x}" y="${137-height/2}" width="7" height="${height/2}" fill="${up ? theme.volumeUp : theme.volumeDown}"/>`;
    });
    const rows = [44,60,76,92,108].map((y,i) => `<rect x="8" y="${y}" width="18" height="3" rx="1" fill="${theme.muted}"/><rect x="33" y="${y}" width="13" height="3" rx="1" fill="${i%2 ? theme.volumeDown : theme.volumeUp}"/>`).join('');
    return `<svg viewBox="0 0 230 145" role="img" aria-label="${theme.description}: скринер, свечи и объёмы"><rect width="230" height="145" fill="${theme.bg}"/><rect width="230" height="23" fill="${theme.raised}"/><rect y="23" width="55" height="122" fill="${theme.panel}"/><rect x="8" y="10" width="29" height="4" rx="2" fill="${theme.accent}"/><rect x="68" y="10" width="21" height="4" rx="2" fill="${theme.muted}"/>${rows}<path d="M60 53H222M60 83H222M60 112H222" stroke="${theme.grid}"/>${bars}</svg>`;
  }
  const api = { themes, get, applyShell, preview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AppearanceThemes = api;
  if (root.document) {
    try { applyShell(root.localStorage.getItem('screener-appearance-theme')); } catch (_) { applyShell(); }
  }
})(typeof window !== 'undefined' ? window : globalThis);
