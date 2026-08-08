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

  // Say something when a session's stakes have climbed well past what it
  // opened with, while it is down. On by default, and once per session: it is
  // the one reading here that is about the player rather than the money, and a
  // thing you would want said to you is not a thing to make you find first.
  notifyChasing: true,

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

  // House edge of the games you play, in percent, for the cost report.
  //
  // One figure standing in for every game until there is a per-game table.
  // 1% is what Stake's own originals are documented at — dice, limbo, mines
  // and the rest are 99% RTP — so it is right for anyone playing those and
  // too low for anyone playing slots, which is the direction that understates
  // rather than overstates what the extension claims to know.
  houseEdgePercent: 1,

  // Fraction of the house edge handed back as rakeback, in percent.
  //
  // 3.5 is the figure in Stake's own help centre, and their worked example
  // agrees with it. Third-party calculators say 5, which is either stale or
  // wrong — so this is a setting rather than a constant, and the extension
  // prefers what it has actually watched arrive over either number.
  rakebackPercent: 3.5,

  // Spread of your real off-ramp, in percent. 0 = use the quoted mid-price.
  feePercent: 0,

  // Set to a number to ignore the providers entirely and use your own rate.
  manualRate: null,

  // Which of the switchable domains in CASINOS the user has turned on, as
  // [{host, site}].
  //
  // Only ever domains from that registry — the list is an allowlist, not a
  // place to name a site. A domain here still does nothing until Chrome has
  // been asked for access to it from the options page, and that permission is
  // per-machine, so this list following the profile does not carry the access
  // with it.
  mirrors: [],

  // What the readout follows on each casino, as {siteId: {selector, label}}.
  //
  // Per site, because a pin is a path into one site's markup: a pin made on
  // Stake and then carried to Duel could only ever fail to resolve, and the
  // readout said "element not on this page" — which reads as a broken pin
  // rather than as a pin for somewhere else.
  //
  // Empty is the normal state. With nothing here the readout follows the site's
  // own balance chip, which is the `currencyChip` selector each adapter already
  // carries for reading the wallet coin: a `data-testid` both sites keep stable
  // across deploys, unlike the generated class names underneath it. Pinning is
  // now for choosing something *else*, not for making the thing work.
  pins: {},

  // The single global pin this replaced. Nothing writes it any more; it is read
  // as a fallback so that anyone who pinned before pins were per site keeps
  // what they had until they pin again.
  trackedSelector: '',
  trackedLabel: '',

  // Where the user dragged the HUD to, in px from the bottom-right.
  hudRight: 16,
  hudBottom: 16,

  // ------------------------------------------------------- streamer overlay
  //
  // A separate window, sized and coloured for broadcast software to capture.
  // It reads the same session state everything else does and shows a chosen
  // subset of it — no new data, no new permission, no request.
  //
  // Nothing here is broadcast until the window is deliberately opened, which
  // is the reason the field list can afford a default at all: the cost of a
  // field being on is paid only by somebody who has already decided to put
  // their session on screen.

  // Which figures the overlay shows, from OVERLAY_FIELDS below.
  //
  // P/L and turnover only. The rest are opt-in one at a time because this is
  // the one surface whose audience is not the person playing — a bet count and
  // a win rate say more about somebody than they may have meant to say, and a
  // layout that shipped with everything on would say it before they looked.
  overlayFields: ['pl', 'wagered'],

  // What each field is called on the overlay, as {fieldId: text}. Anything not
  // named here falls back to the translated label.
  //
  // This is the one place in the extension where the user writes the words
  // rather than choosing a language, and it is the right place for it: an
  // overlay is read by an audience, and which language that audience speaks is
  // not a thing the extension can know. It also covers the case a translation
  // never will — a streamer who wants "PROFIT" where the popup says "P/L", or
  // their own handle in place of a label.
  overlayLabels: {},

  // 'bar' lays the figures out in a row, for a strip along the top or bottom
  // of a scene. 'block' stacks them, for a corner panel.
  overlayLayout: 'bar',

  // Text height in px. Broadcast is watched at a distance and downscaled, so
  // this runs a long way past anything the popup would need.
  overlaySize: 40,

  overlayColor: '#ffffff',

  // Solid rather than transparent, and that is a limitation being handled
  // rather than a preference. Window capture composites against the browser's
  // own opaque backdrop, so a page with no background is captured as white —
  // the way to get a clean cut-out is a flat colour the streamer keys out.
  // Broadcast green by default; anyone who only wants a tidy panel on a second
  // monitor can set it to something dark and key nothing.
  overlayBackground: '#00b140',

  // Show the coin figure beside the converted one. On, because a casino
  // stream's audience is watching a balance denominated in coin.
  overlayCoin: true,
};

/**
 * What the streamer overlay can show.
 *
 * Ordered as they are laid out. `id` is what is stored, so renaming one is a
 * migration; the label is looked up at render time and can change freely.
 */
export const OVERLAY_FIELDS = [
  { id: 'pl', key: 'popPl', label: 'P/L' },
  { id: 'wagered', key: 'popWagered', label: 'Wagered' },
  { id: 'bets', key: 'popBets', label: 'Bets' },
  { id: 'winrate', key: 'ovWinRate', label: 'Won' },
  { id: 'best', key: 'popBest', label: 'Best' },
  { id: 'duration', key: 'labelTime', label: 'Time' },
];

export const OVERLAY_LAYOUTS = ['bar', 'block'];

/**
 * How big the overlay window has to be to hold what was ticked.
 *
 * Both dimensions are multiples of the text height, because that is the only
 * thing deciding how much room a figure needs — but the long axis also scales
 * with the *number* of fields, which the first version of this did not. Six
 * fields in a window sized for two wrapped onto a second row and were clipped
 * top and bottom, which on a stream is a figure cut in half rather than a
 * layout that looks slightly off.
 *
 * The per-field constants are measured, not guessed: six fields at 40px with
 * coin amounts showing lay out in 938×75 — 3.9 text-heights wide per field and
 * 1.9 tall. Both are rounded up from there, because the figures that were
 * measured are not the longest ones there can be; a BTC session carries eight
 * decimals.
 *
 * Capped at something a display can actually show, so a large text size and a
 * full field list ask for a window rather than a wall.
 */
export function overlayWindowSize({ overlayLayout, overlaySize, overlayFields } = {}) {
  const size = Number.isFinite(overlaySize) ? overlaySize : DEFAULTS.overlaySize;
  // At least one, so an empty field list still opens a window big enough to
  // show the "nothing ticked" line rather than a sliver.
  const fields = Math.max(1, (overlayFields || []).length);
  const bar = overlayLayout !== 'block';

  return {
    width: Math.min(1920, Math.round(size * (bar ? fields * 5 + 1 : 11))),
    height: Math.min(1080, Math.round(size * (bar ? 3 : fields * 1.5 + 1))),
  };
}

/**
 * The casinos this build understands, and every domain each answers on.
 *
 * One list, and it is a closed one. The extension will never run anywhere that
 * is not named here — not on a domain a user types, not on one a page claims
 * to be. That is a deliberate limit rather than a missing feature: an adapter
 * is a set of assumptions about one site's ledger, and pointing it at a site it
 * was not written for does not fail, it produces confident wrong numbers.
 *
 * `builtIn` domains are matched by the manifest and work on install.
 * `optional` domains ship switched off; the user turns one on from Options and
 * Chrome asks for access to it then. Both lists must be mirrored exactly in
 * manifest.json — `content_scripts.matches` and `optional_host_permissions`
 * respectively — and tools/domtest.mjs asserts they agree, because a domain
 * this file allows and the manifest does not is a switch that appears to work
 * and does nothing.
 *
 * Adding a casino: an adapter first (see docs/ADAPTERS.md), then an entry here.
 * Adding a domain to a casino that already works: an entry here and in the
 * manifest, and nothing else.
 */
export const CASINOS = {
  stake: {
    id: 'stake',
    name: 'Stake',
    builtIn: ['stake.com', 'stake.bet', 'stake.games', 'stake.us'],
    optional: [],
  },
  duel: {
    id: 'duel',
    name: 'Duel',
    builtIn: ['duel.com', 'duel.limited', 'duel.vip', 'duel.net'],
    optional: [],
  },
};

/** Every domain that can be switched on, as {host, site}. */
export const OPTIONAL_DOMAINS = Object.values(CASINOS)
  .flatMap((casino) => casino.optional.map((host) => ({ host, site: casino.id })));

/** Which casino a switchable domain belongs to, or null if it is not one. */
export function casinoForDomain(host) {
  const wanted = String(host || '').trim().toLowerCase();
  return OPTIONAL_DOMAINS.find((entry) => entry.host === wanted)?.site || null;
}

/** The origins a domain needs before the extension may run on it. */
export function mirrorOrigins(host) {
  return [`https://${host}/*`, `https://*.${host}/*`];
}

/**
 * Reduce a stored list to domains this build actually supports.
 *
 * An allowlist, not a validator: the question is never "is this a well-formed
 * hostname" but "is this one of ours". Which casino a domain is comes from the
 * registry rather than from the stored entry, so a hand-edited settings file
 * cannot hand Duel's adapter a Stake domain.
 */
export function sanitizeMirrors(list) {
  const out = [];
  const seen = new Set();

  for (const entry of Array.isArray(list) ? list : []) {
    const host = String(entry?.host || '').trim().toLowerCase().replace(/\.$/, '');
    const site = casinoForDomain(host);

    if (!site || seen.has(host)) continue;

    seen.add(host);
    out.push({ host, site });
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
  if ('houseEdgePercent' in out) {
    const n = parseAmount(out.houseEdgePercent);
    out.houseEdgePercent = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULTS.houseEdgePercent;
  }
  if ('rakebackPercent' in out) {
    const n = parseAmount(out.rakebackPercent);
    out.rakebackPercent = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULTS.rakebackPercent;
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

  // Keyed by casino, so an unknown key is dropped rather than kept as a pin for
  // a site this build has never heard of. The selector is capped because it is
  // a generated path — twenty levels of Stake's markup is long, and something
  // far longer than that did not come from the picker.
  if ('pins' in out) {
    const known = new Set(Object.keys(CASINOS));
    const offered = out.pins && typeof out.pins === 'object' ? out.pins : {};
    const pins = {};

    for (const [site, value] of Object.entries(offered)) {
      if (!known.has(site)) continue;
      const selector = String(value?.selector ?? '').trim().slice(0, 1000);
      // No selector is not a pin. Storing one would be a row in the options
      // page offering to clear something that was never set.
      if (!selector) continue;
      pins[site] = { selector, label: String(value?.label ?? '').trim().slice(0, 40) };
    }

    out.pins = pins;
  }

  // An allowlist, like the mirrors: a stored field this build does not know how
  // to render would be a blank cell in the middle of somebody's stream.
  if ('overlayFields' in out) {
    const known = new Set(OVERLAY_FIELDS.map((f) => f.id));
    const offered = Array.isArray(out.overlayFields) ? out.overlayFields : [];
    // Deduplicated and put back into the canonical order, so the layout does
    // not depend on which checkbox was clicked first.
    const chosen = new Set(offered.filter((id) => known.has(id)));
    out.overlayFields = OVERLAY_FIELDS.map((f) => f.id).filter((id) => chosen.has(id));
  }

  // Same allowlist as the field list, and a length cap: these go on screen at
  // the overlay's text size, where a long one pushes every figure beside it out
  // of the window. Blank means "use the translated label" rather than "show
  // nothing", so an emptied box removes the override instead of storing one.
  if ('overlayLabels' in out) {
    const known = new Set(OVERLAY_FIELDS.map((f) => f.id));
    const offered = out.overlayLabels && typeof out.overlayLabels === 'object' ? out.overlayLabels : {};
    const labels = {};
    for (const [id, text] of Object.entries(offered)) {
      if (!known.has(id)) continue;
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (clean) labels[id] = clean;
    }
    out.overlayLabels = labels;
  }

  if ('overlayLayout' in out) {
    out.overlayLayout = OVERLAY_LAYOUTS.includes(out.overlayLayout)
      ? out.overlayLayout : DEFAULTS.overlayLayout;
  }

  if ('overlaySize' in out) {
    const n = Number(out.overlaySize);
    out.overlaySize = Number.isFinite(n) ? Math.min(160, Math.max(12, Math.round(n))) : DEFAULTS.overlaySize;
  }

  // Only a hex colour, and only because this string is written into a style
  // attribute: anything else here would be a page the extension renders taking
  // dictation about its own CSS.
  for (const field of ['overlayColor', 'overlayBackground']) {
    if (!(field in out)) continue;
    const raw = String(out[field] || '').trim().toLowerCase();
    out[field] = /^#[0-9a-f]{6}$/.test(raw) ? raw : DEFAULTS[field];
  }

  if ('manualRate' in out) {
    const n = Number(out.manualRate);
    out.manualRate = Number.isFinite(n) && n > 0 ? n : null;
  }

  return out;
}
