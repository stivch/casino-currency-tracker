# Sites and domains

Which casinos the extension runs on, how the two differ, and why the list is closed.

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
| Wallet balance | the figure on the page, with `UserBalances` behind it | the figure on the page |
| Wallet coin | read off the currency chip in the header | read off the ledger rows — Duel's header says `$` whatever it holds |
| Credentials touched | the page's own `authorization` header, kept in the page | none — Duel's session is a cookie the browser attaches itself |

**Duel is the one place this makes requests it did not have to.** Stake publishes its bets as
markup and re-fetches its price table every few seconds, so both can simply be watched. Duel
answers only when asked, so a session there means asking. Both reads are gated on the tab being
open, visible **and** focused; both stop the moment you switch the feature off. If you would
rather it asked for nothing at all, turn off *Track session P/L* and *Use the casino's own price
table* — everything else keeps working.


## Other domains

**The extension runs on a closed list of domains and nowhere else.** Today that is
`stake.com`, `stake.bet`, `stake.games`, `stake.us`, `duel.com`, `duel.limited`, `duel.vip` and
`duel.net`, each with its subdomains.

That list lives in one place — `CASINOS` in `src/lib/settings.js` — and the manifest is checked
against it by `tools/selftest.mjs`, so a domain one allows and the other does not fails the
build rather than shipping as a switch that quietly does nothing.

The limit is deliberate. What the extension knows about a casino is a set of assumptions about
that one site's bet ledger, its price table and its wallet chip. Pointing those at a site they
were not written for does not produce an error; it produces confident wrong numbers. So there is
no "add any domain" box, and **support for a new casino is a new version, not a setting**.

A casino may also declare *switchable* domains — extra domains it answers on that ship switched
off. Those appear in Options → *Sites*, and turning one on asks Chrome for access to that host
and registers the same two content scripts the manifest declares (the page-world reader at
`document_start`, the scraper plus overlay at `document_idle`) via
`chrome.scripting.registerContentScripts`. The permission is per machine, and removing the entry
hands it back. This build ships none — both casinos' known domains are built in.

Next: BC.Game and Roobet. Each needs its own adapter before its domains can be listed;
[docs/ADAPTERS.md](ADAPTERS.md) is the contract, and it starts with capturing real traffic
rather than adding a hostname.
