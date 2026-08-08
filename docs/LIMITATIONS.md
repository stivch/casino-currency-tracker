# Known limits

What the extension does not do, has not proven, or
deliberately refuses. Session limits are a feature and live in
[SESSIONS.md](SESSIONS.md#limits).

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
- All three surfaces have now been rendered against a stubbed extension API and screenshotted —
  which is how the overlay's P/L curve turned out never to have been drawn at all.
  `svg.hidden = false` sets a plain property on an `<svg>`, because `hidden` is defined on
  `HTMLElement` and an SVG element is not one; the attribute stayed put and the overlay's
  `[hidden] { display: none !important }` kept the chart invisible from the day it was written.
  Both charts now use `toggleAttribute`. What is still unverified is any of it inside a real
  Chrome extension rather than a page pretending to be one.
