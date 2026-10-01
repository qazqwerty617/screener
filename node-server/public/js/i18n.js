(function () {
  'use strict';
  const key = 'obsidian_language';
  const dictionary = window.ObsidianEnglish || {};
  const originals = new WeakMap();
  const attributes = ['title', 'placeholder', 'aria-label'];
  const skip = 'script,style,code,[translate="no"],[data-i18n-skip],.journal-note';
  let language = 'ru';
  let appliedLanguage = null;
  try { if (localStorage.getItem(key) === 'en') language = 'en'; } catch (_) {}
  const normalize = value => value.trim().replace(/\s+/g, ' ');
  const patterns = [
    [/^(\d+)\s*[Мм]$/, '$1m'], [/^(\d+)\s*[Чч]$/, '$1h'], [/^(\d+)\s*[Дд]$/, '$1d'], [/^(\d+)\s*[Нн]$/, '$1w'],
    [/^(\d+)\s*мин$/, '$1 min'], [/^(\d+)\s*час$/, '$1 hour'],
    [/^(\d+) сек$/, '$1 s'], [/^(\d+) ч (\d+) мин$/, '$1h $2m'], [/^(\d+) д (\d+) ч$/, '$1d $2h'],
    [/^([\d.]+) (мин|ч) оборота$/, (_, n, unit) => `${n} ${unit === 'ч' ? 'h' : 'min'} turnover`],
    [/^(\d+) раз$/, '$1 times'], [/^(\d+) скан\.$/, '$1 scans'],
    [/^Касаний: (\d+)\+\. Дистанция: ([\d.]+)%$/, 'Touches: $1+. Distance: $2%'],
    [/^(\d+) График(?:а|ов)?$/, '$1 charts'], [/^Стр\. (\d+)$/, 'Page $1'],
    [/^(\d+) стен(?:а|ы)?$/, '$1 walls'], [/^от (\$[\d.KMB]+)$/, 'from $1'],
    [/^Все размеры (\d+)$/, 'All sizes $1'], [/^Мелкие (\d+)$/, 'Small $1'],
    [/^Средние (\d+)$/, 'Medium $1'], [/^Крупные (\d+)$/, 'Large $1'],
    [/^охват (\d+)%$/, 'coverage $1%'],
    [/^(.+): (\d+)\/(\d+) стаканов$/, '$1: $2/$3 order books'],
    [/^до (\d+%)$/, 'up to $1'], [/^от (\d+) сек$/, 'from $1 s'], [/^от (\d+) мин$/, 'from $1 min'],
    [/^от (\d+\/10)$/, 'from $1'], [/^от (\d+) бирж$/, 'from $1 exchanges'],
    [/^Скрыто монет: (\d+)$/, 'Hidden coins: $1'], [/^(\d+)\+ уров(?:ень|ня|ней)$/, '$1+ levels'],
    [/^Показано (\d+)$/, 'Showing $1'], [/^до (\d+) св\.$/, 'up to $1 candles'],
    [/^Показано (\d+) из (\d+)$/, 'Showing $1 of $2'], [/^(\d+[–-]\d+) из (\d+)$/, '$1 of $2'],
    [/^(\d+) записей$/, '$1 entries'], [/^(.+), (?:записей|событий): (\d+)$/, '$1, events: $2'],
    [/^(.+) токенов$/, '$1 tokens'], [/^([\d.,<>]+%) от указанного общего предложения$/, '$1 of stated total supply'],
    [/^обновлено (.+)$/, 'updated $1'], [/^Обновлено (.+)$/, 'Updated $1'],
    [/^Новости (.+)$/, 'News $1'], [/^рынки (.+)$/, 'markets $1'],
    [/^Календарь UTC · в месяце: (\d+) записей с датой \+ (\d+) приблизительных окон · всего по фильтрам: (\d+)\. % = доля общего предложения\.$/, 'UTC calendar · this month: $1 dated entries + $2 approximate windows · matching filters: $3. % = share of total supply.'],
    [/^Кандидатов: (\d+) · сайтов проверено: (\d+) · проектов со ссылками на аккаунты: (\d+) · источников успешно прочитано за 10 минут: (\d+)\.$/, 'Candidates: $1 · websites checked: $2 · projects linking accounts: $3 · sources read successfully in 10 minutes: $4.'],
    [/^(.+) достиг уровня (\$[\d.,]+)$/, '$1 reached $2'],
    [/^(.+): (\d+) касания · ([\d.,]+)% до формации \((.+)\)$/, '$1: $2 touches · $3% from formation ($4)'],
  ];
  function t(value) {
    if (language !== 'en' || typeof value !== 'string' || !/[А-Яа-яЁё]/.test(value)) return value;
    const normalized = normalize(value);
    let result = dictionary[normalized];
    if (result === undefined) {
      const decorated = /^([^А-Яа-яЁё]*)([А-Яа-яЁё].*?)( ↗)?$/.exec(normalized);
      if (decorated && dictionary[decorated[2]]) result = decorated[1] + dictionary[decorated[2]] + (decorated[3] || '');
    }
    if (result === undefined) {
      for (const [pattern, replacement] of patterns) {
        if (pattern.test(normalized)) { result = normalized.replace(pattern, replacement); break; }
      }
    }
    if (result === undefined) {
      const parts = value.split(/(\s+·\s+|\n)/);
      if (parts.length > 1) return parts.map((part, i) => i % 2 ? part : t(part)).join('');
      const labeled = /^([^:]+): (.+)$/.exec(value);
      if (labeled && dictionary[labeled[1]]) return dictionary[labeled[1]] + ': ' + t(labeled[2]);
    }
    return result === undefined ? value : value.replace(value.trim(), result);
  }
  function applyValue(node, attr) {
    const value = attr ? node.getAttribute(attr) : node.data;
    if (!value) return;
    let record = originals.get(node);
    const field = attr || 'text';
    const saved = record?.[field];
    // If the application updated a label, translate the new value rather than
    // resurrecting its previous content on the next language switch.
    const original = saved && value === saved.translated ? saved.original : value;
    const translated = t(original);
    if (translated === value) return;
    if (!record) { record = {}; originals.set(node, record); }
    record[field] = { original, translated };
    if (attr) node.setAttribute(attr, translated); else node.data = translated;
  }
  function translate(root) {
    if (root.nodeType === 3) {
      if (language === 'en' && !/[А-Яа-яЁё]/.test(root.data)) return;
      if (!root.parentElement?.closest(skip + ',textarea')) applyValue(root);
      return;
    }
    if (root.nodeType !== 1 || root.closest(skip)) return;
    for (const attr of attributes) if (root.hasAttribute(attr)) applyValue(root, attr);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return node.nodeType === 1 && node.matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === 3) { if (node.parentElement?.tagName !== 'TEXTAREA') applyValue(node); }
      else for (const attr of attributes) if (node.hasAttribute(attr)) applyValue(node, attr);
    }
  }
  // No observer in the default Russian mode. In English only changed subtrees
  // and labels are visited; never rescan the document on a price/animation tick.
  const observer = new MutationObserver(records => {
    observer.disconnect();
    const roots = new Set();
    for (const record of records) {
      if (record.type === 'attributes' && !record.target.closest(skip)) applyValue(record.target, record.attributeName);
      else if (record.type === 'characterData') roots.add(record.target);
      else for (const node of record.addedNodes) roots.add(node);
    }
    for (const root of roots) if (root.isConnected && !roots.has(root.parentNode)) translate(root);
    observe();
  });
  function observe() {
    if (language === 'en' && typeof document !== 'undefined' && document?.body) observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: attributes
    });
  }
  function setLanguage(next, persist = true) {
    const previous = appliedLanguage;
    language = next === 'en' ? 'en' : 'ru';
    if (persist) { try { localStorage.setItem(key, language); } catch (_) {} }
    observer.disconnect();
    document.documentElement.lang = language;
    if (document.body) {
      if (previous !== language && (language === 'en' || previous === 'en')) translate(document.body);
      appliedLanguage = language;
    }
    const select = document.getElementById('profile-language');
    if (select) select.value = language;
    observe();
    if (previous !== language) window.dispatchEvent(new CustomEvent('obsidian:languagechange', { detail: { language } }));
  }
  window.ObsidianI18n = { t, translate, setLanguage, get language() { return language; }, get locale() { return language === 'en' ? 'en-US' : 'ru-RU'; } };
  function init() {
    setLanguage(language, false);
    document.getElementById('profile-language')?.addEventListener('change', event => setLanguage(event.target.value));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  window.addEventListener('storage', event => { if (event.key === key) setLanguage(event.newValue, false); });
})();
