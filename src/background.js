// Service worker: the only place that touches the network.
//
// Content scripts do not fetch the rate themselves for two reasons. Stake ships
// a strict connect-src CSP, and a content script's fetch is attributable to the
// page it runs in; and doing it once here means one request every few minutes
// no matter how many Stake tabs are open.
//
// It also does not push state to tabs. Everything the content script needs is
// mirrored into chrome.storage.local, which content scripts can read and watch
// without the "tabs" permission that a targeted broadcast would cost.

import { DEFAULTS, TARGET_CURRENCIES, loadSettings, sanitize } from './lib/settings.js';
import { fetchFiatTable, fetchRate, pingKey, ratesFromDuel, ratesFromStake } from './lib/rates.js';
import { coinRate, coinUsd, compactMoney, displayDecimals, effectiveRate, formatMoney } from './lib/format.js';
import { RTL_LANGUAGES, t, useMessages } from './lib/i18n.js';
import {
  CALC_VERSION, applyBalance, applyFunds, archiveEntry, emptySession, ingest, isStale,
  limitStatus, reconcile, rollSession, sessionProfit, summarise,
} from './lib/session.js';

// Enough history to look back over months of play without letting one key in
// storage.local grow without bound.
const HISTORY_LIMIT = 300;

const ALARM_NAME = 'refresh-rate';

// CoinGecko's Demo plan allows 10,000 calls a month. We stop spending the key
// at 9,500 and fall back to keyless, which has no monthly cap at all — so the
// last days of a heavy month degrade to a slightly lower per-minute ceiling
// instead of to no rate whatsoever.
const DEMO_MONTHLY_LIMIT = 10_000;
const DEMO_BUDGET = 9_500;

// ------------------------------------------------------------------ API key
//
// The key lives in storage.local, never storage.sync: it is a credential, and
// sync would push it to every machine on the Chrome profile. It is also kept
// out of the `mirror` object, so the content script running inside stake.com
// never has it in reach.

async function readKey() {
  const { coingeckoKey } = await chrome.storage.local.get('coingeckoKey');
  return typeof coingeckoKey === 'string' && coingeckoKey.trim() ? coingeckoKey.trim() : null;
}

/** Enough to recognise which key is installed, not enough to use it. */
function maskKey(key) {
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// CoinGecko does not publish when a Demo month rolls over, so this counts by
// UTC calendar month. If their cycle is anchored to signup instead, this errs
// toward resetting late rather than early, which is the safe direction.
function currentMonth(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function readUsage() {
  const { keyUsage } = await chrome.storage.local.get('keyUsage');
  const month = currentMonth();
  return keyUsage && keyUsage.month === month ? keyUsage : { month, count: 0 };
}

async function bumpUsage() {
  const usage = await readUsage();
  const next = { month: usage.month, count: usage.count + 1 };
  await chrome.storage.local.set({ keyUsage: next });
  return next;
}

/** Calls a month at this interval, using a 31-day month so the estimate is not optimistic. */
function projectedMonthlyCalls(refreshMinutes) {
  return Math.round((60 / Math.max(1, refreshMinutes)) * 24 * 31);
}

/**
 * How to spend the key at the current refresh interval.
 *
 * Fast polling and the Demo allowance are simply incompatible — a 1-minute
 * interval is 44,640 calls a month against a 10,000 cap, so using the key as
 * primary would exhaust it in under a week and then behave exactly like keyless
 * for the remaining three. Reserving it for 429 recovery instead keeps the same
 * ceiling available all month, for a handful of calls.
 */
function chooseKeyMode(settings, usage, hasKey) {
  if (!hasKey) return 'off';
  if (usage.count >= DEMO_BUDGET) return 'off';
  return projectedMonthlyCalls(settings.refreshMinutes) > DEMO_BUDGET ? 'reserve' : 'primary';
}

// ------------------------------------------------------------------- locale
//
// chrome.i18n answers with Chrome's display language and nothing else, so a
// language *setting* has to resolve the bundle itself. The service worker does
// it once and publishes the result: pages read it from getState, the content
// script from its own storage key. One resolution, one answer everywhere.

function resolveLanguage(settings) {
  if (settings.language && settings.language !== 'auto') return settings.language;
  const ui = chrome.i18n?.getUILanguage?.() || 'en';
  return ui.toLowerCase().startsWith('he') ? 'he' : 'en';
}

let bundleCache = { lang: null, messages: null };

async function loadBundle(lang) {
  if (bundleCache.lang === lang) return bundleCache;

  try {
    const response = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    bundleCache = { lang, rtl: RTL_LANGUAGES.has(lang), messages: await response.json() };
  } catch {
    // A bundle that will not load is not worth failing over: chrome.i18n is
    // still there underneath, and English is still written at every call site.
    bundleCache = { lang, rtl: RTL_LANGUAGES.has(lang), messages: {} };
  }

  useMessages(bundleCache); // the worker's own strings, for notifications
  return bundleCache;
}

/** Publish the bundle for the content script, which cannot call getState cheaply. */
async function syncBundle(settings) {
  const bundle = await loadBundle(resolveLanguage(settings));
  const { i18n } = await chrome.storage.local.get('i18n');
  if (i18n?.lang !== bundle.lang) await chrome.storage.local.set({ i18n: bundle });
  return bundle;
}

// ---------------------------------------------------------------- rate cache
//
// A cached rate belongs to the currency it was fetched for. Reading it under a
// different target would show a shekel figure with a euro sign on it, which is
// the one failure this whole refactor exists to make impossible — so the entry
// carries its target and a mismatch reads as no cache at all.

async function readCache(target = null) {
  const { rateCache } = await chrome.storage.local.get('rateCache');
  if (!rateCache) return null;
  // An entry with no target predates multi-currency, so it is an ILS one.
  const cached = rateCache.target || 'ILS';
  if (target && cached !== target) return null;
  return rateCache;
}

/** Fetch, cache, mirror. Never throws: a failure is recorded on the cache entry. */
async function refreshRate({ force = false } = {}) {
  const settings = await loadSettings();
  const target = settings.targetCurrency;
  const cache = await readCache(target);

  if (!force && cache?.fetchedAt) {
    const ageMs = Date.now() - cache.fetchedAt;
    if (ageMs < settings.refreshMinutes * 60_000 * 0.9) {
      return cache; // still fresh enough; do not spend a request on it
    }
  }

  try {
    const key = await readKey();
    const usage = await readUsage();
    const keyMode = chooseKeyMode(settings, usage, Boolean(key));

    const result = await fetchRate({ apiKey: keyMode === 'off' ? null : key, keyMode, target });
    if (result.usedKey) await bumpUsage();

    // exchangerate-api answers with the whole fiat table whether or not it was
    // the provider we wanted, so when it is the one that answered, the table a
    // session close needs has already arrived and costs nothing to keep.
    if (result.fiat) {
      await storeFiatTable(result.fiat, { quotedAt: result.quotedAt, nextUpdate: result.fiatNextUpdate });
    }

    const { fiat, fiatNextUpdate, ...rest } = result;
    const entry = { ...rest, error: null };
    await chrome.storage.local.set({ rateCache: entry });
    await mirrorState();
    return entry;
  } catch (error) {
    // Keep the last good rate and hang the error off it. A stale-but-labelled
    // number beats a blank readout, as long as the age is visible. Only a rate
    // for *this* target is worth keeping: one fetched for another currency is
    // not a stale answer to this question, it is an answer to a different one.
    const entry = { ...(cache || { target }), error: String(error?.message || error), erroredAt: Date.now() };
    await chrome.storage.local.set({ rateCache: entry });
    await mirrorState();
    return entry;
  }
}

// ---------------------------------------------------------------- fiat table
//
// USD against every fiat, kept so a session can be frozen with the cross-rates
// that actually applied when it closed. That is what lets history be read in a
// currency the player had not chosen yet without ever restating an old evening
// at today's rates.
//
// Refreshed at most once a day and only when a session is being filed, which is
// a handful of requests a month. exchangerate-api publishes daily and says when
// its next update is due, so anything more often would fetch the same numbers.

const FIAT_TABLE_MAX_AGE_MS = 24 * 60 * 60_000;

// Past this, the table is no longer "the rates that applied" by any reasonable
// reading, so a session is filed without one rather than with a stale one
// dressed up as the real thing. It can then only be read in the currency it
// closed in — which it says, rather than guessing.
const FIAT_TABLE_USABLE_MS = 7 * 24 * 60 * 60_000;

async function readFiatTable() {
  const { fiatTable } = await chrome.storage.local.get('fiatTable');
  return fiatTable || null;
}

/**
 * Keep only the currencies that can actually be selected.
 *
 * The response carries about 160 of them; the picker offers 45. Storing the
 * whole thing on each of 300 history entries would be most of a megabyte of
 * currencies nobody in this extension can ask for.
 */
function trimFiat(rates) {
  const out = {};
  for (const code of TARGET_CURRENCIES) {
    const value = Number(rates?.[code]);
    if (Number.isFinite(value) && value > 0) out[code] = value;
  }
  return Object.keys(out).length ? out : null;
}

async function storeFiatTable(rates, { quotedAt = null, nextUpdate = null } = {}) {
  const trimmed = trimFiat(rates);
  if (!trimmed) return null;
  const entry = { rates: trimmed, fetchedAt: Date.now(), quotedAt, nextUpdate };
  await chrome.storage.local.set({ fiatTable: entry });
  return entry;
}

/** The table, refreshed if it is due. A fetch that fails keeps what is cached. */
async function ensureFiatTable() {
  const current = await readFiatTable();
  const age = current ? Date.now() - current.fetchedAt : Infinity;
  const due = age > FIAT_TABLE_MAX_AGE_MS || (current?.nextUpdate && Date.now() > current.nextUpdate);
  if (current && !due) return current;

  try {
    const { rates, quotedAt, nextUpdate } = await fetchFiatTable();
    return (await storeFiatTable(rates, { quotedAt, nextUpdate })) || current;
  } catch {
    // Offline, or the provider is down. A table that is a few hours past due is
    // still the rates that applied; one that is a week past due is refused by
    // archiveSession rather than here.
    return current;
  }
}

// ------------------------------------------------------------------- limits
//
// The three money limits are denominated in whatever `limitCurrency` says, and
// that is normally the target. When the target changes they are converted once,
// here, and the change is announced — because the alternative is comparing a
// number typed in shekels against a session measured in euros and calling the
// result a limit. Silence is the one option that is actually wrong.

const MONEY_LIMITS = ['limitWager', 'limitLoss', 'limitWin'];

/** Everything the UI needs to say what just happened to the limits. Cleared on edit. */
const LIMIT_SWITCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

async function readLimitSwitch() {
  const { limitSwitch } = await chrome.storage.local.get('limitSwitch');
  if (!limitSwitch) return null;
  return Date.now() - limitSwitch.at > LIMIT_SWITCH_MAX_AGE_MS ? null : limitSwitch;
}

/**
 * Fields that used to carry ILS in their name, from before the target was a
 * choice. Renamed rather than left alone: a key called limitWagerIls holding
 * euros is the same lie this whole refactor exists to remove, and it is the one
 * a future reader would trust.
 */
const RENAMED_LIMITS = [
  ['limitWagerIls', 'limitWager'],
  ['limitLossIls', 'limitLoss'],
  ['limitWinIls', 'limitWin'],
];

async function migrateLimitKeys() {
  const keys = RENAMED_LIMITS.flat();
  const stored = await chrome.storage.sync.get([...keys, 'limitCurrency']);
  const present = RENAMED_LIMITS.map(([from]) => from).filter((from) => from in stored);
  if (present.length === 0) return;

  const patch = {};
  for (const [from, to] of RENAMED_LIMITS) {
    // Only where the new key has not already been set, so a half-finished
    // migration cannot overwrite a limit edited since.
    if (Number.isFinite(stored[from]) && !Number.isFinite(stored[to])) patch[to] = stored[from];
  }
  // Anything that existed before the target could be chosen was in shekels.
  if (!stored.limitCurrency) patch.limitCurrency = 'ILS';

  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  await chrome.storage.sync.remove(present);
}

/**
 * Move the money limits onto a new target currency.
 *
 * Converted once, at the cross-rate the fiat table gives, and the old and new
 * figures are both recorded so the UI can say what it did. Without a table
 * there is no honest conversion available, so the limits are cleared instead —
 * an announced "your limits are off" is recoverable in one edit, and a number
 * quietly compared against the wrong currency is not.
 */
async function convertLimits(target) {
  const settings = await loadSettings();
  const from = settings.limitCurrency || 'ILS';
  if (from === target) return;

  const set = MONEY_LIMITS.filter((key) => Number.isFinite(settings[key]));
  if (set.length === 0) {
    // Nothing to convert and nothing to announce; just keep the tag honest.
    await chrome.storage.sync.set({ limitCurrency: target });
    return;
  }

  const table = (await ensureFiatTable())?.rates;
  const perFrom = table?.[from];
  const perTo = table?.[target];

  if (!(perFrom > 0) || !(perTo > 0)) {
    const patch = { limitCurrency: target };
    for (const key of set) patch[key] = null;
    await chrome.storage.sync.set(patch);
    await chrome.storage.local.set({
      limitSwitch: { kind: 'cleared', from, to: target, at: Date.now(), limits: null },
    });
    return;
  }

  const factor = perTo / perFrom;
  const patch = { limitCurrency: target };
  const limits = {};
  for (const key of set) {
    // Rounded to the new currency's own precision: a wager limit of ¥3,051.4 is
    // not a figure anyone set, and the yen has no minor unit to hold it. A
    // figure small enough to round away keeps its full value instead — zero is
    // how this codebase spells "no limit", and turning one off by rounding it
    // would be the quiet failure this whole function exists to avoid.
    const converted = settings[key] * factor;
    const rounded = Number(converted.toFixed(displayDecimals(target, 2)));
    patch[key] = rounded > 0 ? rounded : converted;
    limits[key] = { was: settings[key], now: patch[key] };
  }

  await chrome.storage.sync.set(patch);
  await chrome.storage.local.set({
    limitSwitch: { kind: 'converted', from, to: target, at: Date.now(), limits },
  });
}

// -------------------------------------------------------------- diagnostics
//
// A content script that throws does so inside the page's console, where nobody
// is looking, and the overlay just goes quiet with stale numbers on it. Errors
// are forwarded here instead so the UI can say something is broken.

const DIAGNOSTIC_LIMIT = 20;

async function readDiagnostics() {
  const { diagnostics } = await chrome.storage.local.get('diagnostics');
  return Array.isArray(diagnostics) ? diagnostics : [];
}

async function recordDiagnostic({ where, message, url }) {
  const existing = await readDiagnostics();
  const at = Date.now();

  // The scraper runs on a 2s timer; a persistent fault would otherwise write
  // the same line thirty times a minute. Collapse repeats into a count.
  const head = existing[0];
  if (head && head.where === where && head.message === message) {
    head.count = (head.count || 1) + 1;
    head.at = at;
    await chrome.storage.local.set({ diagnostics: existing });
    return;
  }

  const next = [{ at, where, message, url: url || null, count: 1 }, ...existing].slice(0, DIAGNOSTIC_LIMIT);
  await chrome.storage.local.set({ diagnostics: next });
}

// ----------------------------------------------------------------- session
//
// The background owns the session, not the content script. Bets arrive as
// scraped rows from whichever tab saw them; de-duplication by bet id happens
// here, so two Stake tabs open at once cannot double-count a single bet.

async function readSession() {
  const { session } = await chrome.storage.local.get('session');
  return session || null;
}

async function readHistory() {
  const { sessionHistory } = await chrome.storage.local.get('sessionHistory');
  return Array.isArray(sessionHistory) ? sessionHistory : [];
}

/** Freeze a session into history, newest first. Empty sessions are not worth keeping. */
async function archiveSession(session) {
  if (!session || session.bets === 0) return null;

  const settings = await loadSettings();
  const cache = await readCache(settings.targetCurrency);
  const derived = deriveRate(cache, settings, await readStakeRate());

  // The session's own coin, not USDT: freezing a BTC session at the USDT rate
  // would record a converted figure five orders of magnitude out.
  const rate = coinRate(derived, session.currency);

  // The two halves of "this can be read in another currency later": what the
  // coin was worth in dollars, and what a dollar was worth in everything else.
  // Either one missing and the entry is filed without a snapshot, which the
  // history says plainly rather than papering over.
  const table = await ensureFiatTable();
  const usable = table && Date.now() - table.fetchedAt <= FIAT_TABLE_USABLE_MS ? table : null;

  // A rate you typed cannot be crossed into another currency: market dollars
  // times a market fiat table would produce a euro figure that flatly
  // contradicts the shekel one sitting beside it. So a manually-rated session is
  // filed readable only in the currency it closed in, and says so.
  const entry = archiveEntry(session, {
    rate,
    target: settings.targetCurrency,
    usd: derived.manual ? null : coinUsd(derived, session.currency),
    fiat: usable?.rates || null,
    fiatAt: usable?.quotedAt || usable?.fetchedAt || null,
    fee: settings.feePercent,
  });

  const history = [entry, ...(await readHistory())].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ sessionHistory: history });
  return entry;
}

/**
 * File a session that has gone quiet, without waiting for the next bet.
 *
 * Archiving used to happen only inside recordBets, which meant the last session
 * of the night sat as "current" until the next time you played — the one moment
 * you would want to look it up in history is the one moment it was not there.
 * The refresh alarm is already ticking, so it does this too.
 */
async function archiveIfIdle() {
  const session = await readSession();
  if (!session || session.bets === 0) return false;

  const settings = await loadSettings();
  if (!isStale(session, settings.sessionIdleMinutes)) return false;

  await archiveSession(session);
  // The replacement starts empty, so it is not stale and this cannot re-fire.
  await chrome.storage.local.set({ session: rollSession(session) });
  await mirrorState();
  return true;
}

/** End the current session and open a fresh one that inherits its bet memory. */
async function endSession() {
  const current = await readSession();
  if (!current) return null;

  await archiveSession(current);
  await chrome.storage.local.set({ session: rollSession(current) });
  return mirrorState();
}

/** A session that adopts what is already on screen instead of counting it. */
function seededSession(currency, ids) {
  const session = emptySession(currency);
  session.seen = (ids || []).filter(Boolean);
  return session;
}

async function recordBets(rows, currency) {
  const existing = await readSession();

  // First sight. The table already holds the last ~10 bets, which happened
  // before tracking began — adopt them as history so the session starts at zero
  // rather than opening with someone else's ten bets already on the books.
  if (!existing) {
    // Unsettled rows are deliberately left unseeded: marking one as history
    // would mean it never counts once it finally resolves.
    const session = seededSession(currency, rows.filter((r) => r.settled !== false).map((r) => r.id));
    await chrome.storage.local.set({ session });
    await mirrorState();
    return { added: 0, skipped: 'seeded', session };
  }

  // A session nobody has bet in for the idle window is over. Close it here,
  // when the next bet arrives, rather than on a timer — that way the archived
  // endedAt is the last bet, not whenever a timer happened to fire.
  const settings = await loadSettings();
  let base = existing;
  let rolled = false;

  if (isStale(existing, settings.sessionIdleMinutes)) {
    await archiveSession(existing);
    base = rollSession(existing);
    rolled = true;
  }

  const { session, added, corrected, pending, unreadable, skipped } = ingest(base, rows, {
    currency,
    tableFull: rows.length >= 10,
  });

  // A stake that will not parse means the scraper no longer understands the
  // table. That is a fault worth shouting about rather than a row worth
  // dropping quietly: silently skipped bets look exactly like a flat session.
  if (unreadable > 0) {
    await recordDiagnostic({
      where: 'bet table',
      message: `${unreadable} row${unreadable === 1 ? '' : 's'} had a stake this could not read and ${unreadable === 1 ? 'was' : 'were'} not counted — the Bet Amount column has changed shape.`,
    });
  }

  if (added > 0 || corrected > 0 || rolled) {
    await chrome.storage.local.set({ session });
    await mirrorState();
  }
  return { added, corrected, pending, unreadable, skipped, rolled, session };
}

// ------------------------------------------------------------------- backup
//
// History lives only in storage.local, so an uninstall takes months of
// sessions with it. The backup is one JSON file: settings plus history. The
// API key is deliberately left out — a credential has no business in a file
// that ends up in download folders and cloud drives.

const BACKUP_FORMAT = 'casino-currency-tracker-backup';
const BACKUP_VERSION = 1;

async function exportBackup() {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    settings: await loadSettings(),
    sessionHistory: await readHistory(),
  };
}

/** A history entry sound enough to keep. Essentials only — the rest rides along. */
function validEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    && Number.isFinite(entry.startedAt) && entry.startedAt > 0
    && Number.isFinite(entry.endedAt) && entry.endedAt >= entry.startedAt
    && Number.isFinite(entry.bets) && entry.bets > 0
    && Number.isFinite(entry.wagered) && Number.isFinite(entry.returned);
}

/**
 * Merge a backup into what is already here rather than replacing it: restoring
 * last month's file must not delete this month's sessions. Identity is the
 * session's own start, end and coin — two copies of the same session agree on
 * all three, and no honest pair of different sessions shares them.
 */
async function importBackup(backup) {
  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT) {
    throw new Error('not a backup file this extension wrote');
  }
  if (Number(backup.version) > BACKUP_VERSION) {
    throw new Error('backup written by a newer version — update the extension first');
  }

  const offered = Array.isArray(backup.sessionHistory) ? backup.sessionHistory : [];
  const incoming = offered.filter(validEntry);
  const existing = await readHistory();

  const identity = (e) => `${e.startedAt}:${e.endedAt}:${e.currency || ''}`;
  const have = new Set(existing.map(identity));
  const fresh = incoming.filter((e) => !have.has(identity(e)));

  const merged = [...existing, ...fresh]
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0))
    .slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ sessionHistory: merged });

  // Settings come along only when the file carries them, filtered to keys this
  // build knows and run through the same sanitiser every UI write goes through
  // — a hand-edited file earns the same distrust as a hand-typed field.
  let settingsApplied = false;
  if (backup.settings && typeof backup.settings === 'object') {
    const known = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key in backup.settings) known[key] = backup.settings[key];
    }
    if (Object.keys(known).length) {
      await chrome.storage.sync.set(sanitize(known));
      settingsApplied = true;
    }
  }

  return {
    added: fresh.length,
    duplicates: incoming.length - fresh.length,
    invalid: offered.length - incoming.length,
    total: merged.length,
    settingsApplied,
  };
}

// --------------------------------------------------------------- stake meta
//
// Rakeback and VIP progress, read out of Stake's own GraphQL traffic by the
// page-world bridge. Stored here rather than in the page so the popup can show
// it with no Stake tab open.

async function readStakeMeta() {
  const { stakeMeta } = await chrome.storage.local.get('stakeMeta');
  return stakeMeta || null;
}

async function recordStakeMeta(meta, { forced = false } = {}) {
  if (!meta || typeof meta !== 'object') return false;

  const current = await readStakeMeta();
  const next = { ...(current || {}), ...meta, at: Date.now() };

  // The same figures arrive on every page navigation; only a changed reading
  // is worth a storage write and a re-render everywhere.
  //
  // A reading that was asked for is written even when the figures match. The
  // question a refresh asks is not "has this changed" but "is this still
  // current", and the answer to that is the timestamp — without the write, a
  // click on an unchanged balance would leave the age reading "14m ago" and
  // look like nothing happened.
  const unchanged = current && JSON.stringify({ ...current, at: 0 }) === JSON.stringify({ ...next, at: 0 });
  if (unchanged && !forced) return false;

  await chrome.storage.local.set({ stakeMeta: next });
  await mirrorState();
  return true;
}

// -------------------------------------------------------- Stake's own rates
//
// Stake's app fetches its currency table every few tens of seconds to price
// what it draws. Reading it is free — the request was happening anyway — and it
// beats the provider poll twice over: it is fresher, and it is the same number
// the balance on screen was drawn with. It only exists while a Stake tab is
// open, so the providers stay underneath as the fallback.

// Past this, the tab that was feeding us has gone. Generous next to a table
// that arrives every 10-30 seconds, so a quiet moment does not drop the source.
const STAKE_RATE_MAX_AGE_MS = 150_000;

// The page re-fetches often enough that storing every reading would mean a
// storage write and a full state mirror three times a minute, for a number that
// moves in the fourth decimal. One reading per this window is plenty.
const STAKE_RATE_MIN_GAP_MS = 15_000;

async function readStakeRate() {
  const { stakeRate } = await chrome.storage.local.get('stakeRate');
  return stakeRate || null;
}

/** Which reader a forwarded price table needs. Unknown sources are refused. */
const RATE_READERS = { stake: ratesFromStake, duel: ratesFromDuel };
const SITE_NAMES = { stake: 'Stake', duel: 'Duel' };

// Measured from the last *attempt*, not the last stored reading. A table this
// cannot read for the current target fails on every arrival — every ten seconds
// on Stake — and throttling only successes would turn that into a diagnostic
// counter ticking up all evening for one thing that is wrong once.
let lastRateAttempt = 0;

async function recordStakeRates(baseRates, source = 'stake') {
  if (Date.now() - lastRateAttempt < STAKE_RATE_MIN_GAP_MS) return false;
  lastRateAttempt = Date.now();

  const settings = await loadSettings();
  const target = settings.targetCurrency;
  const read = RATE_READERS[source];
  const name = SITE_NAMES[source] || source;

  const derived = read ? read(baseRates, target) : null;
  if (!derived) {
    // A table that will not read is worth saying out loud rather than falling
    // back in silence: it means either the site changed the shape of it, or it
    // simply does not carry the currency you asked for — and in both cases the
    // rate quietly reverting to the provider is exactly the kind of thing
    // nobody notices for a month.
    await recordDiagnostic({
      where: `${source} rates`,
      message: `${name} sent a currency table this could not read for ${target} — no ${target} or BTC row, or an ambiguous one. Using the rate providers instead.`,
    });
    return false;
  }

  await chrome.storage.local.set({ stakeRate: { ...derived, source, at: Date.now() } });
  await mirrorState();
  return true;
}

/** The stored reading, or null when it is switched off, stale, or in another currency. */
function liveStakeRate(stakeRate, settings) {
  if (!settings.stakeRates || !stakeRate) return null;
  if (!Number.isFinite(stakeRate.rate) || stakeRate.rate <= 0) return null;
  // A reading with no target predates multi-currency, so it is an ILS one. The
  // next table the page sends replaces it within seconds; until then the
  // providers answer, which is better than relabelling shekels as euros.
  if ((stakeRate.target || 'ILS') !== settings.targetCurrency) return null;
  return Date.now() - stakeRate.at > STAKE_RATE_MAX_AGE_MS ? null : stakeRate;
}

// ------------------------------------------------------------- derived state

/**
 * The shape every UI consumes. Manual override and the off-ramp spread are
 * resolved here so the popup, the options page and the content script cannot
 * drift on what "the rate" means.
 */
/**
 * Target-currency units per coin for everything the provider priced, spread
 * applied. Keyed by
 * ticker, so `coins.BTC` is what one bitcoin is worth after the off-ramp cut.
 * A manual override replaces the USDT rate only — it says nothing about BTC.
 */
function deriveCoins(source, settings) {
  const coins = {};
  for (const [ticker, price] of Object.entries(source || {})) {
    const effective = effectiveRate(price, settings.feePercent);
    if (Number.isFinite(effective)) coins[ticker] = effective;
  }
  return coins;
}

/**
 * Three sources, in order of how much they know about your money: a rate you
 * set by hand beats one read off the page you are playing on, which beats a
 * market feed fetched a minute ago. Each falls through to the next.
 */
function deriveRate(cache, settings, stakeRate) {
  const manual = Number.isFinite(settings.manualRate) ? settings.manualRate : null;
  const live = liveStakeRate(stakeRate, settings);

  const quoted = live?.rate ?? (Number.isFinite(cache?.rate) ? cache.rate : null);
  const value = manual ?? quoted;
  const source = manual !== null ? 'manual' : live ? 'stake' : 'provider';

  // Which casino's table this is, for the label. 'stake' is the fallback for a
  // reading stored before the field existed.
  const siteName = SITE_NAMES[live?.source] || SITE_NAMES.stake;

  // Whichever source is in use is the one whose age decides staleness. The
  // casino's table arrives every few seconds while a tab is open, so it is held
  // to a much shorter clock than a provider on a minutes-long refresh.
  const fetchedAt = live ? live.at : cache?.fetchedAt || null;
  const maxAgeMs = live ? STAKE_RATE_MAX_AGE_MS : settings.refreshMinutes * 60_000 * 2 + 60_000;
  const stale = manual === null && (!fetchedAt || Date.now() - fetchedAt > maxAgeMs);

  return {
    value,
    effective: effectiveRate(value, settings.feePercent),
    // The casino prices everything it pays in, which is more coins than any
    // provider request covers, so its table goes on top of theirs rather than
    // beside it.
    coins: { ...deriveCoins(cache?.coins, settings), ...(live ? deriveCoins(live.coins, settings) : {}) },
    // The same coins priced in dollars, with no spread on them: a market price,
    // not a display figure. Only the session snapshot reads this — see
    // archiveSession — and it applies the spread itself at the point of use.
    coinsUsd: { ...(cache?.coinsUsd || {}), ...(live?.coinsUsd || {}) },
    quoted,
    manual: manual !== null,
    source,
    provider: live ? live.source || 'stake' : cache?.provider || null,
    providerLabel:
      manual !== null ? 'Manual rate' : live ? siteName : cache?.providerLabel || null,
    providerDetail:
      manual !== null ? 'set by you' : live ? `read from ${siteName}'s own price table` : cache?.providerDetail || null,
    approximate: source === 'provider' && Boolean(cache?.approximate),
    keyed: source === 'provider' && Boolean(cache?.usedKey),
    quotedAt: live ? live.at : cache?.quotedAt || null,
    fetchedAt,
    stale,
    // A provider failure is not this rate's problem while Stake is supplying it.
    error: source === 'provider' ? cache?.error || null : null,
  };
}

export async function getState() {
  const settings = await loadSettings();
  const cache = await readCache(settings.targetCurrency);
  const key = await readKey();
  const usage = await readUsage();

  const session = await readSession();
  const i18n = await syncBundle(settings);
  const stakeRate = await readStakeRate();

  return {
    settings,
    i18n,
    rate: deriveRate(cache, settings, stakeRate),
    session: session
      ? {
          ...session,
          profit: sessionProfit(session),
          // Reported rather than acted on: archiving happens when the next bet
          // arrives, so a read never causes a write.
          stale: isStale(session, settings.sessionIdleMinutes),
          check: reconcile(session),
          // Scaffolding the UI has no use for.
          seen: undefined,
          marks: undefined,
        }
      : null,
    stake: await readStakeMeta(),
    // What the last change of target did to the money limits. Shown until the
    // limits are next edited, or for a week — long enough to be seen by
    // somebody who switched currency and did not open the popup that evening,
    // short enough not to become furniture.
    limitSwitch: await readLimitSwitch(),
    historyCount: (await readHistory()).length,
    diagnostics: await readDiagnostics(),
    key: {
      present: Boolean(key),
      preview: key ? maskKey(key) : null,
      exhausted: Boolean(key) && usage.count >= DEMO_BUDGET,
      used: usage.count,
      month: usage.month,
      budget: DEMO_BUDGET,
      limit: DEMO_MONTHLY_LIMIT,
      // Calls per month implied by the current interval, so the options page
      // can say up front whether this setting fits the Demo allowance.
      projected: projectedMonthlyCalls(settings.refreshMinutes),
      mode: chooseKeyMode(settings, usage, Boolean(key)),
    },
  };
}

// -------------------------------------------------------------------- badge
//
// The popup is a click away, which is a click more than most people spend on a
// number they want to keep half an eye on. The badge is the same figure with no
// click at all: session P/L in the target currency while a session is live, the
// rate when
// it is not.

const BADGE_BG = { up: '#0b5c22', down: '#7a2320', flat: '#1f4d68' };

async function updateBadge(state) {
  const { settings, session, rate } = state;
  const target = settings.targetCurrency;

  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: `USDT → ${target}` });
    return;
  }

  const live = Boolean(settings.trackSession && session && session.bets > 0);
  const sessionRate = live ? coinRate(rate, session.currency) : null;

  let text = '';
  let tone = 'flat';
  let title = `USDT → ${target}`;

  if (live && Number.isFinite(sessionRate)) {
    const profit = session.profit ?? 0;
    const money = profit * sessionRate;
    // No "+": four characters is the whole budget, and the colour already says
    // which way it went. The tooltip carries the exact figure.
    text = compactMoney(money);
    tone = profit > 0 ? 'up' : profit < 0 ? 'down' : 'flat';
    title = `Session ${profit >= 0 ? '+' : '−'}${formatMoney(Math.abs(money), target, settings.decimals)} · ${session.bets} bet${session.bets === 1 ? '' : 's'}`;
  } else if (Number.isFinite(rate.effective)) {
    text = rate.effective.toFixed(2);
    title = `1 USDT = ${formatMoney(rate.effective, target, settings.decimals)}`;
  }

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG[tone] });
  // Chrome 110+. The minimum supported here is 102, where the default white
  // text on these backgrounds is already legible.
  await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  await chrome.action.setTitle({ title });
}

// ------------------------------------------------------------- notifications
//
// A limit that only shows in the overlay is a limit you see when you are
// already looking at Stake. The point of a limit is to reach you when you are
// not — so it is also a desktop notice, once per limit per session.

const LIMIT_NOTICE = {
  wager: (l, money) => [t('notifyWagerTitle', 'Wager limit reached'), `${money(l.value)} / ${money(l.limit)}`],
  loss: (l, money) => [t('notifyLossTitle', 'Loss limit reached'), `−${money(l.value)} / ${money(l.limit)}`],
  win: (l, money) => [t('notifyWinTitle', 'Win target reached'), `+${money(l.value)} / ${money(l.limit)}`],
  time: (l) => [t('notifyTimeTitle', 'Time limit reached'), `${Math.round(l.value)} / ${l.limit} min`],
};

async function readNotices() {
  const { limitNotices } = await chrome.storage.local.get('limitNotices');
  return limitNotices && Array.isArray(limitNotices.fired) ? limitNotices : { startedAt: null, fired: [] };
}

/**
 * Fire once per limit per session.
 *
 * Keyed on the session's start time rather than a counter: a reset opens a new
 * session with a new startedAt, which is exactly when the notices should be
 * allowed to fire again.
 */
async function notifyCrossings(state) {
  const { settings, session, rate } = state;
  if (!chrome.notifications) return;

  const notices = await readNotices();
  const startedAt = session?.startedAt ?? null;

  if (notices.startedAt !== startedAt) {
    await chrome.storage.local.set({ limitNotices: { startedAt, fired: [] } });
    notices.startedAt = startedAt;
    notices.fired = [];
  }

  if (!settings.notifyLimits || !settings.trackSession || !session) return;

  const crossed = limitStatus(session, { settings, rate: coinRate(rate, session.currency) })
    .filter((limit) => limit.pct >= 100 && !notices.fired.includes(limit.kind));
  if (crossed.length === 0) return;

  const money = (value) => formatMoney(value, settings.targetCurrency, settings.decimals);

  for (const limit of crossed) {
    const [title, message] = LIMIT_NOTICE[limit.kind](limit, money);
    try {
      chrome.notifications.create(`limit-${limit.kind}-${startedAt}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message,
        priority: 2,
      });
    } catch {
      // A notification that cannot be shown must not take the state write with
      // it; the overlay still has the bar and the alert.
    }
  }

  await chrome.storage.local.set({
    limitNotices: { startedAt, fired: [...notices.fired, ...crossed.map((l) => l.kind)] },
  });
}

/**
 * Mirror settings + derived rate into storage.local for content scripts.
 * The `key` block is stripped deliberately — the content script runs inside
 * stake.com and has no business holding credentials, not even masked ones.
 */
async function mirrorState() {
  const state = await getState();
  // The message bundle is published under its own key rather than copied into
  // every mirror write — it changes when the language changes, which is almost
  // never, and the mirror is rewritten every minute.
  const { key, i18n, ...contentSafe } = state;
  // The overlay shows totals, not the per-bet log; no reason to ship 50 rows
  // into the page on every rate tick.
  // The overlay draws the curve but not the per-bet log.
  if (contentSafe.session) contentSafe.session = { ...contentSafe.session, log: undefined };
  await chrome.storage.local.set({ mirror: contentSafe });

  // Everything that has to react to a state change hangs off this one write, so
  // the badge and the notices cannot drift out of step with what the UI shows.
  // Neither is allowed to take the mirror down with it.
  await updateBadge(state).catch(() => {});
  await notifyCrossings(state).catch(() => {});

  return state;
}

// ------------------------------------------------------------------- alarms

async function rescheduleAlarm() {
  const settings = await loadSettings();
  const period = Math.max(1, settings.refreshMinutes); // Chrome clamps below 1
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period, delayInMinutes: period });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Rate first, so a session filed on this tick is frozen at the freshest rate
  // available. The closing mirror is what keeps the time limit honest: without
  // it, a session that crosses 90 minutes without a bet or a rate change would
  // not be noticed until something else happened to write state.
  refreshRate()
    .then(archiveIfIdle)
    .then(() => mirrorState())
    .catch(() => {});
});

// ------------------------------------------------------------------ lifecycle

/**
 * A session accumulated by an older build carries totals computed the wrong
 * way, and there is no way to recompute them — the individual bets were folded
 * in as they arrived. Drop it and start clean; the next scrape re-seeds.
 * Archived history is kept but flagged in the UI instead of deleted.
 */
async function discardStaleCalcSession() {
  const session = await readSession();
  if (session && session.calc !== CALC_VERSION) {
    await chrome.storage.local.remove('session');
  }
}

async function boot() {
  await discardStaleCalcSession();
  await migrateLimitKeys();
  await chrome.storage.sync.set({ ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) });
  await rescheduleAlarm();
  await mirrorState();
  await refreshRate();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

// Also on a plain wake, not only on install: a worker that is revived by a
// message never runs boot, and a limit left under its old key would read as
// "off" until the browser was restarted. It costs one storage read and does
// nothing at all once the old keys are gone.
migrateLimitKeys().catch(() => {});

// A woken worker may have missed alarms while suspended; top the rate up.
refreshRate().catch(() => {});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if ('refreshMinutes' in changes) await rescheduleAlarm();

  // A new target makes every cached rate an answer to the previous question.
  // Nothing shows the stale one — readCache and liveStakeRate both refuse a
  // mismatched currency — so the visible effect is a blank rate for as long as
  // this fetch takes, rather than a wrong one for as long as the interval is.
  //
  // The limits move with it, once, and say so. This handler writes to sync
  // itself, which fires it again — but the second pass carries no
  // targetCurrency change, and convertLimits is a no-op once the tag matches,
  // so it settles rather than looping.
  if ('targetCurrency' in changes) {
    await convertLimits(changes.targetCurrency.newValue);
    await refreshRate({ force: true });
  }

  await mirrorState();
});

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => { // eslint-disable-line
  (async () => {
    switch (message?.type) {
      case 'getState':
        sendResponse(await getState());
        break;

      case 'refresh':
        await refreshRate({ force: true });
        sendResponse(await getState());
        break;

      case 'setSettings': {
        const patch = sanitize(message.patch || {});
        // Editing a limit is the acknowledgement that the conversion notice was
        // asking for, so it stops being shown at that point rather than sitting
        // there being scrolled past for a week.
        if (MONEY_LIMITS.some((key) => key in patch)) await chrome.storage.local.remove('limitSwitch');
        await chrome.storage.sync.set(patch);
        sendResponse(await mirrorState());
        break;
      }

      case 'setApiKey': {
        const key = String(message.key || '').trim();
        if (key) await chrome.storage.local.set({ coingeckoKey: key });
        else await chrome.storage.local.remove('coingeckoKey');
        // A new key gets a fresh allowance: the old count belonged to the old key.
        await chrome.storage.local.set({ keyUsage: { month: currentMonth(), count: 0 } });
        await refreshRate({ force: true });
        sendResponse(await getState());
        break;
      }

      case 'testApiKey':
        sendResponse({ error: null, problem: await pingKey(String(message.key || '').trim() || null) });
        break;

      case 'bets': {
        const { added, corrected, pending, unreadable, skipped } = await recordBets(message.rows || [], message.currency || null);
        sendResponse({ error: null, added, corrected, pending, unreadable, skipped });
        break;
      }

      case 'balance': {
        const current = await readSession();
        // No session yet means no bets yet; the opening balance will be taken
        // when one is created rather than invented here.
        if (!current) {
          sendResponse({ error: null, stored: false });
          break;
        }
        const updated = applyBalance(current, Number(message.value), message.currency || null);
        if (updated !== current) {
          await chrome.storage.local.set({ session: updated });
          await mirrorState();
        }
        sendResponse({ error: null, stored: updated !== current });
        break;
      }

      // Rakeback and VIP progress, forwarded by the page-world bridge. The
      // access token it used to read them never comes with it.
      case 'stakeMeta':
        await recordStakeMeta(message.meta, { forced: Boolean(message.forced) });
        sendResponse({ error: null });
        break;

      // Stake's own price table, seen going past in the page. Public data, no
      // request of ours, and fresher than anything the alarm can fetch.
      case 'stakeRates':
        await recordStakeRates(message.rates, message.source || 'stake');
        sendResponse({ error: null });
        break;

      // "Read those figures again, now." The popup cannot say that to the page
      // itself — a targeted tab message costs the "tabs" permission this
      // extension does not take — so it lands as a storage write that every
      // Stake tab already watches, and the visible one answers it.
      case 'refreshRakeback': {
        const settings = await loadSettings();
        if (!settings.trackRakeback) {
          sendResponse({ error: null, asked: false });
          break;
        }
        await chrome.storage.local.set({ rakebackPing: Date.now() });
        sendResponse({ error: null, asked: true });
        break;
      }

      // Money in or out that no bet explains. Without somewhere to put it, one
      // deposit leaves the cross-check accusing the ledger for the rest of the
      // session.
      case 'fundsMove': {
        const current = await readSession();
        if (!current) {
          sendResponse({ error: null, stored: false });
          break;
        }
        const updated = applyFunds(current, Number(message.delta));
        if (updated !== current) await chrome.storage.local.set({ session: updated });
        sendResponse(await mirrorState());
        break;
      }

      // Reset archives rather than discards, and the replacement inherits the
      // old session's bet ids so the ten rows still on screen are not counted
      // a second time.
      case 'endSession':
        await endSession();
        sendResponse(await getState());
        break;

      case 'getHistory':
        sendResponse({ error: null, history: await readHistory(), totals: summarise(await readHistory()) });
        break;

      case 'contentError':
        await recordDiagnostic({
          where: String(message.where || 'unknown'),
          message: String(message.message || 'no detail'),
          url: _sender?.tab?.url || null,
        });
        // Deliberately not mirrored: a broken scraper must not trigger a state
        // write that re-runs the broken scraper.
        sendResponse({ error: null });
        break;

      case 'clearDiagnostics':
        await chrome.storage.local.remove('diagnostics');
        sendResponse(await getState());
        break;

      case 'clearHistory':
        await chrome.storage.local.remove('sessionHistory');
        sendResponse({ error: null, history: [], totals: {} });
        break;

      case 'exportBackup':
        sendResponse({ error: null, backup: await exportBackup() });
        break;

      case 'importBackup': {
        const result = await importBackup(message.backup);
        await mirrorState();
        sendResponse({ error: null, ...result });
        break;
      }

      default:
        sendResponse({ error: `unknown message type: ${message?.type}` });
    }
  })().catch((error) => sendResponse({ error: String(error?.message || error) }));

  return true; // keep the channel open for the async reply
});
