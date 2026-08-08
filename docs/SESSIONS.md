# Session tracking

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
| Won % | `wins / bets` |
| Best | `max(gross return / stake)`, with the game it happened in |

**The best multiplier is derived, not read.** Stake's table has a multiplier column and its game
replies carry `payoutMultiplier`, so there was a reading to be had for free. Three readers feed
the accounting and only one of them publishes a multiplier at all — a figure taken from a fourth
place would be a fourth place for them to disagree. Gross over stake *is* the definition of the
number, so the one computed here can never contradict the turnover and returns beside it. A bet
with no stake on it sets no record: a free spin returning anything divides by zero.

**Won % carries no minimum sample, and realized RTP does.** That is not an inconsistency. RTP
estimates something unobservable — what the games pay in the long run — so over forty bets it is
variance wearing a percent sign and reads as a verdict, which is why it stays blank below 200
bets. Won % is a count divided by a count: six of ten is exactly six of ten. It describes the
session rather than the games, so it is reported from the first bet.

**The Payout column is not one quantity, and this cost a bug.** On a win it holds the gross
amount credited back (stake × multiplier). On a *loss* it holds the amount debited, written
negative — a lost `0.20` shows as `-0.20000000`, not `0.00000000`. Treating it as a gross return
throughout meant `profit = payout − stake` charged the stake twice on every losing bet, so
sessions read far worse than they were. It is now normalised to a gross return (`max(payout, 0)`)
before anything is summed, and there are tests built from real rows pinning it.

## Unsettled bets, and corrections

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

## The balance cross-check

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

## Recorded sessions

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

## Limits

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

**On their own, the limits block nothing** — they flag, they notify, and the reading is yours. Two
of the switches under [Pre-commitment](#pre-commitment) change that, and both are off until you
turn them on: the cooldown screen holds the page briefly on a crossing, and locked limits refuse
to raise one mid-session. Neither stops a bet.

## The P/L curve

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

## Exports

*Export bets* writes one row per bet for the **current** session — time, game, stake, return,
profit, converted profit, bet id. Archived sessions do not keep their per-bet log, so this is the
live session only.

*Export sessions* writes one row per session — stakes, returns, profit, the rate at close, the
converted figure, peak and trough, and any gap count. Every money column names the currency it
is quoted in, and a session that was restated rather than read at its own frozen rate says so.
Built and downloaded locally; nothing leaves
the machine.

*Export years* writes the table below it: one row per tax year.

## Backup

The CSV exports are for reading elsewhere; they are not a restore path. *Export backup* writes
the one file that is — a JSON copy of your settings and every recorded session. **The API key is
deliberately not in it**: a credential does not belong in a file that ends up in a downloads
folder or a cloud drive.

Everything this extension knows lives in the browser's own storage on one machine, so
uninstalling it, resetting the profile, or moving to a new computer takes the history with it.
There is no server holding a copy, by design — which makes the backup the only copy there is.

*Import backup* **merges rather than replaces.** Sessions already recorded are kept, and a
session already present is skipped rather than doubled — identity is its start, its end and its
coin, which no two genuinely different sessions share. So restoring last month's file cannot
delete this month's play. Entries that do not survive validation are dropped and counted, and
imported settings go through the same sanitising every typed field does: a hand-edited file earns
the same distrust as a hand-typed number.

## By year

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

## Pre-commitment

Three switches, all off until you turn them on, and the only places this extension does anything
other than report. They live in Options → *Session & limits*.

**None of them can be enforced.** Chrome removes an extension in two clicks and takes its settings
with it, and nothing here can close an account or reach a device this is not installed on. What
they do is raise the cost of a decision made in the moment. If you need something that holds, ask
the casino for their own self-exclusion — theirs can shut the account.

### Locked limits

While a session is live, a limit can be tightened but not raised and not switched off. Between
sessions everything is editable, because that is when the choosing is supposed to happen.

Switching a limit off counts as raising it, since off is the loosest setting there is. So does
raising the win target — a higher one means playing on rather than stopping.

The switch that enforces this locks alongside the limits. Refusing to raise a loss limit achieves
nothing if the switch enforcing it can be flicked off first, so it freezes for as long as the
session runs.

### Cooldown screen

The first time a session crosses each limit, the page is held for a few seconds — between 5 and
600, your choice — before it can be dismissed.

Once per limit, not once per crossing. A session that crosses its loss limit and keeps playing is
not interrupted every few seconds by the same screen: a pause that fires repeatedly gets dismissed
reflexively, which is the failure mode it exists to avoid. It is marked as seen when it opens
rather than when it is dismissed, so reloading mid-countdown does not start it again.

The screen is drawn in the extension's own shadow root, like everything else on the page, so the
casino's DOM is never touched.

### Self-exclusion

Blocks every casino this extension knows about for a period between a day and a year.

Arriving at one lands on a page explaining why. A tab that was already open when the exclusion
started *leaves* rather than being covered — a cover leaves the casino loaded underneath it, still
holding a session, still showing a balance, one deleted node away from being back.

The block is a `declarativeNetRequest` rule evaluated by Chrome, not something the content script
does. That is deliberate: a content script runs *after* the navigation it would be stopping, by
which point the page is already loading and already talking to the casino. Chrome does not report
your browsing to the extension in order to apply the rule — see [PRIVACY.md](../PRIVACY.md).

**There is no way to end one early.** Not in Options, not in the popup, not on the blocked page —
especially not on the blocked page, which is where somebody would most want one. It can be
extended, never shortened, and while it runs the period control, its own switch and the domain
list are all frozen: an exclusion with a reachable off switch is not an exclusion.

The end date lives in `chrome.storage.sync`, so an exclusion set on one machine is waiting on the
others. With Chrome sync off it applies only to the machine it was set on.
