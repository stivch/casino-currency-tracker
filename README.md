# Casino Currency Tracker

A Chrome extension that shows casino amounts in your own currency at a live rate — any of
forty-five fiats, shekels by default. Works on **Stake** and on **Duel**. No account, no API
key, no build step.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open Stake or Duel. A small readout appears in the bottom-right corner.

## The two sites

Everything on-screen — conversion, the overlay, hover and selection tooltips, pinning, the
badge, the limits — works the same on both. The differences are in where the numbers come from,
because the two sites are not built alike: Stake is a Svelte app talking GraphQL, Duel a Vue app
talking REST, and Duel has no bet table at all.

| | Stake | Duel |
|---|---|---|
| Bet ledger | the "My Bets" table, watched as it re-renders | `/api/v2/user/transactions`, read every 15s while the tab is in front of you |
| Price table | `currencyConfiguration`, seen going past | `/api/v2/metadata/exchange-rates`, read once a minute while the tab is in front of you |
| Rakeback | `VipMeta`, seen going past | `/api/v2/user/rakeback`, seen going past |
| VIP | tier plus fractional progress to the next | level number (no progress: the xp curve is not published) |
| Wallet coin | read off the currency chip in the header | read off the ledger rows — Duel's header says `$` whatever it holds |
| Credentials touched | the page's own `authorization` header, kept in the page | none — Duel's session is a cookie the browser attaches itself |

**Duel is the one place this makes requests it did not have to.** Stake publishes its bets as
markup and re-fetches its price table every few seconds, so both can simply be watched. Duel
answers only when asked, so a session there means asking. Both reads are gated on the tab being
open, visible **and** focused; both stop the moment you switch the feature off. If you would
rather it asked for nothing at all, turn off *Track session P/L* and *Use the casino's own price
table* — everything else keeps working.

## What you get

**The toolbar popup** — the current rate, a two-way calculator, the live session with its P/L
curve, and the four session limits, editable in place. Works everywhere, not just on the casino.

**The toolbar badge** — session P/L in your currency on the icon itself while a session is running,
the rate when one is not. Green up, red down, exact figure in the tooltip. Turn it off in
Options → *Alerts* if you would rather the icon stayed quiet.

**The floating readout** on the casino — the live rate, plus one amount of your choosing pinned
to it. Drag it by its header; it remembers where you put it.

**Pin an amount.** Click *Pin an amount on the page*, then click your balance. It is tracked
from then on and converted once a second. This exists because both sites' markup is generated
and their class names change between deploys — rather than ship selectors that break on their
next release, you point at the number once and the extension remembers where it was.

You can click the balance chip itself — the whole button, not the digits. The number is
re-found underneath whatever you pinned on every read, so pinning the outer chip is actually
the sturdier choice: both sites' chips carry a stable `data-testid` (`coin-toggle` on Stake,
`currency-value` on Duel), while their innards are re-rendered every time the balance changes.

If the pinned element stops resolving (both sites re-render whole subtrees when you navigate),
the readout says *element not on this page* instead of freezing a stale figure. Re-pin in two
clicks.

**Currency is detected, not assumed.** Stake tags its currency chip (`data-ds-icon="USDT"`), so
the readout names the coin it found — and it is priced in its own right. Duel's header renders
`$` whatever the wallet holds, so there the coin comes off the account reader and the bet ledger
instead, both of which name it outright. Either way the USDT lookup carries fourteen more coins
in the same request (`/simple/price` takes an id list, so pricing fifteen coins costs exactly
what pricing one did), which is what lets a BTC session show money and be held to a money
limit. A coin that request did not price says *no BTC rate yet* rather than running the balance
through the USDT rate and showing a confident number that is wrong by five orders of magnitude.

**Hover** over any amount for a tooltip. **Select** any number to convert it, whether or not it
carries a currency label — selecting something is an explicit "convert this".

## Session tracking

Shows profit/loss, turnover and bet count for the current session, in your currency and in coin —
in the overlay while you play, and in the popup.

**It reads the site's own bet ledger, not the balance.** That distinction is the whole design.
Balance movement can give you profit, but it cannot give you *turnover*: a won bet nets positive
while still having wagered, and a bet that resolves in a single DOM update is indistinguishable
from a deposit. A ledger row instead carries an exact stake, an exact payout, and a unique id —
so every bet is counted once, exactly, and never twice.

On **Stake** that ledger is the "My Bets" table, and the id is the UUID in `data-test-id`. The
All Bets tab has the same five columns plus a user, and is refused by name: counting strangers'
bets as yours would be far worse than counting nothing.

On **Duel** there is no bet table, so the ledger is `/api/v2/user/transactions` — the same feed
that draws Duel's own history page, straight off the server with no markup in between.

**A round there is not a row, and this is the thing that has to be got right.** That feed is a
*balance ledger*, not a bet list. A won round writes **two** lines under the same `data.id` — one
negative for the wager, one positive for the return — and each line's top-level `amount_currency`
is that line's movement, not the stake. Read line by line, a 0.66 stake returning 0.72 comes out
as a bet of −0.66 that paid 0.72 *plus* a bet of 0.72 that paid 0.72: turnover doubled, profit
nonsense. Ten real rounds worth +1.18 read as +28.67 that way.

So lines are grouped into rounds by `data.id` first, and one bet comes out per round, priced two
ways in order:

1. `data.amount_currency` and `data.amount_won` — the round's own stake and gross return, carried
   identically on *both* of its lines. Every game Duel runs itself sends these, and because
   either line alone prices the whole round, it does not matter which side of a page boundary
   the other one fell on.
2. The lines themselves, for provider slots, whose `data` holds nothing but an id: staked what
   was debited, returned what was credited. A group with only a credit is one whose wager line
   fell off the end of the page, and is dropped rather than booked as a stake-free win.

**Open rounds are not losses.** `data.status` of 0 is `ACTIVE` — the wager line is written when
the bet is placed, so a mines grid you are still revealing would otherwise book as a total loss
until you cashed out. Blackjack is the exception worth naming: its hand runs through four more
in-progress states before `FINISHED`, so it is checked against that rather than against zero.

Deposits, withdrawals and rakeback claims arrive in that same feed and are left out — a bet is
matched by what Duel calls the table it came from (`mines_rounds`, `crash_bets`,
`game_round_bets` for provider slots), so a withdrawal can never be booked as a losing bet. The
feed can also mix coins, while a session is denominated in one: the newest bet's coin wins and
the rest sit out, which is the same thing Stake's table does by only ever showing one coin at a
time.

| Shown | From |
|---|---|
| P/L | `Σ gross return − Σ stake` |
| Wagered | `Σ stake` |
| Bets, W/L | row count; a win is any positive payout |

**The Payout column is not one quantity, and this cost a bug.** On a win it holds the gross
amount credited back (stake × multiplier). On a *loss* it holds the amount debited, written
negative — a lost `0.20` shows as `-0.20000000`, not `0.00000000`. Treating it as a gross return
throughout meant `profit = payout − stake` charged the stake twice on every losing bet, so
sessions read far worse than they were. It is now normalised to a gross return (`max(payout, 0)`)
before anything is summed, and there are tests built from real rows pinning it.

### Unsettled bets, and corrections

A row whose payout cell is **blank or non-numeric** has not resolved — an open sports bet, or a
row caught mid-render. Those are skipped *and deliberately not marked as seen*: marking one
would mean it never counts once it finally settles, because de-duplication would refuse to look
at it again.

A numeric **zero is not treated as pending**. Only Mines was ever confirmed to write losses as
negative; if some other game writes them as `0.00000000`, calling that "unsettled" would
silently drop every losing bet in it.

That leaves the case where a row *does* change after being counted. Each counted bet stores a
fingerprint of its stake and payout, so a row that no longer matches is treated as a
**correction**: the old contribution is unwound and the new one applied. The bet count does not
move — it is the same bet — but turnover, returns, the win/loss split and the log entry are all
restated, and the entry is marked corrected.

Peak, trough and the curve are *not* rewritten: a correction changes P/L at the moment it lands,
so it earns a new point rather than editing history. Bets counted by a build that recorded no
fingerprint are left alone, since there is nothing to unwind.

### The balance cross-check

The pinned balance is a second, independent account of the same session. The ledger says one
thing; the wallet says another. **They should agree**, and the popup says so either way:

```
✓ Ledger and wallet agree (-0.40000000 USDT).
```

When they do not, it quantifies the gap and the overlay raises a note. A mismatch is not always
a fault — a deposit, a tip, rakeback, or a bet placed in a game whose table is shaped
differently will all move the wallet without moving the ledger. But a missed bet does too, and
this is what surfaces it. **It would have caught the payout-column bug on the very first losing
bet.**

For the innocent half of that list there is a *Money in / out* field in the popup: type `+50` or
`-20` in the session's coin and the amount is netted off the wallet side before the comparison.
Without it, one deposit left the check accusing the ledger for the rest of the night — and a
warning that is permanently on is a warning nobody reads. The verdict says when it is leaning on
a figure you typed.

Needs a pinned balance; without one it says so rather than pretending. Readings in another coin
are ignored, and a new session opens at the previous one's closing balance so the first bet is
not lost from the check.

Four things it refuses to get wrong:

- **Only your bets.** The All Bets and High Rollers tabs carry a user column, so the table is
  matched on its exact header shape. Counting strangers' bets as yours would be worse than
  counting nothing.
- **Only one denomination.** A session is bound to the coin it started in. Switch wallets and
  new bets stop counting, with a note saying so, rather than adding BTC stakes to USDT ones.
- **Only once.** De-duplication by bet id happens in the service worker, not the page, so two
  casino tabs open at once cannot double-count a single bet.
- **Gaps are declared.** If bets scroll past between two reads — possible under fast auto-bet,
  since the table holds ten rows — the session says so and marks its totals a floor rather than
  quietly under-reporting.

Tracking begins when the extension first sees the ledger; it has no access to bets placed before
you installed it, or while the tab was closed. The site's own statistics remain the authority —
this is a live readout, not an accounting record.

Turn it off in Options → *Track session P/L and wager*.

### Recorded sessions

Sessions are filed to history automatically, and the list lives in Options → *Session history*
with lifetime totals, a CSV export, and per-session detail.

A session ends when **30 minutes pass with no bet** (configurable), or when you reset one. The
idle close is what makes a "session" a real unit rather than "everything since I last clicked
reset". The recorded end time is the last bet, never whenever a timer happened to fire, and
reading the popup never causes a write.

Filing happens either when the next bet arrives or on the refresh alarm that is already ticking,
whichever comes first. The alarm matters more than it sounds: archiving only on the next bet
meant the last session of the night sat as "current" until you next played — the one moment you
would want to look it up in history was the one moment it was not there.

Two details that stop the history from lying to you:

- **The rate is frozen at close.** Each session stores the rate for *its own coin* that applied
  when it ended, and its converted figure is computed from that. Restating a session from three
  weeks ago at today's rate would quietly rewrite what that evening actually cost. Where no rate
  was available, the money column shows `—` rather than inventing one.
- **And so is enough to read it in another currency.** Alongside the rate, a closing session
  stores the coin's dollar price and the USD-per-fiat table — a few hundred bytes. Switch the
  target to euros and last month's session is restated in *that evening's* euros, not today's.
  Read in the currency it closed in, it is still the frozen figure, untouched. Sessions recorded
  before this existed carry no such snapshot: they show their shekel figure under shekels and a
  `—` under anything else, with the reason on hover, rather than a number worked backwards.
- **Lifetime totals are grouped by coin.** Adding USDT turnover to BTC turnover would be
  arithmetic on two different things, so each currency gets its own card.

Resetting archives the session and opens a fresh one that **inherits the old one's bet ids**,
so the ten rows still sitting in the table are not counted a second time.

The **current session's individual bets** are listed in Options above the history — stake,
return and profit per bet — so a total that looks wrong can be checked against the site's own list
rather than reverse-engineered. Sessions carry a `calc` version; any recorded before the payout
fix is marked ⚠ in the history, because its P/L overstates losses and cannot be recomputed from
the stored totals.

### Limits

Four optional thresholds, **set straight from the toolbar popup** (or in Options):

| Limit | Fires when |
|---|---|
| **Wager** | session turnover passes it |
| **Loss** | session is *down* by it |
| **Win** | session is *up* by it — a take-profit marker |
| **Time** | the session has been running that many minutes |

The three money limits are in the currency you convert to — the unit the money is actually in —
and compared at the current rate for the session's coin, which the popup shows converted back to
USDT underneath so you can sanity-check it.

**They carry that currency with them.** Change the target and the three figures are converted
once, and the popup says what it did: `₪1,000.00 → €282.00`. Where no exchange rate is available
to convert them honestly they are turned off instead, and that is said too. What cannot happen is
a number entered in shekels being quietly compared against a session measured in euros — the
comparison itself refuses while the two disagree. Time is counted from the session's first bet, not from opening the tab,
and needs no rate at all, so it is the one limit that applies to every coin unconditionally.

**A crossing is also a desktop notification**, once per limit per session, because a bar in the
overlay only reaches you when the casino is the tab you are looking at. Off in Options → *Alerts*.

Loss and win are the same figure read in opposite directions, so at most one can be live at any
moment; the overlay gives them a single shared bar that follows whichever way the session is
going. Bars run amber from 80% and red at 100%; **a win target is drawn green and worded as
reached, not as a warning**, because hitting it is not a problem. Displays stay quiet below 80%:
a bar at 4% is noise.

Blank means off, and so do `0` and negatives — without that, a stray `0` would read as "limit
reached" the instant a session started. Input is parsed the way the label invites: `1,000` and
`₪1,000` and `€1,000` are all a thousand — the field is labelled with whatever mark the
currency uses, and rejecting exactly what the label invites is a trap rather than a validation
rule. They used to be `NaN`, which cleared the limit while the UI
reported it saved — a value that does not survive validation now says so instead of quietly
turning itself off.

The money limits need the session's coin to be priced. A coin the providers did not return sits
them out rather than measuring against a rate that is not its own; the time limit still runs.

**Nothing is blocked or enforced — this reports, it does not intervene.**

### The P/L curve

Where you stood when the session opened is the line across the middle. **Green above it is
profit, red below it is loss**, and each step along is one bet. The fill is closed to that
baseline rather than to the floor of the box, so the area you see *is* the amount — a session
that is level shows no fill at all.

Three sizes of the same chart, from the same code:

- **The overlay** and **the popup** draw it small, beside the running totals.
- **Options → Profit and loss** draws it full width, with the final figure, the peak and the
  trough named underneath, and a picker for any recorded session.

Zero is forced into range even when a session never went negative: a line with no baseline to
read it against is just a line.

The live series **halves itself** rather than dropping its oldest points once it passes 240 — a
curve showing only the last 240 bets would hide exactly the run-up worth looking at. The
halving is timed so the newest point is never the one discarded, since a curve whose last value
disagreed with the number printed beside it would be worse than no curve.

Archived sessions keep a **60-point thinning** of their curve, first and last points always
kept, because the last point is the final P/L printed beside the chart. Sixty numbers is a
rounding error next to the entry it sits in, and at chart resolution it looks the same. Sessions
recorded before this existed have no curve and simply do not appear in the picker.

An archived session is drawn at **the rate it closed with**, exactly as its row in the history
is — the live one at today's rate.

### Exports

*Export bets* writes one row per bet for the **current** session — time, game, stake, return,
profit, converted profit, bet id. Archived sessions do not keep their per-bet log, so this is the
live session only.

*Export sessions* writes one row per session — stakes, returns, profit, the rate at close, the
converted figure, peak and trough, and any gap count. Every money column names the currency it
is quoted in, and a session that was restated rather than read at its own frozen rate says so.
Built and downloaded locally; nothing leaves
the machine.

*Export years* writes the table below it: one row per tax year.

### By year

Options → *By year* totals every recorded session in your currency **at the rate it closed
with**, grouped by tax year. Sessions across different coins can be added together here precisely
because each was converted at its own rate when it closed.

**The tax year is a setting**, because it is not January everywhere: Israel's is the calendar
year and is the default, the UK's opens in April, Australia's in July. A year that does not start
in January spans two, so it is labelled after both — `2025/26` — because calling a period that
runs to April 2026 simply "2025" is how a figure gets filed against the wrong year. Nothing is
recalculated; it is only the bucket that moves.

Two kinds of session are left out of the money columns, and they are counted separately rather
than folded in at some other session's rate. One closed before any rate was ever fetched and has
no figure at all. The other has a figure, but only in the currency it closed in — recorded before
the snapshot existed, or with a rate you typed by hand, which cannot honestly be crossed into
another currency. Both are said out loud under the table.

## Settings

Right-click the toolbar icon → Options, or *All settings* in the popup.

| Setting | What it does |
|---|---|
| Refresh every | Minutes between fetches. **1 minute is the useful floor — see below.** |
| Convert to | The currency every amount is shown in. Forty-five fiats; ILS by default. |
| Decimal places | Rounding for displayed amounts. A currency with no minor unit — the yen — ignores this and shows whole units. |
| Off-ramp spread % | Subtracted from the quoted rate. See below. |
| Manual rate override | Blank uses the live feed; a number ignores it completely. |
| Assume unlabelled numbers are USDT | See below. |
| Annotate amounts inline | Appends the converted figure after labelled amounts on the page. |
| Wager / Loss / Win / Time limit | The four session thresholds. Blank = off. |
| Tax year starts in | Which month the *By year* report buckets on. January by default. |
| Toolbar badge | Session P/L on the icon, or the rate when no session is running. |
| Notify when a limit is crossed | Desktop notice, once per limit per session. |

### Language

English or Hebrew, set at the top of Options: *Automatic* follows Chrome's own display
language, or pick one outright. It applies everywhere at once — popup, options page and the
overlay on the casino — and takes effect immediately, with no reload.

`chrome.i18n` cannot be overridden at runtime; it answers with Chrome's display language and
nothing else, which is why an extension that only used it could be switched to Hebrew only by
relaunching the whole browser in Hebrew. So the service worker resolves the language itself,
loads the matching bundle, and publishes it: pages read it from state, the overlay from its own
storage key. `chrome.i18n` stays underneath as the fallback.

Every string also carries its English text at the call site, so a missing translation shows the
English rather than a raw message key. Hebrew flips the page right-to-left; numbers, tickers
and rates stay left-to-right inside it, because a money figure reads the same way in every
language. Language and currency are independent axes: the Hebrew overlay prints `€1,234.50` left
to right, which is how a Hebrew reader writes a euro figure anyway.

## Rakeback and VIP progress

*Off by default.* Options → *Casino account*.

Both sites' apps fetch your rakeback balance and your standing with them. With this on, the
extension reads the responses that are already going past, and shows the rakeback balance
converted to your currency next to the rate.

On **Stake** that is `VipMeta` and `VipProgressMeta` off the GraphQL endpoint, and the tier comes
with a fraction: how far along the current one you are, drawn as a bar. On **Duel** it is
`/api/v2/user/rakeback` and `/api/v2/user`, and what you get is a level number — Duel publishes
the level and the xp but not the curve between them, so there is no honest percentage to draw
and the tier is shown on its own rather than beside an invented one. Duel's rakeback figure is
a single dollar total; it is labelled USD and priced with the dollar rate, which is what Duel's
own display means by it.

**How it reads them.** On Stake the endpoint is authenticated by headers the app attaches itself
— an access token, not just a cookie — and those exist only inside the page. So a small script
runs in the page's own JavaScript world and wraps `fetch`. That is also why the token never goes
anywhere: it stays in that closure, in the page where it already lives, and only the extracted
figures cross into the extension. `window.postMessage` is readable by every script on the page,
so nothing secret is ever put on it — which is also why Duel's ledger rows are stripped of their
seeds, balances and invoice ids on the page side, before they are posted, rather than after.

Duel needs none of that capture: its session is an ordinary cookie, which the browser attaches
by itself. Nothing is held in the closure there, and a refresh is a plain GET.

**Refresh every minute** is a second, separate switch, and worth reading before you turn it on.
Watching costs nothing — the requests were happening anyway. Polling makes requests, which is a
different thing: it is automated traffic to Stake's account API from your session, their terms
and their bot handling are theirs, and an account flag is the risk you would be taking. It is
your account and your call; the extension defaults to not making it for you.

When it is on, it is deliberately timid. It repeats the page's *own* request body verbatim
rather than inventing a query, it runs only while the tab is visible **and** focused, it stops
the whole round on any non-200 rather than retrying, and the interval is floored at 30 seconds.
Rakeback accrues continuously — a one-minute display refresh is cosmetic, not functional.

**Refresh now** is the third option, and it needs neither of the first two switches beyond
reading being on: a ⟳ in the overlay's account header, and a *Refresh* button in the popup's.
Both ask for exactly one round, so you can check a rakeback figure at the moment you care about
it instead of leaving a timer running all evening. The header shows how old the reading is,
which is what makes it obvious when that is worth doing.

The popup cannot talk to the page — a targeted tab message would cost the `tabs` permission
this extension does not take — so its button writes a timestamp to storage, every casino tab is
already watching that key, and the visible one answers. Which means it can go unanswered: with
no such tab open, or none visible, the popup waits a few seconds and says so. The overlay's
button skips all of that and asks its own page directly.

On Stake, nothing can be replayed until its app has made the request at least once, so a page
that loaded before reading was switched on has nothing to repeat. That case is reported in
Diagnostics rather than passed off as a refresh that did nothing. Duel has no such
precondition — there is nothing to capture, so a refresh works on any page.

### Off-ramp spread

The quoted rate is a mid-price. Nobody actually receives the mid-price — your exchange takes a
cut on the way out. Set the spread to what yours really charges and every figure the extension
shows becomes what you would actually get, not what a market data feed says a token is worth.
Leave it at 0 for the raw rate.

### Assume unlabelled numbers are USDT

Stake's header balance is a bare number next to a coin icon — there is no "USDT" text anywhere
in the element to key off. Turning this on lets hover convert it.

The cost is that it cannot then tell a balance from a `2.55x` multiplier, an odds figure or a
player count, so hover starts converting things that are not money. It is off by default, and
**pinning your balance is the better answer** — pinning always reads the number regardless of
this setting, because you have already told it what that element is.

## Rates

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

### The casino's own price table

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

### How fast can it update?

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

### CoinGecko API key (optional)

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

## Why nothing is injected into the page's DOM

Both sites are compiled reactive apps — Stake a Svelte one (its markup carries `svelte-xxxxxx`
scoped class hashes), Duel a Vue one (`data-v-xxxxxxxx`). Their compiled output keeps direct
references to the nodes it created and to the anchors it inserts before, so adding or removing
children inside a component's subtree desynchronises those references: the next update writes to
the wrong place, or throws on a node that has moved.

So the entire UI lives in a shadow root attached to `<html>`, a sibling of `<body>`, outside
every component. The one inline mode sets a `data-stake-ils` attribute and lets a CSS `::after`
rule render it — no node ever enters a component's subtree, so nothing it holds a reference to
moves.

## Other domains

`manifest.json` matches `stake.com`, `stake.bet`, `stake.games`, `stake.us` and `duel.com`,
each with its subdomains. Duel also answers on `duel.limited`, `duel.vip` and `duel.net`; those
are not matched by default. For any mirror not on the list, add it to **both** entries in
`content_scripts` — the page-world reader and the overlay are separate injections — and add it
to the matching branch of `siteFor()` in `src/lib/scrape.js` and the hostname test at the bottom
of `src/lib/stakebridge.js`, or the extension will load on it and treat it as Stake. Then reload
at `chrome://extensions`.

## Development

```bash
node tools/selftest.mjs
```

Covers parsing, formatting, the spread maths, session accounting, the limits, and a live
provider fetch. Exits non-zero on failure.

```bash
node tools/domtest.mjs
```

Covers the bet-table scraper against a fake DOM built in the test file — sixty lines, no
dependencies, no browser. It is the piece that depends on someone else's markup and the source
of every number the session shows, so "it needs a DOM" was a bad reason for it to be the one
thing with no tests. The `All Bets` rejection is pinned here, as is Duel's ledger reader and the
hostname matching that decides which site is which — including that `notduel.com` is not Duel.

```bash
node tools/bridgetest.mjs
```

Covers the page-world bridge against a fake `window`, `document` and `fetch`, with intervals
captured rather than run. It is the only code that can make a request against someone's account,
so the things pinned here are the ones that matter if they ever stop being true: that it asks
for nothing until switched on, that it asks for nothing from a tab that is hidden or unfocused,
that a click is always answered even when it failed, that the bet feed is trimmed of seeds and
balances *before* it reaches a bus every script on the page can read, and that Stake's captured
`authorization` header never leaves the closure.

```bash
node tools/make-icons.js
```

Regenerates `icons/*.png`. They are drawn in code rather than committed as opaque binaries.

```
manifest.json
LICENSE            MIT, with the warranty disclaimer the limits lean on
_locales/
  en, he             UI strings; every call carries its English as a fallback
src/
  background.js      service worker: the only thing that touches the network
  content.js         the overlay; standalone, since content scripts are not modules
  popup.html/.js     rate + calculator
  options.html/.js   settings
  ui.css             shared by popup and options
  lib/
    rates.js         provider chain, and the casinos' own price tables
    format.js        parsing, Intl money formatting, spread
    session.js       bet accounting, reconciliation, limits, and restating a
                     closed session into a currency chosen later
    chart.js         P/L curve geometry and archive thinning
    scrape.js        the bet-ledger readers — Stake's My Bets table and Duel's
                     transaction feed — plus which-site-is-this. Plain script,
                     loaded as a content script and require()d by the DOM tests
    stakebridge.js   runs in the PAGE's world: wraps fetch to read rakeback,
                     VIP, the price table and (on Duel) the bet ledger out of
                     the site's own traffic. One adapter per casino
    settings.js      defaults, clamping, and the supported-currency list
    notices.js       the one sentence both pages have to say: what a change of
                     target currency did to the money limits
    i18n.js          message lookup + RTL for the pages
tools/               icon generator, self-test, DOM test, bridge test
```

Everything that knows which casino it is on is in three places and nowhere else: `siteFor()` in
`lib/scrape.js`, the `STAKE` and `DUEL` adapters in `lib/stakebridge.js`, and the `matches` lists
in the manifest. Nothing else branches on a hostname.

State flows one way: settings live in `chrome.storage.sync`, the rate cache in
`chrome.storage.local`, and the service worker mirrors both into a single `mirror` key that the
content script reads and watches. That is why the extension needs no `tabs` permission — there
is no broadcast, just a value everyone reads.

## Diagnostics

A content script that throws does so inside the page's console, where nobody is looking, and
the overlay just goes quiet with stale numbers on it. Every entry point that touches the page's
DOM is wrapped, and failures are forwarded to the service worker and listed in Options →
*Diagnostics*, with a banner in the overlay itself.

Repeats collapse into a count — the scraper runs on a 2-second timer, so a persistent fault
would otherwise write the same line thirty times a minute. Errors are deliberately **not**
mirrored back into page state, because a broken scraper must not trigger a state write that
re-runs the broken scraper.

If the overlay ever goes quiet or shows numbers that stop moving, that panel is the first place
to look.

## Limits

- **Display only.** It reads the page and does arithmetic. It cannot move funds and never
  touches the casino's account or wallet controls. MIT licensed and provided as is: the *By
  year* figures are a readout, not an accounting record, and nothing here is tax advice.
- Prices come from CoinGecko and exchange rates from exchangerate-api.com; both are credited in
  the popup and in Options, which their free tiers ask for and which is simply true.
- **Forty-five target currencies**, the intersection of what both providers quote. A currency
  outside that list cannot be selected; one inside it that a casino's own price table happens
  not to carry falls back to the providers for that currency alone.
- **Only the shekel is proven end to end.** Every other target goes through the same code paths
  and the same tests — ILS, EUR, USD and JPY are exercised against the live providers on every
  run — but no long session has been played and filed in one.
- Sessions recorded before version 1.3.0 can only be read in shekels. They keep their figure
  there and show a dash elsewhere; nothing back-computes them, and nothing ever will.
- Permissions are `storage`, `alarms`, `notifications`, and network access to the two rate
  hosts. Nothing else.
- Chrome 111 or newer, for the page-world content script the rakeback reader needs.
- The rakeback poller has not been run against a live Stake session — the passive path is the
  one that needs no permission and no assumptions, and it is the default for that reason. The
  on-demand refresh takes the same replay path, so it is untested against a live session too.
- **Duel's adapter was built against the live site's responses**, and the readers are pinned to
  those exact shapes in the tests. The bet reader is checked against a real ledger both ways:
  ten mines rounds, twenty lines, and the P/L it produces matches the balance column to nine
  decimal places. The rate reconciles to within 0.3% of CoinGecko's. What is still not verified
  is a long session end to end — in particular an open round being counted, corrected and
  settled while the overlay is on screen.
- Duel's `status` enums were read out of its own bundle: `ACTIVE=0, CASHED_OUT=1, LOST=2` for
  the grid games, `INITIALIZING_TABLE=0 … FINISHED=5` for blackjack. A game whose in-progress
  states are neither 0 nor blackjack's would briefly book as a loss and correct itself on the
  next read — which is what the correction machinery is for, but it would be visible.
- Duel's rakeback figure is read as a single dollar total. The per-pool breakdown beside it was
  empty on the account this was written against, so it is not read at all rather than parsed
  from a shape nobody has seen.
- Duel's bet-key rule (`_rounds` / `_bets` / `_spins`) covers every casino game and the provider
  slots. Sports bets through its Betby integration were not present in the ledger it was checked
  against, so if they are filed under some other name they would go uncounted — which the
  session's gap detection would show as a floor rather than hide.
- All three surfaces have now been rendered against a stubbed extension API, in English and in
  Hebrew, and screenshotted — which is how the overlay's P/L curve turned out never to have been
  drawn at all. `svg.hidden = false` sets a plain property on an `<svg>`, because `hidden` is
  defined on `HTMLElement` and an SVG element is not one; the attribute stayed put and the
  overlay's `[hidden] { display: none !important }` kept the chart invisible from the day it was
  written. Both charts now use `toggleAttribute`. What is still unverified is any of it inside a
  real Chrome extension rather than a page pretending to be one.
- Hebrew covers the popup, the overlay and the options page. The CoinGecko quota paragraphs in
  Options are still English: they are long, they are diagnostics about someone else's billing,
  and a half-translated one would be worse than an English one.
