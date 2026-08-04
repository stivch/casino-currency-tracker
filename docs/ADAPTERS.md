# Adding a casino

Everything site-specific in this extension is deliberately confined to five places. This
document names all five, states what an adapter has to guarantee, and — the part that matters —
states what it has to *refuse*.

Read the refusal rules before writing any code. Every one of them exists because the failure it
prevents is silent: a wrong number that looks exactly like a right one.

---

## The five places

| # | File | What lives there |
|---|---|---|
| 1 | `src/lib/settings.js` | `CASINOS` — the closed registry of casinos and every domain each answers on |
| 2 | `manifest.json` | `content_scripts` matches and `optional_host_permissions`, both mirroring the registry |
| 3 | `src/lib/scrape.js` | The `SITES` table, `siteFor()`, and the ledger reader for a markup-based site |
| 4 | `src/lib/stakebridge.js` | The page-world adapter: which requests to recognise and what to pull out of them |
| 5 | `src/lib/rates.js` | The reader that turns the site's price table into target-currency-per-coin |
| 6 | `src/background.js` | `RATE_READERS` and `SITE_NAMES` — dispatch and the human label |

The registry is the gate: the extension will not run on a domain that is not in it, and
`tools/selftest.mjs` fails the build if the registry and the manifest disagree. Adding a domain
to a casino that already works is an edit to those two files and nothing else. Adding a casino
is everything below first.

A sixth, implicit: `tools/domtest.mjs` and `tools/bridgetest.mjs`. An adapter with no fixture is
not finished. These are the only tests that can catch a ledger reader breaking, and a ledger
reader that breaks does so quietly.

---

## What the extension needs from a site

Four things, in descending order of importance. A site that supplies only the first is still
worth supporting.

### 1. Which coin the wallet is in

Without it, every figure is priced with the wrong rate. Stake tags its currency chip
(`data-ds-icon`); Duel does not — its header renders `$` whatever the wallet holds — so Duel
takes the coin off the ledger rows instead.

**Refuse rather than assume.** A site that will not say which coin is in play gets no conversion,
not a USDT guess. A BTC balance run through the USDT rate is wrong by five orders of magnitude
and looks entirely plausible on screen.

### 2. The bet ledger

The source of every session figure. Two shapes are already supported:

- **`ledger: 'table'`** — markup on the page, watched as it re-renders (Stake).
- **`ledger: 'api'`** — a JSON feed, read on a timer while the tab is open, visible and focused
  (Duel).

A third shape is now in use on Stake alongside its table: **the game's own action endpoints**.
Stake's originals run on `/_api/casino/<game>/bet`, `/next` and `/cashout`, and every reply
carries the same envelope — `{id, active, game, currency, amount, payoutMultiplier}` — with only
`state` differing between games. Since the accounting needs nothing from `state`, one reader
covers every original.

Two rules specific to it. **Never send one**: these endpoints place and settle real bets, and
`tools/bridgetest.mjs` asserts the bridge originates none of them. And **`active` is the settled
flag** — a mines grid mid-reveal is `active: true` and must be left unsettled and unseen, or it
books as a total loss until it is cashed.

A ledger row must yield **an exact stake, an exact gross return, and an id that is stable across
re-renders**. Anything less is not a ledger:

- No id means no de-duplication, and a session that counts the same bet on every poll.
- Balance deltas are not a substitute. A won bet nets positive while still having wagered, so
  balance movement can give profit but never turnover — and a bet that settles in one update is
  indistinguishable from a deposit.
- A *balance ledger* is not a bet list. Duel writes two lines per won round under one `data.id`;
  read line by line, ten rounds worth +1.18 came out as +28.67. If the feed is balance movements,
  group into rounds first and emit one bet per round.

**Refusals that are not optional:**

- **Somebody else's bets.** Stake's "All Bets" tab has the same columns plus a user column and is
  matched out by name (`FOREIGN_HEADER_RE`, `MY_BETS_HEADERS`). Counting strangers' bets as the
  user's is worse than counting nothing. Any new site with a public feed needs the same guard.
- **Unsettled rows.** A bet whose result has not landed is skipped *and left unseen*, so it is
  reconsidered later. Marking it seen freezes it at whatever it showed first.
- **Unparseable stakes.** A stake that will not read is a scraper fault, not a free bet. It must
  be skipped, counted, and reported as a diagnostic — not booked as zero. A zero-stake bet is how
  a session shows a bet, no turnover, and a loss that never happened.
- **Non-bets.** Deposits, withdrawals and rakeback claims arrive in the same feed on Duel and are
  matched out by the table they came from. A withdrawal booked as a losing bet is a plausible
  number and a false one.

### 3. The site's own price table

Optional, and worth having: it is fresher than the provider poll, it costs no request where the
app fetches it anyway, and it is the very number the balance on screen was drawn with.

The reader returns target-currency-per-coin, or `null`. **Null is a normal answer** — the caller
falls through to the rate providers, and the table is not disabled for other currencies because
one is missing.

**The reciprocal trap.** Nothing documents which way round a `baseRate` reads, and getting it
backwards does not fail — it produces a confident rate that is the reciprocal of the real one.
`orientationOf()` settles it by comparing the target fiat against BTC, which are at least four
orders of magnitude apart for every fiat there is. **An inconclusive table is refused, not
guessed at.** Do not write a second copy of this logic: normalise the payload into
`[{currency, baseRate}, …]` and hand it to `ratesFromStake`, which is what `ratesFromDuel` does.

### 4. Account extras

Rakeback and VIP standing. Watching only, and gated behind a setting that is off by default,
because reading an account API is a different kind of thing from reading a page.

**Never invent a progress figure.** Duel publishes a level but not the xp curve, so the overlay
shows the tier alone rather than a fraction derived from a number whose scale is unknown.

---

## Rules that hold for every adapter

**The page-world bridge runs in world `MAIN` at `document_start`.** It therefore has no
`chrome.*` APIs at all. It talks to the isolated world over `postMessage` on a private channel.

**Credentials stay in the page.** The Stake adapter reads the `authorization` header its own app
already sends, in order to recognise the responses. It is never stored, never posted onto the
bus, and never reaches the service worker. `tools/bridgetest.mjs` asserts this; keep it asserting
it.

**Narrow before broadcasting.** The message bus is readable by every script on the page. Trim a
payload to the fields the accounting uses on the side that already has the data, not after it has
been broadcast. Duel's raw feed carries running balances, invoice ids and server seeds; none of
that crosses the bus.

**Originate no request the site did not.** Watching traffic the app makes anyway costs nothing
and is invisible. Repeating a request is automated traffic from the user's logged-in session,
which is what casino bot-handling looks for and what their terms restrict. Where a site must be
asked (Duel has no bet table), the read is gated on the tab being open, visible **and** focused,
is rate-floored, and replays the app's own request verbatim.

**Fail loudly.** A table that will not read, a column that changed shape, a price table missing
the target currency — each gets a diagnostic. The failure mode this codebase is built against is
the overlay going quiet with stale numbers on it while everything looks fine.

---

## Mirrors versus new casinos

These are different jobs and it is worth not confusing them.

**A mirror runs the identical app on another hostname.** The adapter is already correct — only
the matching is missing, so it is two lines in `CASINOS` and the manifest. Put it in `builtIn`
if it should work on install, or `optional` if it should ship switched off and be turned on from
Options.

Verify it really is the same app before adding it. A brand's regional domain usually is; a
domain that merely carries the brand's name may be a different build, an affiliate wrapper, or
somebody else entirely — and the adapter will not say so, it will just start producing numbers.

**A new casino needs its traffic captured before a line is written.** Its ledger shape, its id
field, its settled/unsettled marker, its price table orientation and its non-bet rows are all
unknowns, and every one of them has a silent-failure mode listed above. Writing an adapter from
a guess about a site's API produces exactly the confident wrong number this document exists to
prevent.

The order of work for a new casino is therefore: capture real traffic → write fixtures into
`tools/` → write the adapter against the fixtures → verify against a live account.
