// Self-test for the pure logic and the live providers.
// Run with: node tools/selftest.mjs
//
// The DOM-facing half of the extension needs a browser, but parsing, formatting
// and the provider chain are plain functions and there is no excuse for those
// being wrong. Exits non-zero on any failure.

import {
  coinRate, compactMoney, currencyDecimals, currencySymbol, displayDecimals, effectiveRate,
  extractAmount, formatAge, formatMoney, formatNumber, parseAmount,
} from '../src/lib/format.js';
import { fetchRate, pingKey, ratesFromDuel, ratesFromStake } from '../src/lib/rates.js';
import { DEFAULTS, TARGET_CURRENCIES, sanitize } from '../src/lib/settings.js';
import { downsample, plotSeries } from '../src/lib/chart.js';
import { applyBalance, applyFunds, archiveEntry, chaseStatus, emptySession, fiscalYearOf, gamesOf, ingest, isStale, limitStatus, pushCurve, realisedRtp, reconcile, restate, rollSession, sessionProfit, summarise } from '../src/lib/session.js';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
}

console.log('-- parseAmount');
check('grouped', parseAmount('1,234.56'), 1234.56);
check('plain', parseAmount('0.00012345'), 0.00012345);
check('trailing dot', parseAmount('5.'), 5);
check('leading dot', parseAmount('.5'), 0.5);
check('shekel sign', parseAmount('₪1,000'), 1000);
check('trailing shekel sign', parseAmount('250 ₪'), 250);
check('dollar sign', parseAmount('$12.50'), 12.5);
// The limit fields are labelled with whatever the target's mark is, so every
// mark a target can have is what people will type back into them.
check('euro sign', parseAmount('€1,000'), 1000);
check('yen sign', parseAmount('¥1,235'), 1235);
check('pound sign', parseAmount('£20'), 20);
check('an ISO code, which is how en-US writes some currencies', parseAmount('CHF 1,234.50'), 1234.5);
check('and the non-breaking space Intl puts after it', parseAmount('CHF 1,234.50'), 1234.5);
check('not a number', parseAmount('abc'), null);
check('a sign on its own is not a number', parseAmount('₪'), null);
check('empty', parseAmount(''), null);
check('mixed junk', parseAmount('1.2.3'), null);

console.log('\n-- extractAmount');
check('labelled suffix', extractAmount('1,234.56 USDT', false), { value: 1234.56, labeled: true });
check('labelled prefix', extractAmount('$0.50', false), { value: 0.5, labeled: true });
check('usdc counts', extractAmount('12.00 USDC', false), { value: 12, labeled: true });
check('bare number rejected by default', extractAmount('1,234.56', false), null);
check('bare number accepted when asked', extractAmount('1,234.56', true), { value: 1234.56, labeled: false });
check('multiplier is not money', extractAmount('2.55x', false), null);
check('long strings ignored', extractAmount('x'.repeat(70) + ' 5 USDT', false), null);
check('no digits', extractAmount('USDT', false), null);

console.log('\n-- formatting');
check('shekels', formatMoney(1234.5, 'ILS', 2), '₪1,234.50');
check('zero decimals', formatMoney(1234.5, 'ILS', 0), '₪1,235');
check('a bare number carries no symbol', formatNumber(0.5, 2), '0.50');
check('non-finite guarded', formatMoney(NaN, 'ILS', 2), '₪—');

// The same figure in four currencies. Symbol, placement and precision all come
// from Intl, so this is checking that the target is actually reaching it — and
// that en-US grouping survives, which is what keeps a figure readable inside a
// right-to-left panel.
check('euros', formatMoney(1234.5, 'EUR', 2), '€1,234.50');
check('dollars', formatMoney(1234.5, 'USD', 2), '$1,234.50');
check('a currency with no symbol uses its code', formatMoney(1234.5, 'CHF', 2), 'CHF 1,234.50');
check('negatives keep the sign in front', formatMoney(-5, 'EUR', 2), '-€5.00');

// JPY is the case a hardcoded 2 got wrong: there is no half-yen, so the
// "decimal places" setting has nothing to round and does not apply.
check('yen has no minor unit', currencyDecimals('JPY'), 0);
check('and the setting cannot invent one', displayDecimals('JPY', 2), 0);
check('yen prints whole', formatMoney(1234.5, 'JPY', 2), '¥1,235');
check('even asked for eight decimals', formatMoney(1234.5, 'JPY', 8), '¥1,235');
check('the setting still applies where there are decimals', displayDecimals('EUR', 0), 0);
check('and null means the currency decides', displayDecimals('EUR', null), 2);
check('an unknown code does not throw', formatMoney(1, 'ZZZ', 2), 'ZZZ 1.00');

check('the symbol is read, not tabulated', [currencySymbol('ILS'), currencySymbol('EUR'), currencySymbol('JPY')],
  ['₪', '€', '¥']);
check('an em-dash gets a space after an alphabetic mark', formatMoney(NaN, 'CHF', 2), 'CHF —');
check('and none after a sign', formatMoney(NaN, 'JPY', 2), '¥—');

console.log('\n-- effectiveRate');
check('no spread', effectiveRate(3.06, 0), 3.06);
check('1% spread', Number(effectiveRate(3.06, 1).toFixed(4)), 3.0294);
check('null in, null out', effectiveRate(null, 1), null);

console.log('\n-- formatAge');
check('recent', formatAge(Date.now() - 3000), 'just now');
check('minutes', formatAge(Date.now() - 180_000), '3m ago');
check('never', formatAge(null), 'never');

console.log('\n-- session: ingest');
{
  const bet = (id, amount, payout) => ({ id, amount, payout, game: 'Mines' });
  let s = emptySession('USDT', 1000);

  // Rows arrive newest-first, exactly as the table renders them.
  const first = ingest(s, [bet('b2', 1, 3), bet('b1', 1, 0)], { currency: 'USDT' });
  s = first.session;
  check('two new bets counted', first.added, 2);
  check('turnover is the sum of stakes', s.wagered, 2);
  check('returns are the sum of payouts', s.returned, 3);
  check('profit = returned - wagered', sessionProfit(s), 1);
  check('one win one loss', [s.wins, s.losses], [1, 1]);
  check('biggest win is net, not payout', s.biggestWin, 2);
  check('biggest loss is the sunk stake', s.biggestLoss, 1);
  // Ordering matters: processed oldest-first, the loss lands before the win.
  check('trough saw the losing bet first', s.troughProfit, -1);
  check('peak is after the win', s.peakProfit, 1);

  const repeat = ingest(s, [bet('b2', 1, 3), bet('b1', 1, 0)], { currency: 'USDT' });
  check('re-reading the same table adds nothing', repeat.added, 0);
  check('totals unchanged by a repeat read', sessionProfit(repeat.session), 1);

  const mixed = ingest(s, [bet('b3', 0.01, 0)], { currency: 'BTC' });
  check('a currency switch is refused, not summed', [mixed.added, mixed.skipped], [0, 'currency-changed']);

  const full = Array.from({ length: 10 }, (_, i) => bet('g' + i, 1, 0));
  const gapped = ingest(s, full, { currency: 'USDT', tableFull: true });
  check('a wholly unrecognised full table flags a gap', gapped.session.gaps, 1);

  const seeded = ingest(emptySession('USDT', 1000), [bet('x1', 5, 0)], { currency: 'USDT' });
  check('a fresh session still counts its first bet', seeded.added, 1);

  // A stake the scraper could not read used to be booked as zero: one bet, no
  // turnover, no profit, filed as a loss because a zero payout is a loss. A
  // winning session could read as flat that way, which is what this is here to
  // stop from ever happening again.
  const unreadable = ingest(emptySession('USDT', 1000), [bet('u1', null, 0.4)], { currency: 'USDT' });
  check('a row with an unreadable stake is not counted', unreadable.added, 0);
  check('and is reported rather than dropped in silence', unreadable.unreadable, 1);
  check('no phantom bet is booked', unreadable.session.bets, 0);
  check('and it is left unseen, so it counts once it can be read',
    ingest(unreadable.session, [bet('u1', 0.2, 0.4)], { currency: 'USDT' }).added, 1);
}

console.log('\n-- session: Stake\'s payout column');
{
  // Rows copied verbatim from a live Mines table. The Payout column is the
  // gross credit on a win but the negative debit on a loss — the shape that
  // made every session read worse than it was.
  const row = (id, amount, payout) => ({ id, amount, payout, game: 'Mines' });
  const round = (n) => +Number(n).toFixed(8);

  // Newest first, exactly as the table renders: n1 is the most recent bet.
  const live = [
    row('n1', 0.2, -0.2),          // lost, mult 0.00× — payout column goes negative
    row('n2', 0.2, 0.225),         // won,  mult 1.13× — payout column is gross
    row('n3', 0.2, -0.2),
    row('n4', 0.2, 0.4125),        // won,  mult 2.06×
  ];

  const s = ingest(emptySession('USDT', 1000), live, { currency: 'USDT' }).session;

  check('a lost stake is charged once, not twice', round(sessionProfit(s)), -0.1625);
  check('turnover counts every stake', round(s.wagered), 0.8);
  check('returns never go negative', round(s.returned), 0.6375);
  check('a negative payout is a loss', [s.wins, s.losses], [2, 2]);
  check('biggest loss is the stake, not double it', round(s.biggestLoss), 0.2);
  check('biggest win is net of the stake', round(s.biggestWin), 0.2125);

  // The plain case that first exposed it: three losing 0.2 bets and nothing else.
  const threeLosses = ingest(emptySession('USDT', 1000),
    [row('a', 0.2, -0.2), row('b', 0.2, -0.2), row('c', 0.2, -0.2)], { currency: 'USDT' }).session;
  check('three lost 0.2 bets is -0.6, not -1.2', round(sessionProfit(threeLosses)), -0.6);
  check('and 0.6 wagered', round(threeLosses.wagered), 0.6);

  check('every counted bet is logged', s.log.length, 4);
  check('the log leads with the newest bet', s.log[0].id, 'n1');
  check('a logged loss stores gross 0, not the raw column', s.log[0].gross, 0);
  check('a logged loss costs one stake', round(s.log[0].profit), -0.2);
  check('a logged win keeps its gross', round(s.log[1].gross), 0.225);
  check('a logged win is net of the stake', round(s.log[1].profit), 0.025);
}

console.log('\n-- session: unsettled bets');
{
  const bet = (id, amount, payout, settled) => ({ id, amount, payout, settled, game: 'Sport' });
  const round = (n) => +Number(n).toFixed(8);

  // A pending row must not be counted AND must not be marked seen, or it would
  // never be counted once it settles.
  const first = ingest(emptySession('USDT', 1000), [bet('p1', 1, null, false)], { currency: 'USDT' });
  check('an unsettled bet is not counted', first.added, 0);
  check('an unsettled bet is reported as pending', first.pending, 1);
  // The load-bearing part: not marked seen, so it is still eligible later.
  check('an unsettled bet is not marked as seen', first.session.seen.includes('p1'), false);
  check('an unsettled bet adds no turnover', first.session.wagered, 0);

  // Now it settles, on a session that has already seen the pending row once.
  const settled = ingest(first.session, [bet('p1', 1, 2.5, true)], { currency: 'USDT' });
  check('it counts once it settles', settled.added, 1);
  check('and with the right profit', round(sessionProfit(settled.session)), 1.5);

  // A numeric zero is NOT pending — only Mines was confirmed to write losses
  // negative, so treating 0 as unsettled could drop every loss in some game.
  const zero = ingest(emptySession('USDT', 1000), [bet('z1', 1, 0, true)], { currency: 'USDT' });
  check('a zero payout still counts as a resolved loss', zero.added, 1);
  check('and costs one stake', round(sessionProfit(zero.session)), -1);
}

console.log('\n-- session: corrections');
{
  const bet = (id, amount, payout) => ({ id, amount, payout, settled: true, game: 'Mines' });
  const round = (n) => +Number(n).toFixed(8);

  // Counted as a loss, then the row changes to a win — the case that used to be
  // locked in forever by de-duplication.
  const asLoss = ingest(emptySession('USDT', 1000), [bet('c1', 0.2, -0.2)], { currency: 'USDT' }).session;
  check('first read books a loss', round(sessionProfit(asLoss)), -0.2);

  const fixed = ingest(asLoss, [bet('c1', 0.2, 0.5)], { currency: 'USDT' });
  check('a changed row is a correction, not a new bet', [fixed.added, fixed.corrected], [0, 1]);
  check('the bet count does not double', fixed.session.bets, 1);
  check('profit is restated', round(sessionProfit(fixed.session)), 0.3);
  check('turnover is not double-counted', round(fixed.session.wagered), 0.2);
  check('the loss column gives the bet back', [fixed.session.wins, fixed.session.losses], [1, 0]);
  check('the log entry is restated too', round(fixed.session.log[0].profit), 0.3);
  check('and marked as corrected', fixed.session.log[0].corrected, true);

  // Re-reading an unchanged table must stay a no-op.
  const again = ingest(fixed.session, [bet('c1', 0.2, 0.5)], { currency: 'USDT' });
  check('an unchanged row corrects nothing', [again.added, again.corrected], [0, 0]);

  // A bet counted by an older build carries no mark; there is nothing to unwind.
  const unmarked = { ...asLoss, marks: {} };
  const skipped = ingest(unmarked, [bet('c1', 0.2, 0.5)], { currency: 'USDT' });
  check('a bet with no recorded mark is left alone', [skipped.added, skipped.corrected], [0, 0]);
}

console.log('\n-- session: balance cross-check');
{
  const bet = (id, amount, payout) => ({ id, amount, payout, settled: true, game: 'Mines' });
  const round = (n) => +Number(n).toFixed(8);

  // Every clock here is explicit. They used to default to Date.now(), which
  // made "long after the last bet" zero milliseconds after it — so the case
  // this section exists to prove was never actually being run.
  const T0 = 1_000_000;
  const LATER = T0 + 60_000;

  let s = emptySession('USDT', T0);
  check('no reading means no verdict', reconcile(s).known, false);

  s = applyBalance(s, 10, 'USDT', T0);
  check('the first reading opens the books', s.startBalance, 10);

  // Two losing 0.2 bets: wallet should be down 0.4.
  s = ingest(s, [bet('a', 0.2, -0.2), bet('b', 0.2, -0.2)], { currency: 'USDT', now: T0 + 1000 }).session;
  s = applyBalance(s, 9.6, 'USDT', T0 + 2000);

  const agreed = reconcile(s, { now: LATER });
  check('ledger and wallet agree', agreed.ok, true);
  check('both read the same move', [round(agreed.ledger), round(agreed.balance)], [-0.4, -0.4]);

  // A bet the table never showed. With no funds moving mid-session there is no
  // other explanation, so this is a fault rather than an ambiguity.
  const drifted = reconcile(applyBalance(s, 12, 'USDT', T0 + 3000), { now: LATER });
  check('an unexplained gain is flagged', drifted.ok, false);
  check('and the drift is quantified', round(drifted.drift), 2.4);
  check('a mismatch long after the last bet is settled, not settling', drifted.settling, false);

  // Deposits are wallet movement no bet will ever explain. Told about one, the
  // check goes back to being a claim about the bet list.
  const deposited = applyFunds(applyBalance(s, 12, 'USDT', T0 + 3000), 2.4, T0 + 2500);
  const afterDeposit = reconcile(deposited, { now: LATER });
  check('a logged deposit clears the drift', afterDeposit.ok, true);
  check('and is reported alongside the verdict', afterDeposit.funded, 2.4);
  check('the wallet move is stated net of it', round(afterDeposit.balance), -0.4);
  check('a withdrawal is the same gesture with the other sign',
    applyFunds(deposited, -2.4, T0 + 2600).funded, 0);
  check('a zero move is not a move', applyFunds(s, 0), s);

  // Mid-hand: the stake has left the wallet but the row has not appeared. This
  // must NOT read as a fault or it would fire every few seconds during play.
  const midHand = { ...s, lastBetAt: 10_000, balanceAt: 10_500, lastBalance: 9.4 };
  const inFlight = reconcile(midHand, { now: 11_000 });
  check('a mismatch moments after a bet is still settling', [inFlight.ok, inFlight.settling], [false, true]);
  check('the same mismatch is a fault once it has had time to land',
    reconcile(midHand, { now: 30_000 }).settling, false);

  // A wallet reading older than the last bet cannot judge that bet either.
  const staleRead = { ...s, lastBetAt: 20_000, balanceAt: 10_000, lastBalance: 9.4 };
  check('a wallet reading older than the last bet is not conclusive',
    reconcile(staleRead, { now: 60_000 }).settling, true);

  // A balance in another coin says nothing about a USDT session.
  check('a foreign-coin reading is ignored', applyBalance(s, 999, 'BTC').lastBalance, 9.6);

  const rolled = rollSession(s, 2000);
  check('a new session opens at the closing balance', rolled.startBalance, 9.6);
  check('and starts reconciled', reconcile(rolled).ok, true);
}

console.log('\n-- session: curve and chart');
{
  const row = (id, amount, payout) => ({ id, amount, payout, game: 'Mines' });
  const s = ingest(emptySession('USDT', 1000),
    [row('n1', 0.2, -0.2), row('n2', 0.2, 0.4)], { currency: 'USDT' }).session;
  // Oldest first: +0.2 then -0.2 cumulative.
  check('curve records running profit per bet', s.curve.map((v) => +v.toFixed(8)), [0.2, 0]);

  // Halving must keep the newest point — a curve whose last value is not the
  // current P/L would draw a line that disagrees with the number beside it.
  let curve = [];
  for (let i = 1; i <= 241; i++) curve = pushCurve(curve, i);
  check('the curve halves rather than growing forever', curve.length, 121);
  check('halving keeps the newest point', curve[curve.length - 1], 241);
  check('halving keeps the oldest point', curve[0], 1);

  const plot = plotSeries([0, 1, -1, 2], { width: 200, height: 32 });
  check('path starts with a move', plot.line.startsWith('M'), true);
  check('one segment per point', plot.line.split(/[ML]/).length - 1, 4);
  check('zero baseline sits inside the box', plot.zeroY > 0 && plot.zeroY < 32, true);
  // The fill closes along the baseline, not the floor of the box: the area it
  // encloses is the profit or the loss itself.
  check('the area closes on the baseline', plot.area.endsWith(`L0,${plot.zeroY} Z`), true);
  check('a session that only ever won still shows its baseline',
    plotSeries([0, 5], { width: 200, height: 32 }).zeroY, 26);
  check('a flat series still places zero', plotSeries([5, 5], { width: 200, height: 32 }).zeroY > 0, true);
  check('a single point draws nothing', plotSeries([1], { width: 200, height: 32 }), null);
  check('an empty series draws nothing', plotSeries([], { width: 200, height: 32 }), null);

  // Archiving thins the curve. The ends are where the printed figures come
  // from, so they are the two points that must survive.
  const long = Array.from({ length: 500 }, (_, i) => i);
  check('a long curve is thinned', downsample(long, 60).length, 60);
  check('the first point survives', downsample(long, 60)[0], 0);
  check('and so does the last, which is the final P/L', downsample(long, 60).at(-1), 499);
  check('a short curve is left alone', downsample([1, 2, 3], 60), [1, 2, 3]);
  check('nothing is not a curve', downsample(null, 60), []);
}

console.log('\n-- session: recording');
{
  const bet = (id, amount, payout) => ({ id, amount, payout, game: 'Mines' });
  const played = ingest(emptySession('USDT', 1000), [bet('a2', 1, 3), bet('a1', 1, 0)], { currency: 'USDT' }).session;

  const entry = archiveEntry(played, { endedAt: 5000, rate: 3.01 });
  check('archive drops de-duplication scaffolding', entry.seen, undefined);
  check('archive freezes profit', entry.profit, 1);
  check('archive freezes the rate of the day', entry.rateAtClose, 3.01);
  check('archive keeps turnover', entry.wagered, 2);
  check('a null rate stays null, not NaN', archiveEntry(played, { rate: null }).rateAtClose, null);

  const now = 1000 + 31 * 60_000;
  check('an idle session is stale', isStale({ ...played, lastBetAt: 1000 }, 30, now), true);
  check('a busy session is not', isStale({ ...played, lastBetAt: now - 60_000 }, 30, now), false);
  check('an empty session never goes stale', isStale(emptySession('USDT', 1000), 30, now), false);

  const rolled = rollSession(played, now);
  check('a rolled session starts at zero', [rolled.bets, rolled.wagered, rolled.returned], [0, 0, 0]);
  check('a rolled session keeps the coin', rolled.currency, 'USDT');
  // Without this the ten rows still on screen would be counted a second time.
  check('a rolled session inherits bet ids', rolled.seen, played.seen);
  check('re-reading the table after a roll adds nothing',
    ingest(rolled, [bet('a2', 1, 3), bet('a1', 1, 0)], { currency: 'USDT' }).added, 0);

  check('an archive with no snapshot says so rather than half-carrying one',
    [archiveEntry(played, { rate: 3.01, target: 'ILS' }).snap,
      archiveEntry(played, { rate: 3.01, target: 'ILS', usd: 1 }).snap], [null, null]);

  const totals = summarise([entry, { ...entry, currency: 'BTC', profit: -0.5, wagered: 1, bets: 2, wins: 0, losses: 2, returned: 0.5 }]);
  check('totals are grouped by coin', Object.keys(totals).sort(), ['BTC', 'USDT']);
  check('USDT bucket is untouched by the BTC one', totals.USDT.profit, 1);
  check('BTC bucket sums separately', totals.BTC.profit, -0.5);
}

console.log('\n-- session: restating a closed session');
{
  const bet = (id, amount, payout) => ({ id, amount, payout, game: 'Mines' });
  const round = (n, digits = 4) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : n);

  // One evening: two USDT bets, +1 USDT, closed while the target was shekels.
  // A tether was $0.9995 and a dollar bought 3.05 shekels or 0.92 euros, so the
  // shekel rate stored with it is 0.9995 × 3.05.
  const played = ingest(emptySession('USDT', 1000), [bet('a2', 1, 3), bet('a1', 1, 0)], { currency: 'USDT' }).session;
  const USD = 0.9995;
  const FIAT = { ILS: 3.05, EUR: 0.92, JPY: 150, USD: 1 };

  const closed = archiveEntry(played, {
    endedAt: 5000, rate: USD * FIAT.ILS, target: 'ILS', usd: USD, fiat: FIAT, fiatAt: 4000, fee: 0,
  });

  check('the snapshot is marked with its schema', closed.snap, 1);
  check('and names the currency it closed in', closed.closeTarget, 'ILS');

  // Read back in the currency it closed in, this must be the frozen figure and
  // nothing recomputed — the same number to the last decimal.
  const asIls = restate(closed, closed.profit, 'ILS');
  check('read in the currency it closed in, the frozen figure is handed back',
    asIls.value, closed.profit * closed.rateAtClose);
  check('and it is not marked as restated', asIls.restated, false);

  // Read in another, from the prices that applied that evening — never today's.
  const asEur = restate(closed, closed.profit, 'EUR');
  check('read in another currency, it comes off the stored table',
    round(asEur.value), round(1 * USD * FIAT.EUR));
  check('and says it was restated', asEur.restated, true);
  check('a zero-decimal currency restates like any other',
    round(restate(closed, closed.profit, 'JPY').value), round(1 * USD * FIAT.JPY));
  check('and the dollar is not a special case', round(restate(closed, closed.profit, 'USD').value), round(USD));

  // The off-ramp spread that applied then applies to the restatement too, or
  // the two views would disagree about what you would actually have received.
  const withSpread = archiveEntry(played, {
    rate: USD * FIAT.ILS * 0.98, target: 'ILS', usd: USD, fiat: FIAT, fee: 2,
  });
  check('the spread at close rides along', round(restate(withSpread, 1, 'EUR').value),
    round(USD * FIAT.EUR * 0.98));
  check('and the closing currency still reads its own frozen rate',
    restate(withSpread, 1, 'ILS').value, withSpread.rateAtClose);

  // A currency the stored table did not carry is a dash, not a guess.
  check('a currency missing from the stored table has no figure',
    restate(closed, 1, 'BRL'), { value: null, restated: false, reason: 'no-cross-rate' });

  // The whole point of the schema marker: an entry recorded before any of this
  // existed knows only shekels, and says so instead of being back-computed.
  const legacy = { rateAtClose: 3.05, profit: 1 };
  check('a pre-multi-currency entry still reads in shekels', restate(legacy, 1, 'ILS').value, 3.05);
  check('and refuses every other currency, naming why',
    restate(legacy, 1, 'EUR'), { value: null, restated: false, reason: 'legacy' });

  // A session that closed with no rate at all has no figure in any currency,
  // and that is a different complaint from "cannot be restated".
  const unpriced = archiveEntry(played, { rate: null, target: 'ILS' });
  check('a session closed with no rate says that instead',
    restate(unpriced, 1, 'ILS').reason, 'no-rate');
}

console.log('\n-- the tax year');
{
  // Local time, because a tax year is a local calendar thing: a session played
  // on the evening of 5 April is in that tax year wherever the servers are.
  const on = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

  check('January is the calendar year, named after it',
    fiscalYearOf(on(2025, 3, 14), 1), { year: 2025, label: '2025' });
  check('and December is still that year',
    fiscalYearOf(on(2025, 12, 31), 1), { year: 2025, label: '2025' });

  // The UK: 6 April, rounded to the month, so April onwards is the new year.
  check('April: a date before it belongs to the year before',
    fiscalYearOf(on(2025, 3, 31), 4), { year: 2024, label: '2024/25' });
  check('April: the first of the month opens the new one',
    fiscalYearOf(on(2025, 4, 1), 4), { year: 2025, label: '2025/26' });
  check('April: and the far side of it is the same year',
    fiscalYearOf(on(2026, 3, 1), 4).label, '2025/26');

  // Australia: July, and the label rolls over a century without printing "100".
  check('July groups the second half of the calendar year forward',
    fiscalYearOf(on(2025, 8, 1), 7), { year: 2025, label: '2025/26' });
  check('and the turn of a century still reads as two years',
    fiscalYearOf(on(2099, 8, 1), 7).label, '2099/00');

  check('a month outside 1-12 falls back to January', fiscalYearOf(on(2025, 3, 14), 0).label, '2025');
  check('and so does nonsense', fiscalYearOf(on(2025, 3, 14), 'x').label, '2025');

  const month = (v) => sanitize({ fiscalYearStart: v }).fiscalYearStart;
  check('the setting clamps to a real month', [month(0), month(13), month('4')], [1, 12, 4]);
  check('and defaults to January, which is what this reported before',
    DEFAULTS.fiscalYearStart, 1);
}

console.log('\n-- settings: limits');
{
  const limit = (v) => sanitize({ limitWin: v }).limitWin;
  check('a number is kept', limit('50'), 50);
  check('a decimal is kept', limit('12.5'), 12.5);
  // The field is labelled in shekels, so these are what people actually type.
  // Number() reads every one of them as NaN, which cleared the limit while the
  // UI said it had been saved.
  check('grouping is kept', limit('1,000'), 1000);
  check('a shekel sign is kept', limit('₪1,000'), 1000);
  check('a trailing shekel sign is kept', limit('750 ₪'), 750);
  check('a plain number survives as a number', limit(2500), 2500);
  check('blank clears', limit(''), null);
  check('null clears', limit(null), null);
  // Zero and negatives are not limits; without this a stray "0" would read as
  // "limit reached" the instant the session started.
  check('zero is not a limit', limit('0'), null);
  check('negative is not a limit', limit('-5'), null);
  check('nonsense is not a limit', limit('abc'), null);
  check('all three limits sanitise', Object.keys(sanitize({ limitWager: '1', limitLoss: '0', limitWin: 'x' })).sort(),
    ['limitLoss', 'limitWager', 'limitWin']);
  check('defaults ship with limits off',
    [DEFAULTS.limitWager, DEFAULTS.limitLoss, DEFAULTS.limitWin], [null, null, null]);
}

console.log('\n-- settings: target currency');
{
  const target = (v) => sanitize({ targetCurrency: v }).targetCurrency;
  check('a supported code is kept', target('EUR'), 'EUR');
  check('lower case is normalised', target('jpy'), 'JPY');
  check('an unsupported code falls back to the default', target('XYZ'), 'ILS');
  check('blank falls back too', target(''), 'ILS');
  check('the default ships as ILS, so nobody upgrades into a different currency',
    DEFAULTS.targetCurrency, 'ILS');
  check('the default is itself in the list', TARGET_CURRENCIES.includes(DEFAULTS.targetCurrency), true);
  // The limits' own tag goes through the same validation, and ships agreeing
  // with the target — a fresh install has nothing to convert.
  check('the limit tag is validated the same way', sanitize({ limitCurrency: 'nope' }).limitCurrency, 'ILS');
  check('and ships agreeing with the target', DEFAULTS.limitCurrency, DEFAULTS.targetCurrency);
  // Every code is fed to Intl.NumberFormat and to provider query strings, so a
  // typo here would be a currency that formats as its own code and prices as
  // nothing.
  check('every code is a well-formed ISO 4217 alpha code',
    TARGET_CURRENCIES.filter((code) => !/^[A-Z]{3}$/.test(code)), []);
  check('and the list is sorted and free of duplicates',
    TARGET_CURRENCIES.join(','), [...new Set(TARGET_CURRENCIES)].sort().join(','));
}

console.log('\n-- settings: time limit');
{
  const minutes = (v) => sanitize({ limitMinutes: v }).limitMinutes;
  check('whole minutes are kept', minutes('90'), 90);
  check('fractions round to a minute', minutes('90.4'), 90);
  check('under a minute is not a limit', minutes('0.4'), null);
  check('a day is the ceiling', minutes('5000'), 1440);
  check('blank clears', minutes(''), null);
  check('defaults ship with the time limit off', DEFAULTS.limitMinutes, null);
}

console.log('\n-- limits: what has crossed');
{
  const now = 5_000_000;
  const settings = { ...DEFAULTS, limitWager: 100, limitLoss: 50, limitWin: 40, limitMinutes: 60 };
  const base = { ...emptySession('USDT', now - 30 * 60_000), bets: 4 };

  const up = { ...base, wagered: 10, returned: 30 };   // +20 coin
  const status = limitStatus(up, { settings, rate: 3, now });
  const byKind = Object.fromEntries(status.map((l) => [l.kind, Math.round(l.pct)]));
  check('wager is measured in shekels', byKind.wager, 30);   // 10 * 3 of 100
  check('a session in profit measures the win target', byKind.win, 150); // 20 * 3 of 40
  check('and says nothing about the loss limit', 'loss' in byKind, false);
  check('time is measured without a rate', byKind.time, 50);

  const down = { ...base, wagered: 10, returned: 0 };
  const losing = Object.fromEntries(limitStatus(down, { settings, rate: 3, now }).map((l) => [l.kind, Math.round(l.pct)]));
  check('a losing session measures the loss limit', losing.loss, 60);  // 10 * 3 of 50
  check('and says nothing about the win target', 'win' in losing, false);

  // A coin the providers did not price cannot be held to a shekel figure, but
  // minutes are minutes.
  const unpriced = limitStatus(up, { settings, rate: null, now }).map((l) => l.kind);
  check('no rate means only the time limit applies', unpriced, ['time']);

  check('a session with no bets has nothing to report',
    limitStatus({ ...base, bets: 0 }, { settings, rate: 3, now }).length, 0);
  check('limits that are off report nothing',
    limitStatus(up, { settings: DEFAULTS, rate: 3, now }).length, 0);

  // A limit denominated in one currency and a session measured in another are
  // not comparable, and the failure mode is silent: the numbers still divide,
  // they just mean nothing. Held out until the tag agrees with the target.
  const mismatched = { ...settings, limitCurrency: 'ILS', targetCurrency: 'EUR' };
  check('a limit in another currency is not compared against the target',
    limitStatus(up, { settings: mismatched, rate: 3, now }).map((l) => l.kind), ['time']);
  check('and comes back the moment the tag agrees again',
    limitStatus(up, { settings: { ...mismatched, limitCurrency: 'EUR' }, rate: 3, now }).map((l) => l.kind).sort(),
    ['time', 'wager', 'win']);
}

console.log('\n-- coin rates');
{
  const rate = { effective: 3.7, coins: { BTC: 400_000, ETH: 12_000 } };
  check('USDT is the headline rate', coinRate(rate, 'USDT'), 3.7);
  check('so is an unlabelled amount', coinRate(rate, null), 3.7);
  check('USDC is treated as a dollar', coinRate(rate, 'USDC'), 3.7);
  check('BTC gets its own quote', coinRate(rate, 'BTC'), 400_000);
  check('an unpriced coin is null, not the USDT rate', coinRate(rate, 'LTC'), null);
  check('no coins at all is null', coinRate({ effective: 3.7 }, 'BTC'), null);
}

console.log("\n-- Stake's own price table");
{
  // Both readings of the same market: 1 USD ≈ 3.7 ILS, BTC ≈ $100k. Which way
  // round Stake sends it is not documented, so both are accepted and the wrong
  // one is not silently used — that would produce the reciprocal rate, 0.27
  // shekels to the dollar, and every figure in the extension would be wrong.
  const perUnit = [ // baseRate = dollars for one unit
    { currency: 'usdt', baseRate: 1 },
    { currency: 'ils', baseRate: 0.27 },
    { currency: 'btc', baseRate: 100_000 },
  ];
  const perDollar = [ // baseRate = units for one dollar
    { currency: 'usdt', baseRate: 1 },
    { currency: 'ils', baseRate: 3.7037 },
    { currency: 'btc', baseRate: 0.00001 },
  ];

  const round = (n, digits = 2) => (n === null ? null : Number(n.toFixed(digits)));

  const a = ratesFromStake(perUnit);
  check('dollars-per-unit is recognised', a.orientation, 'per-unit');
  check('and gives shekels per USDT', round(a.rate), 3.7);
  check('and prices BTC in shekels', round(a.coins.BTC, 0), 370_370);

  const b = ratesFromStake(perDollar);
  check('units-per-dollar is recognised', b.orientation, 'per-dollar');
  check('and gives the same rate, not its reciprocal', round(b.rate), 3.7);
  check('and prices BTC the same way up', round(b.coins.BTC, 0), 370_370);

  check('tickers come back upper-cased', Object.keys(a.coins).sort(), ['BTC', 'ILS', 'USDT']);
  check('a currency prices itself at 1', round(a.coins.ILS, 4), 1);

  // Every way the table can fail to be readable refuses rather than guesses.
  check('no ILS row is unusable', ratesFromStake(perUnit.filter((r) => r.currency !== 'ils')), null);
  check('no USDT row is unusable', ratesFromStake(perUnit.filter((r) => r.currency !== 'usdt')), null);
  check('no BTC row leaves the orientation unknowable',
    ratesFromStake(perUnit.filter((r) => r.currency !== 'btc')), null);
  check('an ambiguous BTC is refused',
    ratesFromStake([{ currency: 'usdt', baseRate: 1 }, { currency: 'ils', baseRate: 0.27 }, { currency: 'btc', baseRate: 3 }]), null);
  check('junk in the rows is dropped, not parsed',
    ratesFromStake([{ currency: 'usdt', baseRate: 'x' }, { currency: 'ils', baseRate: 0.27 }, { currency: 'btc', baseRate: 100_000 }]), null);
  check('nothing at all is null', ratesFromStake(null), null);
  check('an empty table is null', ratesFromStake([]), null);

  // USD or USDC standing in for a missing USDT row, since all three are the
  // same dollar as far as a converted figure is concerned.
  const noTether = [
    { currency: 'usd', baseRate: 1 },
    { currency: 'ils', baseRate: 0.27 },
    { currency: 'btc', baseRate: 100_000 },
  ];
  check('USD stands in for USDT', round(ratesFromStake(noTether).rate), 3.7);
}

console.log("\n-- Stake's price table, in every target");
{
  const round = (n, digits = 2) => (n === null ? null : Number(n.toFixed(digits)));

  // Exact reciprocals, so the two orientations of the same market have to give
  // the same answer to the last decimal rather than to a rounding.
  const RATE = { ILS: 3.7, EUR: 0.92, USD: 1, JPY: 150 }; // units per dollar
  const BTC_USD = 100_000;

  const perDollar = (fiat) => [
    { currency: 'usdt', baseRate: 1 },
    { currency: fiat.toLowerCase(), baseRate: RATE[fiat] },
    { currency: 'btc', baseRate: 1 / BTC_USD },
  ];
  const perUnit = (fiat) => [
    { currency: 'usdt', baseRate: 1 },
    { currency: fiat.toLowerCase(), baseRate: 1 / RATE[fiat] },
    { currency: 'btc', baseRate: BTC_USD },
  ];

  // The orientation anchor is the target against BTC, and every fiat there is
  // sits at least four orders of magnitude away from a bitcoin in whichever
  // direction the table runs. The yen is the interesting one: 150 to the dollar
  // is where a check anchored on the dollar's own magnitude would get closest.
  for (const fiat of ['ILS', 'EUR', 'USD', 'JPY']) {
    const up = ratesFromStake(perUnit(fiat), fiat);
    const down = ratesFromStake(perDollar(fiat), fiat);

    check(`${fiat}: dollars-per-unit is recognised`, up.orientation, 'per-unit');
    check(`${fiat}: units-per-dollar is recognised`, down.orientation, 'per-dollar');
    check(`${fiat}: both give the same USDT rate`, [round(up.rate, 6), round(down.rate, 6)],
      [RATE[fiat], RATE[fiat]]);
    check(`${fiat}: and the same BTC price`, [round(up.coins.BTC, 4), round(down.coins.BTC, 4)],
      [round(BTC_USD * RATE[fiat], 4), round(BTC_USD * RATE[fiat], 4)]);
    check(`${fiat}: the reading says what it is quoted in`, up.target, fiat);
  }

  // A table that carries no row for the target is refused *for that target*.
  // The providers answer instead; nothing about the coins is thrown away for
  // anybody else, and no rate is derived from a currency nobody asked for.
  check('a target the table does not carry is refused', ratesFromStake(perDollar('ILS'), 'JPY'), null);
  check('and a lower-case target still matches its row', ratesFromStake(perDollar('EUR'), 'eur').target, 'EUR');
}

console.log('\n-- Duel’s price table');
{
  const round = (n, digits = 2) => (n === null ? null : Number(n.toFixed(digits)));

  // The shape as it comes off /api/v2/metadata/exchange-rates, cut down to the
  // rows that matter. Two tables quoted against different things: fiat per EUR,
  // coins per USD. Values are the real ones, so the arithmetic below is the
  // arithmetic that has to hold on the live site.
  const payload = {
    base: 'EUR',
    rates: { EUR: 1, USD: 1.1535, ILS: 3.5194, GBP: 0.85633 },
    crypto_rates: {
      101: '0.000015702235370227', // BTC
      105: '1.001291666249461805', // USDT
      111: '14.239841652960819075', // DOGE
    },
  };

  const duel = ratesFromDuel(payload);

  // ILS/EUR ÷ USD/EUR = 3.5194 / 1.1535 = 3.0511 shekels to the dollar, and a
  // tether is a hair under one, so the USDT rate lands a hair under that.
  check('the two tables reconcile onto the dollar', round(duel.rate, 3), 3.047);
  check('and read as units per dollar', duel.orientation, 'per-dollar');
  check('BTC is priced in shekels', round(duel.coins.BTC, 0), 194_307);
  check('so is a coin worth fractions of a cent', round(duel.coins.DOGE, 4), 0.2143);
  check('ids became tickers', Object.keys(duel.coins).sort(), ['BTC', 'DOGE', 'ILS', 'USDT']);

  // Same refusals as the Stake reader, since it is the same reader underneath.
  check('no ILS row is unusable', ratesFromDuel({ ...payload, rates: { USD: 1.1535 } }), null);
  check('no USD row leaves ILS unquotable', ratesFromDuel({ ...payload, rates: { ILS: 3.5194 } }), null);
  check('no coins at all is unusable', ratesFromDuel({ ...payload, crypto_rates: {} }), null);
  check('a Stake table is not a Duel one',
    ratesFromDuel([{ currency: 'usdt', baseRate: 1 }, { currency: 'ils', baseRate: 3.7 }]), null);
  check('nothing at all is null', ratesFromDuel(null), null);

  // An id this does not know about is dropped rather than named after whatever
  // happens to sit at that number next season.
  const withStranger = { ...payload, crypto_rates: { ...payload.crypto_rates, 999: '2' } };
  check('an unknown currency id is dropped', Object.keys(ratesFromDuel(withStranger).coins).includes('999'), false);

  // Duel quotes its fiat against the euro, so every target has to be put on the
  // dollar first — including the euro itself, and including the dollar, whose
  // rows are the two the normalisation is written in terms of.
  const eur = ratesFromDuel(payload, 'EUR');
  check('EUR: the euro is normalised onto the dollar like any other target',
    round(eur.rate, 4), round((1 / 1.1535) / 1.001291666249461805, 4));
  check('EUR: and BTC comes out in euros', round(eur.coins.BTC, 0), 55_210);

  const usd = ratesFromDuel(payload, 'USD');
  check('USD: a tether is a hair under a dollar', round(usd.rate, 4), 0.9987);
  check('USD: and a bitcoin is a bitcoin', round(usd.coins.BTC, 0), 63_685);

  check('GBP: a target Duel does carry is read', round(ratesFromDuel(payload, 'GBP').rate, 4), 0.7414);

  // The refusal that matters for multi-currency: Duel's fiat half is not the
  // whole ISO list, and a target missing from it falls through to the providers
  // rather than being derived from some other currency's row.
  check('a target Duel does not quote is refused', ratesFromDuel(payload, 'JPY'), null);
  check('and the same payload still reads for one it does', ratesFromDuel(payload, 'ILS').target, 'ILS');
}

console.log('\n-- badge');
{
  check('small figures keep a decimal', compactMoney(4.25), '4.3');
  check('two digits round', compactMoney(84.4), '84');
  check('thousands compact', compactMoney(1234), '1.2k');
  check('tens of thousands drop the decimal', compactMoney(42_000), '42k');
  check('losses carry the sign', compactMoney(-320), '-320');
  check('nothing to show is empty', compactMoney(null), '');
}

console.log('\n-- loss chasing');
{
  // A session that opened at `open` and has been betting `now` since, with a
  // running P/L of `profit`. Built through ingest so the opening baseline is
  // accumulated the way a real session accumulates it.
  const play = (open, openCount, now, nowCount, { win = 0 } = {}) => {
    let s = emptySession('USDT', 1000);
    let at = 1000;
    for (let i = 0; i < openCount; i++) {
      at += 1000;
      s = ingest(s, [{ id: `o${i}`, source: 'round', game: 'Mines', amount: open, payout: 0 }],
        { currency: 'USDT', now: at }).session;
    }
    for (let i = 0; i < nowCount; i++) {
      at += 1000;
      s = ingest(s, [{ id: `n${i}`, source: 'round', game: 'Mines', amount: now, payout: i < win ? now * 4 : 0 }],
        { currency: 'USDT', now: at }).session;
    }
    return s;
  };

  // The case it exists for: opened at 0.1, now betting 0.5, and down.
  const chasing = play(0.1, 10, 0.5, 15);
  const flag = chaseStatus(chasing);
  check('a session that escalated while losing is flagged', Boolean(flag), true);
  check('reporting what it opened at', Number(flag.opening.toFixed(4)), 0.1);
  check('and what it is betting now', Number(flag.recent.toFixed(4)), 0.5);
  check('and by how much', Number(flag.multiple.toFixed(1)), 5);
  check('and how far down it is', flag.down > 0, true);

  // Everything that must NOT fire, because a detector that cries wolf is one
  // nobody reads by the second week.
  check('steady stakes are not chasing', chaseStatus(play(0.1, 10, 0.1, 15)), null);
  check('a mild rise is not chasing', chaseStatus(play(0.1, 10, 0.15, 15)), null);
  check('doubling is not enough on its own', chaseStatus(play(0.1, 10, 0.2, 15)), null);

  // The one that matters most: raising stakes while *ahead* is something else
  // entirely, and calling it chasing would be wrong about the player in a way
  // that makes the whole feature ignorable.
  const winning = play(0.1, 10, 0.5, 15, { win: 15 });
  check('a session that is up is never chasing', sessionProfit(winning) > 0 && chaseStatus(winning), null);

  // Too early to say anything. Ten bets in, an escalation is a mood.
  check('a short session says nothing', chaseStatus(play(0.1, 10, 0.5, 2)), null);

  // The baseline is the first ten bets, whatever they were — so a session that
  // escalated within those ten carries the escalation into its own baseline
  // and is harder to flag, not easier. That is the safe direction: it errs
  // toward saying nothing rather than toward accusing somebody.
  const early = play(0.1, 4, 0.5, 30);
  check('the baseline is the first ten bets, mixed or not', early.openStakes, 10);
  check('so escalating inside them raises the bar', Number((early.openTotal / 10).toFixed(3)), 0.34);
  check('and it stays quiet', chaseStatus(early), null);

  // The baseline is the session's own opening pace, not an absolute figure:
  // somebody playing in whole coins is not chasing for playing in whole coins.
  check('big stakes held steady are not chasing', chaseStatus(play(100, 10, 100, 15)), null);
  check('but big stakes tripled while down are', Boolean(chaseStatus(play(100, 10, 400, 15))), true);

  // The baseline is frozen, so it survives the log rolling over. A long
  // session that escalated is exactly the case the log cannot answer alone.
  const long = play(0.1, 10, 0.5, 80);
  check('the opening pace is kept past the log limit', long.log.length, 50);
  check('and is still what it is compared against', Number(chaseStatus(long).opening.toFixed(4)), 0.1);

  check('no session at all is nothing', chaseStatus(null), null);
}

console.log('\n-- two readers counting one bet');
{
  // On Stake the game endpoints and the bet table both see every original, and
  // the whole thing rests on them agreeing about a bet's id. If they do, the
  // table's copy is deduplicated. If they do not, every figure doubles — and a
  // doubled total looks entirely reasonable, so it has to be detected.
  const round = (id, game, amount, payout) => ({ id, source: 'round', game, amount, payout });
  const table = (id, game, amount, payout) => ({ id, source: 'table', game, amount, payout });

  // The good case: same id from both readers.
  let agree = emptySession('USDT', 1000);
  agree = ingest(agree, [round('same-id', 'Mines', 1, 2)], { currency: 'USDT', now: 5000 }).session;
  agree = ingest(agree, [table('same-id', 'Mines', 1, 2)], { currency: 'USDT', now: 6000 }).session;
  check('a matching id is counted once', agree.bets, 1);
  check('and raises nothing', agree.doubled, 0);
  check('the round is what counted it', agree.sources, { round: 1 });

  // The bad case: the table calls the same bet something else.
  let differ = emptySession('USDT', 1000);
  differ = ingest(differ, [round('round-id', 'Mines', 1, 2)], { currency: 'USDT', now: 5000 }).session;
  differ = ingest(differ, [table('table-id', 'Mines', 1, 2)], { currency: 'USDT', now: 6000 }).session;
  check('a differing id is counted twice', differ.bets, 2);
  check('which is exactly what is reported', differ.doubled, 1);
  check('with both readers named', differ.sources, { round: 1, table: 1 });

  // What must not trigger it. Playing the same stake twice is ordinary, and
  // those rounds each arrive from the round reader — their table copies are
  // deduplicated by id long before this check sees them.
  let repeat = emptySession('USDT', 1000);
  for (const [i, id] of ['r1', 'r2', 'r3'].entries()) {
    repeat = ingest(repeat, [round(id, 'Mines', 1, 0)], { currency: 'USDT', now: 5000 + i * 100 }).session;
  }
  check('repeating the same stake is not double counting', repeat.doubled, 0);

  // A bet the round reader never saw — a provider slot, a sports bet — comes
  // from the table alone and is a real, new bet.
  let provider = emptySession('USDT', 1000);
  provider = ingest(provider, [round('r1', 'Mines', 1, 0)], { currency: 'USDT', now: 5000 }).session;
  provider = ingest(provider, [table('t1', 'Big Bass Bonanza', 1, 0)], { currency: 'USDT', now: 5500 }).session;
  check('a table-only game is not a duplicate', provider.doubled, 0);
  check('and is counted', provider.bets, 2);

  // Same game and stake but hours apart is two evenings, not one bet.
  let apart = emptySession('USDT', 1000);
  apart = ingest(apart, [round('r1', 'Mines', 1, 0)], { currency: 'USDT', now: 5000 }).session;
  apart = ingest(apart, [table('t1', 'Mines', 1, 0)], { currency: 'USDT', now: 5000 + 3_600_000 }).session;
  check('far apart in time is not a duplicate', apart.doubled, 0);

  // A different stake on the same game is a different bet.
  let other = emptySession('USDT', 1000);
  other = ingest(other, [round('r1', 'Mines', 1, 0)], { currency: 'USDT', now: 5000 }).session;
  other = ingest(other, [table('t1', 'Mines', 2, 0)], { currency: 'USDT', now: 5500 }).session;
  check('a different stake is not a duplicate', other.doubled, 0);

  // Duel has one reader, so it can never trip this.
  let duel = emptySession('USDT', 1000);
  duel = ingest(duel, [{ id: 'd1', source: 'feed', game: 'Mines', amount: 1, payout: 0 }],
    { currency: 'USDT', now: 5000 }).session;
  duel = ingest(duel, [{ id: 'd2', source: 'feed', game: 'Mines', amount: 1, payout: 0 }],
    { currency: 'USDT', now: 5500 }).session;
  check('one reader cannot double count', duel.doubled, 0);
  check('and its source is named', duel.sources, { feed: 2 });

  // A row from a build that did not carry a source still has to count.
  const legacy = ingest(emptySession('USDT', 1000), [{ id: 'x', game: 'Mines', amount: 1, payout: 0 }],
    { currency: 'USDT' }).session;
  check('an untagged row is assumed to be the table', legacy.sources, { table: 1 });
  check('and still counts', legacy.bets, 1);
}

console.log('\n-- per-game roll-up');
{
  const bet = (id, game, amount, payout) => ({ id, game, amount, payout });
  let s = emptySession('USDT', 1000);

  s = ingest(s, [bet('b3', 'Dice', 1, 0), bet('b2', 'Mines', 4, 3), bet('b1', 'Mines', 1, 0)],
    { currency: 'USDT' }).session;

  const rolled = gamesOf(s.games);
  check('one row per game, biggest turnover first', rolled.map((r) => r.game), ['Mines', 'Dice']);
  check('Mines totals', [rolled[0].bets, rolled[0].wagered, rolled[0].returned], [2, 5, 3]);
  check('Dice totals', [rolled[1].bets, rolled[1].wagered, rolled[1].returned], [1, 1, 0]);

  // Equal turnover has to land somewhere stable, or the table reshuffles
  // between renders for no reason the reader can see.
  const tied = gamesOf({ b: { game: 'b', bets: 1, wagered: 5, returned: 0 },
    a: { game: 'a', bets: 1, wagered: 5, returned: 0 } });
  check('a tie falls back to the name', tied.map((r) => r.game), ['a', 'b']);

  // The property that makes the breakdown trustworthy: it must reconcile with
  // the session it came from, or it is quietly omitting bets.
  check('per-game bets add up to the session', rolled.reduce((n, r) => n + r.bets, 0), s.bets);
  check('per-game turnover adds up', rolled.reduce((n, r) => n + r.wagered, 0), s.wagered);
  check('per-game returns add up', rolled.reduce((n, r) => n + r.returned, 0), s.returned);

  // A bet whose game did not read is filed, not dropped — otherwise the sums
  // above stop holding exactly when the scraper is having trouble.
  const nameless = ingest(emptySession('USDT', 1000), [{ id: 'n1', amount: 1, payout: 0 }],
    { currency: 'USDT' }).session;
  check('a nameless game still gets a row', gamesOf(nameless.games).map((r) => r.game), ['']);
  check('and still adds up', gamesOf(nameless.games)[0].wagered, nameless.wagered);

  // A correction has to move the game row too, or the breakdown drifts away
  // from the totals over an evening of late-settling bets.
  let c = ingest(emptySession('USDT', 1000), [bet('c1', 'Mines', 1, 0)], { currency: 'USDT' }).session;
  c = ingest(c, [bet('c1', 'Mines', 1, 5)], { currency: 'USDT' }).session;
  check('a corrected bet corrects its game row', gamesOf(c.games)[0].returned, c.returned);
  check('without double-counting the bet', gamesOf(c.games)[0].bets, 1);

  // The reason this is accumulated rather than rolled up from `log` at close.
  let long = emptySession('USDT', 1000);
  for (let i = 0; i < 120; i++) {
    long = ingest(long, [bet(`L${i}`, 'Dice', 1, 0)], { currency: 'USDT' }).session;
  }
  check('the log is capped', long.log.length, 50);
  check('the per-game roll-up is not', gamesOf(long.games)[0].bets, 120);

  const filed = archiveEntry(long, { rate: 3.7, target: 'ILS' });
  check('the roll-up survives archiving', filed.games[0].bets, 120);
  check('the raw map does not', filed.games instanceof Array && !filed.gamesMap, true);
  check('and the log still does not', filed.log, undefined);

  const totals = summarise([filed, filed]);
  check('lifetime per-game sums across sessions', totals.USDT.games[0].bets, 240);
}

console.log('\n-- lifetime money in and out');
{
  const base = { currency: 'USDT', bets: 4, wagered: 10, returned: 8, wins: 1, losses: 3, profit: -2 };

  const totals = summarise([
    { ...base, funded: 100 },
    { ...base, funded: -40 },
    { ...base, funded: 0 },
  ]);

  // Deposits and withdrawals are kept apart on purpose: netting them to zero
  // would report ten in and ten out as nothing having happened.
  check('deposits are summed', totals.USDT.deposited, 100);
  check('withdrawals are summed as a positive figure', totals.USDT.withdrawn, 40);
  check('only sessions that moved money are counted', totals.USDT.fundedSessions, 2);
  check('sessions with no funding do not distort it', summarise([{ ...base }]).USDT.fundedSessions, 0);
  check('an entry from before the field existed is not counted',
    summarise([{ ...base, funded: undefined }]).USDT.fundedSessions, 0);
}

console.log('\n-- realised RTP');
{
  check('what came back per unit staked', realisedRtp(1000, 970, 500), 97);
  // Rounded: this is a figure shown to two decimals, not one anything compares
  // against, and 1100/1000 in binary floating point is 110.00000000000001.
  check('a winning stretch reads above 100', Number(realisedRtp(1000, 1100, 500).toFixed(4)), 110);

  // The guard that stops this reading as a verdict on the games rather than on
  // the sample.
  check('too few bets is null, not a number', realisedRtp(1000, 970, 50), null);
  check('exactly at the threshold counts', realisedRtp(1000, 970, 200), 97);
  check('no turnover is null', realisedRtp(0, 0, 500), null);
  check('negative turnover is null', realisedRtp(-5, 1, 500), null);
  check('an unknown bet count is trusted, for a caller that has none', realisedRtp(1000, 970), 97);
}

console.log('\n-- supported domains');
{
  const { readFileSync } = await import('node:fs');
  const { CASINOS, OPTIONAL_DOMAINS, casinoForDomain, mirrorOrigins, sanitizeMirrors } =
    await import('../src/lib/settings.js');
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

  const only = (list) => sanitizeMirrors(list).map((m) => `${m.host}:${m.site}`);

  // The allowlist is the whole security model here: nothing outside the
  // registry can become a host permission or a content-script match.
  check('a domain outside the registry is refused', only([{ host: 'evil.test', site: 'stake' }]), []);
  check('a built-in domain is not switchable', only([{ host: 'stake.com', site: 'stake' }]), []);
  check('a wildcard is refused', only([{ host: '*.duel.com', site: 'duel' }]), []);
  check('a bare wildcard is refused', only([{ host: '*', site: 'duel' }]), []);
  check('a scheme is refused', only([{ host: 'https://duel.com', site: 'duel' }]), []);
  check('a path is refused', only([{ host: 'duel.com/evil', site: 'duel' }]), []);
  check('junk is refused', only(['x.test', null, 42]), []);
  check('not a list at all', sanitizeMirrors('duel.com'), []);
  check('an unlisted domain has no casino', casinoForDomain('roobet.com'), null);

  // Every switchable domain must round-trip, and must be filed under the
  // casino the registry says rather than the one the stored entry claims.
  for (const entry of OPTIONAL_DOMAINS) {
    check(`${entry.host} survives as ${entry.site}`,
      only([{ host: entry.host, site: 'nonsense' }]), [`${entry.host}:${entry.site}`]);
  }

  check('origins cover the host and its subdomains',
    mirrorOrigins('duel.limited'), ['https://duel.limited/*', 'https://*.duel.limited/*']);

  // The registry and the manifest are two copies of the same list. A domain
  // one allows and the other does not is a switch that appears to work and
  // does nothing, or a permission asked for and never used.
  const builtIn = Object.values(CASINOS).flatMap((c) => c.builtIn);
  const matchesIn = new Set(manifest.content_scripts.flatMap((entry) => entry.matches));
  check('every built-in domain is matched by the manifest',
    builtIn.filter((host) => !matchesIn.has(`https://${host}/*`) || !matchesIn.has(`https://*.${host}/*`)), []);

  const optional = new Set(manifest.optional_host_permissions || []);
  check('every switchable domain is requestable',
    OPTIONAL_DOMAINS.filter((e) => !optional.has(`https://${e.host}/*`) || !optional.has(`https://*.${e.host}/*`)), []);
  check('and the manifest asks for nothing the registry does not list',
    [...optional].filter((pattern) => {
      const host = pattern.replace(/^https:\/\/(\*\.)?/, '').replace(/\/\*$/, '');
      return !OPTIONAL_DOMAINS.some((e) => e.host === host);
    }), []);

  // The one that would undo all of it.
  check('no manifest permission is a bare wildcard host',
    [...optional, ...matchesIn].filter((p) => /^https:\/\/\*\/|^<all_urls>/.test(p)), []);

  check('sanitize cleans the list on the way in',
    sanitize({ mirrors: [{ host: 'evil.test', site: 'duel' }] }).mirrors, []);
}

console.log('\n-- i18n');
{
  // The pages run inside Chrome; the module only needs chrome.i18n to exist so
  // it can fall through to it when a key is missing from the bundle.
  globalThis.chrome = { i18n: { getMessage: () => '', getUILanguage: () => 'en-US' } };
  const { readFileSync } = await import('node:fs');
  const { t, useMessages } = await import('../src/lib/i18n.js');

  const en = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));

  // Every declared placeholder must point at an argument slot — a content of
  // "$3" with two arguments substitutes emptiness silently at runtime.
  check('placeholder contents are well-formed',
    Object.keys(en).filter((k) =>
      Object.values(en[k].placeholders || {}).some((p) => !/^\$\d+$/.test(String(p.content)))), []);

  useMessages({ lang: 'en', messages: en });
  check('a plain message resolves from the bundle', t('popReset', 'fallback'), 'Reset');
  check('$1 lands in a named placeholder', t('hudNoCoinRate', 'no BTC rate yet', ['BTC']).includes('BTC'), true);
  check('and the placeholder token is consumed', t('hudNoCoinRate', '', ['BTC']).includes('$'), false);
  check('a missing key falls back to the English at the call site',
    t('nosuchkey', 'English fallback'), 'English fallback');

  useMessages(null);
  check('with no bundle it falls back too', t('popReset', 'Reset'), 'Reset');
}

console.log('\n-- live providers');
// One fetch per target, against the real APIs. The point is that a target is a
// parameter all the way down to the query string: a plausible band per currency
// is what catches vs_currencies being ignored and a dollar figure coming back
// wearing a yen label.
const LIVE = [
  { target: 'ILS', low: 1, high: 20 },
  { target: 'EUR', low: 0.5, high: 2 },
  { target: 'USD', low: 0.5, high: 2 },
  { target: 'JPY', low: 50, high: 400 },
];

for (const { target, low, high } of LIVE) {
  try {
    const result = await fetchRate({ target });
    const sane = Number.isFinite(result.rate) && result.rate > low && result.rate < high;
    check(`${result.providerLabel} returned a plausible ${target} rate (${result.rate})`, sane, true);
    check(`${target}: the reading is stamped with what it is quoted in`, result.target, target);
    check(`${target}: keyless call is not counted as keyed`, result.usedKey, false);

    // The coins ride along in the same request; a BTC session is unpriced
    // without them, so a provider that quietly stopped returning them is worth
    // catching. exchangerate-api prices the dollar and nothing else, so it is
    // only asked this when it is not the one that answered.
    const btc = result.coins?.BTC;
    if (result.provider === 'coingecko') {
      check(`${target}: the same call priced BTC (${btc ?? 'missing'})`, Number.isFinite(btc) && btc > 1000, true);
    } else {
      console.log(`skip  ${target}: BTC — ${result.providerLabel} prices the dollar only`);
    }
    if (result.errors.length) console.log(`      note: fell back after — ${result.errors.join('; ')}`);
  } catch (error) {
    // Being throttled is not a defect. Four fetches in a row is enough to trip
    // the ~10/min keyless ceiling on its own, and a suite that goes red for
    // that teaches you to ignore red.
    if (/429|rate limited/i.test(String(error?.message))) {
      console.log(`skip  ${target}: rate limited by the providers, not a code fault`);
    } else {
      failures++;
      console.log(`FAIL  live fetch (${target}): ${error.message}`);
    }
  }
}

console.log('\n-- API key handling');
// Pass an obviously invalid key: CoinGecko must not answer as though it were
// good, or the options page's Test button would green-light a broken key.
// Set COINGECKO_KEY in the environment to test a real one instead.
const realKey = process.env.COINGECKO_KEY || null;

// Being throttled is not a defect, and running this suite a few times in a row
// is enough to trip the ~10/min keyless ceiling. Treat a 429 as "reachable but
// busy" rather than failing the build on it — a test that goes red because it
// was run twice teaches you to ignore red.
{
  const problem = await pingKey(null);
  if (problem && /rate limited/i.test(problem)) {
    console.log('skip  keyless ping — rate limited by CoinGecko, not a code fault');
  } else {
    check('keyless ping succeeds', problem, null);
  }
}

if (realKey) {
  check('supplied key is accepted', await pingKey(realKey), null);
} else {
  const problem = await pingKey('CG-this-key-is-not-real-000000');
  console.log(`      bogus key -> ${problem === null ? 'ACCEPTED (CoinGecko ignores bad demo keys)' : problem}`);
  console.log('      set COINGECKO_KEY=... to test a real key');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all passed'}`);
process.exit(failures ? 1 : 0);
