// Session accounting.
//
// The numbers come from Stake's own "My Bets" table, not from watching the
// balance move. That distinction is the whole design: balance deltas can give
// you profit, but they cannot give you turnover — a won bet nets positive while
// still having wagered — and a bet that resolves in one DOM update is
// indistinguishable from a deposit. Each table row instead carries an exact
// stake, an exact payout, and a UUID, so bets are counted once and only once.
//
// Pure functions, no chrome APIs: this is the half that tools/selftest.mjs can
// actually exercise.

import { downsample } from './chart.js';

/** How many bet ids to remember for de-duplication. The table grows past 10 as you play. */
const SEEN_LIMIT = 400;

/**
 * How many individual bets to keep alongside the totals.
 *
 * Exists because a total nobody can check is a total nobody can trust: the
 * payout-column bug below produced a plausible-looking number that was wrong on
 * every losing bet, and there was no way to see that from the summary alone.
 */
const LOG_LIMIT = 50;

/** Points kept for the P/L curve before it is halved. */
const CURVE_LIMIT = 240;

/**
 * Append a point, halving the series when it gets too long.
 *
 * Halving rather than dropping the oldest keeps the shape of the *whole*
 * session on screen — a sparkline showing only the last 240 bets would hide
 * exactly the run-up a player wants to see. The check fires the moment the
 * limit is passed, so the length is always odd when halved and the newest
 * point is never the one discarded.
 */
export function pushCurve(curve, value) {
  const next = [...(curve || []), value];
  if (next.length <= CURVE_LIMIT) return next;

  const halved = [];
  for (let i = 0; i < next.length; i += 2) halved.push(next[i]);
  return halved;
}

/**
 * Bumped when the accounting itself changes, so figures produced by an older,
 * wrong calculation can be identified rather than silently displayed.
 * 2 = Stake's negative-payout-on-loss column handled correctly.
 */
export const CALC_VERSION = 2;

export function emptySession(currency = null, now = Date.now()) {
  return {
    calc: CALC_VERSION,
    startedAt: now,
    currency,
    bets: 0,
    wagered: 0,
    returned: 0,
    wins: 0,
    losses: 0,
    biggestWin: 0,
    biggestLoss: 0,
    peakProfit: 0,
    troughProfit: 0,
    lastBetAt: null,
    gaps: 0,
    corrections: 0,
    // Wallet figures, for cross-checking the ledger against reality.
    startBalance: null,
    lastBalance: null,
    balanceAt: null,
    // Money moved in or out mid-session that no bet explains: deposits,
    // withdrawals, tips, rakeback. Net coin units, positive for money in.
    funded: 0,
    seen: [],
    // id -> [amount, gross], so a row that changes after being counted can be
    // unwound rather than ignored.
    marks: {},
    log: [],
    curve: [],
  };
}

export const sessionProfit = (session) => (session ? session.returned - session.wagered : 0);

/**
 * Bumped when what a closed session stores changes shape.
 * 1 = the coin's dollar price and the fiat table are frozen alongside the rate,
 *     so the entry can be restated into a currency chosen later.
 */
export const SNAPSHOT_VERSION = 1;

/**
 * Freeze a finished session for the history list.
 *
 * `rateAtClose` is stored rather than converted later on purpose: showing a
 * session from three weeks ago at today's rate would quietly restate what that
 * evening actually cost. The figure a session is recorded with is the figure it
 * keeps, and `restate` below hands it back untouched whenever it is read in the
 * currency it closed in.
 *
 * Three more things are frozen so that reading it in a *different* currency is
 * possible at all, and possible honestly: the coin's dollar price, the
 * USD-per-fiat table, and the off-ramp spread that applied. Together they are
 * the rates that were true that evening — so a euro view of a shekel session is
 * that evening's euros, not today's.
 *
 * `seen`, `marks`, `log` and `curve` are dropped — de-duplication scaffolding, a
 * live audit trail and a drawing, none of which is a result, and all of which
 * would multiply the size of a 300-entry history. The reconciliation verdict is
 * kept, because whether a session's books balanced is a result.
 */
export function archiveEntry(session, {
  endedAt = Date.now(), rate = null, target = null, usd = null, fiat = null, fiatAt = null, fee = 0,
} = {}) {
  const { seen, marks, log, curve, ...rest } = session;
  const check = reconcile(session);

  // Only a complete snapshot is stored. Half of one would look restateable and
  // then produce nothing, which is worse than an entry that says up front it
  // can only be read in the currency it closed in.
  const full = Number.isFinite(usd) && usd > 0 && fiat && typeof fiat === 'object';

  return {
    ...rest,
    // Thinned to chart resolution rather than dropped: the shape of an evening
    // is a result too, and 60 numbers is a rounding error next to the entry it
    // sits in. The per-bet log is still dropped — that is an audit trail, not a
    // result, and it does not survive the session it audits.
    curve: downsample(curve, 60),
    endedAt,
    profit: sessionProfit(session),
    rateAtClose: Number.isFinite(rate) ? rate : null,
    // What rateAtClose is quoted in. Entries written before this existed have
    // no field here and are read as shekels, which is what they were.
    closeTarget: target || null,
    snap: full ? SNAPSHOT_VERSION : null,
    usdAtClose: full ? usd : null,
    fiatAtClose: full ? fiat : null,
    fiatAt: full ? fiatAt || null : null,
    feeAtClose: Number.isFinite(fee) ? fee : 0,
    reconciled: check.known ? check.ok : null,
    drift: check.known ? check.drift : null,
  };
}

/**
 * A recorded session's figure, read in `target`.
 *
 * Two cases, and the difference between them is the whole point:
 *
 * - **The currency it closed in.** The frozen `rateAtClose` is handed back
 *   unchanged. Nothing recomputes what an evening actually cost.
 * - **Any other currency.** Computed from the coin's dollar price and the fiat
 *   table *as they were at close*, so it is still that evening's money — just
 *   counted in a different unit. The off-ramp spread that applied then is
 *   applied here too, so the two views agree about what you would have received.
 *
 * When neither is possible the answer is null with a reason, never a figure
 * back-computed from today's rates. `legacy` means the entry predates the
 * snapshot and simply cannot be read outside the currency it was recorded in.
 *
 * @returns {{value:number|null, restated:boolean, reason:string|null}}
 */
export function restate(entry, value, target) {
  const code = String(target || 'ILS').toUpperCase();
  // No closeTarget means it was written before there was a choice, and the only
  // thing it could have been is shekels.
  const closed = entry?.closeTarget || 'ILS';

  if (code === closed) {
    return Number.isFinite(entry?.rateAtClose)
      ? { value: value * entry.rateAtClose, restated: false, reason: null }
      : { value: null, restated: false, reason: 'no-rate' };
  }

  const usd = entry?.usdAtClose;
  const perDollar = entry?.fiatAtClose?.[code];
  if (!(usd > 0) || !(perDollar > 0)) {
    return { value: null, restated: false, reason: entry?.snap ? 'no-cross-rate' : 'legacy' };
  }

  const fee = Number.isFinite(entry.feeAtClose) ? entry.feeAtClose : 0;
  return { value: value * usd * perDollar * (1 - fee / 100), restated: true, reason: null };
}

/**
 * Has this session gone quiet long enough to be over?
 *
 * A session nobody has bet in for half an hour is finished, whether or not the
 * tab is still open — otherwise "session" would mean "since I last clicked
 * reset", which is not a unit anyone reasons in.
 */
export function isStale(session, idleMinutes, now = Date.now()) {
  if (!session || session.bets === 0) return false;
  const since = session.lastBetAt || session.startedAt;
  return now - since > Math.max(1, idleMinutes) * 60_000;
}

/**
 * A fresh session that inherits the old one's de-duplication memory, so bets
 * already counted in the archived session are not counted again in the new one
 * when they are still sitting in the visible table.
 */
export function rollSession(previous, now = Date.now()) {
  const next = emptySession(previous?.currency ?? null, now);
  next.seen = previous?.seen ? previous.seen.slice() : [];
  next.marks = { ...(previous?.marks || {}) };
  // The wallet figure carries over as the new session's opening balance — it is
  // the same wallet, and waiting for the next reading would lose the first bet
  // from the cross-check.
  if (Number.isFinite(previous?.lastBalance)) {
    next.startBalance = previous.lastBalance;
    next.lastBalance = previous.lastBalance;
    next.balanceAt = now;
  }
  return next; // log and curve start empty: they belong to the new session
}

/**
 * Which tax year a moment falls in, and what to call it.
 *
 * A year that opens in January is the calendar year and is named after it —
 * Israel's, and the only grouping this reported before. One that opens anywhere
 * else spans two calendar years, so it is named after both ("2025/26"): calling
 * a period that runs to April 2026 simply "2025" is how a figure ends up filed
 * against the wrong year.
 *
 * @param startMonth  1-12, the month the tax year opens in.
 */
export function fiscalYearOf(timestamp, startMonth = 1) {
  const date = new Date(timestamp);
  const start = Math.min(12, Math.max(1, Math.round(Number(startMonth)) || 1));
  const year = date.getMonth() + 1 >= start ? date.getFullYear() : date.getFullYear() - 1;
  return { year, label: start === 1 ? String(year) : `${year}/${String(year + 1).slice(-2)}` };
}

/**
 * Lifetime totals, grouped by currency — summing USDT and BTC turnover into one
 * number would be arithmetic on two different things.
 */
export function summarise(history) {
  const totals = {};

  for (const session of history || []) {
    const key = session.currency || 'UNKNOWN';
    const bucket = (totals[key] ||= {
      currency: key, sessions: 0, bets: 0, wagered: 0, returned: 0, wins: 0, losses: 0, profit: 0,
    });

    bucket.sessions += 1;
    bucket.bets += session.bets || 0;
    bucket.wagered += session.wagered || 0;
    bucket.returned += session.returned || 0;
    bucket.wins += session.wins || 0;
    bucket.losses += session.losses || 0;
    bucket.profit += session.profit ?? (session.returned || 0) - (session.wagered || 0);
  }

  return totals;
}

// Cell parsing lives in lib/scrape.js, with the rest of the table reading and
// with the DOM tests that exercise it. It was duplicated here once; the two
// copies drifted, the live one was the stricter of the two, and a stake it
// refused to read became a zero-stake bet. One copy now.

/**
 * Stake's Payout column is not one quantity. On a win it is the gross amount
 * credited back (stake × multiplier). On a loss it is the amount debited,
 * written negative: a lost 0.20 shows as "-0.20000000", not "0.00000000".
 * Everything downstream works in gross terms so a stake is charged once.
 */
const grossOf = (payout) => (Number.isFinite(payout) && payout > 0 ? payout : 0);

const numeric = (value) => (Number.isFinite(value) ? value : 0);

/**
 * Fold newly observed rows into a session.
 *
 * Three things can happen to a row:
 *
 * - **Unsettled** (`settled === false`): skipped entirely, and deliberately not
 *   marked as seen. A bet whose result has not landed yet — a sports bet, or a
 *   row mid-render — would otherwise be frozen at whatever it showed first and
 *   never revisited, because de-duplication would refuse to look at it again.
 * - **New**: counted.
 * - **Changed**: a row already counted whose stake or payout no longer matches
 *   what was recorded. The old contribution is unwound and the new one applied,
 *   so a bet that settles after being counted self-heals instead of locking in
 *   a wrong number.
 *
 * @param rows  Newest-first, as the table renders them.
 *              Each {id, amount, payout, game, settled?}.
 */
export function ingest(session, rows, { currency = null, now = Date.now(), tableFull = false } = {}) {
  const idle = { session, added: 0, corrected: 0, pending: 0, unreadable: 0, skipped: null };
  if (!Array.isArray(rows) || rows.length === 0) return idle;

  // Mixing denominations would silently add BTC stakes to USDT ones. Refuse
  // rather than produce a total that means nothing.
  if (session.currency && currency && session.currency !== currency) {
    return { ...idle, skipped: 'currency-changed' };
  }

  const settled = rows.filter((row) => row && row.id && row.settled !== false);

  // A row whose stake will not parse is a scraper failure, not a free bet. It
  // used to be booked with a stake of zero — which is how a session could show
  // a bet, no turnover, no profit, and a loss it never made. Skip it, leave it
  // unseen so it is reconsidered on the next read, and say so.
  const usable = settled.filter((row) => Number.isFinite(row.amount));
  const unreadable = settled.length - usable.length;
  const pending = rows.length - settled.length;

  const seen = new Set(session.seen);
  const marks = { ...(session.marks || {}) };

  const fresh = usable.filter((row) => !seen.has(row.id));
  const changed = usable.filter((row) => {
    const mark = seen.has(row.id) ? marks[row.id] : null;
    // No mark means it was counted by a build that did not record one; there is
    // nothing to unwind, so leave it alone rather than double-count it.
    if (!mark) return false;
    return mark[0] !== numeric(row.amount) || mark[1] !== grossOf(row.payout);
  });

  if (fresh.length === 0 && changed.length === 0) return { ...idle, pending, unreadable };

  const next = {
    ...session,
    seen: session.seen.slice(),
    log: (session.log || []).slice(),
    curve: (session.curve || []).slice(),
    marks,
  };
  if (!next.currency && currency) next.currency = currency;

  // If the table is full and we recognised none of it, bets came and went
  // between two observations. The totals below are a floor, and say so.
  if (tableFull && session.bets > 0 && fresh.length === usable.length && usable.length > 0) next.gaps += 1;

  const record = (row, { isNew }) => {
    const amount = numeric(row.amount);
    const gross = grossOf(row.payout);
    const profit = gross - amount;

    if (isNew) {
      next.bets += 1;
      next.wagered += amount;
      next.returned += gross;
      if (gross > 0) next.wins += 1;
      else next.losses += 1;

      next.seen.push(row.id);
      next.log.unshift({ id: row.id, game: row.game || '', amount, gross, profit, at: now });
    } else {
      const [wasAmount, wasGross] = marks[row.id];
      next.wagered += amount - wasAmount;
      next.returned += gross - wasGross;

      // The bet count does not move — this is the same bet — but which column
      // it belongs in may have.
      if (wasGross > 0 && gross <= 0) { next.wins -= 1; next.losses += 1; }
      else if (wasGross <= 0 && gross > 0) { next.wins += 1; next.losses -= 1; }

      next.corrections = (next.corrections || 0) + 1;
      next.log = next.log.map((entry) =>
        entry.id === row.id ? { ...entry, amount, gross, profit, corrected: true } : entry,
      );
    }

    marks[row.id] = [amount, gross];

    if (profit > next.biggestWin) next.biggestWin = profit;
    if (-profit > next.biggestLoss) next.biggestLoss = -profit;

    const running = next.returned - next.wagered;
    if (running > next.peakProfit) next.peakProfit = running;
    if (running < next.troughProfit) next.troughProfit = running;
    // A correction changes P/L at the moment it lands, so it earns a point on
    // the curve rather than rewriting one.
    next.curve = pushCurve(next.curve, running);
  };

  // Corrections first: they restate the past, so applying them before new bets
  // keeps the curve in the order things actually became true.
  for (const row of changed) record(row, { isNew: false });
  // Oldest first, so peak and trough follow the order the bets actually landed.
  for (const row of fresh.slice().reverse()) record(row, { isNew: true });

  if (fresh.length) next.lastBetAt = now;
  if (next.seen.length > SEEN_LIMIT) next.seen = next.seen.slice(-SEEN_LIMIT);
  if (next.log.length > LOG_LIMIT) next.log = next.log.slice(0, LOG_LIMIT);

  // Marks only matter for ids still inside the de-duplication window.
  const live = new Set(next.seen);
  next.marks = Object.fromEntries(Object.entries(marks).filter(([id]) => live.has(id)));

  return { session: next, added: fresh.length, corrected: changed.length, pending, unreadable, skipped: null };
}

// ------------------------------------------------------------ reconciliation

/** Coin-unit slack: bet amounts carry 8 decimals, so this is float noise only. */
const RECONCILE_EPSILON = 1e-6;

/**
 * Record what the wallet says, so the ledger can be checked against it.
 * The first balance seen in a session becomes its opening figure.
 */
/**
 * Record money moved in or out that no bet explains.
 *
 * Without this, one deposit mid-session paints the cross-check permanently red:
 * the wallet went up by 100 and the ledger did not, which is exactly the shape
 * of "bets are missing". Told about the deposit, the check goes back to being
 * the useful thing it is — a claim that the bet list is complete.
 */
export function applyFunds(session, delta, now = Date.now()) {
  if (!session || !Number.isFinite(delta) || delta === 0) return session;
  return { ...session, funded: (session.funded || 0) + delta, fundedAt: now };
}

export function applyBalance(session, value, currency = null, now = Date.now()) {
  if (!session || !Number.isFinite(value)) return session;
  // A balance in a different coin says nothing about this session.
  if (session.currency && currency && session.currency !== currency) return session;

  const next = { ...session, lastBalance: value, balanceAt: now };
  if (!Number.isFinite(session.startBalance)) next.startBalance = value;
  return next;
}

/**
 * How long after a bet the two accounts are allowed to disagree.
 *
 * The wallet is sampled about once a second while bets land continuously, so
 * there is always a window where the stake has left the balance but the row has
 * not appeared yet (or the reverse). Flagging inside that window would fire
 * constantly during normal play and train the warning to be ignored.
 */
const SETTLE_MS = 4000;

/**
 * Two independent accounts of the same session: the bet ledger, and the wallet.
 *
 * Given no deposits, tips or rakeback are taken mid-session, these must agree.
 * A settled disagreement therefore means the ledger missed something real — a
 * bet that scrolled past, or a game whose table this code reads wrongly. This
 * is the check that would have caught the payout-column bug on the very first
 * losing bet.
 *
 * `settling` distinguishes "not yet comparable" from "does not add up", so the
 * UI can stay quiet mid-hand instead of accusing itself every few seconds.
 */
export function reconcile(session, { now = Date.now(), settleMs = SETTLE_MS } = {}) {
  const ledger = sessionProfit(session);

  if (!session || !Number.isFinite(session.startBalance) || !Number.isFinite(session.lastBalance)) {
    return { known: false, ledger, balance: null, drift: null, ok: null, settling: false };
  }

  // Deposits and withdrawals are wallet movement the ledger is never going to
  // account for, so they come off the wallet side before the comparison.
  const balance = session.lastBalance - session.startBalance - (session.funded || 0);
  const drift = balance - ledger;
  const agrees = Math.abs(drift) <= RECONCILE_EPSILON;

  // Comparable only once the last bet has had time to land on both sides, and
  // only if the wallet reading is not older than that bet.
  const quiet = !session.lastBetAt || now - session.lastBetAt > settleMs;
  const fresh = !session.lastBetAt || (session.balanceAt || 0) >= session.lastBetAt;

  return {
    known: true, ledger, balance, drift, ok: agrees,
    funded: session.funded || 0,
    settling: !agrees && (!quiet || !fresh),
  };
}

// -------------------------------------------------------------------- limits

/**
 * Every limit that currently has something to say, as {kind, value, limit, pct}.
 *
 * One place decides what a limit means, so the HUD, the popup and the desktop
 * notice cannot disagree about whether one has been crossed. The three money
 * limits are compared in the target currency — pass the rate for the session's
 * own coin — and the fourth in minutes, which needs no rate at all.
 *
 * Loss and win are one figure read in opposite directions, so only the one that
 * matches which way the session is going is ever returned.
 */
export function limitStatus(session, { settings, rate = null, now = Date.now() } = {}) {
  const out = [];
  if (!session || !settings || session.bets === 0) return out;

  const add = (kind, value, limit) => {
    if (!Number.isFinite(limit) || limit <= 0 || !(value > 0)) return;
    out.push({ kind, value, limit, pct: (value / limit) * 100 });
  };

  // The rate converts into the target currency, so a limit denominated in
  // anything else is not comparable with it. That normally cannot happen — the
  // service worker converts the limits when the target changes — but "normally"
  // is not a good enough reason to compare a shekel figure against euros, which
  // is the one way of getting this wrong that produces no visible symptom.
  const comparable = !settings.limitCurrency || !settings.targetCurrency
    || settings.limitCurrency === settings.targetCurrency;

  if (Number.isFinite(rate) && rate > 0 && comparable) {
    const profit = sessionProfit(session);
    add('wager', session.wagered * rate, settings.limitWager);
    if (profit >= 0) add('win', profit * rate, settings.limitWin);
    else add('loss', -profit * rate, settings.limitLoss);
  }

  add('time', (now - session.startedAt) / 60_000, settings.limitMinutes);
  return out;
}
