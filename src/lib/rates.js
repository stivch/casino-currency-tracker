// Rate providers, tried in order. Both are keyless and CORS-open, which is the
// whole reason they were picked: an extension that needs an API key is an
// extension you have to re-provision every time you reinstall it.

const TIMEOUT_MS = 8000;

/**
 * The coins Stake pays in, and what CoinGecko calls them.
 *
 * These ride along in the USDT request rather than costing calls of their own:
 * /simple/price takes a comma-separated id list, so pricing fourteen coins is
 * the same one request per refresh that pricing one was. Without them a BTC
 * session shows "no BTC rate" and none of the money limits can apply to it.
 */
const COIN_IDS = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  litecoin: 'LTC',
  dogecoin: 'DOGE',
  ripple: 'XRP',
  tron: 'TRX',
  solana: 'SOL',
  cardano: 'ADA',
  binancecoin: 'BNB',
  'bitcoin-cash': 'BCH',
  'shiba-inu': 'SHIB',
  chainlink: 'LINK',
  'matic-network': 'POL',
  'the-open-network': 'TON',
};

const PRICE_IDS = ['tether', ...Object.keys(COIN_IDS)].join(',');

/** Ticker -> target currency for every id that came back with a usable number. */
function readCoins(json, vs) {
  const coins = {};
  for (const [id, ticker] of Object.entries(COIN_IDS)) {
    const price = json?.[id]?.[vs];
    if (typeof price === 'number' && price > 0) coins[ticker] = price;
  }
  return coins;
}

// Both providers take the target as a parameter rather than carrying a currency
// of their own: CoinGecko's /simple/price accepts a vs_currencies list, and
// exchangerate-api's USD-base response already contains every fiat there is. So
// converting into a different currency is the same one request either way — the
// target only decides which column is read out of it.
const PROVIDERS = [
  {
    id: 'coingecko',
    label: 'CoinGecko',
    detail: (target) => `USDT priced in USD, converted to ${target}`,
    // A Demo key rides on the same host as the keyless API — only the header
    // differs. Pro would be pro-api.coingecko.com with x-cg-pro-api-key.
    acceptsDemoKey: true,
    // USD rides along beside the target for the same one request. It is what a
    // closed session is frozen at so its history can be restated in any
    // currency later — see archiveEntry — and asking for two vs_currencies
    // costs exactly what asking for one did.
    url: (target) => {
      const vs = [...new Set([target.toLowerCase(), 'usd'])].join(',');
      return `https://api.coingecko.com/api/v3/simple/price?ids=${PRICE_IDS}`
        + `&vs_currencies=${vs}&include_last_updated_at=true`;
    },
    parse(json, target) {
      const vs = target.toLowerCase();
      const rate = json?.tether?.[vs];
      if (typeof rate !== 'number' || !(rate > 0)) {
        throw new Error(`coingecko: response had no numeric tether.${vs}`);
      }
      return {
        rate,
        // A missing coin is not a failed fetch: the USDT rate is what the
        // extension is for, and the rest are a bonus that degrades to "no rate
        // for this coin" on its own.
        coins: readCoins(json, vs),
        coinsUsd: readCoins(json, 'usd'),
        quotedAt: json.tether.last_updated_at ? json.tether.last_updated_at * 1000 : Date.now(),
        approximate: false,
      };
    },
  },
  {
    id: 'er-api',
    label: 'exchangerate-api',
    detail: (target) => `USD/${target}, USDT taken as $1`,
    url: () => 'https://open.er-api.com/v6/latest/USD',
    parse(json, target) {
      const rate = json?.rates?.[target];
      if (typeof rate !== 'number' || !(rate > 0)) {
        throw new Error(`er-api: response had no numeric rates.${target}`);
      }
      // Flagged approximate because it prices the dollar, not the token. USDT
      // has held its peg within a fraction of a percent for years, but the UI
      // says so rather than quietly rounding the distinction away.
      return {
        rate,
        // A dollar feed prices the dollar and nothing else. Coin sessions go
        // back to showing coin units until CoinGecko answers again.
        coins: {},
        coinsUsd: {},
        // The whole USD-per-fiat table, which arrived in this one response
        // whether we wanted it or not. A closed session stores it so its figures
        // can be restated in any currency; capturing it here means the common
        // case costs no request of its own.
        fiat: json.rates,
        quotedAt: json.time_last_update_unix ? json.time_last_update_unix * 1000 : Date.now(),
        nextUpdate: json.time_next_update_unix ? json.time_next_update_unix * 1000 : null,
        approximate: true,
      };
    },
  },
];

/**
 * The USD-per-fiat table on its own.
 *
 * Asked for when a session is filed and the cached table is too old to be the
 * one that applied. One response carries every currency, so a session recorded
 * today stays restateable into any of them for as long as it is kept — which is
 * the whole reason the target is not baked into history.
 */
export async function fetchFiatTable() {
  const json = await fetchJson('https://open.er-api.com/v6/latest/USD');
  const rates = json?.rates;
  if (!rates || typeof rates !== 'object' || !(Number(rates.EUR) > 0)) {
    throw new Error('er-api: response carried no usable rates table');
  }
  return {
    rates,
    quotedAt: json.time_last_update_unix ? json.time_last_update_unix * 1000 : Date.now(),
    nextUpdate: json.time_next_update_unix ? json.time_next_update_unix * 1000 : null,
  };
}

// -------------------------------------------------------- the site's own table
//
// Stake's app fetches `currencyConfiguration` to price everything it displays:
// a flat list of {currency, baseRate} covering every coin it pays in and every
// fiat it can show. It is public data — no account in it — and the app
// re-fetches it every few tens of seconds, which makes reading it both fresher
// than a one-minute poll and free of any request of ours.
//
// A target the table does not carry is refused for that target, and the
// providers answer instead. The table is not disabled for everyone else by one
// currency being missing from it.
//
// Reading it also means the extension converts with the same numbers Stake used
// to draw the balance on screen, rather than a third party's view of the same
// market a minute later.
//
// Duel publishes the same thing in a different shape — see ratesFromDuel, which
// normalises it and hands it to the reader below rather than repeating the
// orientation logic.

/** Which way round a baseRate reads. See orientationOf. */
const PER_UNIT = 'per-unit'; // baseRate = dollars for one unit
const PER_DOLLAR = 'per-dollar'; // baseRate = units for one dollar

/**
 * Whether these baseRates are dollars-per-unit or units-per-dollar.
 *
 * Nothing documents which, and getting it backwards would not fail — it would
 * produce a confident rate that is the reciprocal of the real one. So it is
 * read off the table instead of assumed, and the thing it is read against is
 * BTC versus the target fiat. That pairing settles the question by at least
 * four orders of magnitude in either direction *for every fiat there is*: no
 * currency is worth more than a few dollars a unit, and none is worth so little
 * that a bitcoin's price in it comes anywhere near one. An inconclusive table is
 * refused rather than guessed at.
 *
 * @param fiat  The target's baseRate — the anchor, whichever currency it is.
 */
function orientationOf(fiat, btc) {
  const ratio = btc / fiat;
  if (ratio > 100) return PER_UNIT;
  if (ratio < 0.01) return PER_DOLLAR;
  return null;
}

/**
 * Target-currency units per coin for everything in one of Stake's baseRates
 * tables.
 *
 * @param baseRates  The array as Stake sends it: [{currency, baseRate}, …].
 * @param target     The fiat to convert into, ISO 4217.
 * @returns {{rate:number, coins:Record<string,number>, orientation:string, target:string, currencies:number}|null}
 *          null when the table cannot be read with confidence for this target —
 *          no row for it, no USDT row, or an orientation that will not resolve.
 *          The caller falls through to the providers; the table is not thrown
 *          away for coins or for anybody else's target.
 */
export function ratesFromStake(baseRates, target = 'ILS') {
  const code = String(target || 'ILS').toUpperCase();

  const table = {};
  for (const row of Array.isArray(baseRates) ? baseRates : []) {
    const ticker = String(row?.currency || '').toUpperCase();
    const value = Number(row?.baseRate);
    if (ticker && Number.isFinite(value) && value > 0) table[ticker] = value;
  }

  // USDT is the token this converts from; USD and USDC stand in for it if the
  // table ever drops it, since all three are the same dollar to four decimals.
  const usd = table.USDT ?? table.USD ?? table.USDC;
  const fiat = table[code];
  const btc = table.BTC;
  if (!usd || !fiat || !btc) return null;

  const orientation = orientationOf(fiat, btc);
  if (!orientation) return null;

  // Both orientations reduce to the same shape, which is the useful part: one
  // is value/fiat, the other fiat/value, and either way the answer is target
  // units for one unit of that currency.
  const priceOf = (value) => (orientation === PER_UNIT ? value / fiat : fiat / value);

  // Dollars for one unit, which is what the table is already quoted in one way
  // round or the other. Carried alongside because a session frozen at close
  // stores its coin's dollar price — that is what lets its figures be restated
  // in a currency the player had not chosen yet.
  const dollarsOf = (value) => (orientation === PER_UNIT ? value : 1 / value);

  const coins = {};
  const coinsUsd = {};
  for (const [ticker, value] of Object.entries(table)) {
    const priced = priceOf(value);
    if (Number.isFinite(priced) && priced > 0) coins[ticker] = priced;
    const dollars = dollarsOf(value);
    if (Number.isFinite(dollars) && dollars > 0) coinsUsd[ticker] = dollars;
  }

  const rate = priceOf(usd);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  return { rate, coins, coinsUsd, orientation, target: code, currencies: Object.keys(table).length };
}

/**
 * Duel's currency ids, as its own bundle enumerates them. The wire format is
 * numeric — `crypto_rates` is keyed by id, and so is a transaction's `currency`
 * — so nothing can be read out of it without this.
 *
 * lib/scrape.js carries a second copy for the bet ledger. Content scripts
 * cannot import modules, which is the same reason content.js repeats the
 * formatting helpers; both copies are exercised by the tests in tools/.
 */
export const DUEL_CURRENCIES = {
  101: 'BTC', 102: 'BCH', 103: 'ETH', 104: 'LTC', 105: 'USDT', 106: 'USDC',
  107: 'BNB', 108: 'TRX', 109: 'SOL', 110: 'XRP', 111: 'DOGE', 112: 'ADA',
  113: 'LINK', 114: 'AVAX', 115: 'XLM', 116: 'TON', 117: 'HBAR', 118: 'DOT',
};

/**
 * Target-currency units per coin for everything in Duel's
 * `/api/v2/metadata/exchange-rates`.
 *
 * Duel sends two tables in one payload and they are quoted against different
 * things, which is the whole difficulty:
 *
 *   rates:        fiat, units per EUR   — {"USD": 1.1535, "ILS": 3.5194, …}
 *   crypto_rates: coins, units per USD  — {"101": "0.0000157", "105": "1.0012"}
 *
 * Putting the target on the dollar — target/EUR ÷ USD/EUR — makes both halves
 * units per dollar, which is exactly one of the two orientations ratesFromStake
 * already knows how to read. So this converts and delegates rather than deriving
 * a rate of its own: the reciprocal trap and its four-orders-of-magnitude check
 * are worth having in one tested place, not two.
 *
 * A target with no row in the fiat half is refused — the same refusal Stake's
 * reader makes, and for the same reason: the alternative is a rate derived from
 * a currency nobody asked for.
 *
 * @returns the same shape as ratesFromStake, or null when the payload cannot be
 *          read with confidence for this target.
 */
export function ratesFromDuel(payload, target = 'ILS') {
  const code = String(target || 'ILS').toUpperCase();

  const fiat = payload?.rates;
  const crypto = payload?.crypto_rates;
  if (!fiat || typeof fiat !== 'object' || !crypto || typeof crypto !== 'object') return null;

  const usdPerEur = Number(fiat.USD);
  const targetPerEur = Number(fiat[code]);
  if (!(usdPerEur > 0) || !(targetPerEur > 0)) return null;

  const table = [{ currency: code, baseRate: targetPerEur / usdPerEur }];

  for (const [id, value] of Object.entries(crypto)) {
    const ticker = DUEL_CURRENCIES[Number(id)];
    const units = Number(value);
    if (ticker && Number.isFinite(units) && units > 0) table.push({ currency: ticker, baseRate: units });
  }

  return ratesFromStake(table, code);
}

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', headers });
    if (!response.ok) {
      // 429 is called out by name because it is the one the caller may want to
      // back off on rather than simply fall through to the next provider.
      const error = new Error(response.status === 429 ? 'HTTP 429 rate limited' : `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Validate a Demo key without spending a rate lookup. Returns null on success. */
export async function pingKey(apiKey) {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/ping', {
      cache: 'no-store',
      headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : undefined,
    });
    if (response.status === 401 || response.status === 403) return 'key rejected';
    if (response.status === 429) return 'rate limited — try again in a minute';
    if (!response.ok) return `HTTP ${response.status}`;
    return null;
  } catch (error) {
    return String(error?.message || error);
  }
}

/**
 * Walk the provider list until one answers. Every failure is kept and reported,
 * because "the rate is stale" is useless without "and here is what went wrong".
 *
 * @returns {Promise<{rate:number, coins:Record<string,number>, provider:string, providerLabel:string, providerDetail:string,
 *                    approximate:boolean, quotedAt:number, fetchedAt:number, errors:string[]}>}
 */
/**
 * @param apiKey   CoinGecko Demo key, or null.
 * @param keyMode  'primary' spends the key on every call, falling back to
 *                 keyless on a 429. 'reserve' does the opposite: go keyless
 *                 normally and only spend a key call to recover from a 429.
 *
 *                 Reserve exists because of measured behaviour. Keyless returns
 *                 429 with Retry-After: 60 once you pass roughly ten calls a
 *                 minute, while the Demo key's 10,000/month allowance cannot
 *                 survive minute-by-minute polling for even a week. Reserving
 *                 the key spends it only on the calls that keyless refused,
 *                 which is a few dozen a month rather than 44,000.
 */
export async function fetchRate({ apiKey = null, keyMode = 'primary', target = 'ILS' } = {}) {
  const errors = [];
  const code = String(target || 'ILS').toUpperCase();

  for (const provider of PROVIDERS) {
    const canKey = Boolean(apiKey && provider.acceptsDemoKey);
    const keyHeaders = canKey ? { 'x-cg-demo-api-key': apiKey } : undefined;

    // Ordered attempts for this provider. The second is only ever tried after a
    // 429, and only when it would actually be a different request.
    const attempts = !canKey
      ? [{ headers: undefined, keyed: false }]
      : keyMode === 'reserve'
        ? [{ headers: undefined, keyed: false }, { headers: keyHeaders, keyed: true }]
        : [{ headers: keyHeaders, keyed: true }, { headers: undefined, keyed: false }];

    for (const [index, attempt] of attempts.entries()) {
      try {
        const json = await fetchJson(provider.url(code), attempt.headers);
        const { rate, coins, coinsUsd, fiat, nextUpdate, quotedAt, approximate } = provider.parse(json, code);
        const detail = provider.detail(code);
        return {
          rate,
          // Stamped with what it is quoted in, so nothing downstream can show a
          // figure fetched for one currency under the label of another.
          target: code,
          coins: coins || {},
          coinsUsd: coinsUsd || {},
          // Only exchangerate-api carries this, and only because its response
          // is a fiat table already. Null everywhere else.
          fiat: fiat || null,
          fiatNextUpdate: nextUpdate || null,
          provider: provider.id,
          providerLabel: provider.label,
          providerDetail: index === 0 ? detail : `${detail} (${attempt.keyed ? 'keyed' : 'keyless'} retry)`,
          approximate,
          quotedAt,
          fetchedAt: Date.now(),
          usedKey: attempt.keyed,
          errors,
        };
      } catch (error) {
        errors.push(`${provider.id}${attempt.keyed ? ' (keyed)' : ''}: ${error?.message || error}`);
        // Only a 429 is worth re-trying against the same provider by another
        // route; a 500 or a timeout will fail the same way twice.
        if (error?.status !== 429) break;
      }
    }
  }

  throw new Error(`all rate providers failed — ${errors.join('; ')}`);
}

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);
