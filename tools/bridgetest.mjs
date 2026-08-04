// Tests for the page-world bridge.
// Run with: node tools/bridgetest.mjs
//
// src/lib/stakebridge.js is the half of the extension that lives inside the
// casino's own page, and it is the only code that can make a request against
// someone's account. What it asks for, when it refuses to ask, and what it puts
// on a bus every script on the page can read are all things worth pinning down
// — and none of them need a browser to check.
//
// The fake below is the four things the bridge actually touches: window (fetch,
// postMessage, addEventListener, location), document (visibilityState,
// hasFocus), and the two timer functions. Intervals are captured rather than
// run, so a test can fire one round on demand instead of waiting a minute.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
}

// ------------------------------------------------------------- the fake page

/**
 * Load the bridge into a fresh fake page.
 *
 * @param hostname  Which casino it thinks it is on.
 * @param replies   path -> object, the responses `fetch` will hand back. A
 *                  function is called instead, so a test can answer with a
 *                  status or count the calls.
 */
function loadBridge(hostname, replies = {}) {
  const posted = [];
  const requested = [];
  const listeners = [];
  const intervals = [];

  // The page's own requests and the bridge's replays both arrive at the same
  // fake `fetch`, and the whole point of several of these tests is that they
  // are not the same thing — so which one is calling is recorded at the door.
  let fromPage = false;

  const respond = (url) => {
    const path = String(url).split('?')[0];
    const reply = replies[path];
    const body = typeof reply === 'function' ? reply() : reply;
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (body && body.__status) return { ok: false, status: body.__status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body, clone: () => ({ json: async () => body }) };
  };

  const window = {
    location: { hostname, origin: `https://${hostname}` },
    fetch: async (url) => {
      if (!fromPage) requested.push(String(url));
      return respond(url);
    },
    postMessage: (data) => posted.push(data),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  };

  global.window = window;
  global.document = { visibilityState: 'visible', hasFocus: () => true };
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  global.clearInterval = () => {};

  delete require.cache[require.resolve('../src/lib/stakebridge.js')];
  require('../src/lib/stakebridge.js');

  // The bridge only listens to messages that came from the same window, so the
  // event has to claim to have.
  const sendIn = (data) => {
    for (const fn of listeners) fn({ source: window, data: { channel: 'stake-ils-bridge', ...data } });
  };

  return {
    posted,
    requested,
    intervals,
    sendIn,
    /** What the page itself asked for, seen going past. Never counted as ours. */
    async pageFetch(url, init) {
      fromPage = true;
      try {
        return await window.fetch(url, init);
      } finally {
        fromPage = false;
      }
    },
    /** Let every pending promise settle. */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    kindsOf: (kind) => posted.filter((m) => m.kind === kind),
  };
}

// Real payloads, cut to the fields that are read.
const DUEL_RATES = {
  base: 'EUR',
  rates: { EUR: 1, USD: 1.1535, ILS: 3.5194 },
  crypto_rates: { 101: '0.000015702235370227', 105: '1.001291666249461805' },
};

const DUEL_RAKEBACK = { success: true, data: { claimable_at: '2026-08-02T15:35:53.000000Z', total: '4.25', pools: [] } };

const DUEL_USER = {
  success: true, id: 1, username: 'someone', balance: 12.5,
  default_balance_type: 105,
  levels_data: { level: 7, xp: 4200 },
};

const DUEL_TRANSACTIONS = {
  success: true,
  current_page: 1,
  data: [
    {
      id: 91, secure_id: 'gvLZTn', key: 'mines_rounds', type: 'Mines Rounds',
      amount_currency: '0.75', currency: 105, balance_after: 12.5,
      balance_after_coins: '12.500000', invoice_id: null,
      data: {
        id: 50065914, status: 1, amount_currency: '0.50', amount_won: '0.75',
        server_seed: 'nobody-else-s-business', client_seed: 'nor-this', nonce: 4,
      },
    },
    {
      id: 90, secure_id: 'gvLZTm', key: 'mines_rounds', type: 'Mines Rounds',
      amount_currency: '-0.50', currency: 105, balance_after: 11.75,
      data: {
        id: 50065914, status: 1, amount_currency: '0.50', amount_won: '0.75',
        server_seed: 'nobody-else-s-business', client_seed: 'nor-this', nonce: 4,
      },
    },
    {
      id: 89, secure_id: 'wd-1', key: 'withdrawal_invoices', type: 'Crypto Withdrawal',
      amount_currency: '-50.00', currency: 105, data: { id: 7 },
    },
  ],
};

const DUEL_PATHS = {
  '/api/v2/metadata/exchange-rates': DUEL_RATES,
  '/api/v2/user/rakeback': DUEL_RAKEBACK,
  '/api/v2/user': DUEL_USER,
  '/api/v2/user/transactions': DUEL_TRANSACTIONS,
};

// ------------------------------------------------------------------- tests

console.log('-- Duel: nothing happens until it is switched on');
{
  const page = loadBridge('duel.com', DUEL_PATHS);
  await page.settle();

  check('loading the bridge asks for nothing', page.requested, []);
  check('and says nothing', page.posted, []);

  // The page making its own request is not a reason to read it either.
  await page.pageFetch('/api/v2/user/transactions');
  await page.settle();
  check('a request going past is ignored while off', page.kindsOf('bets'), []);
}

console.log('\n-- Duel: reading what goes past');
{
  const page = loadBridge('duel.com', DUEL_PATHS);
  page.sendIn({ kind: 'config', capture: true, rates: true, bets: false, poll: false, seconds: 60 });
  await page.settle();

  await page.pageFetch('/api/v2/metadata/exchange-rates');
  await page.settle();
  check('the price table is forwarded', page.kindsOf('rates').length, 1);
  check('tagged with which site it came from', page.kindsOf('rates')[0].source, 'duel');
  check('and forwarded whole, not derived',
    Object.keys(page.kindsOf('rates')[0].rates).sort(), ['crypto_rates', 'rates']);

  await page.pageFetch('/api/v2/user/rakeback');
  await page.settle();
  const meta = page.kindsOf('meta');
  check('the rakeback balance is read', meta[0].meta.rakeback, [{ currency: 'USD', amount: 4.25 }]);

  await page.pageFetch('/api/v2/user');
  await page.settle();
  const user = page.kindsOf('meta').at(-1).meta;
  check('the level is read as a tier with no fraction', user.vip, { flag: 'Level 7', progress: null });
  check('and the wallet coin comes with it', user.wallet, 'USDT');

  // Reading is not asking: watching the page's own traffic must not make any
  // traffic of its own.
  check('watching costs no requests', page.requested, []);
}

console.log('\n-- Duel: what reaches the bus');
{
  const page = loadBridge('duel.com', DUEL_PATHS);
  page.sendIn({ kind: 'config', capture: false, rates: false, bets: true, poll: false, betSeconds: 15 });
  await page.settle();

  const bets = page.kindsOf('bets');
  check('the ledger is read as soon as tracking is on', bets.length, 1);
  check('and only the bets in it', bets[0].feed.map((r) => r.key), ['mines_rounds', 'mines_rounds']);

  // Both lines of the round have to survive the trim, and both have to keep
  // `data.id` — that is the field that makes them one bet rather than two.
  check('the round id comes through on every line',
    bets[0].feed.map((r) => r.data.id), [50065914, 50065914]);

  // The bus is readable by every script on the page. The feed carries seeds,
  // balances and invoice ids; none of them are anyone else's business, and the
  // narrowing has to happen before the broadcast rather than after it.
  check('trimmed to what the accounting uses',
    Object.keys(bets[0].feed[0]).sort(),
    ['amount_currency', 'currency', 'data', 'key', 'type']);
  check('and the seeds do not come with it',
    Object.keys(bets[0].feed[0].data).sort(), ['amount_currency', 'amount_won', 'id', 'status']);
  check('nor does the balance', 'balance_after' in bets[0].feed[0], false);
}

console.log('\n-- Duel: only while you are looking');
{
  const page = loadBridge('duel.com', DUEL_PATHS);
  page.sendIn({ kind: 'config', capture: true, rates: true, bets: true, poll: true, seconds: 60, betSeconds: 15 });
  await page.settle();

  const first = page.requested.length;
  check('the first ledger read happens straight away', first, 1);

  // A tab in the background is not the one being played in, and quiet tabs
  // making timed API calls is the traffic pattern worth not generating.
  global.document.visibilityState = 'hidden';
  for (const timer of page.intervals) timer.fn();
  await page.settle();
  check('a hidden tab asks for nothing', page.requested.length, first);

  global.document.visibilityState = 'visible';
  global.document.hasFocus = () => false;
  for (const timer of page.intervals) timer.fn();
  await page.settle();
  check('nor does a visible one you are not looking at', page.requested.length, first);

  global.document.hasFocus = () => true;
  for (const timer of page.intervals) timer.fn();
  await page.settle();
  check('a tab in front of you does', page.requested.length > first, true);

  // Three timers, and each asks for one thing: the account, the ledger, the
  // price table. Nothing else is ever fetched.
  check('and only ever for these', [...new Set(page.requested)].sort(), [
    '/api/v2/metadata/exchange-rates',
    '/api/v2/user',
    '/api/v2/user/rakeback',
    '/api/v2/user/transactions',
  ]);
}

console.log('\n-- Duel: a refresh that fails says so');
{
  const page = loadBridge('duel.com', { ...DUEL_PATHS, '/api/v2/user/rakeback': () => ({ __status: 401 }) });
  page.sendIn({ kind: 'config', capture: true, rates: false, bets: false, poll: false });
  page.sendIn({ kind: 'poll' });
  await page.settle();

  const answer = page.kindsOf('refresh');
  check('a click is always answered', answer.length, 1);
  check('and answered with the reason', [answer[0].ok, answer[0].message], [false, 'Duel answered HTTP 401']);
  check('which is filed as a diagnostic too', page.kindsOf('problem').length, 1);
}

console.log('\n-- Duel: a refresh that works');
{
  const page = loadBridge('duel.com', DUEL_PATHS);
  page.sendIn({ kind: 'config', capture: true, rates: false, bets: false, poll: false });
  page.sendIn({ kind: 'poll' });
  await page.settle();

  check('answers ok', page.kindsOf('refresh'), [{ channel: 'stake-ils-bridge', kind: 'refresh', ok: true, message: null }]);
  // A reading that was asked for is marked as such, so the extension stores it
  // even when the figures have not moved.
  check('and the readings are marked as asked-for', page.kindsOf('meta').every((m) => m.forced), true);
  check('with no complaint filed', page.kindsOf('problem'), []);
}

console.log('\n-- Duel: a refresh is refused when reading is off');
{
  const page = loadBridge('duel.com', DUEL_PATHS);
  page.sendIn({ kind: 'config', capture: false, rates: false, bets: false, poll: false });
  page.sendIn({ kind: 'poll' });
  await page.settle();

  check('nothing is asked for', page.requested, []);
}

console.log('\n-- Stake: still reads its own traffic, and asks for nothing');
{
  const STAKE_META = {
    data: {
      user: {
        id: 'u1',
        rakeback: { enabled: true, balances: [{ currency: 'usdt', availableAmount: 1.5 }] },
        flagProgress: { flag: 'bronze', progress: 0.42 },
      },
    },
  };
  const STAKE_RATES = {
    data: { currencyConfiguration: { baseRates: [{ currency: 'usdt', baseRate: 1 }, { currency: 'ils', baseRate: 3.7 }] } },
  };

  let next = STAKE_META;
  const page = loadBridge('stake.com', { '/_api/graphql': () => next });
  page.sendIn({ kind: 'config', capture: true, rates: true, poll: false });
  await page.settle();

  await page.pageFetch('/_api/graphql', { body: JSON.stringify({ operationName: 'VipMeta' }), headers: { authorization: 'secret' } });
  await page.settle();

  const meta = page.kindsOf('meta');
  check('rakeback is read out of the page’s own reply', meta[0].meta.rakeback, [{ currency: 'USDT', amount: 1.5 }]);
  check('and VIP progress with it', meta[0].meta.vip, { flag: 'bronze', progress: 0.42 });

  next = STAKE_RATES;
  await page.pageFetch('/_api/graphql', { body: JSON.stringify({ operationName: 'CurrencyConfiguration' }) });
  await page.settle();
  const rates = page.kindsOf('rates');
  check('the price table is forwarded as rows', rates[0].rates, [
    { currency: 'USDT', baseRate: 1 }, { currency: 'ILS', baseRate: 3.7 },
  ]);
  check('tagged as Stake’s', rates[0].source, 'stake');

  // The token the page attached is what makes a replay possible, and it stays
  // in the closure. Nothing on the bus may carry it.
  check('no captured header reaches the bus', JSON.stringify(page.posted).includes('secret'), false);

  // Stake's ledger is the table on the page, so the bridge never reads bets.
  page.sendIn({ kind: 'config', capture: true, rates: true, bets: true, poll: false, betSeconds: 15 });
  await page.settle();
  check('and no bet reading is attempted there', page.kindsOf('bets'), []);
}

console.log('\n-- Stake: rounds seen going past');
{
  // A real reply, whole — including the two parts that must not cross the bus.
  const MINES_ALIVE = {
    minesNext: {
      id: '4df90720-a8fe-41da-9f0f-c8eecd9bb77b',
      active: true,
      currency: 'usdt',
      amountMultiplier: 1,
      payoutMultiplier: 0,
      amount: 0,
      payout: 0,
      updatedAt: 'Tue, 04 Aug 2026 21:43:54 GMT',
      game: 'mines',
      user: { id: '00000000-0000-4000-8000-000000000000', name: 'SomePlayer' },
      state: { rounds: [{ field: 0, payoutMultiplier: 1.03125 }], minesCount: 1, mines: null },
    },
  };

  const MINES_CASHOUT = {
    minesCashout: {
      ...MINES_ALIVE.minesNext,
      id: '723853ed-18d2-4b05-a442-e29a0ff32e44',
      active: false,
      payoutMultiplier: 1.125,
      state: { rounds: [{ field: 10, payoutMultiplier: 1.03125 }], minesCount: 1, mines: [4] },
    },
  };

  // Opening a round. Its `state.rounds` is empty and there is no multiplier
  // yet — the only thing that matters here is that it arrives marked open.
  const MINES_BET = {
    minesBet: {
      ...MINES_ALIVE.minesNext,
      id: '8f79732b-271b-4d86-9e28-1a5fe699801b',
      state: { rounds: [], minesCount: 3, mines: null },
    },
  };

  const page = loadBridge('stake.com', {
    '/_api/casino/mines/bet': MINES_BET,
    '/_api/casino/mines/next': MINES_ALIVE,
    '/_api/casino/mines/cashout': MINES_CASHOUT,
  });

  page.sendIn({ kind: 'config', site: 'stake', capture: false, rates: false, bets: true, poll: false });

  await page.pageFetch('/_api/casino/mines/bet', { body: '{"currency":"usdt","amount":0,"minesCount":3}' });
  await page.settle();

  const opened = page.kindsOf('round');
  check('placing a bet is forwarded as an open round', opened.length, 1);
  check('marked open', opened[0].round.active, true);
  check('and the wrapper key does not matter', opened[0].round.game, 'mines');

  await page.pageFetch('/_api/casino/mines/next', { body: '{"fields":[10]}' });
  await page.settle();

  const rounds = page.kindsOf('round').slice(1);
  check('an open round is forwarded', rounds.length, 1);
  check('with the fields the accounting needs',
    Object.keys(rounds[0].round).sort(),
    ['active', 'amount', 'currency', 'game', 'id', 'payout', 'payoutMultiplier']);
  check('and it is still open', rounds[0].round.active, true);

  // The bus is readable by every script on the page. The reply carries the
  // account id and the player's name, and the whole revealed board; none of it
  // is the extension's business and none of it may be broadcast.
  const bus = JSON.stringify(page.posted);
  check('the player’s name never reaches the bus', bus.includes('SomePlayer'), false);
  check('nor their account id', bus.includes('00000000-0000-4000-8000'), false);
  check('nor the board', bus.includes('minesCount'), false);

  await page.pageFetch('/_api/casino/mines/cashout', { body: '{"identifier":"dVr9TVep8zVsrOj_ch3o2"}' });
  await page.settle();

  const settled = page.kindsOf('round').at(-1);
  check('a cashout is forwarded as settled', settled.round.active, false);
  check('carrying its multiplier', settled.round.payoutMultiplier, 1.125);

  check('and the bridge asked for none of it', page.requested, []);
}

{
  // Session tracking off means the rounds are not read at all, not read and
  // discarded — the same switch that stops Duel's feed being fetched.
  const page = loadBridge('stake.com', { '/_api/casino/mines/next': { minesNext: { id: 'r', active: true, currency: 'usdt', amount: 1, payoutMultiplier: 0, game: 'mines' } } });
  page.sendIn({ kind: 'config', site: 'stake', capture: false, rates: false, bets: false, poll: false });
  await page.pageFetch('/_api/casino/mines/next', { body: '{}' });
  await page.settle();
  check('nothing is read with tracking off', page.kindsOf('round'), []);
}

console.log('\n-- a game this cannot read says so');
{
  // The point of the whole exercise: a game whose replies do not parse is a
  // game whose bets are not being counted, and that has to be visible. Right
  // now the only games with captured replies are the ones this was written
  // against — every other Stake original is an assumption until it is played.
  const page = loadBridge('stake.com', {
    // A round-shaped reply that fails the type checks: no id.
    '/_api/casino/dragon-tower/bet': { dragonTowerBet: { active: true, game: 'dragon-tower', amount: 1, payoutMultiplier: 0 } },
    // Not a round at all — a list, a config blob. Must stay silent.
    '/_api/casino/games/list': { games: [{ name: 'mines' }, { name: 'dice' }] },
    // A readable one, to show a good round raises nothing.
    '/_api/casino/dice/bet': { diceBet: { id: 'd1', active: false, game: 'dice', currency: 'usdt', amount: 1, payoutMultiplier: 2 } },
  });

  page.sendIn({ kind: 'config', site: 'stake', capture: false, rates: false, bets: true, poll: false });

  await page.pageFetch('/_api/casino/games/list', { body: '{}' });
  await page.settle();
  check('a casino reply that is not a round is not complained about', page.kindsOf('problem'), []);

  await page.pageFetch('/_api/casino/dice/bet', { body: '{}' });
  await page.settle();
  check('a round that reads raises nothing', page.kindsOf('problem'), []);
  check('and is forwarded', page.kindsOf('round').length, 1);

  // A single-shot game settles on the bet itself, which is the case no
  // capture covers yet.
  check('a single-shot game arrives settled', page.kindsOf('round')[0].round.active, false);

  await page.pageFetch('/_api/casino/dragon-tower/bet', { body: '{}' });
  await page.settle();

  const problems = page.kindsOf('problem');
  check('but a round-shaped reply that will not parse does', problems.length, 1);
  check('naming the game, so it can be found', problems[0].message.includes('dragon-tower'), true);
  check('and saying it is not being counted', problems[0].message.includes('not being counted'), true);

  // The reply is what identifies the failure, and it is exactly what must not
  // be kept: it carries the player and the board.
  check('no part of the reply is forwarded with it', problems[0].message.includes('payoutMultiplier'), false);
}

console.log('\n-- nothing replays a casino action');
{
  // Stake's games are driven by REST endpoints — /_api/casino/mines/bet places
  // a real bet with real money, /cashout settles one. When the bet reader is
  // written against those, the bridge will be watching them go past, and the
  // one thing it must never do is send one itself.
  //
  // Structurally that holds because a replay can only ever send a body that
  // was captured, and only the account operations are captured. This asserts
  // it from the outside, so the guarantee survives the reader being added.
  const ACTIONS = [
    '/_api/casino/mines/bet',
    '/_api/casino/mines/next',
    '/_api/casino/mines/cashout',
    '/_api/casino/dice/bet',
  ];

  const VIP = {
    data: {
      user: {
        id: 'u1',
        rakeback: { enabled: true, balances: [{ currency: 'usdt', availableAmount: 1.5 }] },
        flagProgress: { flag: 'bronze', progress: 0.42 },
      },
    },
  };

  const page = loadBridge('stake.com', {
    '/_api/graphql': VIP,
    ...Object.fromEntries(ACTIONS.map((path) => [path, { round: { identifier: 'r1' } }])),
  });

  page.sendIn({ kind: 'config', site: 'stake', capture: true, rates: true, poll: true, seconds: 30 });

  // The page plays a round while everything the bridge can do is switched on.
  for (const path of ACTIONS) {
    await page.pageFetch(path, { body: JSON.stringify({ currency: 'usdt', amount: 5 }) });
  }
  await page.settle();

  // Then every timer the config started fires.
  for (const timer of page.intervals) await timer.fn();
  await page.settle();

  const sent = page.requested.map(String);
  check('the bridge sent no casino action of its own',
    sent.filter((url) => url.includes('/_api/casino/')), []);

  // The other half of it: a round's payload must not be sitting in the replay
  // store waiting to be sent by some later change.
  check('and no action payload was captured',
    JSON.stringify(page.posted).includes('minesCount'), false);
}

console.log('\n-- the adapter follows the config, not the hostname');
{
  // A user-added mirror is a hostname the bridge cannot recognise, so the
  // content script names the site on the config message. Without this a Duel
  // mirror gets the Stake adapter, never reads its transaction feed, and
  // reports nothing wrong — the quietest failure this extension has.
  const page = loadBridge('duel-mirror.test', {
    '/api/v2/user/transactions': DUEL_TRANSACTIONS,
    '/api/v2/user/rakeback': DUEL_RAKEBACK,
  });

  page.sendIn({ kind: 'config', site: 'duel', capture: false, rates: false, bets: true, poll: false, betSeconds: 15 });
  await page.settle();

  check('an unknown host told it is Duel reads the ledger', page.kindsOf('bets').length > 0, true);
  check('and asked Duel’s own endpoint for it',
    page.requested.some((url) => String(url).includes('/api/v2/user/transactions')), true);
}

{
  // And the reverse: naming Stake must not start the bet poll, because Stake's
  // ledger is the table on the page.
  const page = loadBridge('stake-mirror.test', { '/api/v2/user/transactions': DUEL_TRANSACTIONS });

  page.sendIn({ kind: 'config', site: 'stake', capture: false, rates: false, bets: true, poll: false, betSeconds: 15 });
  await page.settle();

  check('a mirror told it is Stake reads no bet ledger', page.kindsOf('bets'), []);
  check('and asks for nothing', page.requested, []);
}

{
  // A config with no site at all is every build before this one, and the
  // hostname must still decide.
  const page = loadBridge('duel.limited', { '/api/v2/user/transactions': DUEL_TRANSACTIONS });

  page.sendIn({ kind: 'config', capture: false, rates: false, bets: true, poll: false, betSeconds: 15 });
  await page.settle();
  check('a Duel domain with no site named still reads bets', page.kindsOf('bets').length > 0, true);
}

{
  // An unrecognised site id must leave the hostname's answer alone rather than
  // land on some default.
  const page = loadBridge('duel.com', { '/api/v2/user/transactions': DUEL_TRANSACTIONS });

  page.sendIn({ kind: 'config', site: 'roobet', capture: false, rates: false, bets: true, poll: false, betSeconds: 15 });
  await page.settle();
  check('an unknown site id does not unseat the hostname', page.kindsOf('bets').length > 0, true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
