import { plotSeries } from './lib/chart.js';
import { activeLanguage, applyI18n, t, useMessages } from './lib/i18n.js';
import { currencySymbol, escapeHtml, formatMoney, formatMultiplier } from './lib/format.js';
import { costReport, fiscalYearOf, realisedRtp, restate, winRate } from './lib/session.js';
import { limitSwitchText } from './lib/notices.js';
import { CASINOS, DEFAULTS, OPTIONAL_DOMAINS, OVERLAY_FIELDS, TARGET_CURRENCIES, casinoForDomain, mirrorOrigins, overlayWindowSize } from './lib/settings.js';
import { EXCLUSION_PERIODS, exclusionState, lockedKeys, remainingParts } from './lib/exclusion.js';

const $ = (id) => document.getElementById(id);

const CHECKBOXES = ['enabled', 'trackSession', 'showHud', 'hoverTooltip', 'selectionTooltip',
  'assumeUnlabeled', 'inlineAnnotate', 'showBadge', 'notifyLimits', 'notifyChasing', 'stakeRates',
  'trackRakeback', 'rakebackPoll', 'overlayCoin', 'lockLimits', 'cooldownScreen'];
const NUMBERS = ['refreshMinutes', 'decimals', 'feePercent', 'sessionIdleMinutes', 'overlaySize',
  'cooldownSeconds'];
// Percentages typed as text so "1.5" and a pasted "1.5%" both survive.
const RATES = ['houseEdgePercent', 'rakebackPercent'];
const SELECTS = ['targetCurrency', 'fiscalYearStart', 'overlayLayout'];
// <input type="color"> is always a valid #rrggbb, so these need no parsing —
// only their own listener, because they commit on `input` as you drag.
const COLOURS = ['overlayColor', 'overlayBackground'];
// Nullable: blank means "no limit", so these cannot go through the numeric path.
const LIMITS = ['limitWager', 'limitLoss', 'limitWin', 'limitMinutes', 'alertAbove', 'alertBelow'];

let history = [];
let rakebackEarned = {};

let state = null;

/** The fiat this page reports in. */
const target = () => state?.settings?.targetCurrency || 'ILS';

// Dates, times and counts in the language the page is written in.
//
// `toLocaleString()` with no locale takes the *browser's*, which is not the
// same question: this page is English whatever Chrome is set to, and a Hebrew
// Chrome was rendering its session dates and clock times accordingly. One
// argument each, and they follow the bundle for free if a translation lands.
const stamp = (value, options) => new Date(value).toLocaleString(activeLanguage(), options);
const count = (value) => Number(value).toLocaleString(activeLanguage());

/** "5 Aug 2026, 21:04" — a recorded session's start, as shown in tables. */
const when = (value) => stamp(value, {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

/**
 * The currency picker, filled from the supported list.
 *
 * Names come from Intl rather than a table in this repo, so they arrive
 * already translated into whichever language the page is being read in and
 * cannot drift out of date. A browser that will not name a code shows the code,
 * which is the thing people actually recognise anyway.
 *
 * The language comes from `activeLanguage()` rather than from `<html lang>`.
 * Reading it off the document made this depend on `applyI18n` having run first,
 * and on that attribute being right — which on a Hebrew Chrome it was not, so
 * an English settings page listed its currencies in Hebrew.
 */
function fillCurrencies() {
  let names = null;
  try {
    names = new Intl.DisplayNames([activeLanguage()], { type: 'currency' });
  } catch {
    names = null;
  }

  $('targetCurrency').innerHTML = TARGET_CURRENCIES
    .map((code) => {
      let name = code;
      try {
        name = names?.of(code) || code;
      } catch {
        name = code;
      }
      return `<option value="${code}">${code}${name === code ? '' : ` — ${name}`}</option>`;
    })
    .join('');
}

/** The twelve months, named by Intl in the page's language rather than listed here. */
function fillMonths() {
  const lang = activeLanguage();
  let format = null;
  try {
    format = new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' });
  } catch {
    format = null;
  }

  $('fiscalYearStart').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const label = format ? format.format(new Date(Date.UTC(2001, i, 1))) : String(i + 1);
    return `<option value="${i + 1}">${label}</option>`;
  }).join('');
}

// ------------------------------------------------------------------ panes
//
// Which pane is showing is the URL fragment and nothing else. That is worth a
// sentence, because the obvious alternative — a variable here plus a stored
// preference — would have to be kept in step with the address bar anyway the
// moment anyone used the back button or opened a link to #reports.

/** The first pane, when the fragment names nothing this page has. */
const FIRST_PAGE = 'general';

function showPage(name) {
  const pages = [...document.querySelectorAll('.page')];
  const wanted = pages.some((page) => page.id === name) ? name : FIRST_PAGE;

  for (const page of pages) page.classList.toggle('on', page.id === wanted);

  for (const link of document.querySelectorAll('.nav-item')) {
    const current = link.getAttribute('href') === `#${wanted}`;
    // aria-current rather than a class of our own: it is what a screen reader
    // reads out, and the stylesheet can select on it just as easily.
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  // Switching pane is arriving somewhere new, and arriving halfway down it is
  // disorienting — but only scroll when there is somewhere to scroll back from.
  if (window.scrollY > 0) window.scrollTo({ top: 0 });
}

const currentPage = () => decodeURIComponent(location.hash.replace(/^#/, ''));

window.addEventListener('hashchange', () => showPage(currentPage()));

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

/**
 * The confirmation line, shown as a pill above everything for a moment.
 *
 * The timer is cleared and restarted rather than left to run: two saves a
 * second apart used to leave the first one's timeout to hide the second's
 * message early, which reads as a save that did not take.
 */
let statusTimer = null;

function status(text, refusal = false) {
  const box = $('status');
  box.textContent = text;
  box.classList.toggle('show', Boolean(text));
  box.classList.toggle('bad', Boolean(refusal));

  clearTimeout(statusTimer);
  if (text) {
    // A refusal has to outlast a confirmation. "Saved." is a receipt for
    // something the user watched happen; "that is locked" is the only
    // explanation they will get for a control that sprang back.
    statusTimer = setTimeout(() => {
      box.classList.remove('show');
      box.textContent = '';
    }, refusal ? 6000 : 1600);
  }
}

function render() {
  const { settings } = state;

  for (const id of CHECKBOXES) $(id).checked = Boolean(settings[id]);
  for (const id of NUMBERS) $(id).value = settings[id];
  for (const id of RATES) $(id).value = settings[id];
  for (const id of SELECTS) $(id).value = settings[id];

  renderExclusion(settings);

  // Blank means "use the live feed", so null must not render as "null".
  $('manualRate').value = Number.isFinite(settings.manualRate) ? settings.manualRate : '';
  for (const id of LIMITS) $(id).value = Number.isFinite(settings[id]) ? settings[id] : '';

  // The money limits name their unit, and the unit is now a setting away.
  const mark = currencySymbol(target());
  $('optLimWagerLabel').textContent = t('optLimWager', `Wager limit (${mark})`, [mark]);
  $('optLimLossLabel').textContent = t('optLimLoss', `Loss limit (${mark})`, [mark]);
  $('optLimWinLabel').textContent = t('optLimWin', `Win limit (${mark})`, [mark]);
  $('optAlertAboveLabel').textContent = t('optAlertAbove', `Alert when the rate rises above (${mark})`, [mark]);
  $('optAlertBelowLabel').textContent = t('optAlertBelow', `Alert when the rate falls below (${mark})`, [mark]);

  // Said next to the picker that caused it, because this is the page where the
  // currency was just changed.
  const switched = limitSwitchText(state.limitSwitch);
  $('limitSwitchNote').hidden = !switched;
  $('limitSwitchNote').className = switched ? 'hint warn' : 'hint';
  $('limitSwitchNote').textContent = switched;

  renderOverlay();
  renderDiagnostics();
  renderMirrors();

  renderKey();
  renderBetLog();
  renderChart();
  // The target currency and the tax-year start both change what this table
  // says without changing a single recorded session, so it is redrawn on any
  // settings write rather than only when history is reloaded.
  renderYears();

  renderPins();
}

/**
 * One row per casino, saying what the readout follows there.
 *
 * Rendered rather than written into the markup because it is a row per entry in
 * `CASINOS` — and because "nothing pinned" is no longer the same statement as
 * "nothing to follow": with no pin the readout follows the site's own balance
 * chip, and a page still headed *Nothing pinned* while the overlay showed a
 * live balance would be describing the opposite of what was happening.
 */
function renderPins() {
  const pins = state.settings.pins || {};

  const rows = Object.values(CASINOS).map((casino) => {
    const pin = pins[casino.id];
    const label = pin
      ? pin.label || t('optPinnedElement', 'pinned element')
      : t('optPinAuto', 'the balance chip');

    return `<div class="row">
      <span class="grow"><span class="label">${escapeHtml(casino.name)} — ${escapeHtml(label)}</span>
        <span class="sub selector">${pin
          ? escapeHtml(pin.selector)
          : t('optPinAutoSub', 'Automatic. Pin something on the page to follow that instead.')}</span></span>
      ${pin ? `<button class="ghost" data-clear-pin="${casino.id}">${t('optClear', 'Clear')}</button>` : ''}
    </div>`;
  });

  // The single pin from before pins were per site. Shown only while one exists,
  // with a way to be rid of it: it is tried on every site, so an old path that
  // happens to match something on a casino it was not made for is the one way
  // this can follow the wrong number.
  if (state.settings.trackedSelector) {
    rows.push(`<div class="row">
      <span class="grow"><span class="label">${t('optPinLegacy', 'Pinned before this was per site')}</span>
        <span class="sub selector">${escapeHtml(state.settings.trackedSelector)}</span></span>
      <button class="ghost" data-clear-pin="legacy">${t('optClear', 'Clear')}</button>
    </div>`);
  }

  const list = $('pinnedList');
  list.innerHTML = rows.join('');

  for (const button of list.querySelectorAll('[data-clear-pin]')) {
    button.addEventListener('click', () => {
      const site = button.dataset.clearPin;
      if (site === 'legacy') return void patch({ trackedSelector: '', trackedLabel: '' });

      const next = { ...(state.settings.pins || {}) };
      delete next[site];
      patch({ pins: next });
    });
  }
}

// ---------------------------------------------------------------- mirrors
//
// A host in the list and a permission for it are two different things: the
// list follows the Chrome profile, the permission does not. So each row says
// which of the two it has, because "added it and nothing happens" is otherwise
// indistinguishable from a broken extension.

const SITE_LABELS = Object.fromEntries(Object.values(CASINOS).map((c) => [c.id, c.name]));

async function mirrorGranted(host) {
  try {
    return await chrome.permissions.contains({ origins: mirrorOrigins(host) });
  } catch {
    return false;
  }
}

/** What this build supports, said plainly — it is a closed list, so it can be. */
function renderSupported() {
  const lines = Object.values(CASINOS).map((casino) => {
    const domains = [...casino.builtIn, ...casino.optional].join(', ');
    return `<strong>${casino.name}</strong> — ${domains}`;
  });
  $('sitesSupported').innerHTML = lines.join('<br>');
}

/** The switchable domains not already on. Empty in a build that ships none. */
function renderMirrorPicker() {
  const on = new Set((state?.settings?.mirrors || []).map((m) => m.host));
  const available = OPTIONAL_DOMAINS.filter((entry) => !on.has(entry.host));

  $('mirrorAdd').hidden = available.length === 0;
  $('mirrorHost').innerHTML = available
    .map((entry) => `<option value="${entry.host}">${entry.host} — ${SITE_LABELS[entry.site]}</option>`)
    .join('');
}

async function renderMirrors() {
  renderSupported();
  renderMirrorPicker();

  const mirrors = state?.settings?.mirrors || [];
  const list = $('mirrorList');

  list.hidden = mirrors.length === 0;
  if (mirrors.length === 0) {
    list.innerHTML = '';
    return;
  }

  const rows = await Promise.all(mirrors.map(async (mirror) => {
    const granted = await mirrorGranted(mirror.host);
    const note = granted
      ? t('mirrorActive', 'running here', [])
      : t('mirrorNoPermission', 'not allowed yet — remove it and add it again to be asked', []);
    return `<div class="row">
      <span class="grow"><span class="label">${escapeHtml(mirror.host)}</span>
        <span class="sub">${SITE_LABELS[mirror.site] || mirror.site} · <span class="${granted ? 'good' : 'warn'}">${note}</span></span></span>
      <button class="ghost" data-mirror="${escapeHtml(mirror.host)}">${t('mirrorRemove', 'Remove')}</button>
    </div>`;
  }));

  list.innerHTML = rows.join('');
  for (const button of list.querySelectorAll('[data-mirror]')) {
    button.addEventListener('click', () => removeMirror(button.dataset.mirror));
  }
}

// ------------------------------------------------------- streamer overlay

/**
 * The field list is built from the registry rather than written into the HTML,
 * so adding a field to `OVERLAY_FIELDS` puts a tick here without touching this
 * page. Everything else in the section is an ordinary control.
 */
function renderOverlay() {
  const { settings } = state;
  const list = $('overlayFields');
  const chosen = new Set(settings.overlayFields || []);
  const labels = settings.overlayLabels || {};

  // Rebuilt whole rather than patched, and it must not be rebuilt while
  // somebody is typing into it — a re-render mid-word would take the caret with
  // it. Every write here goes through patch(), which calls render(), so tabbing
  // from one label to the next would otherwise land the caret nowhere. Only the
  // rebuild is skipped; the controls below it are still brought up to date.
  // The listeners are bound to the elements this builds, so the rebuild and
  // the binding have to be skipped together — binding again over elements that
  // already have listeners is how one keystroke becomes four settings writes.
  if (!list.contains(document.activeElement)) {
    list.innerHTML = OVERLAY_FIELDS.map((field) => {
      const name = escapeHtml(t(field.key, field.label));
      return `<div class="field">
        <label><input type="checkbox" data-field="${field.id}"${chosen.has(field.id) ? ' checked' : ''}>${name}</label>
        <input type="text" data-label="${field.id}" maxlength="24" placeholder="${name}"
          value="${escapeHtml(labels[field.id] || '')}">
      </div>`;
    }).join('');

    for (const box of list.querySelectorAll('[data-field]')) {
      box.addEventListener('change', () => {
        const picked = [...list.querySelectorAll('[data-field]')]
          .filter((el) => el.checked).map((el) => el.dataset.field);
        patch({ overlayFields: picked });
      });
    }

    for (const box of list.querySelectorAll('[data-label]')) {
      // change, not input: one settings write per keystroke would be one state
      // mirror and one overlay repaint per keystroke.
      box.addEventListener('change', () => {
        const next = {};
        for (const el of list.querySelectorAll('[data-label]')) next[el.dataset.label] = el.value;
        patch({ overlayLabels: next });
      });
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.target.blur();
      });
    }
  }

  for (const id of COLOURS) $(id).value = settings[id];

  // Ticking nothing is allowed — it is a set of choices, not a required one —
  // but it produces a blank window, and being told that here beats finding out
  // by capturing it.
  const empty = chosen.size === 0;
  $('overlayHint').className = empty ? 'sub warn' : 'sub';
  $('overlayHint').textContent = empty
    ? t('optOverlayNoFields', 'Nothing ticked, so the window will be empty.')
    : t('optOverlayOpenSub', 'Opens now, and updates itself as you play. Close it to stop broadcasting.');
}

/**
 * Open the overlay in its own window.
 *
 * A `popup` window rather than a tab: it has no tab strip, no address bar and
 * no bookmarks bar, which is three rows of browser furniture that would
 * otherwise be inside the capture. Sized to suit the layout, because a row of
 * figures and a stack of them want opposite shapes.
 */
let overlayWindowId = null;

async function openOverlay() {
  // Raise the one that is already open rather than adding a second. Two
  // overlays on the same session is never what was wanted, and the spare is
  // the one that ends up behind a scene still broadcasting.
  if (overlayWindowId !== null) {
    const raised = await chrome.windows.update(overlayWindowId, { focused: true }).catch(() => null);
    if (raised) return;
    overlayWindowId = null; // closed since; fall through and open a new one
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('src/overlay.html'),
    type: 'popup',
    ...overlayWindowSize(state.settings),
  });

  overlayWindowId = created?.id ?? null;
}

// The window can be closed from its own title bar, and this page would go on
// trying to raise a window that is not there.
chrome.windows.onRemoved.addListener((id) => {
  if (id === overlayWindowId) overlayWindowId = null;
});

function mirrorNote(text, tone = '') {
  $('mirrorMsg').className = tone ? `hint ${tone}` : 'hint';
  $('mirrorMsg').textContent = text;
}

async function addMirror() {
  const host = $('mirrorHost').value;

  // The picker only ever offers registry domains, but the registry is asked
  // again anyway: this is the one place a domain turns into a permission
  // request, and it should not trust the markup it came from.
  const site = casinoForDomain(host);
  if (!site) return mirrorNote(t('mirrorUnknown', 'That domain is not one this version supports.'), 'warn');

  const existing = state.settings.mirrors || [];
  if (existing.some((m) => m.host === host)) {
    return mirrorNote(t('mirrorAlready', `${host} is already on the list.`, [host]));
  }

  // Must happen inside the click, and before the setting is written: a host
  // saved without permission is a row that looks added and does nothing.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: mirrorOrigins(host) });
  } catch (error) {
    return mirrorNote(String(error?.message || error), 'warn');
  }
  if (!granted) return mirrorNote(t('mirrorDeclined', 'Chrome did not grant access, so nothing was added.'), 'warn');

  await patch({ mirrors: [...existing, { host, site }] });
  mirrorNote(t('mirrorAdded', `Running on ${host} now. Reload any tab already open there.`, [host]), 'good');
}

async function removeMirror(host) {
  const rest = (state.settings.mirrors || []).filter((m) => m.host !== host);
  await patch({ mirrors: rest });
  // Handing the permission back matters: leaving it granted would keep access
  // to a site the user has just said they do not want this running on.
  try {
    await chrome.permissions.remove({ origins: mirrorOrigins(host) });
  } catch {
    // Nothing to hand back, which is fine.
  }
  mirrorNote(t('mirrorRemoved', `Stopped running on ${host}.`, [host]));
}

// ------------------------------------------------------------ history view

const num = (value, digits = 4) =>
  Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const signClass = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : '');

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Money in the target currency, at whatever precision that currency has. */
const fiat = (value) => formatMoney(Number(value || 0), target(), state?.settings?.decimals);

/** Why a recorded session has no figure in the currency being viewed. */
const WHY_NO_FIGURE = () => ({
  'no-rate': t('whyNoRate', 'This session closed before any rate had been fetched, so it has no converted figure at all.'),
  'no-cross-rate': t('whyNoCross', 'This session was recorded with a rate you typed, or in a currency the stored table did not cover, so it can only be read in the currency it closed in.'),
  legacy: t('whyLegacy', 'Recorded before the extension could convert to more than one currency, so it can only be read in shekels.'),
});

/**
 * A recorded session's figure in the currency being viewed.
 *
 * Read in the currency it closed in, that is the frozen figure, untouched. Read
 * in another, it is computed from the coin's dollar price and the exchange
 * rates stored when it closed — that evening's money, counted differently, not
 * today's rates applied to an old evening. Where neither is possible it is a
 * dash carrying the reason, never a number worked backwards.
 */
function closedAt(entry, value) {
  const { value: shown, reason } = restate(entry, value, target());
  if (Number.isFinite(shown)) return fiat(shown);
  const why = WHY_NO_FIGURE()[reason] || '';
  return `<span class="flag" title="${why.replace(/"/g, '&quot;')}">—</span>`;
}

/**
 * Which games the money actually went into, per coin.
 *
 * Only sessions recorded since the roll-up existed carry it, so the count of
 * those is said out loud — a breakdown covering half the history and not
 * saying so is a breakdown nobody should trust.
 */
function renderGames(totals) {
  const buckets = Object.values(totals || {}).filter((b) => b.games.length > 0);
  const wrap = $('gameWrap');
  const note = $('gameNote');

  wrap.hidden = buckets.length === 0;
  if (buckets.length === 0) {
    wrap.innerHTML = '';
    note.textContent = t('gamesNone',
      'No per-game figures yet. Sessions recorded from now on keep which games they were played on.');
    return;
  }

  const covered = history.filter((e) => Array.isArray(e.games)).length;
  note.textContent = covered === history.length
    ? t('gamesAll', `From all ${history.length} recorded sessions.`, [String(history.length)])
    : t('gamesSome',
      `From ${covered} of ${history.length} recorded sessions — the rest were archived before this was kept.`,
      [String(covered), String(history.length)]);

  wrap.innerHTML = buckets.map((bucket) => {
    const head = `<thead><tr><th>${t('colGame', 'Game')}</th><th>${t('colBets', 'Bets')}</th>
      <th>${t('colWagered', 'Wagered')}</th><th>${t('colPl', 'P/L')}</th>
      <th>${t('colRtp', 'Return')}</th></tr></thead>`;

    const rows = bucket.games.map((row) => {
      const profit = row.returned - row.wagered;
      const rtp = realisedRtp(row.wagered, row.returned, row.bets);
      return `<tr>
        <td>${escapeHtml(row.game || t('gameUnnamed', 'unnamed'))}</td>
        <td>${count(row.bets)}</td>
        <td>${num(row.wagered)}</td>
        <td class="${signClass(profit)}">${profit > 0 ? '+' : ''}${num(profit)}</td>
        <td>${rtp === null ? '—' : `${rtp.toFixed(2)}%`}</td>
      </tr>`;
    }).join('');

    return `<h3>${bucket.currency}</h3><div class="table-scroll"><table>${head}<tbody>${rows}</tbody></table></div>`;
  }).join('');
}

/**
 * What the games took, what was expected, and what came back.
 *
 * Per coin, because an edge applied to USDT turnover and one applied to BTC
 * turnover are answers to different questions. The rate actually observed is
 * preferred over the documented one wherever there is enough of it to divide.
 */
function renderCost(totals) {
  const settings = state?.settings || {};
  const buckets = Object.values(totals || {});
  const wrap = $('costWrap');

  const cards = buckets.map((bucket) => {
    const report = costReport({
      wagered: bucket.wagered,
      returned: bucket.returned,
      edgePercent: settings.houseEdgePercent,
      rakebackPercent: settings.rakebackPercent,
      earned: rakebackEarned[bucket.currency],
    });
    if (!report) return '';

    // Positive luck means it went worse than the edge alone accounts for.
    // Named as luck rather than as a verdict on the games, because over any
    // normal number of bets that is exactly what it is.
    const ran = report.luck > 0
      ? t('costWorse', `${num(report.luck)} worse than the edge accounts for`, [num(report.luck)])
      : t('costBetter', `${num(-report.luck)} better than the edge accounts for`, [num(-report.luck)]);

    const rateLine = report.measuredRate === null
      ? t('costRateAssumed', `assumed ${settings.rakebackPercent}% of the edge`, [String(settings.rakebackPercent)])
      : t('costRateMeasured', `${report.measuredRate.toFixed(2)}% of the edge, as measured`,
        [report.measuredRate.toFixed(2)]);

    return `<div class="card"><h3>${t('cardCost', `${bucket.currency} — what it costs`, [bucket.currency])}</h3><dl>
      <dt>${t('colWagered', 'Wagered')}</dt><dd>${num(report.wagered)}</dd>
      <dt title="${t('costExpectedWhy', 'Turnover times the house edge — what the games take on average.').replace(/"/g, '&quot;')}">${t('costExpected', 'Expected loss')}</dt>
      <dd>${num(report.expected)}</dd>
      <dt>${t('costActual', 'Actual')}</dt>
      <dd class="${signClass(-report.actual)}">${num(report.actual)}</dd>
      <dt title="${t('costLuckWhy', 'The gap between the two. Over any normal number of bets this is variance, not a verdict on the games.').replace(/"/g, '&quot;')}">${t('costLuck', 'Variance')}</dt>
      <dd class="${signClass(-report.luck)}">${ran}</dd>
      <dt>${t('costRakeback', 'Rakeback')}</dt>
      <dd>${num(report.rakeback)}<br><span class="sub">${rateLine}</span></dd>
      <dt title="${t('costEffectiveWhy', 'The house edge after rakeback — what a unit staked really costs you.').replace(/"/g, '&quot;')}">${t('costEffective', 'Effective edge')}</dt>
      <dd>${report.effectiveEdge.toFixed(3)}%</dd>
    </dl></div>`;
  }).filter(Boolean);

  wrap.hidden = cards.length === 0;
  wrap.className = cards.length ? 'totals' : '';
  wrap.innerHTML = cards.join('');

  const measured = buckets.some((b) => Number.isFinite(rakebackEarned[b.currency]));
  $('costNote').textContent = cards.length === 0
    ? t('costNone', 'Nothing wagered yet, so there is nothing to cost.')
    : measured
      ? t('costMeasuredNote',
        'Rakeback shown is what this extension has watched arrive since it was installed, not your lifetime total.')
      : t('costAssumedNote',
        'Rakeback here is calculated, not observed. Turn on “Read rakeback and VIP progress” and it will report what actually arrives instead.');
}

function renderHistory(totals) {
  $('historyCount').textContent = history.length
    ? t('historyCount', `${history.length} session${history.length === 1 ? '' : 's'} recorded.`, [String(history.length)])
    : t('historyNone', 'No sessions recorded yet.');
  $('exportHistory').disabled = history.length === 0;
  $('clearHistory').disabled = history.length === 0;

  // Totals per currency: summing USDT and BTC turnover would be arithmetic on
  // two different things.
  $('historyTotals').innerHTML = Object.values(totals || {})
    .map(
      (bucket) => {
        // Below the sample threshold this is variance with a percent sign on
        // it, so it is a dash rather than a verdict on the games.
        const rtp = realisedRtp(bucket.wagered, bucket.returned, bucket.bets);
        const won = winRate(bucket.wins, bucket.bets);
        const net = bucket.deposited - bucket.withdrawn;

        // A best multiplier of null means no session recorded one, which is not
        // the same claim as a best of zero. Sessions closed before this was
        // tracked land here, so the dash says which it is.
        const best = bucket.best && Number.isFinite(bucket.best.multiplier)
          ? `${formatMultiplier(bucket.best.multiplier)}${bucket.best.game
            ? ` <span class="dim">${escapeHtml(bucket.best.game)}</span>` : ''}`
          : `<span class="flag" title="${t('bestNone', 'No session has recorded one yet. Sessions closed before this was tracked carry no multiplier.').replace(/"/g, '&quot;')}">—</span>`;

        return `<div class="card"><h3>${t('cardLifetime', `${bucket.currency} — lifetime`, [bucket.currency])}</h3><dl>
        <dt>${t('colSessions', 'Sessions')}</dt><dd>${bucket.sessions}</dd>
        <dt>${t('colBets', 'Bets')}</dt><dd>${count(bucket.bets)}</dd>
        <dt title="${t('winRateWhy', 'How often a bet came back with anything at all. A count, not an estimate — it needs no minimum sample.').replace(/"/g, '&quot;')}">${t('colWonPct', 'Bets that paid')}</dt>
        <dd>${won === null ? '—' : `${won.toFixed(1)}%`}</dd>
        <dt title="${t('bestWhy', 'The highest payout multiplier recorded, across every session in this coin.').replace(/"/g, '&quot;')}">${t('colBest', 'Best multiplier')}</dt>
        <dd>${best}</dd>
        <dt>${t('colWagered', 'Wagered')}</dt><dd>${num(bucket.wagered)}</dd>
        <dt>${t('colPl', 'P/L')}</dt><dd class="${signClass(bucket.profit)}">${bucket.profit > 0 ? '+' : ''}${num(bucket.profit)}</dd>
        <dt title="${t('rtpWhy', 'What came back per unit staked, over every recorded bet.').replace(/"/g, '&quot;')}">${t('colRtp', 'Return')}</dt>
        <dd>${rtp === null
          ? `<span class="flag" title="${t('rtpTooFew', 'Fewer than 200 bets recorded — too small a sample to mean anything.').replace(/"/g, '&quot;')}">—</span>`
          : `${rtp.toFixed(2)}%`}</dd>
        <dt title="${t('fundedWhy', 'Money you logged as moving in or out, which no bet explains. Only as complete as what you told it about.').replace(/"/g, '&quot;')}">${t('colFunded', 'In / out')}</dt>
        <dd>${bucket.fundedSessions === 0
          ? `<span class="flag" title="${t('fundedNone', 'Nothing logged. Use “Money in / out” in the popup when you deposit or withdraw.').replace(/"/g, '&quot;')}">—</span>`
          : `<span class="good">+${num(bucket.deposited)}</span> / <span class="warn">−${num(bucket.withdrawn)}</span>`}</dd>
        ${bucket.fundedSessions === 0 ? '' : `<dt>${t('colNetFunded', 'Net put in')}</dt>
        <dd class="${signClass(-net)}">${net > 0 ? '+' : ''}${num(net)}</dd>`}
      </dl></div>`;
      },
    )
    .join('');

  renderGames(totals);
  renderCost(totals);

  const mark = currencySymbol(target());
  const head = `<thead><tr><th>${t('colStarted', 'Started')}</th><th>${t('colLength', 'Length')}</th>
    <th>${t('colCoin', 'Coin')}</th><th>${t('colBets', 'Bets')}</th><th>${t('colWl', 'W/L')}</th>
    <th>${t('colBestShort', 'Best')}</th>
    <th>${t('colWagered', 'Wagered')}</th><th>${t('colPl', 'P/L')}</th><th>${t('colPlMoney', `P/L (${mark})`, [mark])}</th>
    <th>${t('colBooks', 'Books')}</th></tr></thead>`;

  const rows = history.length
    ? history
        .map((e) => {
          // Anything recorded before the payout-column fix over-charged every
          // losing bet. It cannot be recomputed, so it is flagged, not hidden.
          const suspect = e.calc !== 2;
          return `<tr class="${suspect ? 'suspect' : ''}">
            <td>${when(e.startedAt)}${
              suspect ? '<span class="flag" title="Recorded before the payout fix — P/L overstates losses">⚠</span>' : ''
            }</td>
            <td>${duration((e.endedAt || e.startedAt) - e.startedAt)}</td>
            <td>${e.currency || '—'}</td>
            <td>${e.bets}</td>
            <td>${e.wins}/${e.losses}</td>
            <td title="${escapeHtml(e.best?.game || '')}">${
              e.best && Number.isFinite(e.best.multiplier) ? formatMultiplier(e.best.multiplier) : '—'
            }</td>
            <td>${num(e.wagered)}</td>
            <td class="${signClass(e.profit)}">${e.profit > 0 ? '+' : ''}${num(e.profit)}</td>
            <td class="${signClass(e.profit)}">${closedAt(e, e.profit)}</td>
            <td class="${e.reconciled === true ? 'up' : e.reconciled === false ? 'down' : ''}"
                title="${e.reconciled === false ? `Wallet and ledger differed by ${num(e.drift)} — bets are missing from this session` : e.reconciled === true ? 'Wallet and ledger agreed' : 'No balance was pinned, so this was never checked'}">${
              e.reconciled === true ? '✓' : e.reconciled === false ? '⚠' : '–'
            }</td>
          </tr>`;
        })
        .join('')
    : `<tr><td class="empty" colspan="10">${t('historyEmpty', 'Nothing recorded yet — play a session and it will appear here.')}</td></tr>`;

  $('historyTable').innerHTML = `${head}<tbody>${rows}</tbody>`;
  renderYears();
  renderChart();
}

/**
 * Sessions totalled by tax year, in the target currency at the rate each one
 * closed with. The year opens in whichever month `fiscalYearStart` says —
 * January by default, which is the calendar year and Israel's tax year.
 *
 * Two kinds of session carry no figure here, and they are different claims. One
 * closed before any rate was ever fetched and has none in any currency. The
 * other has one, but only in the currency it closed in: recorded before the
 * snapshot existed, or against a rate typed by hand. Both are counted out loud
 * rather than folded in at some other session's rate, which would be inventing
 * the number.
 */
function byYear(entries) {
  const years = new Map();
  const code = target();
  const start = state?.settings?.fiscalYearStart ?? 1;

  for (const entry of entries) {
    const { year, label } = fiscalYearOf(entry.startedAt, start);
    const bucket = years.get(year) || {
      year, label, sessions: 0, bets: 0, ms: 0, wagered: 0, profit: 0, unpriced: 0, legacy: 0,
    };

    bucket.sessions += 1;
    bucket.bets += entry.bets || 0;
    bucket.ms += Math.max(0, (entry.endedAt || entry.startedAt) - entry.startedAt);

    const wagered = restate(entry, entry.wagered || 0, code);
    const profit = restate(entry, entry.profit ?? 0, code);

    if (Number.isFinite(wagered.value) && Number.isFinite(profit.value)) {
      bucket.wagered += wagered.value;
      bucket.profit += profit.value;
    } else if (profit.reason === 'no-rate') {
      bucket.unpriced += 1;
    } else {
      // Recorded before the snapshot existed, or with a rate you typed. It has
      // a figure — in another currency — and folding it in at some other
      // session's cross-rate would be inventing this one.
      bucket.legacy += 1;
    }

    years.set(year, bucket);
  }

  return [...years.values()].sort((a, b) => b.year - a.year);
}

function renderYears() {
  const years = byYear(history);
  const mark = currencySymbol(target());
  const head = `<thead><tr><th>${t('colYear', 'Year')}</th><th>${t('colSessions', 'Sessions')}</th>
    <th>${t('colBets', 'Bets')}</th><th>${t('colPlayed', 'Played')}</th>
    <th>${t('colWageredMoney', `Wagered (${mark})`, [mark])}</th>
    <th>${t('colPlMoney', `P/L (${mark})`, [mark])}</th></tr></thead>`;

  const left = (y) => y.unpriced + y.legacy;
  const rows = years.length
    ? years
        .map((y) => `<tr>
          <td>${y.label}</td>
          <td>${y.sessions}${left(y) ? `<span class="flag" title="${left(y)} session${left(y) === 1 ? '' : 's'} cannot be shown in ${target()} — ${y.unpriced} closed with no rate at all, ${y.legacy} can only be read in the currency ${y.legacy === 1 ? 'it' : 'they'} closed in">⚠</span>` : ''}</td>
          <td>${count(y.bets)}</td>
          <td>${duration(y.ms)}</td>
          <td>${fiat(y.wagered)}</td>
          <td class="${signClass(y.profit)}">${y.profit > 0 ? '+' : ''}${fiat(y.profit)}</td>
        </tr>`)
        .join('')
    : `<tr><td class="empty" colspan="6">${t('yearEmpty', 'Nothing recorded yet.')}</td></tr>`;

  $('yearTable').innerHTML = `${head}<tbody>${rows}</tbody>`;
  $('exportYears').disabled = years.length === 0;

  // Two different reasons a session can be missing from these columns, and they
  // are not the same claim: one never had a rate, the other has one in a
  // currency this table is not in. Both are counted out loud rather than folded
  // in at a rate that was never theirs.
  const unpriced = years.reduce((sum, y) => sum + y.unpriced, 0);
  const legacy = years.reduce((sum, y) => sum + y.legacy, 0);
  const notes = [];
  if (unpriced) {
    notes.push(t('yearUnpriced',
      `${unpriced} session${unpriced === 1 ? '' : 's'} closed without a rate and ${unpriced === 1 ? 'is' : 'are'} left out of the converted columns.`,
      [String(unpriced)]));
  }
  if (legacy) {
    notes.push(t('yearLegacy',
      `${legacy} session${legacy === 1 ? '' : 's'} can only be read in the currency ${legacy === 1 ? 'it' : 'they'} closed in, and ${legacy === 1 ? 'is' : 'are'} left out rather than converted at a rate that was never ${legacy === 1 ? 'its' : 'theirs'}.`,
      [String(legacy)]));
  }
  $('yearNote').textContent = notes.length
    ? notes.join(' ')
    : t('yearAllPriced', 'Every recorded session carries the rate it closed with.');
}

function yearsToCsv() {
  // The money columns carry the currency rather than being named after one: a
  // column called profit_ils holding euros is worse than no column at all.
  // `year` is the year the tax year opens in and `year_label` is what it is
  // called, which differ the moment the tax year is not the calendar one.
  const header = ['year', 'year_label', 'sessions', 'bets', 'minutes', 'currency', 'wagered', 'profit',
    'sessions_without_rate', 'sessions_not_restateable'];
  const code = target();
  const lines = byYear(history).map((y) =>
    [y.year, y.label, y.sessions, y.bets, Math.round(y.ms / 60000), code,
      y.wagered.toFixed(2), y.profit.toFixed(2), y.unpriced, y.legacy].join(','));
  return [header.join(','), ...lines].join('\n');
}

// ------------------------------------------------------------------ P/L chart
//
// The session's own opening balance is the baseline, so zero here means "level
// with where you started". The area is closed to that line rather than to the
// floor of the box: above it is profit, below it is loss, and how much area
// there is *is* how much money it was.

/** Everything that can be charted: the live session first, then history. */
function chartable() {
  const options = [];

  const live = state.session;
  if (live?.curve?.length > 1) {
    options.push({ id: 'current', label: t('chartCurrent', 'Current session'), entry: live, live: true });
  }

  for (const [index, entry] of history.entries()) {
    if (!(entry.curve?.length > 1)) continue;
    options.push({
      id: `h${index}`,
      label: when(entry.startedAt),
      entry,
    });
  }

  return options;
}

let chartPick = 'current';

function renderChart() {
  const options = chartable();
  const picker = $('chartPick');

  picker.innerHTML = options.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
  picker.disabled = options.length === 0;

  const chosen = options.find((o) => o.id === chartPick) || options[0] || null;
  if (chosen) {
    chartPick = chosen.id;
    picker.value = chosen.id;
  }

  const svg = $('chart');

  if (!chosen) {
    svg.innerHTML = '';
    $('chartValue').textContent = '—';
    $('chartValue').className = 'chart-value';
    $('chartRange').textContent = '';
    $('chartLow').textContent = $('chartBase').textContent = $('chartHigh').textContent = '';
    $('chartNote').textContent = t('chartEmpty', 'Nothing to draw yet — play a couple of bets and the curve appears here.');
    return;
  }

  const entry = chosen.entry;
  const plot = plotSeries(entry.curve, { width: 600, height: 200 });
  const coin = entry.currency || 'USDT';
  const profit = entry.curve[entry.curve.length - 1];

  // A live session is priced at today's rate; an archived one at the rates it
  // closed with, exactly as its row in the history is — including when the
  // currency being viewed is not the one it closed in, which the snapshot makes
  // answerable and which nothing else in here guesses at.
  const convert = (value) => (chosen.live
    ? { value: Number.isFinite(state.rate?.effective) ? value * state.rate.effective : null }
    : restate(entry, value, target()));

  const money = (value) => {
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    const converted = convert(Math.abs(value)).value;
    return Number.isFinite(converted)
      ? `${sign}${fiat(converted)}`
      : `${sign}${num(Math.abs(value))} ${coin}`;
  };
  const priced = Number.isFinite(convert(1).value);

  // Faded away from the baseline — see renderSpark in popup.js for why a flat
  // fill stops reading as an area once it covers most of the box.
  svg.innerHTML = `
    <defs>
      <clipPath id="above"><rect x="0" y="0" width="600" height="${plot.zeroY}"></rect></clipPath>
      <clipPath id="below"><rect x="0" y="${plot.zeroY}" width="600" height="${200 - plot.zeroY}"></rect></clipPath>
      <linearGradient id="aboveFade" x1="0" y1="${plot.zeroY}" x2="0" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#00e701" stop-opacity=".28"></stop>
        <stop offset="1" stop-color="#00e701" stop-opacity="0"></stop>
      </linearGradient>
      <linearGradient id="belowFade" x1="0" y1="${plot.zeroY}" x2="0" y2="200" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ff5b55" stop-opacity=".28"></stop>
        <stop offset="1" stop-color="#ff5b55" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <path class="fill-up" d="${plot.area}" clip-path="url(#above)" style="fill:url(#aboveFade)"></path>
    <path class="fill-down" d="${plot.area}" clip-path="url(#below)" style="fill:url(#belowFade)"></path>
    <line class="base" x1="0" x2="600" y1="${plot.zeroY}" y2="${plot.zeroY}"></line>
    <path class="line${profit < 0 ? ' down' : ''}" d="${plot.line}"></path>`;

  $('chartValue').textContent = money(profit);
  $('chartValue').className = 'chart-value ' + signClass(profit);
  $('chartRange').textContent = t('chartBets', `${entry.bets} bets`, [String(entry.bets)]);

  // Named rather than left as bare figures: two numbers either side of a
  // baseline are not self-explanatory, and the peak of a session that never
  // went negative is a different claim from its final P/L.
  $('chartHigh').textContent = t('chartPeak', `peak ${money(plot.max)}`, [money(plot.max)]);
  $('chartLow').textContent = t('chartTrough', `trough ${money(plot.min)}`, [money(plot.min)]);
  $('chartBase').textContent = t('chartBaseline', 'session start');

  $('chartNote').textContent = priced
    ? ''
    : t('chartNoRate', 'No rate for this session in this currency, so the figures are in coin units.');
}

$('chartPick').addEventListener('change', (event) => {
  chartPick = event.target.value;
  renderChart();
});

function renderDiagnostics() {
  const errors = state.diagnostics || [];
  $('diagCount').textContent = errors.length
    ? t('diagCount', `${errors.length} issue${errors.length === 1 ? '' : 's'} reported.`, [String(errors.length)])
    : t('diagNone', 'No problems reported.');
  $('clearDiagnostics').disabled = errors.length === 0;

  $('diagnostics').innerHTML = errors.length
    ? errors
        .map(
          (e) => `<div class="entry">
            <div class="where">${e.where}${e.count > 1 ? ` <span style="opacity:.7">×${e.count}</span>` : ''}</div>
            <div class="msg">${String(e.message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</div>
            <div class="meta">${stamp(e.at)}${e.url ? ` · ${new URL(e.url).pathname}` : ''}</div>
          </div>`,
        )
        .join('')
    : `<div class="clean">${t('diagClean', 'Nothing to report — the overlay has not thrown since this was last cleared.')}</div>`;
}

function renderBetLog() {
  const log = state.session?.log || [];
  const wrap = $('currentBets');

  wrap.hidden = !(state.settings.trackSession && log.length);
  if (wrap.hidden) return;

  const head = `<thead><tr><th>${t('colWhen', 'When')}</th><th>${t('colGame', 'Game')}</th>
    <th>${t('colStake', 'Stake')}</th><th>${t('colReturned', 'Returned')}</th>
    <th>${t('colProfit', 'Profit')}</th></tr></thead>`;
  const rows = log
    .map((b) => `<tr>
      <td>${stamp(b.at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
      <td>${b.game || '—'}</td>
      <td>${num(b.amount)}</td>
      <td>${num(b.gross)}</td>
      <td class="${signClass(b.profit)}">${b.profit > 0 ? '+' : ''}${num(b.profit)}</td>
    </tr>`)
    .join('');

  $('betLogTable').innerHTML = `${head}<tbody>${rows}</tbody>`;
}

async function loadHistory() {
  const response = await send({ type: 'getHistory' });
  history = response.history || [];
  rakebackEarned = response.rakebackEarned || {};
  renderHistory(response.totals);
}

function toCsv() {
  // `fiat_currency` names what `profit_fiat` is quoted in, and `closed_in` names
  // what the session was actually recorded in — the two differ exactly when a
  // row has been restated, and `restated` says which happened. A file exported
  // under one target then still reads correctly beside one exported under
  // another, and a blank money column has a reason next to it.
  const header = ['started', 'ended', 'minutes', 'currency', 'bets', 'wins', 'losses',
    'wagered', 'returned', 'profit', 'closed_in', 'rate_at_close', 'fiat_currency',
    'profit_fiat', 'restated', 'biggest_win', 'biggest_loss', 'best_multiplier', 'best_game',
    'peak_profit', 'trough_profit', 'gaps'];

  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const code = target();
  const lines = history.map((e) => {
    const shown = restate(e, e.profit ?? 0, code);
    return [
      new Date(e.startedAt).toISOString(),
      e.endedAt ? new Date(e.endedAt).toISOString() : '',
      Math.round(((e.endedAt || e.startedAt) - e.startedAt) / 60000),
      e.currency || '', e.bets, e.wins, e.losses,
      e.wagered, e.returned, e.profit,
      e.closeTarget || 'ILS',
      e.rateAtClose ?? '',
      code,
      Number.isFinite(shown.value) ? shown.value : '',
      shown.restated ? 'yes' : 'no',
      e.biggestWin, e.biggestLoss,
      // Blank rather than 0 where no multiplier was recorded: a session from
      // before this was tracked did not have a best of nothing.
      Number.isFinite(e.best?.multiplier) ? e.best.multiplier : '',
      e.best?.game ?? '',
      e.peakProfit, e.troughProfit, e.gaps ?? 0,
    ].map(escape).join(',');
  });

  return [header.join(','), ...lines].join('\n');
}

/** Per-bet export for the session running now. Archived sessions do not keep the log. */
function betsToCsv() {
  const log = state.session?.log || [];
  const currency = state.session?.currency || '';
  const rate = state.rate?.effective;

  const header = ['time', 'game', 'currency', 'stake', 'returned', 'profit',
    'fiat_currency', 'profit_fiat', 'bet_id'];
  const code = target();
  const lines = log.map((b) => [
    new Date(b.at).toISOString(),
    b.game || '', currency,
    b.amount, b.gross, b.profit,
    code,
    Number.isFinite(rate) ? b.profit * rate : '',
    b.id,
  ].join(','));

  return [header.join(','), ...lines].join('\n');
}

/** Build and download locally; nothing leaves the machine. */
function download(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderKey() {
  const { key, settings } = state;

  $('keyState').textContent = key.present
    ? t('optKeyInstalled', `Key installed (${key.preview})`, [key.preview])
    : t('optNoKey', 'No key installed');
  $('apiKey').placeholder = key.present ? key.preview : 'CG-…';
  $('clearKey').disabled = !key.present;

  if (!key.present) {
    // Without a key there is no monthly ceiling to report against, so the only
    // useful thing to say is what the interval costs.
    $('keyUsage').textContent = t('keyKeyless', 'Using the keyless public API — no monthly cap.');
    $('keyMsg').textContent = '';
    $('keyMsg').className = 'hint';
    return;
  }

  $('keyUsage').textContent =
    `${count(key.used)} / ${count(key.budget)} keyed calls in ${key.month}` +
    ` (Demo cap ${count(key.limit)})` +
    (key.exhausted ? ' — budget spent, now running keyless' : '');

  const message = $('keyMsg');
  const perMonth = count(key.projected);
  const interval = `A ${settings.refreshMinutes}-minute refresh`;

  if (key.mode === 'off') {
    message.className = 'hint warn';
    message.textContent =
      `Budget spent for ${key.month} — running keyless until it resets. Keyless has no monthly cap, ` +
      `so the rate keeps updating; only the per-minute ceiling is lower.`;
  } else if (key.mode === 'reserve') {
    message.className = 'hint';
    message.textContent =
      `${interval} works out at about ${perMonth} calls/month, far past the ${count(key.limit)} cap, ` +
      `so the key is held in reserve: every call goes keyless, and the key is spent only to recover from a 429. ` +
      `That costs a few dozen calls a month instead of exhausting the allowance in under a week.`;
  } else {
    message.className = 'hint good';
    message.textContent =
      `${interval} projects to about ${perMonth} calls/month — inside the ${count(key.budget)} budget, ` +
      `so the key is used on every call.`;
  }
}

/**
 * Draw the self-exclusion controls for the state they are actually in.
 *
 * Two shapes: not excluded, where the period picker and its button are live;
 * and excluded, where they are not — along with everything else that could be
 * used to get out, which is what `lockedKeys` names.
 *
 * The picker stays visible while excluded rather than being hidden, because
 * extending is still allowed and hiding it would suggest otherwise.
 */
function renderExclusion(settings) {
  const state_ = exclusionState(settings);
  // A session is live when it has actually taken a bet, which is the same test
  // the worker applies before refusing the write.
  const sessionLive = Boolean(settings.trackSession && state.session && state.session.bets > 0);
  const locked = lockedKeys(settings, Date.now(), { sessionLive });

  $('exclusionActiveRow').hidden = !state_.active;

  if (state_.active) {
    const { unit, value } = remainingParts(state_.msRemaining);
    const lang = activeLanguage();
    const left = new Intl.NumberFormat(lang, {
      style: 'unit', unit: unit.replace(/s$/, ''), unitDisplay: 'long',
    }).format(value);
    const until = new Intl.DateTimeFormat(lang, { dateStyle: 'full', timeStyle: 'short' })
      .format(state_.until);

    $('exclusionUntilText').textContent =
      t('optExclusionLeft', '$LEFT$ left — until $DATE$', [left, until]);
    $('exclusionStart').textContent = t('optExclusionExtend', 'Extend');
  } else {
    $('exclusionStart').textContent = t('optExclusionStart', 'Start');
  }

  // Every control the lock names, disabled with the same rule that refuses the
  // write. Reading the list rather than hard-coding it keeps the greying-out
  // and the refusal from drifting apart.
  for (const id of ['lockLimits', 'cooldownScreen', 'cooldownSeconds']) {
    $(id).disabled = locked.has(id === 'cooldownSeconds' ? 'cooldownScreen' : id);
  }
  $('exclusionPeriod').disabled = false;
  $('mirrorAdd')?.toggleAttribute('disabled', locked.has('mirrors'));
}

async function patch(changes) {
  let reply;

  // send() turns an { error } reply into a throw, so a refusal arrives here
  // rather than as a value. It has to put the control back where it was —
  // otherwise the box stays ticked while the setting is not, which reads as a
  // save that worked.
  try {
    reply = await send({ type: 'setSettings', patch: changes });
  } catch (error) {
    const why = String(error?.message || '');
    if (why !== 'locked' && why !== 'limit-locked') throw error;

    render();
    status(why === 'limit-locked'
      ? t('statusLimitLocked', 'Limits are locked while a session is running. Tighten one, or end the session.')
      : t('statusExcluded', 'That is locked until your self-exclusion ends.'), true);
    return;
  }

  state = reply;
  // The bundle can change under us — this is where the language setting takes
  // effect, and applyI18n is idempotent because the keys live in the markup.
  useMessages(state.i18n);
  applyI18n();
  // applyI18n sets <html lang>, and both lists are named in it.
  fillCurrencies();
  fillMonths();
  render();
  status(t('statusSaved', 'Saved.'));
}

for (const id of SELECTS) {
  $(id).addEventListener('change', (event) => patch({ [id]: event.target.value }));
}

for (const id of CHECKBOXES) {
  $(id).addEventListener('change', (event) => patch({ [id]: event.target.checked }));
}

for (const id of NUMBERS) {
  // change, not input: committing on every keystroke would clamp mid-typing.
  $(id).addEventListener('change', (event) => patch({ [id]: event.target.value }));
}

for (const id of COLOURS) {
  // change, not input: a colour picker fires input continuously while the
  // cursor is dragged around the wheel, and each one is a settings write and a
  // state mirror. The value on release is the only one anybody chose.
  $(id).addEventListener('change', (event) => patch({ [id]: event.target.value }));
}

// The period picker is filled from the registry rather than written into the
// markup, so the stored ids and the offered options cannot drift.
$('exclusionPeriod').innerHTML = EXCLUSION_PERIODS
  .map(({ id, hours }) => {
    const days = hours / 24;
    const label = days >= 365
      ? t('optExclYear', 'a year')
      : t('optExclDays', `${days} days`, [String(days)]);
    return `<option value="${id}">${escapeHtml(label)}</option>`;
  })
  .join('');
$('exclusionPeriod').value = '7d';

/**
 * Start or extend an exclusion.
 *
 * The one confirmation dialog in this extension, and it earns its place: this
 * is the only control here whose effect cannot be undone by clicking it again.
 * The wording says the part that matters — no early end — rather than asking
 * "are you sure", which nobody reads.
 */
$('exclusionStart').addEventListener('click', async () => {
  const period = $('exclusionPeriod').value;
  const chosen = $('exclusionPeriod').selectedOptions[0]?.textContent?.trim() || period;
  const extending = exclusionState(state.settings).active;

  const question = extending
    ? t('optExclConfirmExtend', 'Extend your self-exclusion to $PERIOD$ from now? It still cannot be ended early.', [chosen])
    : t('optExclConfirm', 'Block every casino for $PERIOD$? There is no way to end this early — you would have to remove the extension.', [chosen]);

  if (!window.confirm(question)) return;

  try {
    state = await send({ type: 'beginExclusion', period });
  } catch {
    // Refused rather than broken: the only reason is a period that would end
    // sooner than the exclusion already running.
    status(t('statusExclRefused', 'That would end sooner than the exclusion already running.'), true);
    return;
  }

  render();
  status(t('statusExclStarted', 'Self-exclusion started.'));
});

$('openOverlay').addEventListener('click', () => openOverlay());

// Changing either rate redraws the cost report, which patch() does by way of
// render() — the figures behind it have not moved, only what they are read
// against.
for (const id of RATES) {
  $(id).addEventListener('change', (event) => patch({ [id]: event.target.value }));
}

$('manualRate').addEventListener('change', (event) => {
  const raw = event.target.value.trim();
  patch({ manualRate: raw === '' ? null : raw });
});

for (const id of LIMITS) {
  $(id).addEventListener('change', async (event) => {
    const raw = event.target.value.trim();
    state = await send({ type: 'setSettings', patch: { [id]: raw === '' ? null : raw } });
    render();

    // A value that does not survive sanitising is cleared to null, and render()
    // then draws the field blank. Saying "Saved." on top of that is how a
    // rejected limit came to look like one that simply refused to stick.
    const noun = id.startsWith('alert') ? 'a rate alert' : 'a limit';
    status(raw === '' || Number.isFinite(state.settings[id])
      ? t('statusSaved', 'Saved.')
      : `“${raw}” is not ${noun} — needs a number above zero. Left off.`);
  });
}

$('addMirror').addEventListener('click', () => { addMirror().catch((e) => mirrorNote(String(e?.message || e), 'warn')); });

$('clearDiagnostics').addEventListener('click', async () => {
  state = await send({ type: 'clearDiagnostics' });
  render();
  status(t('statusDiagCleared', 'Diagnostics cleared.'));
});

// Clearing a pin is wired up in renderPins, beside the row it belongs to —
// there is one button per casino now, not one button.

// ------------------------------------------------------------------ API key

$('saveKey').addEventListener('click', async () => {
  const field = $('apiKey');
  const value = field.value.trim();
  if (!value) return status(t('statusPasteKey', 'Paste a key first.'));

  state = await send({ type: 'setApiKey', key: value });
  field.value = ''; // never leave the key sitting in a form field
  render();
  status(t('statusKeySaved', 'Key saved.'));
});

$('testKey').addEventListener('click', async () => {
  // Tests the typed key if there is one, otherwise the installed key by
  // triggering a plain keyless ping — either way it never echoes the secret.
  const typed = $('apiKey').value.trim();
  if (!typed && !state.key.present) return status(t('statusPasteKey', 'Paste a key first.'));

  const button = $('testKey');
  button.disabled = true;
  try {
    const { problem } = await send({ type: 'testApiKey', key: typed });
    const message = $('keyMsg');
    message.className = problem ? 'hint warn' : 'hint good';
    message.textContent = problem ? `Test failed: ${problem}` : 'Test passed — CoinGecko accepted the request.';
  } finally {
    button.disabled = false;
  }
});

$('clearKey').addEventListener('click', async () => {
  state = await send({ type: 'setApiKey', key: '' });
  $('apiKey').value = '';
  render();
  status(t('statusKeyRemoved', 'Key removed — back to keyless.'));
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.clear();
  state = await send({ type: 'setSettings', patch: DEFAULTS });
  render();
  status(t('statusReset', 'Reset to defaults.'));
});

const today = () => new Date().toISOString().slice(0, 10);

$('exportHistory').addEventListener('click', () => download(`casino-sessions-${today()}.csv`, toCsv()));

$('exportYears').addEventListener('click', () => download(`casino-years-${today()}.csv`, yearsToCsv()));

$('exportBets').addEventListener('click', () => {
  if (!state.session?.log?.length) return status(t('statusNoBets', 'No bets in the current session yet.'));
  download(`casino-bets-${today()}.csv`, betsToCsv());
});

$('exportBackup').addEventListener('click', async () => {
  const { backup } = await send({ type: 'exportBackup' });
  download(`casino-tracker-backup-${today()}.json`, JSON.stringify(backup, null, 1), 'application/json');
  status(t('statusBackupSaved', 'Backup saved.'));
});

$('importBackup').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = ''; // so picking the same file again still fires change
  if (!file) return;

  let backup = null;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    return status(t('statusBackupUnreadable', 'Not a readable backup file.'));
  }

  const offered = Array.isArray(backup?.sessionHistory) ? backup.sessionHistory.length : 0;
  const ok = confirm(t('backupConfirm',
    `Import ${offered} recorded sessions and the settings from this file? Existing sessions are kept and duplicates are skipped.`,
    [String(offered)]));
  if (!ok) return;

  try {
    const result = await send({ type: 'importBackup', backup });
    state = await send({ type: 'getState' });
    useMessages(state.i18n);
    applyI18n();
    fillCurrencies();
    fillMonths();
    render();
    await loadHistory();
    status(t('statusBackupImported', `Imported ${result.added} new sessions (${result.duplicates} already here).`,
      [String(result.added), String(result.duplicates)]));
  } catch (error) {
    status(String(error?.message || error));
  }
});

$('clearHistory').addEventListener('click', async () => {
  if (!confirm(`Delete all ${history.length} recorded sessions? This cannot be undone.`)) return;
  const response = await send({ type: 'clearHistory' });
  history = response.history || [];
  renderHistory(response.totals);
  status(t('statusHistoryCleared', 'History cleared.'));
});

// The pane comes up before the state does: it depends on nothing but the
// fragment, and a page that shows every section at once for the length of a
// round trip to the service worker is a visible flash of the wrong layout.
showPage(currentPage());

try {
  $('appVersion').textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  // A version nobody can read is not worth failing the page over.
}

state = await send({ type: 'getState' });
useMessages(state.i18n);
applyI18n();
fillCurrencies();
fillMonths();
render();
await loadHistory();
