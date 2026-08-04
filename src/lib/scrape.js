// Reading someone else's bet ledger — Stake's "My Bets" table, or Duel's
// transaction feed.
//
// This is the riskiest code in the extension and it used to be the only code
// with no test at all: it depends on someone else's markup, it is the source of
// every number the session shows, and when it breaks it breaks quietly. The
// only reason it lived inside content.js was that content scripts cannot be ES
// modules — so it lives here instead, as a plain script that the manifest loads
// ahead of content.js and that tools/domtest.mjs can require() against a fake
// DOM. One copy, exercised by tests.
//
// Nothing in here touches chrome APIs or the network: give it a document-like
// object or a parsed response and it will read it.

(function (root) {
  'use strict';

  // ------------------------------------------------------------- which site
  //
  // The two supported casinos keep the same figures in completely different
  // places, so which one this is decides where every reader looks. Everything
  // site-specific in the extension is named here; nothing else branches on a
  // hostname.

  const SITES = {
    stake: {
      id: 'stake',
      name: 'Stake',
      // The ledger is markup: a table on the page, scraped as it re-renders.
      ledger: 'table',
      // The wallet chip, for reading which coin is in play.
      currencyChip: 'button[data-testid="coin-toggle"], [data-testid="balance-toggle"]',
    },
    duel: {
      id: 'duel',
      name: 'Duel',
      // The ledger is JSON: Duel has no bet table at all, and its transaction
      // feed is a better source than one would have been — an exact stake, an
      // exact payout and a unique id per row, with no markup in the way.
      ledger: 'api',
      // Duel labels its balance but not its coin: the header renders "$0.00"
      // whatever the wallet holds. The coin therefore comes off the ledger
      // rows, which carry it as a number, rather than off the chip.
      currencyChip: '[data-testid="currency-value"]',
    },
  };

  /**
   * Hostnames each casino answers on, mirrors included.
   *
   * Duplicated once, at the bottom of lib/stakebridge.js, and that copy cannot
   * be avoided: the bridge runs in the page's world as a plain script, so it
   * can neither import this nor read it off the extension. Both copies are
   * exercised by tools/domtest.mjs, which is what keeps them from drifting —
   * a Duel mirror that only one of them recognises is read as Stake by the
   * other, and Stake's readers find nothing on it while reporting no fault.
   */
  const DUEL_HOSTS = /(^|\.)duel\.(com|limited|vip|net)$/;
  const STAKE_HOSTS = /(^|\.)stake\.(com|bet|games|us)$/;

  /**
   * Which casino a hostname is, or null for anywhere else.
   *
   * @param mirrors  The user's extra hosts, [{host, site}]. Consulted only
   *                 after the built-in patterns, so nothing in a settings list
   *                 can turn stake.com into something else. A mirror matches
   *                 its own host and subdomains of it, and by suffix rather
   *                 than substring — otherwise "evilduel.com" would answer for
   *                 a mirror declared as "duel.com".
   */
  function siteFor(hostname, mirrors) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return null;

    if (DUEL_HOSTS.test(host)) return SITES.duel;
    if (STAKE_HOSTS.test(host)) return SITES.stake;

    for (const entry of Array.isArray(mirrors) ? mirrors : []) {
      const declared = String(entry?.host || '').toLowerCase();
      if (!declared) continue;
      if (host === declared || host.endsWith(`.${declared}`)) return SITES[entry.site] || null;
    }

    return null;
  }

  /**
   * The exact columns of the "My Bets" tab, in order. Matching on the full set
   * rather than a substring is what keeps "All Bets" out: that table carries a
   * user column, and counting strangers' bets as yours would be far worse than
   * counting nothing at all.
   */
  const MY_BETS_HEADERS = ['game', 'time', 'bet amount', 'multiplier', 'payout'];

  /** Columns that mark a table as somebody else's bets. */
  const FOREIGN_HEADER_RE = /user|player|name/;

  /** A signed decimal anywhere in a cell, grouped form first. */
  const CELL_NUMBER_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.?\d*|-?\.\d+/;

  /**
   * "0.20000000" -> 0.2, "1.13×" -> 1.13, "0.20000000 USDT" -> 0.2.
   * Returns null when the cell holds no number at all.
   *
   * This used to demand that the *whole* cell be a bare number, which meant a
   * stake rendered with its ticker beside it — or a currency symbol, or an
   * icon carrying alt text — parsed as null. Null then became a zero stake and
   * the bet was booked anyway: one bet, nothing wagered, no profit, filed as a
   * loss because a zero payout is a loss. A whole winning session could read as
   * flat that way. Find the number in the cell; do not insist on the cell being
   * nothing but the number.
   */
  function parseCell(text) {
    if (text === null || text === undefined) return null;

    const match = String(text).match(CELL_NUMBER_RE);
    if (!match) return null;

    const value = Number.parseFloat(match[0].replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
  }

  /** The user's own bet table on the page, or null. */
  function findMyBetsTable(doc) {
    const scope = doc || root.document;
    if (!scope) return null;

    for (const table of scope.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim().toLowerCase());
      if (heads.length !== MY_BETS_HEADERS.length) continue;
      if (heads.some((h) => FOREIGN_HEADER_RE.test(h))) continue;
      if (MY_BETS_HEADERS.every((h, i) => heads[i] === h)) return { table, heads };
    }
    return null;
  }

  /**
   * Rows as {id, settled, game, amount, payout}, newest first — the order the
   * table renders them in.
   *
   * A payout cell that is blank or not a number means the bet has not resolved:
   * an unsettled sports bet, or a row caught mid-render. A *numeric* zero is
   * deliberately not treated as pending — only Mines was ever confirmed to
   * write losses as a negative, and calling 0.00000000 "pending" would silently
   * drop every losing bet in whichever game writes them that way.
   */
  function scrapeBets(table, heads) {
    const iGame = heads.indexOf('game');
    const iAmount = heads.indexOf('bet amount');
    const iPayout = heads.indexOf('payout');
    const rows = [];

    for (const tr of table.querySelectorAll('tbody tr')) {
      const id = tr.getAttribute('data-test-id') || tr.getAttribute('data-testid');
      if (!id) continue;

      const payout = parseCell(tr.cells[iPayout]?.textContent ?? '');

      rows.push({
        id,
        settled: payout !== null,
        game: tr.cells[iGame]?.textContent.trim() || '',
        amount: parseCell(tr.cells[iAmount]?.textContent),
        payout,
      });
    }
    return rows;
  }

  // ------------------------------------------------------- Duel's ledger
  //
  // Duel has no bet table. What it has is /api/v2/user/transactions: a paged,
  // newest-first ledger of everything that ever moved the balance, bets among
  // it. Page one is the same "top of the list" the Stake scraper reads off the
  // table, and the accounting downstream treats it identically — including the
  // gap detection for bets that scrolled past unseen.

  /** Duel's currency ids. Second copy of the map in lib/rates.js; see there. */
  const DUEL_CURRENCIES = {
    101: 'BTC', 102: 'BCH', 103: 'ETH', 104: 'LTC', 105: 'USDT', 106: 'USDC',
    107: 'BNB', 108: 'TRX', 109: 'SOL', 110: 'XRP', 111: 'DOGE', 112: 'ADA',
    113: 'LINK', 114: 'AVAX', 115: 'XLM', 116: 'TON', 117: 'HBAR', 118: 'DOT',
  };

  /**
   * Which ledger rows are bets.
   *
   * Duel names the source table in `key`: mines_rounds, dice_rounds, crash_bets,
   * slots_spins. Deposits, withdrawals and rakeback claims sit in the same feed
   * under names of their own (withdrawal_invoices, user_rakeback_balances), and
   * booking a withdrawal as a losing bet would be considerably worse than
   * missing it — so this matches what a bet is called rather than excluding a
   * list of what it is not.
   */
  const DUEL_BET_KEY_RE = /_(rounds|bets|spins)$/;

  /** "0.20000000" -> 0.2. Duel sends amounts as strings; blanks stay null. */
  function parseDuelAmount(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Is a round finished?
   *
   * Every game Duel runs itself carries a status, and 0 means the round is
   * still going — `ACTIVE` for mines, dice and crash, `INITIALIZING_TABLE` for
   * blackjack. Blackjack is the exception worth naming: its hand runs through
   * four more in-progress states before `FINISHED`, so "not zero" would book a
   * hand mid-deal as a total loss.
   *
   * Provider slots carry no status at all. Those settle server-side in one go,
   * so a round with a wager line is a finished round, and the caller decides.
   *
   * @returns true / false, or null when the feed did not say.
   */
  const DUEL_ROUND_ACTIVE = 0;
  const DUEL_BLACKJACK_FINISHED = 5;

  function duelSettled(key, status) {
    if (!Number.isFinite(status)) return null;
    if (key === 'blackjack_rounds') return status === DUEL_BLACKJACK_FINISHED;
    return status !== DUEL_ROUND_ACTIVE;
  }

  /**
   * Bets out of one page of Duel's transaction feed, newest first, in the shape
   * the session accounting already takes.
   *
   * **A round is not a row.** This is the thing that has to be got right, and
   * getting it wrong is not a rounding error — it inverts the P/L. Duel's feed
   * is a *balance ledger*, not a bet list: a won round writes two lines under
   * the same key, one negative for the wager and one positive for the return,
   * and the top-level `amount_currency` is that line's movement, not the stake.
   * Read line by line, a 0.66 stake returning 0.72 reads as a bet of −0.66 that
   * paid 0.72 *plus* a bet of 0.72 that paid 0.72 — turnover doubled and the
   * profit nonsense. So lines are grouped into rounds by `data.id` first, and
   * one bet comes out per round.
   *
   * Two ways to price a round, in order:
   *
   *  1. `data.amount_currency` and `data.amount_won` — the round's own stake and
   *     gross return, carried identically on *both* of its lines. Every game
   *     Duel runs itself sends these, and because either line alone is enough,
   *     it does not matter which side of a page boundary the other one fell.
   *  2. The lines themselves, for provider slots, whose `data` holds nothing but
   *     an id: stake is what was debited, return is what was credited. A group
   *     with only a credit is one whose wager line fell off the end of the page,
   *     and is dropped rather than booked as a stake-free win.
   *
   * Duel's feed can also mix coins — a USDT session and a BTC one land in the
   * same list — while a session is denominated in exactly one. So the coin of
   * the newest bet wins and rounds in any other coin are left out, which is the
   * same thing Stake's table does by only ever showing one coin at a time.
   * Switching wallet mid-session is then caught by the accounting, which says so.
   *
   * @returns {{rows: Array, currency: string|null, mixed: number}}
   */
  function betsFromDuel(json) {
    const feed = Array.isArray(json?.data) ? json.data : [];

    // Insertion order is the feed's order, which is newest first — the same
    // order the Stake scraper hands back, and the one the accounting expects.
    const rounds = new Map();

    for (const entry of feed) {
      const key = String(entry?.key || '');
      if (!DUEL_BET_KEY_RE.test(key)) continue;

      // The round id, not the ledger line's. A line id would count a won round
      // twice — once as its wager, once as its return.
      const round = entry?.data?.id;
      if (round === null || round === undefined) continue;

      const id = `${key}:${round}`;
      let group = rounds.get(id);

      if (!group) {
        group = {
          id,
          key,
          game: String(entry.type || key),
          currency: DUEL_CURRENCIES[Number(entry.currency)] || null,
          // The round's own figures, when the game sends them.
          stake: parseDuelAmount(entry?.data?.amount_currency),
          won: parseDuelAmount(entry?.data?.amount_won),
          settled: duelSettled(key, Number(entry?.data?.status)),
          // What its lines moved, for the games that send nothing else.
          debited: 0,
          credited: 0,
          wagered: false,
        };
        rounds.set(id, group);
      }

      const line = parseDuelAmount(entry.amount_currency);
      if (line === null) continue;
      if (line < 0) {
        group.debited -= line;
        group.wagered = true;
      } else if (line > 0) {
        group.credited += line;
      } else {
        // A zero line is still a round that happened — a free spin, or a stake
        // too small to move the balance. It has no wager to find in the lines,
        // but the round's own figures may still price it.
        group.wagered = group.wagered || group.stake !== null;
      }
    }

    const all = [];

    for (const group of rounds.values()) {
      const exact = group.stake !== null && group.won !== null;
      if (!exact && !group.wagered) continue; // a credit whose wager is off-page

      all.push({
        id: group.id,
        // Nothing said either way — a provider slot — means finished: they are
        // settled server-side in one go, and there is no open state to be in.
        settled: group.settled === null ? true : group.settled,
        game: group.game,
        amount: exact ? group.stake : group.debited,
        payout: exact ? group.won : group.credited,
        currency: group.currency,
      });
    }

    const currency = all.length ? all[0].currency : null;
    const rows = all.filter((row) => row.currency === currency);

    // Stripped of the per-row coin, because everything downstream takes one
    // currency for the whole batch and a second one on a row would be a lie
    // waiting to be read.
    return {
      rows: rows.map(({ currency: _coin, ...row }) => row),
      currency,
      mixed: all.length - rows.length,
    };
  }

  // ------------------------------------------- Stake's own games, as rounds
  //
  // A round arrives from the page-world bridge on every action: opened by
  // /bet, updated by each /next, closed by /cashout or by hitting a mine. All
  // of them carry the same id, so the session sees one bet that starts
  // unsettled and settles once — which is exactly the shape `ingest` already
  // handles for a table row that settles late.

  /**
   * Stake names its games three ways in the same field: "mines",
   * "dragon-tower", and — for its slots — "slotsTomeOfLife". All three end up
   * in the per-game totals beside names the bet table rendered, so they are
   * made to read alike here rather than as one row per spelling.
   *
   * The slots prefix is left on. It is Stake's own name for the game and
   * dropping it would be this file deciding what a game is really called,
   * which is a guess with nothing to check it against.
   */
  function gameName(raw) {
    return String(raw || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * One round, as a bet row.
   *
   * The return is computed as stake times `payoutMultiplier` rather than taken
   * from the reply's own `payout`, because what `payout` means was unknown
   * when this was written: every capture was zero-stake, where the gross
   * return and the net profit are both zero and agree with everything.
   *
   * A losing slots spin at a real stake has since narrowed it — 0.00042962
   * staked, `payout` 0. A net figure would have been −0.00042962 there, so
   * `payout` is what came back rather than what was made. That still leaves a
   * win unconfirmed, and the multiplier needs no confirming: 1.125 on a mines
   * cashout is the total returned per unit staked, and 0 on a bust.
   *
   * `payout` is still compared against the computed figure and a disagreement
   * is reported, so a winning round settles the last of it by itself.
   *
   * @returns {{rows: Array, currency: string|null, mismatch: object|null}}
   */
  function betsFromStakeGame(round) {
    const id = typeof round?.id === 'string' ? round.id : '';
    const amount = round?.amount;
    const multiplier = round?.payoutMultiplier;

    // Typed rather than coerced, and that distinction is load-bearing:
    // Number(null) is 0, so a reply missing its stake would come through as a
    // real bet of nothing — one bet, no turnover, booked as a loss because a
    // zero return is a loss. That is the same shape as the unreadable-stake
    // bug the table scraper already had to be fixed for.
    if (!id || typeof amount !== 'number' || !Number.isFinite(amount)
      || typeof multiplier !== 'number' || !Number.isFinite(multiplier)) {
      return { rows: [], currency: null, mismatch: null };
    }

    const gross = amount * multiplier;
    const settled = round.active !== true;

    // Only worth comparing once there is money on it: at a zero stake every
    // reading of every field is zero and agrees with all the others.
    const stated = Number(round?.payout);
    const mismatch = settled && amount > 0 && Number.isFinite(stated)
      && Math.abs(stated - gross) > Math.max(1e-8, gross * 1e-6)
      ? { id, amount, multiplier, computed: gross, stated }
      : null;

    return {
      rows: [{
        id,
        game: gameName(round.game),
        amount,
        // `ingest` reads a payout at or below zero as a loss, which is what a
        // busted round is: multiplier 0, so gross 0.
        payout: gross,
        settled,
      }],
      currency: String(round?.currency || '').toUpperCase() || null,
      mismatch,
    };
  }

  const API = {
    MY_BETS_HEADERS, parseCell, findMyBetsTable, scrapeBets,
    SITES, siteFor, DUEL_HOSTS, STAKE_HOSTS,
    DUEL_CURRENCIES, DUEL_BET_KEY_RE, duelSettled, betsFromDuel,
    gameName, betsFromStakeGame,
  };

  // In the page: a global in the content script's isolated world, read by
  // content.js. In Node: a CommonJS export, read by the test harness. The guard
  // is what lets one file be both.
  root.StakeScrape = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
