// Parsing and display of money. Kept deliberately dumb: no locale guessing.
// Stake renders en-US grouping ("1,234.56"), so that is the only shape we parse.

/** Matches a grouped or plain decimal number. Order matters: grouped form first. */
export const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/;

/** Tokens that make an amount unambiguously dollar-ish. USDC/USD are treated as USDT. */
export const CURRENCY_RE = /USDT|USDC|USD|₮|\$/i;

/**
 * Pull a USDT-ish amount out of a short string.
 * `assumeUnlabeled` is what lets us read Stake's header balance, which shows a
 * bare number next to a coin icon with no currency text anywhere in the node.
 * It is off by default because every other number on the page (odds, multipliers,
 * player counts) would otherwise be read as money.
 *
 * @returns {{value:number, labeled:boolean}|null}
 */
export function extractAmount(text, assumeUnlabeled = false) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) return null;

  const num = trimmed.match(NUMBER_RE);
  if (!num) return null;

  const labeled = CURRENCY_RE.test(trimmed);
  if (!labeled && !assumeUnlabeled) return null;

  const value = parseAmount(num[0]);
  if (value === null) return null;

  return { value, labeled };
}

/**
 * "1,234.56" -> 1234.56. Returns null for anything that is not a finite number.
 *
 * Currency marks are stripped along with grouping and spaces: a field labelled
 * in the target currency invites "₪1,000" or "€1,000", and rejecting exactly
 * what the label asks for is not a validation rule, it is a trap. \p{Sc} is
 * every currency sign there is, so this needs no per-currency list; a bare ISO
 * code goes too, because en-US writes several currencies that way ("CHF 1,000")
 * and that is then what the field's own placeholder invites.
 */
export function parseAmount(str) {
  if (typeof str === 'number') return Number.isFinite(str) ? str : null;
  if (!str) return null;
  const cleaned = String(str)
    .replace(/\b[A-Z]{3}\b/g, '')
    .replace(/[,\s\p{Zs}\p{Sc}]/gu, '');
  // Accepts a trailing dot so a half-typed "5." in the popup still converts.
  if (!/^\d+\.?\d*$|^\.\d+$/.test(cleaned)) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------- money display
//
// Every figure on screen is formatted through Intl.NumberFormat, and the
// currency code is the only thing that varies. That one decision buys symbol
// choice, symbol placement, grouping and each currency's own precision for
// every target at once, with no per-currency table in this repo to maintain or
// to fall out of date.
//
// en-US rather than the reader's own locale, and that is deliberate: some
// locales' currency form emits bidi control marks, which look broken inside a
// casino's left-to-right layout. Language and target currency are independent
// axes here — a figure prints "€1,234.50" whatever the interface language is.

const symbolCache = new Map();
const decimalCache = new Map();

const codeOf = (currency) => String(currency || '').toUpperCase() || 'ILS';

/** The mark en-US puts on a figure: "₪", "€", or an ISO code like "CHF". */
export function currencySymbol(currency) {
  const code = codeOf(currency);
  if (symbolCache.has(code)) return symbolCache.get(code);

  let symbol = code;
  try {
    const parts = new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code, minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).formatToParts(0);
    symbol = parts.find((part) => part.type === 'currency')?.value || code;
  } catch {
    // A code Intl does not know shows as itself rather than throwing here.
  }

  symbolCache.set(code, symbol);
  return symbol;
}

/** How many decimals this currency actually has: 2 for most, 0 for the yen. */
export function currencyDecimals(currency) {
  const code = codeOf(currency);
  if (decimalCache.has(code)) return decimalCache.get(code);

  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
      .resolvedOptions().maximumFractionDigits;
  } catch {
    digits = 2;
  }

  decimalCache.set(code, digits);
  return digits;
}

/**
 * The decimals a figure is actually printed with.
 *
 * The "decimal places" setting is a rounding preference, and it applies to any
 * currency that has decimals to round. A currency with no minor unit has none:
 * there is no half-yen, so "¥1,234.50" is not a rounding preference, it is a
 * quantity that does not exist. Those are pinned at zero and the setting sits
 * out — which is the assumption the old hardcoded 2 quietly made everywhere.
 */
export function displayDecimals(currency, setting = null) {
  const natural = currencyDecimals(currency);
  if (natural === 0) return 0;
  return Number.isFinite(setting) ? setting : natural;
}

/**
 * An amount in the target currency.
 *
 * @param decimals  The "decimal places" setting, or null for the currency's own.
 */
export function formatMoney(value, currency = 'ILS', decimals = null) {
  const code = codeOf(currency);
  const digits = displayDecimals(code, decimals);

  if (!Number.isFinite(value)) {
    // "₪—" for a sign, "CHF —" for a code: Intl puts a space after an
    // alphabetic mark, and running one straight into a dash reads as a word.
    const symbol = currencySymbol(code);
    return /[A-Za-z]$/.test(symbol) ? `${symbol} —` : `${symbol}—`;
  }

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return currencySymbol(code) + value.toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  }
}

/** A bare number — a coin amount, a rate, anything carrying its unit elsewhere. */
export function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** "3m ago" / "just now". Age is what tells you whether to trust the number. */
export function formatAge(timestamp) {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Tokens whose value is a dollar, so the USDT rate prices them as-is. */
export const DOLLAR_PEGGED = new Set(['USDT', 'USDC', 'USD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'PYUSD']);

/**
 * Target-currency units per unit of `currency`, or null if this rate does not
 * price it.
 *
 * A dollar-pegged token is the USDT rate. Anything else needs its own quote —
 * running a BTC balance through the USDT rate produces a confident number that
 * is wrong by five orders of magnitude, which is worse than no number at all.
 */
export function coinRate(rate, currency) {
  if (!rate) return null;
  if (!currency || DOLLAR_PEGGED.has(currency)) {
    return Number.isFinite(rate.effective) ? rate.effective : null;
  }
  const coin = rate.coins?.[currency];
  return Number.isFinite(coin) ? coin : null;
}

/**
 * Dollars per unit of `currency`, or null if this rate does not price it.
 *
 * Not a display figure: this is what a session stores when it closes, so its
 * totals can be restated in a currency the player had not chosen yet. It is a
 * market price with no off-ramp spread on it — the spread is stored separately
 * and applied at the point of restatement, so the two halves cannot be applied
 * twice or forgotten once.
 *
 * A dollar-pegged token falls back to exactly one dollar, which is the premise
 * the whole extension already runs on and labels "via USD" where it matters.
 */
export function coinUsd(rate, currency) {
  const quoted = rate?.coinsUsd?.[currency];
  if (Number.isFinite(quoted) && quoted > 0) return quoted;
  if (!currency || DOLLAR_PEGGED.has(currency)) return 1;
  return null;
}

/**
 * The sign a value should be shown with, decided from the figure as it will be
 * *printed* rather than as it is held.
 *
 * A loss of 0.0001 rounds to 0.00 at two decimals, and "−₪0.00" is not a
 * number anyone can read — it says "you are down" and "you are level" in the
 * same breath. Round first, then ask which way it went.
 */
export function displaySign(value, decimals = 2) {
  if (!Number.isFinite(value)) return '';
  // Number('-0.00') is -0, and -0 is neither greater nor less than 0, so this
  // falls through to no sign exactly when the printed digits are all zero.
  const shown = Number(Number(value).toFixed(decimals));
  return shown > 0 ? '+' : shown < 0 ? '−' : '';
}

/** 'up' / 'down' / '' for a value, by the same printed-not-held rule. */
export function displayDirection(value, decimals = 2) {
  const sign = displaySign(value, decimals);
  return sign === '+' ? 'up' : sign === '−' ? 'down' : '';
}

/**
 * Four characters of money for the toolbar badge — Chrome truncates past
 * roughly that, so precision is spent where it survives: "84", "1.2k", "-320".
 * No symbol: four characters is the whole budget, and the tooltip beside it
 * carries the figure in full.
 */
export function compactMoney(value) {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);

  // Same rule as displaySign: a figure that prints as zero is not negative.
  const digits = abs >= 10 ? 0 : 1;
  const sign = value < 0 && Number(abs.toFixed(digits)) > 0 ? '-' : '';

  if (abs >= 100_000) return `${sign}${Math.round(abs / 1000)}k`;
  if (abs >= 10_000) return `${sign}${(abs / 1000).toFixed(0)}k`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  if (abs >= 10) return `${sign}${Math.round(abs)}`;
  return `${sign}${abs.toFixed(1)}`;
}

/**
 * The rate actually used for conversion: the quoted rate minus whatever spread
 * the user says their real off-ramp charges. A player who cashes out through an
 * exchange never gets the CoinGecko mid-price, and a converter that pretends
 * otherwise is lying by a couple of percent.
 */
export function effectiveRate(rate, feePercent = 0) {
  if (!Number.isFinite(rate)) return null;
  const fee = Number.isFinite(feePercent) ? feePercent : 0;
  return rate * (1 - fee / 100);
}
