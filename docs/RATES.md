# Rates

Three sources, in order of how much each one knows about your money. Whichever is in use is
named on the rate line, in the popup and in the overlay:

1. **A manual rate**, if you set one. Nothing overrides a number you typed.
2. **The casino's own price table**, while a Stake or Duel tab is open. See below.
3. **The providers** — tried in order, first to answer wins:
   - **CoinGecko** — `simple/price`, genuine USDT spot in the currency you asked for.
   - **exchangerate-api** — USD against that currency, with USDT taken as $1. Labelled *via USD*
     in the UI when used, because it is pricing the dollar rather than the token.

Neither costs more for being asked in a different currency: CoinGecko’s `vs_currencies` takes a
list, and exchangerate-api’s dollar-base response contains every fiat there is. The supported
list is the intersection of the two, fixed at build time rather than discovered at runtime.

Both providers are keyless and CORS-open. Fetching happens once in the service worker no matter
how many casino tabs are open, never in the page: Stake ships a strict `connect-src` policy, and
a content script's requests are attributable to the page it runs in either way.

A failed fetch keeps the last good rate and marks it stale (amber dot) rather than blanking —
with the age always on screen, so you can see exactly how much to trust it.

## The casino's own price table

*On by default.* Options → *Rate* → **Use the casino's own price table**.

Both sites publish a currency table carrying the major fiats alongside every coin they pay in,
because both need one to draw their own figures. Using it gets a rate that is fresher than a one-minute poll,
prices far more coins than one provider call covers, and — the part that actually matters —
converts your balance with the same number the site used to draw it.

It rides the same page-world reader as the rakeback figures, but on its own switch and with a
deliberate separation: this table is public price data with no account in it, so reading it
captures no request headers and replays nothing. Turning it on cannot put an access token
anywhere.

**Stake** fetches a `CurrencyConfiguration` query every ten to thirty seconds, so its table is
only ever read going past — there is no reason to ask for something that arrives that often.

**Duel** fetches `/api/v2/metadata/exchange-rates` once when the page loads and then not again,
so watching alone would leave the reading stale before it was ever used. It is therefore asked
for once a minute, and only while the tab is visible and focused. That endpoint needs no session
and carries no account data, so asking for it says nothing about anyone.

**Which way round the numbers go is read, not assumed.** A rate could mean dollars for one unit
or units for one dollar, and taking it the wrong way would not fail — it would produce the
reciprocal, a confident 0.27 shekels to the dollar. So the orientation is settled by BTC against
the currency you are converting into, which sits at least four orders of magnitude away from a
bitcoin in whichever direction the table runs — and that is true of every fiat there is, which is
what makes one check enough for all of them. A table that will not resolve — no row for your
currency, no BTC row, an ambiguous ratio — is refused **for that currency**, noted in
Diagnostics, and the providers carry on. The refusal is per-target: a table missing the yen still
prices everything for someone reading in euros.

Duel's table needs one step before that check can run, because it arrives quoted two different
ways in one payload: fiat against the euro, coins against the dollar. Putting your currency on
the dollar first (target/EUR ÷ USD/EUR) makes both halves units-per-dollar, which is one of the
two shapes the
reader already knows — so it converts and delegates rather than growing a second copy of the
reciprocal check. Duel names its coins by number on the wire (`101` is BTC, `105` USDT); an id
the extension does not recognise is dropped rather than guessed at.

The reading only lives while a tab is feeding it. Two and a half minutes without one and it
lapses back to the providers, which keep polling throughout regardless — they are what answers
when no casino tab is open at all.

## How fast can it update?

Ten to thirty seconds on Stake and about a minute on Duel while a tab is open, because that is
how often each table is refreshed. The rest of this section is about the providers, which are
what answers when no tab is.

**One minute.** Faster is not merely disallowed, it is pointless — measured against the live API:

- **The source data changes about every 80 seconds.** Polling every 5s for 96s produced exactly
  one new `last_updated_at`.
- **Cloudflare caches the response for 60s.** Repeat calls come back `cf-cache-status: HIT`
  with a climbing `age` header and byte-identical data.
- **Keyless 429s at roughly 10 calls/minute**, and the response carries `Retry-After: 60`.
  So overrunning the limit makes you *slower*: you trade one wasted call for a full minute of
  no data at all.

A 1-minute interval therefore sees every update the API has, and the extension's existing
behaviour already satisfies `Retry-After: 60` — a 429 simply waits for the next alarm, which is
at least 60 seconds away.

If you need genuinely sub-minute pricing from the providers, no amount of tuning here gets it.
That needs a paid CoinGecko plan or an exchange websocket feed, which is a different piece of
software — or a casino tab, which has one already and is where the table above comes from.

## CoinGecko API key (optional)

Paste a Demo key into Options → *CoinGecko API key*. It is stored in `chrome.storage.local` on
this machine only — never `sync`, and it is stripped out of the `mirror` object, so the content
script running inside stake.com never has it in reach.

The trade is not one-directional, which is why the options page does the arithmetic for you:

| | Per-minute | Monthly cap |
|---|---|---|
| Keyless | ~10 (measured), **shared with everyone on your IP** | none |
| Demo key | 100, yours alone | **10,000** |

Those two limits pull in opposite directions, so the extension picks a strategy from your
refresh interval rather than making you reason about it:

- **5 minutes or slower → `primary`.** About 8,900 calls/month fits the allowance, so the key
  is used on every call and you get the 100/min ceiling all month.
- **Faster than 5 minutes → `reserve`.** A 1-minute interval is 44,640 calls/month against a
  10,000 cap; used as primary the key would be gone in under a week. So every call goes
  keyless, and the key is spent *only* to recover from a 429 — a few dozen calls a month, with
  the higher ceiling still there whenever keyless actually refuses.
- **Allowance exhausted → `off`.** Falls back to keyless, which has no monthly cap. A lower
  per-minute ceiling beats no rate at all.

*Test* validates a key against `/ping` before you rely on it. A bogus key is genuinely
rejected there, so a pass means something.
