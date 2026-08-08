// The streamer overlay: the live session, large, on a colour that keys out.
//
// It is a separate window rather than a mode of the on-page HUD, because the
// two want opposite things. The HUD is small, draggable and sits beside the
// numbers it is converting; this is fixed, enormous, and has to survive being
// captured by software that knows nothing about it.
//
// It reads state the same way the content script does — the `mirror` key in
// storage.local, rewritten by the service worker on every change — so it costs
// no request, no permission and no new data. Nothing here can write anything.
//
// **How this is actually captured.** OBS's Browser Source runs its own browser
// and cannot load a chrome-extension:// URL out of your profile, so the working
// path is a Window Capture of this window with a chroma key on the background
// colour. That is why the background is a flat colour rather than transparent:
// window capture composites against the browser's own opaque backdrop, so a page
// with no background of its own is captured as white.

import { coinRate, escapeHtml, formatMoney, formatMultiplier, formatNumber } from './lib/format.js';
import { applyI18n, t, useMessages } from './lib/i18n.js';
import { winRate } from './lib/session.js';
import { DEFAULTS, OVERLAY_FIELDS, OVERLAY_LAYOUTS } from './lib/settings.js';

const panel = document.getElementById('panel');
const idle = document.getElementById('idle');

let state = null;

/** Settings, with anything missing filled from the defaults. */
const conf = () => ({ ...DEFAULTS, ...(state?.settings || {}) });

/**
 * How each field reads, given the session and the rate for its coin.
 *
 * Every one returns `{value, sub, tone}` or null to be left out entirely — a
 * cell that would say "—" is worse than no cell, because on a stream an empty
 * box reads as something broken rather than as something absent.
 */
const READERS = {
  pl(s, ctx) {
    const profit = s.profit ?? 0;
    const sign = profit > 0 ? '+' : profit < 0 ? '−' : '';
    return {
      value: sign + ctx.money(Math.abs(profit)),
      sub: ctx.coin(Math.abs(profit)),
      tone: profit > 0 ? 'up' : profit < 0 ? 'down' : '',
    };
  },

  wagered: (s, ctx) => ({ value: ctx.money(s.wagered), sub: ctx.coin(s.wagered), tone: '' }),

  bets: (s) => ({ value: String(s.bets), sub: `${s.wins}W / ${s.losses}L`, tone: '' }),

  winrate(s) {
    const rate = winRate(s.wins, s.bets);
    return rate === null ? null : { value: `${rate.toFixed(0)}%`, sub: '', tone: '' };
  },

  best(s) {
    // Nothing has paid yet, so there is no record — not a record of zero.
    if (!s.best || !Number.isFinite(s.best.multiplier) || s.best.multiplier <= 0) return null;
    return { value: formatMultiplier(s.best.multiplier), sub: s.best.game || '', tone: '' };
  },

  duration(s) {
    const minutes = Math.floor((Date.now() - s.startedAt) / 60_000);
    const shown = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return { value: shown, sub: '', tone: '' };
  },
};

function render() {
  const settings = conf();
  const root = document.documentElement;

  root.style.setProperty('--size', `${settings.overlaySize}px`);
  root.style.setProperty('--fg', settings.overlayColor);
  root.style.setProperty('--bg', settings.overlayBackground);

  const layout = OVERLAY_LAYOUTS.includes(settings.overlayLayout) ? settings.overlayLayout : 'bar';
  panel.className = `panel ${layout}`;

  const s = state?.session;
  // A session with no bets in it is not a session anybody wants on screen, and
  // the between-sessions state is most of an evening.
  if (!s || !(s.bets > 0)) {
    panel.hidden = true;
    idle.hidden = false;
    idle.textContent = t('ovWaiting', 'Waiting for a session…');
    return;
  }

  idle.hidden = true;
  panel.hidden = false;

  const rate = coinRate(state.rate, s.currency);
  const code = settings.targetCurrency;
  const ticker = s.currency || 'USDT';

  const ctx = {
    // A coin the providers did not price shows coin units rather than a
    // converted figure that is not its own — the same refusal as everywhere else.
    money: (value) => (Number.isFinite(rate)
      ? formatMoney(value * rate, code, settings.decimals)
      : `${formatNumber(value, 4)} ${ticker}`),
    coin: (value) => (settings.overlayCoin && Number.isFinite(rate)
      ? `${formatNumber(value, 4)} ${ticker}`
      : ''),
  };

  const cells = [];
  for (const field of OVERLAY_FIELDS) {
    if (!settings.overlayFields.includes(field.id)) continue;

    const read = READERS[field.id]?.(s, ctx);
    if (!read) continue;

    // The user's own wording wins over the translated label. An overlay is read
    // by an audience whose language the extension has no way of knowing, so the
    // words are theirs to write — see `overlayLabels`.
    const label = settings.overlayLabels?.[field.id] || t(field.key, field.label);

    // Every one of these is a formatted number, a game name read off the
    // casino's own markup, or a string the user typed. All three are escaped.
    cells.push(`<div class="cell">
      <span class="k">${escapeHtml(label)}</span>
      <b class="v${read.tone ? ` ${read.tone}` : ''}">${escapeHtml(read.value)}${
        read.sub ? `<small>${escapeHtml(read.sub)}</small>` : ''
      }</b>
    </div>`);
  }

  // Every chosen field declined to report. Says so rather than showing an empty
  // strip that looks like a broken capture.
  if (cells.length === 0) {
    panel.hidden = true;
    idle.hidden = false;
    idle.textContent = t('ovNothingYet', 'Nothing to show yet…');
    return;
  }

  panel.innerHTML = cells.join('');
}

// The mirror is rewritten by the service worker on every state change, so this
// is the whole update path: no polling, no messaging, no request.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.i18n) { useMessages(changes.i18n.newValue); applyI18n(); }
  if (changes.mirror) { state = changes.mirror.newValue; render(); }
});

const { mirror, i18n } = await chrome.storage.local.get(['mirror', 'i18n']);
useMessages(i18n);
applyI18n();

// The mirror is written on every state change, but a freshly installed profile
// may not have one yet.
state = mirror || await chrome.runtime.sendMessage({ type: 'getState' }).catch(() => null);
render();

// The clock keeps moving between bets, and a session length frozen at whatever
// the last bet left it would be wrong for as long as nobody is betting — which
// is exactly when somebody is looking at it.
setInterval(render, 15_000);
