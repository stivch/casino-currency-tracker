// Runs in the PAGE's own JavaScript world, not the extension's.
//
// Why it has to: the casino's own API is authenticated by credentials that only
// exist inside the page — an access token Stake's app attaches as a header, a
// session cookie on Duel — and the responses it already receives are the only
// place several of these figures exist at all. This script wraps the page's own
// `fetch`, so it can read what the app already asks for, and, when asked to,
// repeat one of those exact requests.
//
// What it deliberately does NOT do: hand credentials to anything. On Stake the
// captured headers stay in this closure, in the page where they already live.
// On Duel nothing is captured at all — the session is a cookie, which the
// browser attaches by itself. Only extracted figures — a rakeback balance, a
// VIP tier, a bet's stake and payout — are posted to the extension.
// `window.postMessage` is readable by every script on the page, so nothing
// secret and nothing surplus is ever put on it.
//
// Reading is passive by default: whatever the app fetches, we see. Polling is a
// separate opt-in, runs only while the tab is visible and focused, and on Stake
// replays the page's own request body verbatim rather than inventing a query.

(() => {
  'use strict';

  if (window.__stakeIlsBridge) return;
  window.__stakeIlsBridge = true;

  const CHANNEL = 'stake-ils-bridge';

  const nativeFetch = window.fetch;

  const post = (kind, payload) => {
    try {
      window.postMessage({ channel: CHANNEL, kind, ...payload }, window.location.origin);
    } catch {
      // A page that has navigated away is not worth reporting to.
    }
  };

  /**
   * What the API complained about, if it complained. A 200 carrying nothing but
   * an `errors` array is the quietest way this can fail — the request goes out,
   * the reply comes back, and there is simply no account data in it — so the
   * reason is dug out rather than left to be inferred from a display that did
   * not move.
   */
  function complaint(json) {
    const first = Array.isArray(json?.errors) ? json.errors[0] : null;
    const message = first?.message || first?.errorType || json?.message;
    return message ? String(message).slice(0, 120) : null;
  }

  // ============================================================ Stake
  //
  // One GraphQL endpoint, authenticated by a header the app attaches. Reading
  // means watching for two named operations going past; refreshing means
  // replaying one of them with the headers it carried.

  const STAKE = (() => {
    const ENDPOINT = '/_api/graphql';

    /** The account operations worth reading. Anything else is left alone. */
    const OPERATIONS = ['VipMeta', 'VipProgressMeta', 'UserBalances'];

    /**
     * The price table Stake's app uses to draw every figure on the page. Public
     * data, no account in it, and re-fetched every few tens of seconds — so it
     * is read on a switch of its own, and never replayed: there is no need to
     * ask for something that arrives on its own that often.
     */
    const RATE_OPERATION = 'CurrencyConfiguration';

    // Used only if the page has not made the request itself yet. Trimmed to the
    // fields actually displayed.
    const FALLBACK_QUERY = {
      VipMeta: 'query VipMeta { user { id rakeback { enabled balances { currency availableAmount } } } }',
      VipProgressMeta: 'query VipProgressMeta { user { id flagProgress { flag progress } } } ',
      // Cut to `available` — the wallet bets are actually placed from. The real
      // query asks for `vault` beside it, and that is deliberately not asked
      // for here: nothing reads it yet, and a replay should ask for what gets
      // used rather than for everything the app happens to want.
      UserBalances: 'query UserBalances { user { id balances { available { amount currency } } } }',
    };

    // Everything Stake's own request carries that is not the browser's business.
    // Cookies are added by the browser; content-length is recomputed.
    const REPLAYABLE = /^(content-type|authorization|x-[\w-]+)$/;

    const captured = { headers: null, bodies: {} };

    /**
     * Pull just the two figures out of a response. Everything else is ignored.
     *
     * `forced` rides along to say this reading was asked for rather than
     * noticed, which is the difference between "these figures changed" and
     * "these figures are current as of now" — and the extension stores the
     * second even when the numbers are identical.
     */
    function harvest(json, forced = false) {
      const user = json?.data?.user;
      if (!user) return false;

      const meta = {};

      if (Array.isArray(user.rakeback?.balances)) {
        meta.rakeback = user.rakeback.balances
          .map((row) => ({ currency: String(row?.currency || '').toUpperCase(), amount: Number(row?.availableAmount) }))
          .filter((row) => row.currency && Number.isFinite(row.amount));
      }

      if (user.flagProgress) {
        const progress = Number(user.flagProgress.progress);
        if (Number.isFinite(progress)) {
          meta.vip = { flag: String(user.flagProgress.flag || ''), progress };
        }
      }

      /**
       * The wallet, from Stake's own books rather than off the page.
       *
       * `available` only. `vault` is money that has been put aside and cannot
       * be bet from, so adding the two would produce a wallet figure the
       * balance cross-check would then find disagreeing with the bet ledger by
       * exactly the amount in the vault.
       *
       * Zeroes are dropped, and that is not merely a size cut — the reply
       * enumerates *every* currency Stake supports, about a hundred and eighty
       * of them, essentially all zero. Because it is exhaustive, a coin missing
       * from what is sent means zero rather than unknown, which is what lets
       * the reader treat the short list as the whole truth. Sending all of it
       * would put a hundred and eighty rows on a bus every script on the page
       * can read, once per capture, to say almost nothing.
       */
      if (Array.isArray(user.balances)) {
        const balances = user.balances
          .map((row) => ({
            currency: String(row?.available?.currency || '').toUpperCase(),
            amount: Number(row?.available?.amount),
          }))
          .filter((row) => row.currency && Number.isFinite(row.amount) && row.amount > 0);

        // An account holding nothing anywhere is a real answer, and the empty
        // array is how it is said — so this is keyed on the field being there,
        // not on the filtered list having survived.
        meta.balances = balances;
      }

      const found = Object.keys(meta).length > 0;
      if (found) post('meta', { meta, forced });
      return found;
    }

    /**
     * Stake's own price table, as it goes past. Nothing is derived here — which
     * way round a baseRate reads is decided in lib/rates.js, where it can be
     * tested; this side only forwards what it saw.
     */
    function harvestRates(json) {
      const base = json?.data?.currencyConfiguration?.baseRates;
      if (!Array.isArray(base) || base.length === 0) return;

      const rates = base
        .map((row) => ({ currency: String(row?.currency || '').toUpperCase(), baseRate: Number(row?.baseRate) }))
        .filter((row) => row.currency && Number.isFinite(row.baseRate) && row.baseRate > 0);

      if (rates.length) post('rates', { source: 'stake', rates });
    }

    // ------------------------------------------------- Stake's own games
    //
    // Stake's originals are driven by REST, one endpoint per action:
    //   /_api/casino/mines/bet      opens a round
    //   /_api/casino/mines/next     reveals a tile, round still open
    //   /_api/casino/mines/cashout  settles it
    //
    // Every reply carries the same envelope — {<action>: {id, active, game,
    // currency, amount, payoutMultiplier, …}} — with only `state` differing
    // between games, and `state` is the one part the accounting does not need.
    // So one reader covers every original rather than one per game.
    //
    // Read only. These are the endpoints that place and settle real bets, and
    // nothing here ever sends one: see the matching test in tools/bridgetest.
    const CASINO_PATH = '/_api/casino/';

    /**
     * The round object out of a reply, whatever the action wrapped it in.
     *
     * Found by shape rather than by a list of key names, so an action nobody
     * has seen yet — blackjack's hit and stand, a game added next year — is
     * read rather than ignored. Everything the accounting needs must be
     * present and the right type, or this is not a round.
     */
    function roundOf(json) {
      for (const value of Object.values(json || {})) {
        if (!value || typeof value !== 'object') continue;
        if (typeof value.id !== 'string' || !value.id) continue;
        if (typeof value.active !== 'boolean') continue;
        if (typeof value.game !== 'string' || !value.game) continue;
        // Typed, not coerced: Number(null) is 0, and a round whose stake is
        // missing must be refused here rather than forwarded as a free bet.
        if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) continue;
        if (typeof value.payoutMultiplier !== 'number' || !Number.isFinite(value.payoutMultiplier)) continue;
        return value;
      }
      return null;
    }

    /**
     * Forward one round, cut to the fields the accounting uses.
     *
     * The reply also carries `user` — an account id and the player's name —
     * and `state`, the full board with every revealed tile. Neither is any of
     * the extension's business, and this bus is readable by every script on
     * the page, so the narrowing happens here rather than after broadcasting.
     */
    /** The game a casino path belongs to: /_api/casino/mines/bet -> "mines". */
    function gameFromPath(url) {
      const match = /\/_api\/casino\/([^/?#]+)/.exec(String(url || ''));
      return match ? match[1] : '';
    }

    /**
     * Did this reply look like a round we simply could not read?
     *
     * Only a near miss is worth reporting. Something under /_api/casino/ that
     * carries no `game` at all is a game list or a config blob, not a round —
     * complaining about those would bury the one case that matters under
     * noise. A payload that names a game and still will not parse is a game
     * this extension is not counting, which is exactly the silent failure the
     * whole ledger design exists to avoid.
     */
    function looksLikeRound(json) {
      for (const value of Object.values(json || {})) {
        if (value && typeof value === 'object' && typeof value.game === 'string' && value.game) return true;
      }
      return false;
    }

    function harvestRound(json, url) {
      const round = roundOf(json);
      if (!round) {
        if (looksLikeRound(json)) {
          const game = gameFromPath(url);
          post('problem', {
            message: `${game || 'a game'}: a round went past that this could not read, so it is not being counted.`,
          });
        }
        return;
      }

      post('round', {
        round: {
          id: round.id,
          game: round.game,
          currency: String(round.currency || ''),
          amount: Number(round.amount),
          payoutMultiplier: Number(round.payoutMultiplier),
          // Stake's own figure. Not what the return is computed from — see
          // betsFromStakeGame — but carried so the two can be compared, since
          // whether it is gross or net cannot be told from a zero-stake round.
          payout: Number(round.payout),
          active: round.active === true,
        },
      });
    }

    function operationOf(body) {
      return OPERATIONS.find((name) => body.includes(name)) || null;
    }

    /** Keep the headers and the exact body, so a poll can repeat a real request. */
    function remember(input, init, body) {
      const headers = {};
      const source = init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : null);

      const add = (key, value) => {
        const name = String(key).toLowerCase();
        if (REPLAYABLE.test(name)) headers[name] = value;
      };

      if (source) {
        if (typeof source.forEach === 'function') source.forEach((value, key) => add(key, value));
        else if (Array.isArray(source)) for (const [key, value] of source) add(key, value);
        else for (const [key, value] of Object.entries(source)) add(key, value);
      }

      if (Object.keys(headers).length) captured.headers = headers;

      const operation = body && operationOf(body);
      if (operation) captured.bodies[operation] = body;
    }

    return {
      id: 'stake',
      name: 'Stake',

      // Stake's ledger is the table on the page; nothing here reads bets.
      readsBets: false,

      /** Watch one outgoing request. Returns true if its reply is worth reading. */
      inspect({ url, input, init, body, wants }) {
        // A game action. Recognised by path alone — these carry no operation
        // name — and deliberately checked before the GraphQL branch so a
        // casino path can never reach the header capture below.
        if (url.includes(CASINO_PATH)) return wants.bets ? 'round' : null;

        if (!url.includes(ENDPOINT)) return null;

        // Only a string body can be read without consuming the request. Stake
        // sends one; anything else is left alone rather than risk breaking the
        // app's own call to read it.
        if (!body) return null;

        // Headers are kept only for the account operations, because those are
        // the only ones ever replayed. Reading the price table asks for
        // nothing, so switching it on never puts an access token in this
        // closure.
        //
        // The operation check comes first deliberately. Capturing on any
        // request to this endpoint would put a token in reach of a page that
        // merely has a matching URL in it, and it buys nothing: a replay needs
        // the operation's own body, which is only ever recorded here, so
        // headers taken without one could never be used.
        if (wants.account && OPERATIONS.some((name) => body.includes(name))) {
          try {
            remember(input, init, body);
          } catch {
            // Never let bookkeeping break the page's request.
          }
          return 'account';
        }
        if (wants.rates && body.includes(RATE_OPERATION)) return 'rates';
        return null;
      },

      /** Read a reply the inspector marked as interesting. */
      absorb(what, json, wants, url) {
        // A game reply is nothing like a GraphQL one, so it is routed by what
        // the inspector decided rather than tried against both readers.
        if (what === 'round') {
          if (wants.bets) harvestRound(json, url);
          return;
        }
        if (wants.account) harvest(json);
        if (wants.rates) harvestRates(json);
      },

      /**
       * One round of asking for the account figures, because a timer fired or
       * somebody clicked. Returns null on success, or the reason it did not
       * work — see `ended` for why that reason has to travel back.
       */
      async readAccount({ forced }) {
        if (!captured.headers) {
          // Nothing has been seen to replay yet: either reading was only just
          // switched on, or this page load predates it.
          return 'no Stake request seen yet — reload the page and try again';
        }

        let read = 0;
        let why = null;

        for (const operation of OPERATIONS) {
          const replayed = Boolean(captured.bodies[operation]);
          const body = captured.bodies[operation]
            || JSON.stringify({ query: FALLBACK_QUERY[operation], variables: {} });

          const response = await nativeFetch(ENDPOINT, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', ...captured.headers },
            body,
          });

          // Stop the whole round on a refusal rather than trying the next
          // query: a 401 or a 429 is about the connection, not this operation.
          if (!response.ok) return `Stake answered HTTP ${response.status}`;

          // A 200 that carries no `user` is the failure worth naming: the reply
          // arrived and held nothing. Keep going — the other operation may
          // still answer — but remember why this one did not.
          const json = await response.json();
          if (harvest(json, forced)) read++;
          else {
            why = complaint(json)
              || `${operation} came back with no account data${replayed ? '' : ' (asked with our own query, not Stake’s)'}`;
          }
        }

        return read > 0 ? null : why || 'the reply carried no rakeback or VIP figures';
      },
    };
  })();

  // ============================================================= Duel
  //
  // Plain REST on the page's own origin, authenticated by a cookie the browser
  // attaches itself — so there is nothing to capture and nothing to replay, and
  // a request of ours is the same request the app makes.
  //
  // What is read, and from where:
  //   /api/v2/metadata/exchange-rates   the price table — public, no account
  //   /api/v2/user/rakeback             the claimable rakeback balance
  //   /api/v2/user                      the level, and which coin the wallet is
  //   /api/v2/user/transactions         the bet ledger
  //
  // The last one is the one Stake does not need: Duel has no bet table on the
  // page, so a session cannot be tracked by watching markup. See `readBets`.

  const DUEL = (() => {
    const RATES = '/api/v2/metadata/exchange-rates';
    const RAKEBACK = '/api/v2/user/rakeback';
    const USER = '/api/v2/user';
    const TRANSACTIONS = '/api/v2/user/transactions';

    /** Duel's currency ids. Third copy of the map; see lib/rates.js for why. */
    const CURRENCIES = {
      101: 'BTC', 102: 'BCH', 103: 'ETH', 104: 'LTC', 105: 'USDT', 106: 'USDC',
      107: 'BNB', 108: 'TRX', 109: 'SOL', 110: 'XRP', 111: 'DOGE', 112: 'ADA',
      113: 'LINK', 114: 'AVAX', 115: 'XLM', 116: 'TON', 117: 'HBAR', 118: 'DOT',
    };

    /** Which ledger rows are bets. Same rule as lib/scrape.js, and the same why. */
    const BET_KEY_RE = /_(rounds|bets|spins)$/;

    /** The path of a URL, whether it arrived absolute or relative. */
    function pathOf(url) {
      try {
        return new URL(url, window.location.origin).pathname;
      } catch {
        return String(url).split('?')[0];
      }
    }

    /**
     * The claimable rakeback balance.
     *
     * Duel quotes one figure — `data.total` — and does not say what in. Every
     * amount it displays is a dollar one, so it is labelled USD and priced with
     * the dollar rate, which is what the site's own display means by it. The
     * per-pool breakdown beside it is left alone: it was empty on every account
     * this was written against, and reading a shape nobody has seen is how you
     * get a confident wrong number.
     */
    function harvestRakeback(json, forced) {
      const total = Number(json?.data?.total);
      if (!Number.isFinite(total)) return false;
      post('meta', { meta: { rakeback: [{ currency: 'USD', amount: total }] }, forced });
      return true;
    }

    /**
     * The level, and which coin the wallet is in.
     *
     * Duel has levels rather than Stake's fractional progress to the next tier,
     * so there is no percentage to send and the overlay shows the tier alone.
     * Inventing a fraction out of the xp figure would need the curve behind it,
     * which is not published.
     */
    function harvestUser(json, forced) {
      const meta = {};

      const level = Number(json?.levels_data?.level ?? json?.level);
      if (Number.isFinite(level)) meta.vip = { flag: `Level ${level}`, progress: null };

      const wallet = CURRENCIES[Number(json?.default_balance_type)];
      if (wallet) meta.wallet = wallet;

      if (!Object.keys(meta).length) return false;
      post('meta', { meta, forced });
      return true;
    }

    /**
     * The price table, forwarded as it arrived. Both halves of it are quoted
     * against different things and reconciling them is lib/rates.js's job, for
     * the same reason Stake's orientation is: it is testable there.
     */
    function harvestRates(json) {
      if (!json?.rates || !json?.crypto_rates) return;
      post('rates', { source: 'duel', rates: { rates: json.rates, crypto_rates: json.crypto_rates } });
    }

    /**
     * Bets out of one page of the transaction feed.
     *
     * Trimmed to what the accounting uses before it goes anywhere. The full
     * feed carries running balances, invoice ids and server seeds, and this bus
     * is readable by every script on the page — so the narrowing happens here,
     * on the side that already has the data, rather than after it has been
     * broadcast. Normalising what is left is lib/scrape.js's job.
     *
     * `data.id` is the round, and it is the field that makes the difference
     * between a bet list and a balance ledger: a won round writes two lines and
     * both carry it. `data.amount_currency` and `data.amount_won` are that
     * round's stake and gross return, and `data.status` says whether it has
     * finished. Nothing else in `data` is anyone's business.
     */
    function harvestBets(json) {
      const feed = Array.isArray(json?.data) ? json.data : [];
      const rows = [];

      for (const entry of feed) {
        if (!BET_KEY_RE.test(String(entry?.key || ''))) continue;
        rows.push({
          key: entry.key,
          type: entry.type,
          amount_currency: entry.amount_currency,
          currency: entry.currency,
          data: {
            id: entry?.data?.id,
            status: entry?.data?.status,
            amount_currency: entry?.data?.amount_currency,
            amount_won: entry?.data?.amount_won,
          },
        });
      }

      if (rows.length) post('bets', { feed: rows });
    }

    /** GET one of ours, on the cookie the browser attaches by itself. */
    async function get(path) {
      const response = await nativeFetch(path, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const error = new Error(`Duel answered HTTP ${response.status}`);
        error.handled = true;
        throw error;
      }
      return response.json();
    }

    return {
      id: 'duel',
      name: 'Duel',

      // Duel's ledger is an API, so this side is the only thing that can read
      // a bet at all.
      readsBets: true,

      inspect({ url, wants }) {
        const path = pathOf(url);
        if (wants.rates && path === RATES) return 'rates';
        if (wants.account && (path === RAKEBACK || path === USER)) return 'account';
        if (wants.bets && path === TRANSACTIONS) return 'bets';
        return null;
      },

      absorb(what, json) {
        if (what === 'rates') harvestRates(json);
        else if (what === 'bets') harvestBets(json);
        else if (what === 'account') {
          // One handler per shape, and neither minds being handed the other's
          // reply: whichever of the two this was, only its own reader matches.
          harvestRakeback(json, false);
          harvestUser(json, false);
        }
      },

      async readAccount({ forced }) {
        let read = 0;
        if (harvestRakeback(await get(RAKEBACK), forced)) read++;
        if (harvestUser(await get(USER), forced)) read++;
        return read > 0 ? null : 'the reply carried no rakeback or level figures';
      },

      /**
       * Ask for the newest page of the ledger.
       *
       * This is the one thing the extension does on Duel that it does not do on
       * Stake, and it is not free: Stake publishes the bets as markup, so they
       * can be watched, while Duel only answers when asked. Page one is twenty
       * rows — the same "top of the list" the Stake scraper reads — and it is
       * only ever asked for while the tab is both visible and focused.
       */
      async readBets() {
        harvestBets(await get(TRANSACTIONS));
      },

      /**
       * Ask for the price table.
       *
       * Stake's app re-fetches its own every few tens of seconds, so there is
       * never a reason to ask; Duel's is fetched once when the page loads and
       * then not again, which would leave the reading permanently stale and the
       * feature permanently unused. This endpoint carries no account data and
       * needs no session, so asking for it says nothing about anyone — and it
       * is still gated on the tab being visible and focused.
       */
      async readRates() {
        harvestRates(await get(RATES));
      },
    };
  })();

  // ========================================================= the wrap

  // Which adapter this page gets. Mirrors are named here in full rather than
  // matched loosely: an unrecognised Duel host falls to STAKE, whose readers
  // then find nothing and report no fault, which is the quietest way this can
  // fail. The same list lives in siteFor() in lib/scrape.js — this script runs
  // in the page's world and can read neither that file nor the extension, so
  // the copy is forced; tools/domtest.mjs checks the two agree.
  const DUEL_HOSTS = /(^|\.)duel\.(com|limited|vip|net)$/i;

  const ADAPTERS = { stake: STAKE, duel: DUEL };

  // The hostname answers for every built-in domain. A user-added mirror it
  // cannot answer for at all, so the content script — which can read settings —
  // names the site on the config message and this is replaced before anything
  // is read.
  //
  // Waiting for that config costs nothing: `wants` starts all-false and the
  // fetch wrapper returns before touching the adapter until it is configured,
  // so there is no window in which the wrong one can inspect a request.
  let SITE = DUEL_HOSTS.test(window.location.hostname) ? DUEL : STAKE;

  const wants = { account: false, rates: false, bets: false };
  let accountTimer = null;
  let betTimer = null;
  let rateTimer = null;

  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input?.url || '';
    } catch {
      url = '';
    }

    const result = nativeFetch.apply(this, arguments);
    if (!wants.account && !wants.rates && !wants.bets) return result;

    // Only a string body can be read without consuming the request.
    const body = typeof init?.body === 'string' ? init.body : null;

    let what = null;
    try {
      what = SITE.inspect({ url, input, init, body, wants });
    } catch {
      // An unreadable request is not a reason to break the page's own call.
      what = null;
    }
    if (!what) return result;

    return result.then((response) => {
      try {
        response.clone().json().then((json) => {
          try {
            SITE.absorb(what, json, wants, url);
          } catch (error) {
            post('problem', { message: `reading ${what}: ${String(error?.message || error).slice(0, 100)}` });
          }
        }).catch(() => {});
      } catch {
        // A body already consumed elsewhere, or not JSON. Nothing to read.
      }
      return response;
    });
  };

  // ---------------------------------------------------------------- polling

  /**
   * Why a round ended. Always to diagnostics; and to the UI as well when a
   * click is sitting there waiting for it.
   *
   * A timer that quietly gives up costs nothing. A button that quietly gives up
   * is indistinguishable from one that is not wired to anything — every way
   * this can fail sends the request and then displays the same unchanged
   * number, so the reason has to travel back to where the click happened.
   */
  function ended(forced, message) {
    if (message) post('problem', { message: `rakeback ${forced ? 'refresh' : 'poll'}: ${message}` });
    if (forced) post('refresh', { ok: !message, message: message || null });
  }

  /**
   * Only while you are actually looking at the casino. A background tab does
   * not need a fresher rakeback figure, and quiet tabs making timed API calls
   * is exactly the traffic pattern worth not generating.
   *
   * A forced round drops the focus half of that gate: it is a click, and one of
   * the two places it can be clicked is the popup, which takes focus off the
   * page by definition. Visible is still required — a hidden tab was not the
   * one being asked.
   */
  function watching(forced) {
    if (document.visibilityState !== 'visible') return false;
    return forced || document.hasFocus();
  }

  async function pollOnce({ forced = false } = {}) {
    if (!watching(forced)) return;

    try {
      ended(forced, await SITE.readAccount({ forced }));
    } catch (error) {
      ended(forced, String(error?.message || error).slice(0, 120));
    }
  }

  async function pollBets() {
    if (!SITE.readsBets || !watching(false)) return;
    try {
      await SITE.readBets();
    } catch (error) {
      post('problem', { message: `bet ledger: ${String(error?.message || error).slice(0, 120)}` });
    }
  }

  async function pollRates() {
    if (!SITE.readRates || !watching(false)) return;
    try {
      await SITE.readRates();
    } catch (error) {
      post('problem', { message: `price table: ${String(error?.message || error).slice(0, 120)}` });
    }
  }

  // Floored well above anything that would look like hammering.
  const every = (fn, seconds, floor) => setInterval(fn, Math.max(floor, Number(seconds) || floor) * 1000);

  function configure(config) {
    // Before anything reads SITE below: wants.bets is decided by the adapter's
    // own capability, so choosing the adapter second would gate the new site's
    // ledger on the old site's answer.
    if (config.site && ADAPTERS[config.site]) SITE = ADAPTERS[config.site];

    wants.account = Boolean(config.capture);
    wants.rates = Boolean(config.rates);
    // "Interested in bets", which is not the same as "polls for them". Stake's
    // rounds go past on their own and are only watched; Duel's have to be
    // asked for, and that is what readsBets gates below.
    wants.bets = Boolean(config.bets);

    clearInterval(accountTimer);
    clearInterval(betTimer);
    clearInterval(rateTimer);
    accountTimer = null;
    betTimer = null;
    rateTimer = null;

    if (wants.account && config.poll) accountTimer = every(pollOnce, config.seconds, 30);

    // The bet poll is not a separate opt-in the way the account one is, because
    // on Duel it is the only way a session exists at all — switching session
    // tracking on and having it read nothing would be worse than the request.
    // It still only fires while the tab is visible and focused.
    if (wants.bets && SITE.readsBets) {
      betTimer = every(pollBets, config.betSeconds, 10);
      pollBets();
    }

    // Likewise: a site that publishes its price table once per page load has to
    // be asked, or the reading is stale before it is ever used. Only where the
    // site does not re-fetch it on its own — SITE.readRates is undefined on
    // Stake, whose app asks every few seconds anyway.
    if (wants.rates && SITE.readRates) rateTimer = every(pollRates, config.seconds, 30);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.kind === 'config') {
      configure(data);
      return;
    }

    // One round, now, because somebody asked for it. It needs reading to be on,
    // since that is where the request being replayed came from, but not the
    // minute poll — asking once is the thing you do *instead* of leaving a timer
    // running, so requiring the timer to be on would defeat it.
    if (data.kind === 'poll' && wants.account) pollOnce({ forced: true });
  });
})();
