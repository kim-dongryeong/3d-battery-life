// Lightweight, contributor-friendly i18n for the viewer.
//
// Design: Korean is the source language and also the KEY — a locale file is just a flat JSON dict
// { "한국어 원문": "translation", ... }. To add a language a contributor copies web/locales/en.json,
// translates the values, and drops it in as web/locales/<code>.json (+ one line in locales/index.json).
// No key management, no build step. Untranslated strings gracefully fall back to Korean.
//
// Static UI is marked by putting `data-i18n` on a container (scope); at load we walk the text nodes
// and `title` attributes inside each scope and swap any exact-match Korean for its translation. We
// run once at load (the marked scopes are static HTML), and changing language just reloads the page.
// Dynamic JS strings can opt in via the exported `t('한국어')` (returns the translation or the Korean).

let dict = {};
const LANG = (() => { try { return localStorage.getItem('battLang') || 'ko'; } catch { return 'ko'; } })();

export function curLang() { return LANG; }
export function t(ko) { return dict[ko] || ko; }
export function setLang(l) { try { localStorage.setItem('battLang', l); } catch { /* ignore */ } location.reload(); }

// available languages: served list, falling back to the two we ship
export async function listLangs() {
  const base = [['ko', '한국어'], ['en', 'English']];
  try {
    const arr = await (await fetch('/locales/index.json')).json();
    if (Array.isArray(arr) && arr.length) return arr.map(x => [x.code, x.name]);
  } catch { /* ignore */ }
  return base;
}

export async function initI18n() {
  if (LANG && LANG !== 'ko') {
    try { dict = await (await fetch(`/locales/${LANG}.json`)).json(); } catch { dict = {}; }
  }
  applyI18n(document);
}

// Translate all text nodes + title attributes inside every [data-i18n] scope under `root`.
let applying = false;
export function applyI18n(root) {
  if (LANG === 'ko' || !root || applying) return;
  const scopes = root.matches && root.matches('[data-i18n]') ? [root] : [];
  if (root.querySelectorAll) root.querySelectorAll('[data-i18n]').forEach(s => scopes.push(s));
  if (!scopes.length) return;
  applying = true;   // guard so our own DOM writes don't re-trigger the observer into extra work
  try {
    for (const scope of scopes) {
      for (const el of [scope, ...scope.querySelectorAll('[title]')]) {
        const o = el.getAttribute && el.getAttribute('title');
        if (o && dict[o.trim()]) el.setAttribute('title', dict[o.trim()]);
      }
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      const nodes = []; let n;
      while ((n = walker.nextNode())) nodes.push(n);
      for (const tn of nodes) {
        const k = tn.nodeValue.trim();
        if (k && dict[k]) tn.nodeValue = tn.nodeValue.replace(k, dict[k]);
      }
    }
  } finally { applying = false; }
}

// Keep dynamic (JS-rendered) content translated: re-apply on any DOM change inside the marked scopes.
export function observeI18n() {
  if (LANG === 'ko' || typeof MutationObserver === 'undefined') return;
  const obs = new MutationObserver(muts => {
    if (applying) return;
    const seen = new Set();
    for (const m of muts) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const scope = el && el.closest && el.closest('[data-i18n]');
      if (scope && !seen.has(scope)) { seen.add(scope); applyI18n(scope); }
    }
  });
  document.querySelectorAll('[data-i18n]').forEach(s => obs.observe(s, { childList: true, subtree: true, characterData: true }));
}
