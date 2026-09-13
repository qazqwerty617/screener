(function (root) {
  'use strict';
  const themes = [
    { id: 'obsidian', name: 'Obsidian Original', description: 'Оригинальная · фирменный фиолетовый', bg: '#0d0f14', panel: '#13151e', raised: '#181b26', hover: '#1e2235', text: '#d1d4dc', muted: '#6b7080', border: '#2b2e39', accent: '#7c3aed', onAccent: '#ffffff', up: '#26c97a', down: '#ff4560', wickUp: '#26c97a', wickDown: '#ff4560', volumeUp: '#26c97a', volumeDown: '#ff4560', grid: '#1c1f27', mapBg: '#04050d', mapPanel: '#0d0f14', arbitrageBg: '#080a0f', arbitragePanel: '#0d1016', formationsBg: '#0d0f14', formationsPanel: '#11131c', light: false },
    { id: 'aurora', name: 'Северное сияние', description: 'Ночной синий · мята и коралл', bg: '#101c28', panel: '#162635', raised: '#1e3344', hover: '#294255', text: '#e0edf3', muted: '#9fb4c3', border: '#354b5b', accent: '#58b6ce', onAccent: '#102029', up: '#63dbb5', down: '#f48b89', wickUp: '#91efd1', wickDown: '#ffb5ae', volumeUp: '#439d8e', volumeDown: '#be6b78', grid: '#253744', mapBg: '#091722', mapPanel: '#132837', arbitrageBg: '#0c1822', arbitragePanel: '#152735', formationsBg: '#0d1a25', formationsPanel: '#172a39', light: false },
    { id: 'silver', name: 'Серебро', description: 'Серо-белая · чистый графит', bg: '#edf0f3', panel: '#ffffff', raised: '#e2e6eb', hover: '#d3dae2', text: '#232b35', muted: '#596675', border: '#bdc6d0', accent: '#46576b', onAccent: '#ffffff', up: '#ffffff', down: '#505c6b', wickUp: '#66788a', wickDown: '#384756', volumeUp: '#a0afbd', volumeDown: '#586b7e', grid: '#d6dce3', mapBg: '#e7ebef', mapPanel: '#f8fafc', arbitrageBg: '#e9edf1', arbitragePanel: '#ffffff', formationsBg: '#e7ebef', formationsPanel: '#f7f9fb', light: true },
    { id: 'dune', name: 'Тёплый песок', description: 'Слоновая кость · нефрит и терракота', bg: '#f4efe4', panel: '#fffaf0', raised: '#eae1d1', hover: '#ded2be', text: '#393d33', muted: '#706b5c', border: '#cfc4af', accent: '#586a48', onAccent: '#ffffff', up: '#348578', down: '#bf654c', wickUp: '#256458', wickDown: '#944933', volumeUp: '#7da294', volumeDown: '#cd9277', grid: '#e0d7c8', mapBg: '#eee7d9', mapPanel: '#fff9ed', arbitrageBg: '#f1ebdf', arbitragePanel: '#fffaf0', formationsBg: '#eee7da', formationsPanel: '#faf3e7', light: true },
    { id: 'orchid', name: 'Орхидея', description: 'Глубокая слива · лаванда и золото', bg: '#201a2b', panel: '#2b2338', raised: '#382e49', hover: '#493959', text: '#efe4f5', muted: '#b8a3c6', border: '#51415f', accent: '#c4a2ec', onAccent: '#271b36', up: '#b9a0ed', down: '#e7ad65', wickUp: '#d4c1fa', wickDown: '#f4ce93', volumeUp: '#8268ae', volumeDown: '#a88254', grid: '#372d42', mapBg: '#171020', mapPanel: '#2a2037', arbitrageBg: '#1a1423', arbitragePanel: '#292034', formationsBg: '#1b1525', formationsPanel: '#2d233a', light: false },
    { id: 'terminal', name: 'Терминал', description: 'Чёрный графит · лайм и янтарь', bg: '#090b0c', panel: '#111516', raised: '#192021', hover: '#24302d', text: '#e7eee9', muted: '#89968e', border: '#303a36', accent: '#9ac65b', onAccent: '#11170d', up: '#9bd66f', down: '#f1a85b', wickUp: '#c1ec9f', wickDown: '#ffd099', volumeUp: '#618c52', volumeDown: '#aa7549', grid: '#222a28', mapBg: '#050706', mapPanel: '#101612', arbitrageBg: '#070908', arbitragePanel: '#111614', formationsBg: '#070a08', formationsPanel: '#121714', light: false },
    { id: 'ice', name: 'Ледяной океан', description: 'Стальной синий · лёд и малина', bg: '#101721', panel: '#172231', raised: '#202f41', hover: '#2a3d53', text: '#e5f0fa', muted: '#93a9bc', border: '#34495e', accent: '#72b9e8', onAccent: '#0f2230', up: '#8dd8f2', down: '#ec7895', wickUp: '#b8ebfb', wickDown: '#ffadc0', volumeUp: '#568ea9', volumeDown: '#a9546d', grid: '#263748', mapBg: '#09121c', mapPanel: '#142535', arbitrageBg: '#0c1520', arbitragePanel: '#172534', formationsBg: '#0d1722', formationsPanel: '#182838', light: false },
  ];
  const get = id => themes.find(theme => theme.id === id) || themes[0];

  function parseColor(value) {
    if (typeof value !== 'string') return null;
    const input = value.trim();
    const hex = input.match(/^#([0-9a-f]{3,8})$/i)?.[1];
    if (hex) {
      const expanded = hex.length === 3 || hex.length === 4
        ? hex.split('').map(char => char + char).join('')
        : hex;
      if (expanded.length !== 6 && expanded.length !== 8) return null;
      return {
        r: parseInt(expanded.slice(0, 2), 16),
        g: parseInt(expanded.slice(2, 4), 16),
        b: parseInt(expanded.slice(4, 6), 16),
        a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1
      };
    }
    const rgb = input.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i);
    if (!rgb) return null;
    return {
      r: Math.max(0, Math.min(255, Number(rgb[1]))),
      g: Math.max(0, Math.min(255, Number(rgb[2]))),
      b: Math.max(0, Math.min(255, Number(rgb[3]))),
      a: rgb[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgb[4]) / (rgb[0].includes('%') ? 100 : 1)))
    };
  }

  function composite(foreground, background) {
    const alpha = foreground.a + background.a * (1 - foreground.a);
    if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
      g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
      b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
      a: alpha
    };
  }

  function luminance(color) {
    const channel = value => {
      const normalized = value / 255;
      return normalized <= .04045 ? normalized / 12.92 : Math.pow((normalized + .055) / 1.055, 2.4);
    };
    return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
  }

  function contrastRatio(foreground, background) {
    const bg = parseColor(background) || parseColor('#0d0f14');
    const fg = parseColor(foreground) || parseColor('#ffffff');
    const opaqueBg = bg.a < 1 ? composite(bg, parseColor('#ffffff')) : bg;
    const renderedFg = fg.a < 1 ? composite(fg, opaqueBg) : fg;
    const lighter = Math.max(luminance(renderedFg), luminance(opaqueBg));
    const darker = Math.min(luminance(renderedFg), luminance(opaqueBg));
    return (lighter + .05) / (darker + .05);
  }

  function ensureReadableColor(preferred, background, minimum = 4.5) {
    if (contrastRatio(preferred, background) >= minimum) return preferred;
    const dark = '#18202b';
    const light = '#f7f9fc';
    return contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light;
  }

  function applyShell(id) {
    const theme = get(id), el = root.document?.documentElement;
    if (!el) return theme;
    el.dataset.appearanceTheme = theme.id;
    el.dataset.appearanceLight = String(theme.light);
    el.style.colorScheme = theme.light ? 'light' : 'dark';
    const vars = { bg: theme.bg, bg2: theme.panel, bg3: theme.raised, bgh: theme.hover, bgh2: theme.hover, bd: theme.border, bd2: theme.border, t1: theme.text, t2: theme.muted, t3: theme.muted, ac: theme.accent, gr: theme.light ? theme.wickUp : theme.up, rd: theme.down, 'on-accent': theme.onAccent, 'chart-grid': theme.grid, 'screener-bg': theme.panel, 'screener-header-bg': theme.raised, 'map-bg': theme.mapBg, 'map-panel': theme.mapPanel, 'map-text': ensureReadableColor(theme.text, theme.mapPanel), 'map-muted': ensureReadableColor(theme.muted, theme.mapPanel), 'arbitrage-bg': theme.arbitrageBg, 'arbitrage-panel': theme.arbitragePanel, 'arbitrage-text': ensureReadableColor(theme.text, theme.arbitragePanel), 'arbitrage-muted': ensureReadableColor(theme.muted, theme.arbitragePanel), 'formations-bg': theme.formationsBg, 'formations-panel': theme.formationsPanel, 'formations-text': ensureReadableColor(theme.text, theme.formationsPanel), 'formations-muted': ensureReadableColor(theme.muted, theme.formationsPanel), acglow: theme.accent + '22', grglow: theme.up + '22', rdglow: theme.down + '22' };
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
  const api = { themes, get, applyShell, preview, contrastRatio, ensureReadableColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AppearanceThemes = api;
  if (root.document) {
    try {
      let saved = root.localStorage.getItem('screener-appearance-theme');
      // Aurora was briefly written automatically as the default. Restore the
      // original palette once for those users, while retaining explicit themes.
      if (!root.localStorage.getItem('screener-appearance-theme-v2') && (!saved || saved === 'aurora')) {
        saved = 'obsidian';
        root.localStorage.setItem('screener-appearance-theme', saved);
      }
      root.localStorage.setItem('screener-appearance-theme-v2', '1');
      applyShell(saved);
    } catch (_) { applyShell(); }
  }
})(typeof window !== 'undefined' ? window : globalThis);
