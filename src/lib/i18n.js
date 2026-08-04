// Localisation for the extension pages.
//
// Two lookups, in order. A bundle handed in by the service worker comes first,
// because chrome.i18n cannot be overridden at runtime — it reads Chrome's own
// display language and nothing else — and an extension whose language you can
// only change by relaunching the whole browser is not one anybody switches.
// chrome.i18n is the fallback, so the extension still speaks before any bundle
// has arrived.
//
// English is the only bundle today. The indirection stays because it is what
// makes a second language a data change rather than a rewrite.
//
// Every call also carries its English text as an argument rather than relying
// on the files being complete: a missing key then degrades to the string that
// was always there, instead of showing a raw key to whoever is unlucky enough
// to be running that locale.

/**
 * Right-to-left languages. Empty while English is the only translation — the
 * RTL layout work (bidi isolation of figures, flipped accents) lives in the
 * git history under the Hebrew locale if a right-to-left language returns.
 */
export const RTL_LANGUAGES = new Set();

/** @type {{lang: string, messages: Record<string, {message: string, placeholders?: object}>}|null} */
let bundle = null;

/** Install the bundle the service worker resolved. Null falls back to chrome.i18n. */
export function useMessages(next) {
  bundle = next && next.messages ? next : null;
}

export const activeLanguage = () => bundle?.lang || chrome.i18n?.getUILanguage?.() || 'en';

/**
 * Chrome's own substitution, done by hand: a message written "$COIN$ balance"
 * declares a placeholder whose content is "$1", which means the first argument.
 */
function substitute(entry, subs) {
  let message = entry.message;
  for (const [name, spec] of Object.entries(entry.placeholders || {})) {
    const index = Number(String(spec.content).replace('$', '')) - 1;
    const value = Array.isArray(subs) ? subs[index] : subs;
    message = message.replace(new RegExp(`\\$${name}\\$`, 'gi'), value ?? '');
  }
  return message;
}

/**
 * @param key       Message name in _locales/<lang>/messages.json.
 * @param fallback  The English text, written at the call site.
 * @param subs      Values for $1, $2, … in the message.
 */
export function t(key, fallback = '', subs = undefined) {
  const entry = bundle?.messages?.[key];
  if (entry?.message) return substitute(entry, subs);

  const message = chrome.i18n?.getMessage(key, subs);
  return message || fallback;
}

/**
 * Replace the text of everything tagged in the markup, and set the page's
 * direction. Safe to run again after a language change: the keys live in the
 * attributes, so nothing is consumed by being applied once.
 *
 *   <span data-i18n="popReset">Reset</span>
 *   <input data-i18n-ph="popOff" placeholder="off">
 *   <button data-i18n-title="hudRefresh" title="Refresh rate">⟳</button>
 */
export function applyI18n(root = document) {
  const html = document.documentElement;
  html.lang = activeLanguage();

  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, el.textContent);
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh, el.placeholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle, el.title);
  }
}
