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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
