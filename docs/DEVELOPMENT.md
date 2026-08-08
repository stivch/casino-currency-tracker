# Development

No dependencies, no build step: Node 22 and Chrome 111 are the whole toolchain.
Contribution workflow and the settled design positions are in [../CONTRIBUTING.md](../CONTRIBUTING.md).

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
  en                 UI strings; every call carries its English as a fallback.
                     One folder per shipped language, and `TRANSLATIONS` in
                     lib/i18n.js has to name the same set — a language claimed
                     with no bundle behind it is what Intl then names currencies
                     and months in
src/
  background.js      service worker: the only thing that touches the network
  content.js         the overlay; standalone, since content scripts are not modules
  popup.html/.js     rate + calculator
  options.html/.js   settings, reports and history — eight panes behind a
                     sidebar, with the URL fragment deciding which one shows
  overlay.html/.js   the streamer overlay window
  ui.css             shared by popup and options
  overlay.css        the overlay's own; shares nothing with ui.css, because
                     every panel and border in there would be captured too
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

Everything that knows which casino it is on is in four places and nowhere else: `siteFor()` in
`lib/scrape.js`, the `STAKE` and `DUEL` adapters in `lib/stakebridge.js`, the `matches` lists in
the manifest, and the user's own *Other domains* list. Nothing else branches on a hostname —
`content.js` and the bridge both read a resolved site rather than testing one.

The bridge is the awkward case: it runs in the page's own world, so it can read neither the
settings nor `siteFor()`. It is therefore *told* which site it is on, on the config message the
content script already sends, and falls back to its own copy of the built-in host pattern.
That copy is the one duplication here, and `tools/domtest.mjs` asserts the two agree — if they
drift, a mirror is Duel to one layer and Stake to the other.

[docs/ADAPTERS.md](ADAPTERS.md) is the contract for adding a casino.

State flows one way: settings live in `chrome.storage.sync`, the rate cache in
`chrome.storage.local`, and the service worker mirrors both into a single `mirror` key that the
content script reads and watches. That is why the extension needs no `tabs` permission — there
is no broadcast, just a value everyone reads.

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
