import { parseAmount } from './format.js';

// Settings live in chrome.storage.sync (tiny, and worth following you between
// machines). The rate cache lives in storage.local — see rates.js — because it
// is per-machine and rewritten every few minutes.

/**
 * 'auto' follows Chrome's own display language; the rest force one. English
 * only for now — the bundle plumbing stays so a new translation is one folder
 * in _locales plus an entry here.
 */
export const LANGUAGES = ['auto', 'en'];

/**
 * The fiats you can convert into.
 *
 * Intersected once, here, rather than at runtime: CoinGecko's
 * /simple/price?vs_currencies list and exchangerate-api's USD-base response
 * both carry every code below, so any of them can be served by either provider
 * and by the casinos' own price tables. Asking the two APIs which currencies
 * they have in common would cost two requests to learn something that changes
 * about once a decade.
 *
 * Display names come from Intl.DisplayNames at the call site, so there is no
 * name table here to fall out of date either.
 */
export const TARGET_CURRENCIES = [
  'AED', 'ARS', 'AUD', 'BDT', 'BHD', 'BMD', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY',
  'CZK', 'DKK', 'EUR', 'GBP', 'GEL', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'JPY',
  'KRW', 'KWD', 'LKR', 'MMK', 'MXN', 'MYR', 'NGN', 'NOK', 'NZD', 'PHP', 'PKR',
  'PLN', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'USD', 'VND',
  'ZAR',
];

export const DEFAULTS = {
  enabled: true,

  // The fiat everything is converted into. ISO 4217, and the one setting the
  // rest of the extension is parameterised on: providers are asked for it, the
  // casinos' price tables are read for it, limits are denominated in it, and
  // every figure on screen is formatted for it.
  //
  // ILS is the default because that is what this was before it could be
  // anything else — an existing install has no stored value and lands here,
  // so nobody's numbers change under them on upgrade.
  targetCurrency: 'ILS',

  // chrome.i18n cannot be overridden at runtime, so the resolved language is
  // carried in state and the message bundle is looked up by hand. This is the
  // knob that decides which bundle.
  language: 'auto',

  // How often the service worker re-fetches.
  //
  // 1 minute is the fastest setting that gains anything, and it is measured
  // rather than assumed: the source data changes about every 80s, Cloudflare
  // caches the response for 60s, and keyless 429s past roughly 10 calls/min
  // with Retry-After: 60 — so polling harder trades one wasted call for a full
  // minute of no data. Chrome clamps alarms at 1 minute anyway.
  refreshMinutes: 1,

  decimals: 2,

  // Read Stake's "My Bets" table to track session profit, loss and turnover.
  trackSession: true,

  // Quiet time after which a session is considered finished and archived.
  sessionIdleMinutes: 30,

  // The month a tax year opens on, 1-12. The By-year report buckets on it.
  //
  // January because Israel's tax year is the calendar year and that is what
  // this was built for; the UK's opens in April and Australia's in July, and
  // neither is served by a report that can only count calendar years. Purely a
  // bucketing choice — nothing about the figures themselves changes.
  fiscalYearStart: 1,

  // Session limits, in money — the unit the player actually thinks in.
  // Compared against the session converted at the current rate. null = off.
  // Loss and win are two directions of the same figure, so at most one of them
  // can be live at any moment.
  limitWager: null,
  limitLoss: null,
  limitWin: null,

  // Which currency those three are denominated in. Normally the same as
  // targetCurrency — the service worker converts them once when the target
  // changes and moves this along with them — but it is stored rather than
  // assumed, because the alternative is comparing a number entered in shekels
  // against a session measured in euros and calling that a limit.
  limitCurrency: 'ILS',

  // The fourth limit, and the only one not measured in money: minutes since the
  // session opened. Time is what people actually lose track of.
  limitMinutes: null,

  // Rate alerts: a desktop notice when the effective USDT rate crosses a line,
  // in target-currency units per USDT. Fires on the crossing, not while the
  // condition holds. null = off. Denominated in limitCurrency like the money
  // limits, and converted alongside them when the target changes.
  alertAbove: null,
  alertBelow: null,

  // Toolbar badge: session P/L in shekels while a session is live, the rate
  // when it is not. Visible without opening anything.
  showBadge: true,

  // One desktop notice per limit per session. The overlay only helps if the
  // Stake tab is the one you are looking at.
  notifyLimits: true,

  // Read the rakeback balance and VIP progress out of the GraphQL responses
  // Stake's own app already receives. Off by default: it reads an account API
  // rather than the page, which is a different kind of thing to be doing.
  trackRakeback: false,

  // Additionally repeat one of those requests on a timer, while the tab is
  // visible and focused. Separately opt-in because this one generates traffic
  // rather than only watching it.
  rakebackPoll: false,

  // Take the rate from the casino's own currency table when one of its tabs is
  // open. On by default, unlike the rakeback reader: this is the public price
  // list the page fetches every few seconds to draw its own figures, it carries
  // no account data, it costs no request, and it is both fresher than the
  // one-minute provider poll and the very rate the balance on screen was drawn
  // with. A target the table does not carry falls through to the providers.
  stakeRates: true,

  // Overlay surfaces, all rendered in an isolated shadow root.
  showHud: true,
  hoverTooltip: true,
  selectionTooltip: true,

  // Attribute-based annotation of amounts found in the page. Off by default:
  // see content.js for why this is the only inline mode that is safe here.
  inlineAnnotate: false,

  // Treat a bare number as USDT when it has no currency label. Needed for the
  // header balance; noisy everywhere else.
  assumeUnlabeled: false,

  // Spread of your real off-ramp, in percent. 0 = use the quoted mid-price.
  feePercent: 0,

  // Set to a number to ignore the providers entirely and use your own rate.
  manualRate: null,

  // Extra hostnames the casinos answer on, as [{host, site}].
  //
  // Both sites run the same app on several domains, and which ones exist
  // changes without notice — so they are a setting rather than a list baked
  // into the manifest. Each entry names which casino it is: guessing from a
  // hostname is exactly the mistake this avoids, since a Duel mirror read as
  // Stake watches for a bet table that does not exist and reports nothing
  // wrong.
  //
  // A host here does nothing on its own. The extension only runs on it once
  // the browser has been asked for permission, from the options page, and that
  // permission is per-machine — so this list syncing between machines does not
  // carry the access with it.
  mirrors: [],

  // The element pinned by the picker, so the HUD can read a live balance.
  trackedSelector: '',
  trackedLabel: '',

  // Where the user dragged the HUD to, in px from the bottom-right.
  hudRight: 16,
  hudBottom: 16,
};

/** Casinos a mirror may be declared as. Anything else is not an adapter. */
export const MIRROR_SITES = ['stake', 'duel'];

/** More than anyone has, and low enough that the list stays reviewable. */
const MIRROR_LIMIT = 20;

/**
 * A bare hostname: no scheme, no port, no path, no wildcard, at least one dot.
 *
 * Deliberately strict. Every accepted value here becomes a host permission
 * request and a content-script match pattern, and "*" in the wrong place is
 * the difference between one casino and every site the user visits.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The origins a mirror needs before the extension may run on it. */
export function mirrorOrigins(host) {
  return [`https://${host}/*`, `https://*.${host}/*`];
}

/**
 * Clean a mirror list into something safe to register content scripts against.
 * Anything that does not survive is dropped rather than corrected.
 */
export function sanitizeMirrors(list) {
  const out = [];
  const seen = new Set();

  for (const entry of Array.isArray(list) ? list : []) {
    const host = String(entry?.host || '').trim().toLowerCase().replace(/\.$/, '');
    const site = String(entry?.site || '').trim().toLowerCase();

    if (!HOSTNAME_RE.test(host)) continue;
    if (!MIRROR_SITES.includes(site)) continue;
    if (seen.has(host)) continue;

    seen.add(host);
    out.push({ host, site });
    if (out.length >= MIRROR_LIMIT) break;
  }

  return out;
}

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  return loadSettings();
}

/** Clamp anything a text input could produce into something usable. */
export function sanitize(patch) {
  const out = { ...patch };

  if ('refreshMinutes' in out) {
    const n = Number(out.refreshMinutes);
    out.refreshMinutes = Number.isFinite(n) ? Math.min(1440, Math.max(1, Math.round(n))) : DEFAULTS.refreshMinutes;
  }
  if ('decimals' in out) {
    const n = Number(out.decimals);
    out.decimals = Number.isFinite(n) ? Math.min(8, Math.max(0, Math.round(n))) : DEFAULTS.decimals;
  }
  if ('sessionIdleMinutes' in out) {
    const n = Number(out.sessionIdleMinutes);
    out.sessionIdleMinutes = Number.isFinite(n) ? Math.min(1440, Math.max(1, Math.round(n))) : DEFAULTS.sessionIdleMinutes;
  }
  if ('fiscalYearStart' in out) {
    const n = Number(out.fiscalYearStart);
    out.fiscalYearStart = Number.isFinite(n) ? Math.min(12, Math.max(1, Math.round(n))) : DEFAULTS.fiscalYearStart;
  }
  if ('feePercent' in out) {
    const n = Number(out.feePercent);
    out.feePercent = Number.isFinite(n) ? Math.min(50, Math.max(-50, n)) : 0;
  }
  // Blank clears a limit; anything at or below zero is not a limit.
  //
  // Parsed the same way as an amount on the page, not with a bare Number():
  // these fields are money, and their label carries the target's own mark, so
  // "1,000", "₪1,000" and "€1,000" are all the obvious things to type. Number()
  // turns every one of them into NaN — which used to land here as null and read
  // back as "off" while the UI reported it saved.
  for (const field of ['limitWager', 'limitLoss', 'limitWin', 'alertAbove', 'alertBelow']) {
    if (!(field in out)) continue;
    const n = parseAmount(out[field]);
    out[field] = Number.isFinite(n) && n > 0 ? n : null;
  }

  // Same nullable rule as the money limits, but whole minutes and capped at a
  // day: a 90-minute session is a limit, "1.5" minutes is a typo.
  if ('limitMinutes' in out) {
    const n = parseAmount(out.limitMinutes);
    out.limitMinutes = Number.isFinite(n) && n >= 1 ? Math.min(1440, Math.round(n)) : null;
  }

  // An unknown language is 'auto' rather than a blank UI.
  if ('language' in out) {
    out.language = LANGUAGES.includes(out.language) ? out.language : 'auto';
  }

  // A target the providers cannot quote is not a target. Falling back to the
  // default keeps every downstream lookup — vs_currencies, the fiat row in a
  // casino table, Intl.NumberFormat — asking for something that exists.
  for (const field of ['targetCurrency', 'limitCurrency']) {
    if (!(field in out)) continue;
    const code = String(out[field] || '').toUpperCase();
    out[field] = TARGET_CURRENCIES.includes(code) ? code : DEFAULTS[field];
  }

  if ('mirrors' in out) out.mirrors = sanitizeMirrors(out.mirrors);

  if ('manualRate' in out) {
    const n = Number(out.manualRate);
    out.manualRate = Number.isFinite(n) && n > 0 ? n : null;
  }

  return out;
}
