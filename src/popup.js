import { coinRate, currencySymbol, displayDecimals, formatMoney, formatNumber, parseAmount } from './lib/format.js';
import { applyI18n, t, useMessages } from './lib/i18n.js';
import { plotSeries } from './lib/chart.js';
import { limitStatus } from './lib/session.js';
import { limitSwitchText } from './lib/notices.js';

const $ = (id) => document.getElementById(id);

const TOGGLES = ['showHud', 'hoverTooltip', 'inlineAnnotate'];
// Nullable: blank means "no limit", so these do not go through a numeric path.
const MONEY_LIMITS = ['limitWager', 'limitLoss', 'limitWin'];
const LIMITS = [...MONEY_LIMITS, 'limitMinutes'];

/**
 * Age in words. Not lib/format.js's formatAge: that one is a pure function with
 * its own tests and no business reaching for a message bundle.
 */
function ageText(timestamp) {
  if (!timestamp) return t('ageNever', 'never');

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return t('ageJustNow', 'just now');
  if (seconds < 60) return t('ageSeconds', `${seconds}s ago`, [String(seconds)]);

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('ageMinutes', `${minutes}m ago`, [String(minutes)]);

  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('ageHours', `${hours}h ago`, [String(hours)]);

  const days = Math.round(hours / 24);
  return t('ageDays', `${days}d ago`, [String(days)]);
}

const LIMIT_LABEL = () => ({
  wager: t('popWagered', 'Wagered'),
  win: t('labelUp', 'Up'),
  loss: t('labelDown', 'Down'),
  time: t('labelTime', 'Time'),
});

let state = null;

/** The fiat everything on this page is denominated in. */
const target = () => state?.settings?.targetCurrency || 'ILS';

/** One amount in that currency, at the display precision the settings ask for. */
const fiat = (value) => formatMoney(value, target(), state?.settings?.decimals);


async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function flashSaved() {
  $('saved').classList.add('show');
  setTimeout(() => $('saved').classList.remove('show'), 900);
}

// --------------------------------------------------------------- rendering

function render() {
  const { settings, rate } = state;

  for (const id of TOGGLES) $(id).checked = Boolean(settings[id]);

  const dot = $('dot');
  const value = $('rateValue');
  const meta = $('rateMeta');

  if (!Number.isFinite(rate.effective)) {
    dot.className = 'dot dead';
    value.textContent = '—';
    meta.textContent = rate.error || t('popFetching', 'fetching…');
    meta.className = 'rate-meta bad';
  } else {
    dot.className = 'dot' + (rate.stale ? ' stale' : '');
    value.textContent = formatNumber(rate.effective, Math.max(2, settings.decimals));

    const bits = [rate.providerLabel || t('rateSourceUnknown', 'unknown source')];
    if (rate.keyed) bits.push(t('rateKeyed', 'demo key'));
    if (rate.providerDetail) bits.push(rate.providerDetail);
    if (!rate.manual) bits.push(t('rateUpdated', `updated ${ageText(rate.fetchedAt)}`, [ageText(rate.fetchedAt)]));
    if (rate.error) bits.push(t('rateFailed', 'last fetch failed'));
    meta.textContent = bits.join(' · ');
    meta.className = 'rate-meta' + (rate.stale || rate.error ? ' warn' : '');
  }

  renderStake();
  renderSession();
  renderLimitEditor();

  // Only mention the spread when there is one; the mid-price case needs no note.
  $('feeNote').textContent = settings.feePercent
    ? t('feeNote',
        `Includes your ${settings.feePercent}% off-ramp spread (mid-price ${formatNumber(rate.quoted ?? NaN, 3)}).`,
        [String(settings.feePercent), formatNumber(rate.quoted ?? NaN, 3)])
    : '';

  // The calculator's second field is whatever you are converting into, so it is
  // labelled with the code rather than with a word.
  $('rateUnit').textContent = t('popRateUnit', `${target()} per USDT`, [target()]);
  $('fiatLabel').textContent = target();

  const usable = Number.isFinite(rate.effective);
  $('usdt').disabled = !usable;
  $('fiat').disabled = !usable;
}

/**
 * Rakeback and VIP progress, as read out of Stake's own traffic. Rakeback is a
 * balance, so it converts like any other; VIP progress is a fraction of the way
 * to the next tier and converts to nothing.
 */
function renderStake() {
  const meta = state.stake;
  const section = $('stakeSection');

  // Shown whenever reading is switched on, not only once something has been
  // read. With nothing captured yet the refresh button in this header is the
  // one thing worth having, and hiding the block hid that too.
  section.hidden = !state.settings.trackRakeback;
  if (section.hidden) return;

  const balances = meta?.rakeback || [];
  const wallet = state.session?.currency || 'USDT';
  const pick = balances.find((row) => row.currency === wallet)
    || [...balances].sort((a, b) => b.amount - a.amount)[0]
    || null;

  if (!pick) {
    $('rakeVal').textContent = '—';
  } else {
    const rate = coinRate(state.rate, pick.currency);
    const coin = `${formatNumber(pick.amount, 6)} ${pick.currency}`;
    $('rakeVal').innerHTML = Number.isFinite(rate)
      ? `${fiat(pick.amount * rate)}<small>${coin}</small>`
      : coin;
  }

  const progress = meta?.vip?.progress;
  const bar = $('vipBar');

  if (!Number.isFinite(progress)) {
    $('vipVal').textContent = '—';
    bar.hidden = true;
  } else {
    const percent = Math.max(0, Math.min(100, progress * 100));
    $('vipVal').innerHTML = `${percent.toFixed(1)}%<small>${meta.vip.flag || ''}</small>`;
    bar.hidden = false;
    bar.querySelector('i').style.width = `${percent}%`;
  }

  // Passive reading only updates when Stake itself asks, which can be a while.
  // The age is the difference between a live figure and a remembered one.
  $('stakeAge').textContent = meta?.at ? ageText(meta.at) : t('popStakeUnread', 'not read yet');
}

// ----------------------------------------------------------------- session

function renderSession() {
  const s = state.session;
  const section = $('sessionSection');

  section.hidden = !(state.settings.trackSession && s && s.bets > 0);
  if (section.hidden) return;

  const minutes = Math.floor((Date.now() - s.startedAt) / 60000);
  $('sessDur').textContent = minutes < 1
    ? t('popJustStarted', 'just started')
    : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

  // The session's own coin, not always USDT. A coin the providers did not price
  // shows coin units only, rather than a converted figure that is not its own.
  const rate = coinRate(state.rate, s.currency);
  const money = (value) => {
    const coin = `${formatNumber(Math.abs(value), 4)} ${s.currency || 'USDT'}`;
    if (!Number.isFinite(rate)) return coin;
    return `${fiat(Math.abs(value) * rate)}<small>${coin}</small>`;
  };

  const profit = s.profit ?? 0;
  const pl = $('sessPl');
  pl.className = profit > 0 ? 'up' : profit < 0 ? 'down' : '';
  pl.innerHTML = (profit > 0 ? '+' : profit < 0 ? '−' : '') + money(profit);

  $('sessWag').innerHTML = money(s.wagered);
  $('sessBets').innerHTML =
    `${s.bets}<small>${t('winLoss', `${s.wins}W / ${s.losses}L`, [String(s.wins), String(s.losses)])}</small>`;

  renderSpark(s.curve, profit);
  renderCheck(s);
  renderFunds(s);
  renderLimits(s, rate);

  const warn = $('sessWarn');
  const notes = [];
  if (s.stale) notes.push(t('sessIdle', 'Idle — this session is finished and will be filed to history when you next bet.'));
  if (s.gaps) {
    notes.push(t('sessGaps',
      `${s.gaps} gaps — bets scrolled past unseen, so these totals are a floor`, [String(s.gaps)]));
  }
  warn.hidden = notes.length === 0;
  warn.textContent = notes.join(' ');
}

/**
 * The same chart as the options page, at postage-stamp size: baseline where the
 * session opened, green filled above it, red below.
 */
function renderSpark(curve, profit) {
  const svg = $('spark');
  const plot = plotSeries(curve, { width: 280, height: 46, pad: 3 });

  // One bet is a dot, not a shape. toggleAttribute rather than `.hidden`: that
  // property lives on HTMLElement and an <svg> is not one, so assigning to it
  // sets an expando and leaves the attribute alone — which here meant an empty
  // 52px box sat in the panel whenever there was nothing to draw.
  svg.toggleAttribute('hidden', !plot);
  if (!plot) return;

  // The fill fades away from the baseline rather than sitting as a flat slab.
  // A session that spent the whole evening down puts zero at the top of the box
  // and fills almost all of it, and a solid block that size stops reading as an
  // area and starts reading as a background.
  svg.innerHTML = `
    <defs>
      <clipPath id="sparkUp"><rect x="0" y="0" width="280" height="${plot.zeroY}"></rect></clipPath>
      <clipPath id="sparkDown"><rect x="0" y="${plot.zeroY}" width="280" height="${46 - plot.zeroY}"></rect></clipPath>
      <linearGradient id="sparkUpFade" x1="0" y1="${plot.zeroY}" x2="0" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#00e701" stop-opacity=".30"></stop>
        <stop offset="1" stop-color="#00e701" stop-opacity="0"></stop>
      </linearGradient>
      <linearGradient id="sparkDownFade" x1="0" y1="${plot.zeroY}" x2="0" y2="46" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ff5b55" stop-opacity=".30"></stop>
        <stop offset="1" stop-color="#ff5b55" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <path class="spark-fill up" d="${plot.area}" clip-path="url(#sparkUp)" style="fill:url(#sparkUpFade)"></path>
    <path class="spark-fill down" d="${plot.area}" clip-path="url(#sparkDown)" style="fill:url(#sparkDownFade)"></path>
    <line class="spark-zero" x1="0" x2="280" y1="${plot.zeroY}" y2="${plot.zeroY}"></line>
    <path class="spark-line${profit < 0 ? ' down' : ''}" d="${plot.line}"></path>`;
}

/** Editable whether or not a session is running — you set a limit before you play. */
function renderLimitEditor() {
  const section = $('limitsSection');
  section.hidden = !state.settings.trackSession;
  if (section.hidden) return;

  // The three money fields say which currency they are in, on the label, where
  // it is next to the box you type into. It is the only thing on this row that
  // has to change when the target does.
  const mark = currencySymbol(target());
  $('limWagerLabel').textContent = `${t('popLimWager', 'Wager')} ${mark}`;
  $('limLossLabel').textContent = `${t('popLimLoss', 'Loss')} ${mark}`;
  $('limWinLabel').textContent = `${t('popLimWin', 'Win')} ${mark}`;

  for (const id of LIMITS) {
    const field = $(id);
    const value = state.settings[id];
    // Do not fight the user mid-keystroke.
    if (document.activeElement !== field) field.value = Number.isFinite(value) ? value : '';
    field.classList.toggle('on', Number.isFinite(value));
  }

  const rate = state.rate?.effective;
  const none = LIMITS.every((id) => !Number.isFinite(state.settings[id]));
  const money = MONEY_LIMITS.filter((id) => Number.isFinite(state.settings[id]));
  const hint = $('limitsHint');

  hint.className = 'hint'; // drops a rejection notice from a previous edit

  // A change of target moves these three figures, and that is worth saying
  // where they are rather than only in Options. It stops being said the moment
  // one of them is edited, which is the acknowledgement it was asking for.
  const switched = limitSwitchText(state.limitSwitch);
  if (switched) {
    hint.className = 'hint warn';
    hint.textContent = switched;
    return;
  }

  if (none) {
    hint.textContent = t('limitsOffHint', 'Blank means off. Flags in the overlay when a session passes one — nothing is blocked.');
    return;
  }

  const parts = [];
  if (money.length && Number.isFinite(rate)) {
    // The limits are set in the target currency; this says what each one is in
    // the coin, so a figure typed in one unit can be sanity-checked in the other.
    const word = {
      limitWager: t('limitWordWager', 'wager'),
      limitLoss: t('limitWordLoss', 'loss'),
      limitWin: t('limitWordWin', 'win'),
    };
    const quoted = formatNumber(rate, 3);
    const back = money
      .map((id) => `${word[id]} ${formatNumber(state.settings[id] / rate, 2)} USDT`)
      .join(', ');
    parts.push(t('limitsRateHint',
      `At ${quoted} ${target()}/USDT that is about ${back}.`, [quoted, target(), back]));
  } else if (money.length) {
    parts.push(t('limitsNoRate', 'No rate yet, so the money limits cannot be compared until one arrives.'));
  }
  if (Number.isFinite(state.settings.limitMinutes)) {
    parts.push(t('limitsTimeHint', 'Time runs from the first bet of the session, not from opening the tab.'));
  }

  hint.textContent = parts.join(' ');
}

/**
 * Deposits, withdrawals, tips and rakeback are wallet movement no bet explains,
 * and the cross-check has no way to know about them. One field to say so beats
 * a warning that stays red for the rest of the night.
 */
function renderFunds(s) {
  const row = $('fundsRow');
  row.hidden = false;
  $('fundsLabel').textContent = t('popFundsLabel', `Money in / out (${s.currency || 'USDT'})`, [s.currency || 'USDT']);

  const moved = s.check?.funded || 0;
  const amount = `${moved > 0 ? '+' : ''}${formatNumber(moved, 4)}`;
  $('fundsDelta').placeholder = moved ? t('fundsLogged', `${amount} logged`, [amount]) : '+0.00';
}

/**
 * The bet ledger against the wallet — two independent accounts of the same
 * session. Shown always rather than only on mismatch, because "checked and
 * agreed" is the useful half of the statement.
 */
function renderCheck(s) {
  const box = $('sessCheck');
  const check = s.check;
  const coin = s.currency || 'USDT';

  if (!check?.known) {
    box.hidden = false;
    box.className = 'sess-check';
    box.textContent = state.settings.trackedSelector
      ? t('checkWaiting', 'Balance cross-check waiting for a wallet reading.')
      : t('checkPin', 'Pin your balance on Stake to cross-check these figures against the wallet.');
    return;
  }

  box.hidden = false;

  // Money logged as moved in or out is netted off the wallet side, so say so —
  // an agreement that quietly depends on a figure you typed should show it.
  const signed = `${check.funded > 0 ? '+' : '−'}${formatNumber(Math.abs(check.funded), 8)}`;
  const moved = check.funded ? ' ' + t('checkMoved', `after ${signed} logged in/out`, [signed]) : '';

  if (check.ok) {
    box.className = 'sess-check ok';
    box.textContent = `✓ ${t('checkAgree', 'Ledger and wallet agree')} (${formatNumber(check.balance, 8)} ${coin}${moved}).`;
    return;
  }

  if (check.settling) {
    box.className = 'sess-check';
    box.textContent = t('checkSettling', 'Cross-check settling — a bet is still landing on one side.');
    return;
  }

  // With no deposits, tips or rakeback taken mid-session, there is no innocent
  // explanation left: the ledger is missing something real.
  const missing = -check.drift;
  const wallet = formatNumber(check.balance, 8);
  const ledger = formatNumber(check.ledger, 8);
  const gap = formatNumber(Math.abs(missing), 8);
  const direction = missing > 0
    ? t('checkMissingLosses', 'of losses are missing from the ledger')
    : t('checkMissingWins', 'of winnings are unrecorded in the ledger');

  box.className = 'sess-check off';
  box.textContent = '⚠ ' + t('checkIncomplete',
    `These figures are incomplete. The wallet moved ${wallet} ${coin} but the bets only account for ` +
    `${ledger} — ${gap} ${coin} ${direction}. Bets were placed that this did not see.`,
    [wallet, coin, ledger, gap, direction]);
}

function renderLimits(s, rate) {
  const box = $('sessLimit');
  const parts = [];
  const label = LIMIT_LABEL();
  let worst = 0;
  let onlyWin = true;

  // Quiet until it is nearly relevant; a bar at 4% is noise.
  const measure = ({ kind, value, limit, pct }) => {
    if (pct < 80) return;
    worst = Math.max(worst, pct);
    if (kind !== 'win') onlyWin = false;

    const shown = kind === 'time'
      ? `${label.time} ${Math.round(value)} / ${limit} ${t('unitMin', 'min')}`
      : `${label[kind]} ${fiat(value)} ${t('limitOf', 'of')} ${fiat(limit)}`;
    parts.push(`${shown} (${Math.round(pct)}%)`);
  };

  for (const limit of limitStatus(s, { settings: state.settings, rate })) measure(limit);

  box.hidden = parts.length === 0;
  if (box.hidden) return;

  const reached = worst >= 100;
  const prefix = reached
    ? (onlyWin ? t('limitWinReached', 'Win target reached — ') : t('limitReached', 'Limit reached — '))
    : t('limitApproaching', 'Approaching — ');

  box.className = 'sess-limit' + (onlyWin ? ' win' : reached ? '' : ' near');
  box.textContent = prefix + parts.join(' · ');
}

for (const id of LIMITS) {
  // change, not input: committing per keystroke would clamp "1" out of "10".
  $(id).addEventListener('change', async (event) => {
    const raw = event.target.value.trim();
    state = await send({ type: 'setSettings', patch: { [id]: raw === '' ? null : raw } });
    render();

    // Anything that fails sanitising comes back as null and render() blanks the
    // field. Flashing "saved" over that is what made a rejected limit look like
    // one that saved and then turned itself off.
    if (raw !== '' && !Number.isFinite(state.settings[id])) {
      const hint = $('limitsHint');
      hint.className = 'hint warn';
      hint.textContent = t('limitsRejected', `“${raw}” is not a limit — needs a number above zero. Left off.`, [raw]);
      return;
    }

    const saved = $('limitsSaved');
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 900);
  });

  // Enter commits without waiting for focus to leave the field.
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });
}

/**
 * Ask whichever Stake tab is open to re-read rakeback and VIP progress now.
 *
 * The figures are read out of Stake's own traffic as it goes past, so between
 * requests they are simply as old as the last one — and the popup is exactly
 * where you look at them without a Stake tab in front of you.
 *
 * It can legitimately go unanswered: nothing here can force a page that is not
 * open to make a request. So it waits a beat for a reading to land and says so
 * plainly when none does, rather than spinning or quietly doing nothing.
 */
async function refreshStake() {
  const button = $('refreshStake');
  const hint = $('stakeHint');
  const before = state.stake?.at ?? null;

  button.disabled = true;
  button.textContent = t('popRefreshing', 'Refreshing…');
  hint.hidden = true;

  try {
    await send({ type: 'refreshRakeback' });
    const answered = await waitForReading(before, 8000);

    state = await send({ type: 'getState' });
    render();

    // A refusal from Stake is filed as a diagnostic by whichever tab tried, so
    // when nothing came back the reason is usually already here. Reporting the
    // generic "no tab answered" over the top of an actual HTTP 401 would be
    // wrong twice over.
    const reason = recentStakeFault(before);
    hint.hidden = answered;
    hint.textContent = answered
      ? ''
      : reason || t('popStakeNoAnswer', 'No answer — open the Stake tab you play in, and it will refresh there.');
  } finally {
    button.disabled = false;
    button.textContent = t('popRefreshAccount', 'Refresh');
  }
}

/** A stake-api fault logged since the refresh was asked for, if there is one. */
function recentStakeFault(since) {
  const cutoff = Math.max(Number(since) || 0, Date.now() - 20_000);
  const fault = (state.diagnostics || []).find((entry) => entry.where === 'stake api' && entry.at >= cutoff);
  return fault ? fault.message : null;
}

/** Resolves true on a reading newer than the one we started with, false on timeout. */
function waitForReading(previousAt, ms) {
  return new Promise((resolve) => {
    const finish = (answered) => {
      chrome.storage.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(answered);
    };

    const listener = (changes, area) => {
      if (area !== 'local') return;
      if (changes.stakeMeta && (changes.stakeMeta.newValue?.at ?? null) !== previousAt) return finish(true);

      // A refusal is an answer too — no reason to sit out the rest of the clock
      // when the tab has already said why it could not.
      const newest = changes.diagnostics?.newValue?.[0];
      if (newest?.where === 'stake api' && Date.now() - newest.at < 5_000) finish(false);
    };

    const timer = setTimeout(() => finish(false), ms);
    chrome.storage.onChanged.addListener(listener);
  });
}

$('refreshStake').addEventListener('click', refreshStake);

$('resetSession').addEventListener('click', async () => {
  state = await send({ type: 'endSession' });
  render();
  flashSaved();
});

/**
 * "+12.5" or "-3". The sign is the whole point of this field — a withdrawal is
 * the same gesture as a deposit with the other sign — so parseAmount, which
 * refuses negatives, is not enough on its own.
 */
function parseSigned(raw) {
  const trimmed = String(raw).trim();
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const value = parseAmount(trimmed.replace(/^[+-]/, ''));
  return value === null || value === 0 ? null : sign * value;
}

async function logFunds() {
  const field = $('fundsDelta');
  const delta = parseSigned(field.value);

  if (delta === null) {
    field.classList.add('bad');
    return;
  }

  field.classList.remove('bad');
  state = await send({ type: 'fundsMove', delta });
  field.value = '';
  render();
  flashSaved();
}

$('fundsLog').addEventListener('click', logFunds);
$('fundsDelta').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') logFunds();
});
$('fundsDelta').addEventListener('input', () => $('fundsDelta').classList.remove('bad'));

// -------------------------------------------------------------- conversion

function convertFrom(source) {
  const rate = state?.rate?.effective;
  if (!Number.isFinite(rate)) return;

  const usdtField = $('usdt');
  const fiatField = $('fiat');
  const [from, to] = source === 'usdt' ? [usdtField, fiatField] : [fiatField, usdtField];

  if (!from.value.trim()) {
    to.value = '';
    return;
  }

  const amount = parseAmount(from.value);
  if (amount === null) {
    to.value = '';
    return;
  }

  // Converting *into* the target rounds the way that currency rounds — a yen
  // field showing 1234.50 is a quantity that does not exist. Going the other
  // way lands in coin units, where two decimals is a floor, not a preference.
  const decimals = state.settings.decimals;
  const result = source === 'usdt' ? amount * rate : amount / rate;
  to.value = source === 'usdt'
    ? formatNumber(result, displayDecimals(target(), decimals))
    : formatNumber(result, Math.max(2, decimals));
}

// ------------------------------------------------------------------ wiring

$('usdt').addEventListener('input', () => convertFrom('usdt'));
$('fiat').addEventListener('input', () => convertFrom('fiat'));

for (const id of TOGGLES) {
  $(id).addEventListener('change', async (event) => {
    state = await send({ type: 'setSettings', patch: { [id]: event.target.checked } });
    render();
    flashSaved();
  });
}

$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = t('popRefreshing', 'Refreshing…');
  try {
    state = await send({ type: 'refresh' });
    render();
    convertFrom($('fiat').matches(':focus') ? 'fiat' : 'usdt');
  } finally {
    button.disabled = false;
    button.textContent = t('popRefresh', 'Refresh rate now');
  }
});

$('openOptions').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

state = await send({ type: 'getState' });
useMessages(state.i18n);
applyI18n();
render();
$('usdt').focus();
