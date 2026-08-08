// DOM tests for the bet-table scraper.
// Run with: node tools/domtest.mjs
//
// src/lib/scrape.js is the one piece of this extension that depends on someone
// else's markup, and it is the source of every number the session shows. It had
// no coverage at all because it needed a DOM — so this file brings one, in about
// sixty lines and with no dependencies. The fake implements exactly the four
// things the scraper touches: querySelectorAll for 'table' / 'thead th' /
// 'tbody tr', textContent, getAttribute and row.cells.
//
// A real browser would be a better test. It would also be a package.json, a
// download, and a reason not to run this — which is how the file that most
// needed tests ended up with none.

import { createRequire } from 'node:module';
import { emptySession, gamesOf, ingest, sessionProfit } from '../src/lib/session.js';

const require = createRequire(import.meta.url);
const { findMyBetsTable, scrapeBets, parseCell, siteFor, betsFromDuel, DUEL_HOSTS, betsFromStakeGame, gameName, SITES, pinCandidates } = require('../src/lib/scrape.js');

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
}

// ------------------------------------------------------------- the fake DOM

const cell = (text) => ({ textContent: String(text) });

/**
 * @param headers  Column titles, as Stake renders them.
 * @param rows     [id, ...cells] — a null id means a row with no test hook.
 */
function makeTable(headers, rows) {
  const head = headers.map(cell);
  const body = rows.map(([id, ...values]) => {
    const cells = values.map(cell);
    return {
      cells,
      getAttribute: (name) => (name === 'data-test-id' ? id : null),
    };
  });

  return {
    querySelectorAll(selector) {
      if (selector === 'thead th') return head;
      if (selector === 'tbody tr') return body;
      return [];
    },
  };
}

const makeDocument = (tables) => ({
  querySelectorAll: (selector) => (selector === 'table' ? tables : []),
});

const MY_BETS = ['Game', 'Time', 'Bet Amount', 'Multiplier', 'Payout'];
const ALL_BETS = ['Game', 'User', 'Time', 'Bet Amount', 'Multiplier', 'Payout'];

// ------------------------------------------------------------------- tests

console.log('-- finding the table');
{
  const mine = makeTable(MY_BETS, []);
  check('the My Bets table is found', findMyBetsTable(makeDocument([mine]))?.table, mine);

  // Whitespace and case are Stake's business, not ours.
  const padded = makeTable(['  GAME ', 'Time', 'BET AMOUNT', 'Multiplier', ' Payout'], []);
  check('headers are matched case- and space-insensitively',
    Boolean(findMyBetsTable(makeDocument([padded]))), true);

  // The one that matters: All Bets has the same five columns plus a user, and
  // counting strangers' bets as yours would be far worse than counting nothing.
  check('the All Bets table is refused', findMyBetsTable(makeDocument([makeTable(ALL_BETS, [])])), null);
  check('a table with the right count but wrong columns is refused',
    findMyBetsTable(makeDocument([makeTable(['Game', 'Time', 'Bet Amount', 'Multiplier', 'Player'], [])])), null);
  check('an unrelated table is refused',
    findMyBetsTable(makeDocument([makeTable(['Rank', 'Wagered'], [])])), null);
  check('no table at all is null', findMyBetsTable(makeDocument([])), null);

  // Both on the page at once is the normal case: Stake shows the tabs together.
  const mixed = makeDocument([makeTable(ALL_BETS, []), mine]);
  check('My Bets is picked out from beside All Bets', findMyBetsTable(mixed)?.table, mine);
}

console.log('\n-- reading the rows');
{
  const table = makeTable(MY_BETS, [
    ['id-win', 'Dice', '12:00', '0.20000000', '2.00×', '0.40000000'],
    ['id-loss', 'Mines', '11:59', '0.20000000', '0.00×', '-0.20000000'],
    ['id-pending', 'Sports', '11:58', '1.00000000', '—', ''],
    [null, 'Dice', '11:57', '0.10000000', '1.00×', '0.10000000'],
  ]);
  const rows = scrapeBets(table, findMyBetsTable(makeDocument([table])).heads);

  check('rows without a test hook are skipped', rows.length, 3);
  check('the newest row comes first', rows[0].id, 'id-win');
  check('a win reads its stake and payout', [rows[0].amount, rows[0].payout], [0.2, 0.4]);
  check('the game name is trimmed', rows[0].game, 'Dice');
  // Stake writes a lost stake as a negative payout, not as zero. Everything
  // downstream depends on that being passed through untouched.
  check('a loss keeps its negative payout', rows[1].payout, -0.2);
  check('a settled row is marked settled', [rows[0].settled, rows[1].settled], [true, true]);
  check('an empty payout is not settled', rows[2].settled, false);
  check('and carries a null payout rather than a zero', rows[2].payout, null);
}

console.log('\n-- parseCell');
{
  check('eight decimals', parseCell('0.20000000'), 0.2);
  check('a multiplier', parseCell('1.13×'), 1.13);
  check('grouped thousands', parseCell('1,234.50'), 1234.5);
  check('a negative payout', parseCell('-0.20000000'), -0.2);
  check('an em dash is not a number', parseCell('—'), null);
  check('blank is not a number', parseCell(''), null);
  check('missing is not a number', parseCell(undefined), null);

  // The shapes that used to return null — and a null stake became a zero
  // stake, which became a bet with no turnover and no profit. Anything Stake
  // puts beside the digits has to be survivable.
  check('a ticker beside the stake', parseCell('0.20000000 USDT'), 0.2);
  check('a ticker in front', parseCell('USDT 0.20000000'), 0.2);
  check('a currency symbol', parseCell('$0.10'), 0.1);
  check('a shekel sign', parseCell('₪0.35'), 0.35);
  check('surrounding whitespace and markup text', parseCell('\\n  0.20000000\\n  '), 0.2);
  check('a negative with a ticker', parseCell('-0.20000000 USDT'), -0.2);
  check('letters alone are still not a number', parseCell('Mines'), null);
  check('a pending marker is still not a number', parseCell('- -'), null);
}

console.log('\n-- which site');
{
  check('stake.com', siteFor('stake.com')?.id, 'stake');
  check('a stake subdomain', siteFor('www.stake.bet')?.id, 'stake');
  check('duel.com', siteFor('duel.com')?.id, 'duel');
  check('a duel subdomain', siteFor('www.duel.com')?.id, 'duel');
  check('case is not the hostname’s business', siteFor('WWW.DUEL.COM')?.id, 'duel');

  // The one that matters: a lookalike host must not be handed the adapter for
  // the real one, or the extension starts posting reads at somebody else's API.
  check('a lookalike is not Duel', siteFor('notduel.com'), null);
  check('a lookalike is not Stake', siteFor('fakestake.com'), null);
  check('duel.com as a subdomain of somewhere else', siteFor('duel.com.evil.net'), null);
  check('anywhere else', siteFor('example.com'), null);
  check('nothing at all', siteFor(''), null);

  check('Stake reads its ledger off a table', siteFor('stake.com')?.ledger, 'table');
  check('Duel reads its ledger off an API', siteFor('duel.com')?.ledger, 'api');

  // Duel's other domains. These are the ones that fail quietly: an unmatched
  // Duel host falls through to the Stake adapter, which then watches for a bet
  // table that does not exist and reports no fault at all.
  for (const host of ['duel.limited', 'duel.vip', 'duel.net', 'www.duel.limited']) {
    check(`${host} is Duel`, siteFor(host)?.id, 'duel');
  }
  check('a duel lookalike TLD is still not Duel', siteFor('duel.limited.evil.net'), null);
  check('an unrelated duel TLD is not Duel', siteFor('duel.example'), null);
}

console.log('\n-- Stake: a game round');
{
  // Real replies, captured from stake.com, trimmed of the `user` block and the
  // full `state.rounds` list — neither of which crosses the bridge.
  const alive = {
    id: '4df90720-a8fe-41da-9f0f-c8eecd9bb77b',
    active: true,
    currency: 'usdt',
    amountMultiplier: 1,
    payoutMultiplier: 0,
    amount: 0,
    payout: 0,
    game: 'mines',
  };

  const busted = { ...alive, active: false, payoutMultiplier: 0 };
  const cashed = { ...alive, id: '723853ed-18d2-4b05-a442-e29a0ff32e44', active: false, payoutMultiplier: 1.125 };

  const open = betsFromStakeGame(alive);
  check('an open round is one row', open.rows.length, 1);
  check('carrying the round id', open.rows[0].id, alive.id);
  check('and it is not settled', open.rows[0].settled, false);
  check('the coin comes off the round itself', open.currency, 'USDT');
  check('the game is named as the bet table names it', open.rows[0].game, 'Mines');

  // The whole reason an open round is marked unsettled: ingest skips it and
  // leaves it unseen, so a mines grid being revealed does not book as a total
  // loss and is reconsidered when it closes.
  check('a busted round is settled', betsFromStakeGame(busted).rows[0].settled, true);
  check('and returns nothing', betsFromStakeGame(busted).rows[0].payout, 0);

  check('a cashed-out round is settled', betsFromStakeGame(cashed).rows[0].settled, true);

  // Every capture was zero-stake, so the arithmetic is checked at a stake the
  // captures did not have. 1.125 is the gross multiplier, so 8 returns 9.
  const real = betsFromStakeGame({ ...cashed, amount: 8 });
  check('the return is stake times multiplier', real.rows[0].payout, 9);
  check('and the stake is untouched', real.rows[0].amount, 8);

  const lost = betsFromStakeGame({ ...busted, amount: 8 });
  check('a lost round returns nothing at any stake', lost.rows[0].payout, 0);
  check('so ingest reads it as a loss of the stake', lost.rows[0].payout - lost.rows[0].amount, -8);

  // Stake's own payout field was 0 in every capture, at a zero stake, so
  // whether it is gross or net is unknown. It is compared, never used.
  check('agreement is silent', betsFromStakeGame({ ...cashed, amount: 8, payout: 9 }).mismatch, null);
  check('a zero-stake round never complains', betsFromStakeGame(cashed).mismatch, null);
  check('an open round never complains', betsFromStakeGame({ ...alive, amount: 8, payout: 999 }).mismatch, null);

  const net = betsFromStakeGame({ ...cashed, amount: 8, payout: 1 });
  check('but a real disagreement is reported', Boolean(net.mismatch), true);
  check('with both figures, so it can be read', [net.mismatch.computed, net.mismatch.stated], [9, 1]);

  // Junk must not become a bet.
  check('no id is no row', betsFromStakeGame({ ...cashed, id: '' }).rows, []);
  check('no amount is no row', betsFromStakeGame({ ...cashed, amount: null }).rows, []);
  check('no multiplier is no row', betsFromStakeGame({ ...cashed, payoutMultiplier: 'x' }).rows, []);
  check('nothing at all is no row', betsFromStakeGame(undefined).rows, []);

  check('a hyphenated game reads as the table names it', gameName('dragon-tower'), 'Dragon Tower');
  check('a single word', gameName('limbo'), 'Limbo');
  check('a slots name is camelCase, not hyphenated', gameName('slotsTomeOfLife'), 'Slots Tome Of Life');
  check('digits do not split a word', gameName('keno2'), 'Keno2');
  check('nothing is nothing', gameName(undefined), '');
}

console.log('\n-- Stake: a slots spin, at a real stake');
{
  // Captured from stake.com. Three things no earlier capture had: a game that
  // settles on the bet itself, a stake that is not zero, and Stake's own
  // slots naming.
  const SPIN = {
    id: 'c726c31f-bd0a-4e98-9826-6290aaef7e3a',
    active: false,
    currency: 'usdt',
    amountMultiplier: 1,
    payoutMultiplier: 0,
    amount: 0.00042962,
    payout: 0,
    game: 'slotsTomeOfLife',
  };

  const { rows, currency, mismatch } = betsFromStakeGame(SPIN);
  check('a single-shot game settles on the bet', rows[0].settled, true);
  check('the stake is carried at full precision', rows[0].amount, 0.00042962);
  check('a losing spin returns nothing', rows[0].payout, 0);
  check('the coin comes off the spin', currency, 'USDT');
  check('and it is filed under Stake’s own name for it', rows[0].game, 'Slots Tome Of Life');

  // The evidence this capture actually carried: at a real stake, a loss
  // reports payout 0 rather than −0.00042962. A net figure would have been
  // negative, so `payout` is what came back, not what was made.
  check('Stake’s own payout agrees with stake times multiplier', mismatch, null);

  let s = ingest(emptySession(null, 1000), rows, { currency }).session;
  check('one spin is one bet', s.bets, 1);
  check('turnover is the stake', s.wagered, 0.00042962);
  check('and the spin lost it', sessionProfit(s), -0.00042962);
  check('counted as a loss', [s.wins, s.losses], [0, 1]);

  // Re-reading it — the table showing the same spin a moment later — must not
  // count it twice.
  s = ingest(s, rows, { currency }).session;
  check('and it is only counted once', s.bets, 1);
}

console.log('\n-- Stake: a bonus buy that paid');
{
  // Captured from /_api/casino/slots-tome-of-life/bonus. The one that settles
  // what `payout` means: a round that actually returned money.
  const BONUS = {
    id: '53d860de-b469-4dc3-95a6-f1492e072d7b',
    active: false,
    currency: 'usdt',
    amountMultiplier: 1,
    payoutMultiplier: 0.35472974,
    amount: 0.00010434000000000001,
    payout: 0.000037012500000000005,
    game: 'slotsTomeOfLife',
  };

  const { rows, mismatch } = betsFromStakeGame(BONUS);

  // 0.00010434 × 0.35472974 = 0.0000370125010716, against a stated
  // 0.0000370125. A rounding step apart, not a different quantity — so the
  // field is the gross return, and the computed figure is right.
  check('the computed return matches Stake’s own', mismatch, null);
  check('within a rounding step', Math.abs(rows[0].payout - BONUS.payout) < 1e-10, true);

  // A different wrapper key and a different endpoint, and neither matters:
  // the round is found by shape, and the game is named by the round.
  check('a bonus buy is one bet', rows.length, 1);
  check('filed under the same game as a plain spin', rows[0].game, 'Slots Tome Of Life');
  check('and it is settled', rows[0].settled, true);

  const s = ingest(emptySession(null, 1000), rows, { currency: 'USDT' }).session;
  check('turnover is the buy-in', s.wagered, 0.00010434000000000001);

  // The buy cost more than it returned, so it lost money — but it returned
  // something, and `ingest` files anything that returned as a win. That is
  // Stake's own framing, and the same thing the bet table produces, so it is
  // left alone rather than made to disagree with the site.
  check('it returned less than it cost', sessionProfit(s) < 0, true);
  check('but a return is a return', [s.wins, s.losses], [1, 0]);

  // The free spins inside `state` carry their own amounts, and they sum to a
  // different figure than the stake. Reading turnover from there would be
  // wrong by more than half, which is why `state` never leaves the page.
  check('the stake is the buy-in, not the free spins', s.wagered !== 15 * 0.00000282, true);
}

console.log('\n-- Stake: a whole mines round');
{
  // The property the entire multi-step design rests on: one round is one bet,
  // however many HTTP calls it takes. Count each call and turnover multiplies
  // — which is exactly how Duel's two-line ledger read ten rounds worth +1.18
  // as +28.67 before it was grouped.
  //
  // The stake is 8 here; every real capture was zero-stake, and a round worth
  // nothing cannot show a doubled anything.
  const OPENED = { // /bet, verbatim shape
    id: '8f79732b-271b-4d86-9e28-1a5fe699801b',
    active: true, currency: 'usdt', amountMultiplier: 1,
    payoutMultiplier: 0, amount: 8, payout: 0, game: 'mines',
  };
  const REVEALED = { ...OPENED, payoutMultiplier: 0 }; // /next, still alive
  const CASHED = { ...OPENED, active: false, payoutMultiplier: 1.125 };

  const feed = (session, round) => {
    const { rows, currency } = betsFromStakeGame(round);
    return ingest(session, rows, { currency }).session;
  };

  let s = emptySession(null, 1000);
  s = feed(s, OPENED);
  check('opening a round books nothing', [s.bets, s.wagered, s.returned], [0, 0, 0]);

  s = feed(s, REVEALED);
  s = feed(s, REVEALED);
  check('and neither does revealing tiles', [s.bets, s.wagered, s.returned], [0, 0, 0]);

  s = feed(s, CASHED);
  check('cashing out books exactly one bet', s.bets, 1);
  check('with the stake charged once', s.wagered, 8);
  check('and the gross returned once', s.returned, 9);
  check('so the round is worth its profit', sessionProfit(s), 1);
  check('the coin came off the round', s.currency, 'USDT');
  check('filed under the game', gamesOf(s.games).map((g) => [g.game, g.bets]), [['Mines', 1]]);

  // Replaying the whole round — a re-read, a second tab — must change nothing.
  for (const round of [OPENED, REVEALED, CASHED]) s = feed(s, round);
  check('replaying the round adds nothing', [s.bets, s.wagered, s.returned], [1, 8, 9]);

  // The other ending.
  let lost = emptySession(null, 1000);
  lost = feed(lost, OPENED);
  lost = feed(lost, { ...OPENED, active: false, payoutMultiplier: 0 });
  check('a busted round is one bet too', lost.bets, 1);
  check('losing the stake and returning nothing', [lost.wagered, lost.returned], [8, 0]);
  check('which is a loss of the stake', sessionProfit(lost), -8);
  check('counted as a loss, not a win', [lost.wins, lost.losses], [0, 1]);
}

console.log('\n-- switched-on domains');
{
  // Which domains may be switched on at all is settled in lib/settings.js
  // against a closed registry; siteFor takes whatever list it is handed. These
  // check the routing rather than the allowlist, so they use hosts that are
  // deliberately not in the registry — if the two layers ever disagree, this
  // is the one that still has to be safe.
  const mirrors = [{ host: 'duel.example', site: 'duel' }, { host: 'mirror.test', site: 'stake' }];

  check('a declared Duel mirror is Duel', siteFor('duel.example', mirrors)?.id, 'duel');
  check('and reads its ledger off an API', siteFor('duel.example', mirrors)?.ledger, 'api');
  check('a declared Stake mirror is Stake', siteFor('mirror.test', mirrors)?.id, 'stake');
  check('a subdomain of a mirror counts', siteFor('www.duel.example', mirrors)?.id, 'duel');

  // The suffix has to be a real label boundary, or a mirror declared as
  // "duel.example" would answer for "evilduel.example".
  check('a lookalike of a mirror does not count', siteFor('evilduel.example', mirrors), null);
  check('a mirror as somebody else’s subdomain does not count',
    siteFor('duel.example.evil.net', mirrors), null);

  // A settings list must never be able to reassign a domain the extension
  // already knows: the built-ins are matched first.
  check('a mirror cannot turn stake.com into Duel',
    siteFor('stake.com', [{ host: 'stake.com', site: 'duel' }])?.id, 'stake');

  check('an unknown site id is refused', siteFor('x.test', [{ host: 'x.test', site: 'nope' }]), null);
  check('no mirrors is the old behaviour', siteFor('duel.example'), null);
  check('a junk list is ignored', siteFor('duel.example', 'nonsense'), null);
}

console.log('\n-- the two host lists agree');
{
  // lib/stakebridge.js runs in the page's own world, so it cannot import
  // siteFor and carries its own copy of the Duel pattern. If the two drift, a
  // mirror is Duel to one layer and Stake to the other: the overlay reads one
  // site's ledger while the bridge polls the other's API. Nothing about that
  // announces itself, so it is asserted here.
  const { readFileSync } = await import('node:fs');
  const bridge = readFileSync(new URL('../src/lib/stakebridge.js', import.meta.url), 'utf8');

  const found = bridge.match(/const DUEL_HOSTS = (\/.*\/i?);/);
  check('the bridge still declares a Duel host pattern', Boolean(found), true);

  if (found) {
    // Compared by what they match rather than by source text, so a harmless
    // difference in flags or spacing does not fail and a real difference does.
    const bridgeRe = eval(found[1]); // eslint-disable-line no-eval -- our own source, read from disk
    const hosts = ['duel.com', 'www.duel.com', 'duel.limited', 'duel.vip', 'duel.net',
      'stake.com', 'www.stake.bet', 'notduel.com', 'duel.com.evil.net', 'example.com'];
    check('both layers agree on every host',
      hosts.filter((h) => bridgeRe.test(h) !== DUEL_HOSTS.test(h)), []);
  }
}

console.log('\n-- Duel: a round is not a row');
{
  // Verbatim from a live /api/v2/user/transactions page. A won mines round is
  // TWO lines under one `data.id`: the wager, negative, and the return,
  // positive. Reading them as two bets doubles the turnover and invents a
  // profit out of the sign — which is exactly what this used to do.
  const wonRound = [
    {
      key: 'mines_rounds', type: 'Mines Rounds', currency: 105,
      amount_currency: '0.717448757701796187',
      data: { id: 50065914, status: 1, amount_currency: '0.660713570656308800', amount_won: '0.717448757701796187' },
    },
    {
      key: 'mines_rounds', type: 'Mines Rounds', currency: 105,
      amount_currency: '-0.660713570656308800',
      data: { id: 50065914, status: 1, amount_currency: '0.660713570656308800', amount_won: '0.717448757701796187' },
    },
  ];

  const { rows } = betsFromDuel({ data: wonRound });

  check('two ledger lines are one bet', rows.length, 1);
  check('identified by the round, not the line', rows[0].id, 'mines_rounds:50065914');
  check('the stake is the stake, not the line movement', rows[0].amount, 0.6607135706563088);
  check('and the payout is the gross return', rows[0].payout, 0.717448757701796187);
  check('so the profit is the profit',
    Number((rows[0].payout - rows[0].amount).toFixed(9)), 0.056735187);
  check('a cashed-out round is settled', rows[0].settled, true);
  check('and named for the game', rows[0].game, 'Mines Rounds');

  // Either line alone prices the whole round, which is what makes a page
  // boundary between the two harmless.
  check('the return line alone is enough', betsFromDuel({ data: [wonRound[0]] }).rows[0].amount, 0.6607135706563088);
  check('the wager line alone is too', betsFromDuel({ data: [wonRound[1]] }).rows[0].payout, 0.717448757701796187);
}

console.log('\n-- Duel: losses and open rounds');
{
  // A lost round writes one line: the wager. status 2 is LOST.
  const lost = betsFromDuel({
    data: [{
      key: 'mines_rounds', type: 'Mines Rounds', currency: 105,
      amount_currency: '-1.611740679934329000',
      data: { id: 50065582, status: 2, amount_currency: '1.611740679934329000', amount_won: '0.000000000000000000' },
    }],
  }).rows[0];

  check('a loss keeps its whole stake', lost.amount, 1.611740679934329);
  check('and returns nothing', lost.payout, 0);
  check('and is settled — a zero return is a result, not a pending one', lost.settled, true);

  // status 0 is ACTIVE: the wager line is written when the bet is placed, and
  // the round has not resolved. Counting it would book an open grid as a total
  // loss until the cashout landed.
  const open = betsFromDuel({
    data: [{
      key: 'mines_rounds', type: 'Mines Rounds', currency: 105,
      amount_currency: '-1.000000000000000000',
      data: { id: 50065999, status: 0, amount_currency: '1.000000000000000000', amount_won: '0.000000000000000000' },
    }],
  }).rows[0];
  check('an active round is not settled', open.settled, false);

  // Blackjack is the exception: its hand runs 0..4 before FINISHED=5, so
  // "not zero" would call a hand mid-deal a loss.
  const bj = (status) => betsFromDuel({
    data: [{
      key: 'blackjack_rounds', type: 'Blackjack Round', currency: 105,
      amount_currency: '1.221331251063659200',
      data: { id: 771, status, amount_currency: '0.610665625531829600', amount_won: '1.221331251063659200' },
    }],
  }).rows[0].settled;

  check('a blackjack hand mid-deal is not settled', [bj(1), bj(2), bj(3), bj(4)], [false, false, false, false]);
  check('a finished one is', bj(5), true);
}

console.log('\n-- Duel: provider slots, which send no round figures');
{
  // `data` on a slot line holds nothing but an id, so the stake and the return
  // have to come off the lines themselves.
  const spin = [
    {
      key: 'game_round_bets', type: 'Le Fisherman', currency: 105,
      amount_currency: '2.332565822404645110', data: { id: 280717558 },
    },
    {
      key: 'game_round_bets', type: 'Le Fisherman', currency: 105,
      amount_currency: '-6.006607267994794274', data: { id: 280717558 },
    },
  ];

  const { rows } = betsFromDuel({ data: spin });
  check('a spin is one bet', rows.length, 1);
  check('staked what was debited', rows[0].amount, 6.006607267994794274);
  check('returned what was credited', rows[0].payout, 2.332565822404645110);
  check('and counts as finished — slots have no open state', rows[0].settled, true);
  check('named for the game, not the key', rows[0].game, 'Le Fisherman');

  // The one case a page boundary can still break: a credit whose wager line
  // fell off the end. Booking it would be a stake-free win — a pure invented
  // profit — so it is dropped instead.
  check('an orphaned credit is dropped, not booked as free money',
    betsFromDuel({ data: [spin[0]] }).rows, []);
  check('an orphaned debit is a bet, since the worst case is a loss that corrects',
    betsFromDuel({ data: [spin[1]] }).rows[0].amount, 6.006607267994794274);
}

console.log('\n-- Duel: what is not a bet');
{
  const { rows } = betsFromDuel({
    data: [
      {
        key: 'mines_rounds', type: 'Mines Rounds', currency: 105, amount_currency: '-1',
        data: { id: 1, status: 2, amount_currency: '1', amount_won: '0' },
      },
      {
        key: 'user_rakeback_balances', type: 'Rakeback Claim', currency: 105,
        amount_currency: '3.000000000000000000', data: { id: 9 },
      },
      {
        key: 'withdrawal_invoices', type: 'Crypto Withdrawal', currency: 105,
        amount_currency: '-50.000000000000000000', data: { id: 9 },
      },
    ],
  });

  // A withdrawal booked as a losing bet would be far worse than a bet missed.
  check('a claim and a withdrawal are not bets', rows.map((r) => r.id), ['mines_rounds:1']);

  check('a line with no round id is skipped',
    betsFromDuel({ data: [{ key: 'dice_rounds', currency: 105, amount_currency: '-1', data: {} }] }).rows, []);
  check('an empty feed is empty', betsFromDuel({ data: [] }), { rows: [], currency: null, mixed: 0 });
  check('nothing at all is empty', betsFromDuel(null), { rows: [], currency: null, mixed: 0 });
}

console.log('\n-- Duel: one coin per batch');
{
  const round = (id, currency, stake, won) => ({
    key: 'dice_rounds', type: 'Dice Rounds', currency,
    amount_currency: String(-stake),
    data: { id, status: 2, amount_currency: String(stake), amount_won: String(won) },
  });

  // The feed mixes coins; a session is denominated in exactly one. The newest
  // bet decides, and the rest sit out rather than being counted at its rate.
  const { rows, currency, mixed } = betsFromDuel({
    data: [round(1, 105, 1, 2), round(2, 101, 0.0001, 0), round(3, 105, 3, 0)],
  });

  check('the newest bet’s coin wins', currency, 'USDT');
  check('only that coin’s rounds come back', rows.map((r) => r.id), ['dice_rounds:1', 'dice_rounds:3']);
  check('and the rest are counted, not silently gone', mixed, 1);

  check('an unknown currency id is null, not a guess',
    betsFromDuel({ data: [round(4, 999, 1, 0)] }).currency, null);
}

console.log('\n-- Duel: the whole page adds up');
{
  // Three won rounds and one lost, as six ledger lines in feed order. The
  // figures the session shows are Σstake and Σreturn − Σstake, and the point of
  // this test is that they come out of the ledger unchanged.
  const won = (id, stake, ret) => ([
    { key: 'mines_rounds', type: 'Mines Rounds', currency: 105, amount_currency: String(ret),
      data: { id, status: 1, amount_currency: String(stake), amount_won: String(ret) } },
    { key: 'mines_rounds', type: 'Mines Rounds', currency: 105, amount_currency: String(-stake),
      data: { id, status: 1, amount_currency: String(stake), amount_won: String(ret) } },
  ]);
  const lost = (id, stake) => ([
    { key: 'mines_rounds', type: 'Mines Rounds', currency: 105, amount_currency: String(-stake),
      data: { id, status: 2, amount_currency: String(stake), amount_won: '0' } },
  ]);

  const { rows } = betsFromDuel({ data: [...won(3, 2, 2.5), ...won(2, 1, 1.5), ...lost(1, 4)] });

  const wagered = rows.reduce((sum, r) => sum + r.amount, 0);
  const profit = rows.reduce((sum, r) => sum + Math.max(r.payout, 0) - r.amount, 0);

  check('three rounds, not five lines', rows.length, 3);
  check('newest first', rows.map((r) => r.id), ['mines_rounds:3', 'mines_rounds:2', 'mines_rounds:1']);
  check('wagered is the sum of the stakes', wagered, 7);
  check('and the P/L is down by the lost stake less the two wins', profit, -3);
}

console.log('\n-- what the readout follows');
{
  // The order is the feature: it is what decides whether anybody ever has to
  // pin anything, and whether a pin made on one casino follows you to another.
  const order = (site, settings) => pinCandidates(site, settings).map((c) => c.source);
  const first = (site, settings) => pinCandidates(site, settings)[0];

  // Nothing pinned: the site's own balance chip is the only candidate, and it
  // is what makes pinning optional rather than required.
  check('nothing pinned still has something to follow', order(SITES.stake, {}), ['auto']);
  check('and it is the chip the currency reader already uses',
    first(SITES.stake, {}).selector, SITES.stake.currencyChip);
  check('Duel has one of its own', first(SITES.duel, {}).selector, SITES.duel.currencyChip);

  // A pin is tried first, with the chip still behind it — that fallback is what
  // stops a path that stopped matching from meaning "pin it again".
  const pinned = { pins: { stake: { selector: '#mine', label: 'USDT' } } };
  check('a pin is tried before the chip', order(SITES.stake, pinned), ['pin', 'auto']);
  check('and the chip is still there to fall back to',
    pinCandidates(SITES.stake, pinned)[1].selector, SITES.stake.currencyChip);
  check('the pin carries its label', first(SITES.stake, pinned).label, 'USDT');

  // Per casino. One slot for both was why a pin made on Stake left the readout
  // on Duel saying the element was not on the page.
  check("Stake's pin is not offered on Duel", order(SITES.duel, pinned), ['auto']);
  check('each casino has its own',
    order(SITES.duel, { pins: { duel: { selector: '#d' }, stake: { selector: '#s' } } }), ['pin', 'auto']);

  // The single pin from before this was per site is still read, so upgrading
  // does not quietly discard what somebody chose — but a new pin outranks it.
  check('the old global pin is still tried',
    order(SITES.stake, { trackedSelector: '#old' }), ['legacy', 'auto']);
  check('and a per-site pin comes first',
    order(SITES.stake, { trackedSelector: '#old', pins: { stake: { selector: '#new' } } }),
    ['pin', 'legacy', 'auto']);

  // Nothing here may produce an empty selector: content.js would hand it to
  // querySelector, which throws on one.
  check('no candidate is ever blank',
    pinCandidates(SITES.stake, { pins: { stake: { selector: '' } }, trackedSelector: '   ' })
      .filter((c) => !c.selector.trim()), []);
  check('a missing site is not a crash', order(undefined, {}), []);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
