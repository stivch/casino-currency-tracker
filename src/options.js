import { plotSeries } from './lib/chart.js';
import { applyI18n, t, useMessages } from './lib/i18n.js';
import { currencySymbol, formatMoney } from './lib/format.js';
import { fiscalYearOf, restate } from './lib/session.js';
import { limitSwitchText } from './lib/notices.js';
import { CASINOS, DEFAULTS, OPTIONAL_DOMAINS, TARGET_CURRENCIES, casinoForDomain, mirrorOrigins } from './lib/settings.js';

const $ = (id) => document.getElementById(id);

const CHECKBOXES = ['enabled', 'trackSession', 'showHud', 'hoverTooltip', 'selectionTooltip',
  'assumeUnlabeled', 'inlineAnnotate', 'showBadge', 'notifyLimits', 'stakeRates', 'trackRakeback', 'rakebackPoll'];
const NUMBERS = ['refreshMinutes', 'decimals', 'feePercent', 'sessionIdleMinutes'];
const SELECTS = ['targetCurrency', 'fiscalYearStart'];
// Nullable: blank means "no limit", so these cannot go through the numeric path.
const LIMITS = ['limitWager', 'limitLoss', 'limitWin', 'limitMinutes', 'alertAbove', 'alertBelow'];

let history = [];

let state = null;

/** The fiat this page reports in. */
const target = () => state?.settings?.targetCurrency || 'ILS';

/**
 * The currency picker, filled from the supported list.
 *
 * Names come from Intl rather than a table in this repo, so they arrive
 * already translated into whichever language the page is being read in and
 * cannot drift out of date. A browser that will not name a code shows the code,
 * which is the thing people actually recognise anyway.
 */
function fillCurrencies() {
  let names = null;
  try {
    names = new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'currency' });
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
  const lang = document.documentElement.lang || 'en';
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

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function status(text) {
  $('status').textContent = text;
  if (text) setTimeout(() => { $('status').textContent = ''; }, 1600);
}

function render() {
  const { settings } = state;

  for (const id of CHECKBOXES) $(id).checked = Boolean(settings[id]);
  for (const id of NUMBERS) $(id).value = settings[id];
  for (const id of SELECTS) $(id).value = settings[id];

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

  renderDiagnostics();
  renderMirrors();

  renderKey();
  renderBetLog();
  renderChart();
  // The target currency and the tax-year start both change what this table
  // says without changing a single recorded session, so it is redrawn on any
  // settings write rather than only when history is reloaded.
  renderYears();

  const pinned = Boolean(settings.trackedSelector);
  $('pinnedLabel').textContent = pinned
    ? settings.trackedLabel || t('optPinnedElement', 'pinned element')
    : t('optNothingPinned', 'Nothing pinned');
  $('pinnedSelector').textContent = pinned
    ? settings.trackedSelector
    : t('optPinnedSub', 'Use “Pin an amount on the page” in the overlay on Stake.');
  $('clearPin').disabled = !pinned;
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
      (bucket) => `<div class="card"><h3>${t('cardLifetime', `${bucket.currency} — lifetime`, [bucket.currency])}</h3><dl>
        <dt>${t('colSessions', 'Sessions')}</dt><dd>${bucket.sessions}</dd>
        <dt>${t('colBets', 'Bets')}</dt><dd>${bucket.bets.toLocaleString()}</dd>
        <dt>${t('colWagered', 'Wagered')}</dt><dd>${num(bucket.wagered)}</dd>
        <dt>${t('colPl', 'P/L')}</dt><dd class="${signClass(bucket.profit)}">${bucket.profit > 0 ? '+' : ''}${num(bucket.profit)}</dd>
      </dl></div>`,
    )
    .join('');

  const mark = currencySymbol(target());
  const head = `<thead><tr><th>${t('colStarted', 'Started')}</th><th>${t('colLength', 'Length')}</th>
    <th>${t('colCoin', 'Coin')}</th><th>${t('colBets', 'Bets')}</th><th>${t('colWl', 'W/L')}</th>
    <th>${t('colWagered', 'Wagered')}</th><th>${t('colPl', 'P/L')}</th><th>${t('colPlMoney', `P/L (${mark})`, [mark])}</th>
    <th>${t('colBooks', 'Books')}</th></tr></thead>`;

  const rows = history.length
    ? history
        .map((e) => {
          const started = new Date(e.startedAt);
          // Anything recorded before the payout-column fix over-charged every
          // losing bet. It cannot be recomputed, so it is flagged, not hidden.
          const suspect = e.calc !== 2;
          return `<tr class="${suspect ? 'suspect' : ''}">
            <td>${started.toLocaleDateString()} ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${
              suspect ? '<span class="flag" title="Recorded before the payout fix — P/L overstates losses">⚠</span>' : ''
            }</td>
            <td>${duration((e.endedAt || e.startedAt) - e.startedAt)}</td>
            <td>${e.currency || '—'}</td>
            <td>${e.bets}</td>
            <td>${e.wins}/${e.losses}</td>
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
    : `<tr><td class="empty" colspan="9">${t('historyEmpty', 'Nothing recorded yet — play a session and it will appear here.')}</td></tr>`;

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
          <td>${y.bets.toLocaleString()}</td>
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
    const started = new Date(entry.startedAt);
    options.push({
      id: `h${index}`,
      label: `${started.toLocaleDateString()} ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
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
            <div class="meta">${new Date(e.at).toLocaleString()}${e.url ? ` · ${new URL(e.url).pathname}` : ''}</div>
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
      <td>${new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
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
    'profit_fiat', 'restated', 'biggest_win', 'biggest_loss', 'peak_profit', 'trough_profit', 'gaps'];

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
      e.biggestWin, e.biggestLoss, e.peakProfit, e.troughProfit, e.gaps ?? 0,
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
    `${key.used.toLocaleString()} / ${key.budget.toLocaleString()} keyed calls in ${key.month}` +
    ` (Demo cap ${key.limit.toLocaleString()})` +
    (key.exhausted ? ' — budget spent, now running keyless' : '');

  const message = $('keyMsg');
  const perMonth = key.projected.toLocaleString();
  const interval = `A ${settings.refreshMinutes}-minute refresh`;

  if (key.mode === 'off') {
    message.className = 'hint warn';
    message.textContent =
      `Budget spent for ${key.month} — running keyless until it resets. Keyless has no monthly cap, ` +
      `so the rate keeps updating; only the per-minute ceiling is lower.`;
  } else if (key.mode === 'reserve') {
    message.className = 'hint';
    message.textContent =
      `${interval} works out at about ${perMonth} calls/month, far past the ${key.limit.toLocaleString()} cap, ` +
      `so the key is held in reserve: every call goes keyless, and the key is spent only to recover from a 429. ` +
      `That costs a few dozen calls a month instead of exhausting the allowance in under a week.`;
  } else {
    message.className = 'hint good';
    message.textContent =
      `${interval} projects to about ${perMonth} calls/month — inside the ${key.budget.toLocaleString()} budget, ` +
      `so the key is used on every call.`;
  }
}

async function patch(changes) {
  state = await send({ type: 'setSettings', patch: changes });
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

$('clearPin').addEventListener('click', () => patch({ trackedSelector: '', trackedLabel: '' }));

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

state = await send({ type: 'getState' });
useMessages(state.i18n);
applyI18n();
fillCurrencies();
fillMonths();
render();
await loadHistory();
