# Roadmap: what is missing for the person actually gambling

The extension converts well and accounts honestly. What it does not yet do is turn the data it
already collects into the handful of facts that change how somebody plays.

Everything in the first section is an aggregation over data already stored — no new collection,
no new permission, no new site knowledge. That is what puts it first.

---

## Tier 1 — the data is already there

**1.1, 1.2 and 1.3 have shipped.** 1.4 is the one left in this tier.

### 1.1 Lifetime money in and out ✅ DONE

**The gap.** `funded` is recorded per session (`applyFunds`, `src/lib/session.js`), survives into
history through `archiveEntry`, and is then never summed. `summarise` buckets `sessions`, `bets`,
`wagered`, `returned`, `wins`, `losses` and `profit` — deposits and withdrawals are not among
them.

**Why it matters more than anything else here.** Session P/L measured in coin is not a position.
A run of sessions can each read flat or mildly green while the wallet is only staying level
because money keeps going in. Total deposited minus total withdrawn is the number that says what
the hobby has actually cost, and it is the number people avoid looking at hardest.

**Shape of the work.** Add `funded` to the `summarise` buckets; show net funding beside lifetime
P/L in Options, and in the *By year* table. Split the sign into deposits and withdrawals rather
than reporting only the net — "±0 net" hides ten deposits against ten withdrawals.

**Honesty constraint.** `funded` is only as complete as what the user logged, because it is
entered by hand in the popup. The figure must be labelled as "what you told it about", not
presented as a bank statement. Where a session's cross-check is unreconciled, say so in the
total rather than quietly summing over it.

### 1.2 Realized RTP, against expectation ✅ DONE

**The gap.** Nothing in the codebase computes `returned / wagered`. There is no concept of
house edge anywhere.

**Why it matters.** That ratio is the realized return-to-player: the single most informative
number derivable from what is already stored. Paired with the game's published edge it produces
the sentence that does the work — *wagered 50,000, expected loss at a 1% edge is 500, actual loss
is 3,200.* It replaces "I am due" with arithmetic, and it is equally useful in the other
direction: somebody running well should know that is what is happening.

**Shape of the work.** Per session and lifetime, show realized RTP. Add an expected-loss column
driven by a house-edge figure. Two sources for that figure, in order: a per-game table (see 1.3)
if one exists, otherwise a single user-set edge with a sensible default.

**Honesty constraint.** Realized RTP over a few hundred bets is dominated by variance and must
say so — a confidence band, or at minimum a bet-count threshold below which the figure is shown
greyed with "too few bets to mean anything". A number that looks like a verdict after forty spins
would be worse than no number.

### 1.3 Per-game breakdown ✅ DONE

**The gap.** `game` is captured on every bet (`ingest`, `src/lib/session.js`), rendered in the
live bet log, and written to the per-bet CSV. Then `archiveEntry` strips `log` entirely, so
nothing about which game the money went into survives the session that produced it.

**Why it matters.** "Which game actually takes my money" is the first question anybody asks of
their own history, and the extension currently collects the answer nightly and throws it away.

**Shape of the work.** Fold a per-game roll-up into the archive entry rather than keeping the
log: `{game, bets, wagered, returned}` per game, which for a normal session is a handful of rows
and a rounding error next to the entry it sits in. That is the same reasoning that already keeps
the P/L curve at 60 points while dropping the per-bet log.

**Bonus once it exists.** Per-game realized RTP (1.2) becomes possible, and a per-game published
edge table becomes worth carrying.

### 1.4 Time-of-day and session-length patterns

**The gap.** Every archived session carries `startedAt` and `endedAt`, and nothing groups on
either.

**Why it matters.** Late sessions and long sessions are where results decay, and people do not
notice it about themselves without being shown. "Sessions that run past two hours end down four
times in five" is a fact about the reader, produced from their own history, with no advice
attached.

**Shape of the work.** Two buckets in Options — start hour, and duration band — each with
sessions, wagered, and P/L. Same aggregation machinery as *By year*, a different key.

---

## Tier 2 — behavioural, and genuinely novel

### 2.1 Loss-chasing detection ✅ DONE

**The gap.** Nothing looks at the *shape* of a session while it is running.

**Why it matters.** Stake escalation after a losing run is the pattern that turns a bad evening
into a bad month, and it is invisible from the inside. The live log already holds per-bet
amounts in order, so the signal is in reach right now: current average stake against the
session's opening average, evaluated while the session is down.

**Shape of the work.** A rolling comparison — say, the mean stake of the last ten bets against
the mean of the first ten — surfaced in the overlay once it crosses a multiple, and as one
desktop notice per session. *"Your average stake has tripled since you went down."*

**Honesty constraint.** It must not fire on a session that opened small and stayed profitable,
and it must not fire twice for the same escalation. This is a statement about the reader's
behaviour, so a false positive costs more credibility than a missed one costs safety.

### 2.2 Pre-commitment budget

**The gap.** The four limits are global settings, editable at any moment — including mid-session,
which is exactly when they get raised.

**Why it matters.** Pre-commitment is the responsible-gambling intervention with actual evidence
behind it. A limit chosen while calm and unavailable while playing is a different instrument from
a limit that can be edited the moment it bites.

**Shape of the work.** A session-scoped budget set before or at the start of a session, and
locked while that session is live. The extension still blocks nothing on the casino — it refuses
to raise *its own* limit until the session closes, or delays the increase. That distinction keeps
the project's posture intact.

### 2.3 Cooldown screen

**The gap.** A crossed limit produces a desktop notice and an overlay flag, both dismissible
without breaking stride.

**Why it matters.** The moment a loss limit is crossed is the moment attention is worth the most
and is given the least.

**Shape of the work.** A full-viewport overlay in the extension's own shadow root, with a short
forced pause before it can be dismissed. It stops no bet and touches nothing of the casino's.

**This one is a decision, not an oversight.** The README commits to *reports, does not
intervene*, and a mandatory pause is the first thing that bends that. Worth choosing
deliberately, and worth being a setting rather than a default if it ships.

---

## Tier 3 — casino-specific value

### 3.1 Bonus wagering-requirement tracker

Casino bonuses carry rollover requirements — 40× is typical — and players routinely lose track
and forfeit. `wagered` is already totalled per session and lifetime, so the tracker is a stored
requirement, a start point, and a progress bar.

Narrow, unglamorous, and the sort of thing somebody would install an extension specifically to
get.

### 3.2 VIP and rakeback forecasting ✅ PARTLY DONE

`flagProgress.progress` and the rakeback balances are already read. What is missing is the
projection: at the current wagering rate, how far the next tier is, and what a unit wagered is
worth back in rakeback.

Players optimise around this deliberately, which makes it attention the conversion feature never
gets. It is also the one place where the honest framing needs care: the value of a tier is not a
reason to wager toward it, and the panel should report the arithmetic without implying the
conclusion.

---

## Deliberately not doing

**Provably-fair seed verification.** Heavy, and the casinos' own tooling covers it.

**Stake sizing, Kelly, or any bet-size suggestion.** Reporting realized RTP describes what
happened. Recommending a bet size advises what to do next, which is the line PLAN.md's legal
review already flags. Everything above stays on the descriptive side of it deliberately.

---

## Suggested order

1. ~~**1.1 lifetime money in and out**~~ — done: deposits and withdrawals kept apart, per coin.
2. ~~**1.2 realized RTP**~~ — done for the observed figure, per coin and per game, null below 200
   bets. Still to do: the expected-loss column, which needs a house-edge figure per game.
3. ~~**1.3 per-game roll-up**~~ — done: accumulated live in `session.games`, frozen at archive.
4. **1.4 time-of-day** — cheap, and it pairs with 1.3 in the same reporting surface.
5. ~~**2.1 loss-chasing**~~ — done: one notice per session, three times the opening pace while down.
6. **2.2 / 2.3** — after the posture question in 2.3 has been answered.
7. **Tier 3** — whenever the casino-specific surfaces are next being worked on.

Together the first three change what the extension is for: from *what is this worth in my
currency* to *what is this costing me*.
