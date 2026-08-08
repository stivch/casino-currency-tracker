# Rakeback and VIP progress

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

**On Stake this also reads your wallet.** `UserBalances` is a third operation on the same
endpoint, and it answers with `available` and `vault` for every currency Stake supports — 174 of
them in the reply this was built against, of which exactly one was non-zero. Only `available` is
taken: `vault` is money set aside that cannot be bet from, and adding it in would make the wallet
disagree with the bet ledger by precisely the amount put away. Only non-zero balances are
forwarded, which is safe because the reply is exhaustive — a coin missing from the short list is
a coin holding nothing, not a coin nobody asked about. That is a 54-byte message instead of a
27 KB one, on a bus every script on the page can read.

**It does not replace the figure on screen, and that is deliberate.** The API number is exact and
covers every coin at once, but it arrives only when Stake's app happens to ask — a whole-wallet
query, not something re-run per bet — while the number on the page updates the moment a bet
settles. For a figure whose whole job is to be compared against a bet ledger as it grows, fresh
beats exact. So it fills the gap the page reading leaves rather than overriding it: it is what
lets the readout show a balance when the balance chip is not on the page at all.

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
