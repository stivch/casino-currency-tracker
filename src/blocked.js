// The page a casino is replaced with while a self-exclusion is running.
//
// Reads settings directly rather than going through the service worker: this
// page has to render even if the worker is asleep, and everything it shows is
// two numbers out of sync storage. It writes nothing — there is no control on
// this page at all, deliberately, because the moment somebody lands here is the
// worst possible moment to offer them a way out.

import { activeLanguage, applyI18n, t, useMessages } from './lib/i18n.js';
import { DEFAULTS } from './lib/settings.js';
import { exclusionState, remainingParts } from './lib/exclusion.js';

const remainingEl = document.getElementById('remaining');
const untilEl = document.getElementById('until');
const titleEl = document.getElementById('title');

/**
 * Re-read and redraw.
 *
 * On a timer as well as on storage changes, because an exclusion can end while
 * this page is sitting open — and a page that still says "blocked" an hour
 * after it lifted would teach people to distrust it in the other direction too.
 */
async function render() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };
  const state = exclusionState(settings);

  if (!state.active) {
    // It has expired while this page was open. Say so rather than silently
    // navigating somewhere — an automatic bounce back onto a casino is the last
    // thing this feature should do.
    titleEl.textContent = t('blkOverTitle', 'That has finished');
    remainingEl.textContent = t('blkOver', 'Your self-exclusion has ended.');
    untilEl.textContent = '';
    return;
  }

  const { unit, value } = remainingParts(state.msRemaining);
  const lang = activeLanguage();

  remainingEl.textContent = new Intl.NumberFormat(lang, {
    style: 'unit',
    unit: unit.replace(/s$/, ''),
    unitDisplay: 'long',
  }).format(value);

  untilEl.textContent = t('blkUntil', 'until $DATE$', [
    new Intl.DateTimeFormat(lang, { dateStyle: 'full', timeStyle: 'short' }).format(state.until),
  ]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') render();
  // The bundle is mirrored into local storage by the service worker, the same
  // path the streamer overlay reads.
  if (area === 'local' && changes.i18n) {
    useMessages(changes.i18n.newValue);
    applyI18n(document);
    render();
  }
});

// A minute is fine: the figure on screen is rounded to hours or days, so a
// tighter tick would redraw the same words repeatedly.
setInterval(render, 60_000);

(async () => {
  // Null is a supported value — it falls back to chrome.i18n — so a profile the
  // worker has never written a mirror for still renders words rather than keys.
  const { i18n } = await chrome.storage.local.get('i18n');
  useMessages(i18n);
  applyI18n(document);
  await render();
})();
