# Settings

Right-click the toolbar icon → Options, or *All settings* in the popup.

| Setting | What it does |
|---|---|
| Refresh every | Minutes between fetches. **1 minute is the useful floor** — see [How fast can it update?](RATES.md#how-fast-can-it-update) |
| Convert to | The currency every amount is shown in. Forty-five fiats; ILS by default. |
| Decimal places | Rounding for displayed amounts. A currency with no minor unit — the yen — ignores this and shows whole units. |
| Off-ramp spread % | Subtracted from the quoted rate. See [Off-ramp spread](#off-ramp-spread). |
| Manual rate override | Blank uses the live feed; a number ignores it completely. |
| Assume unlabelled numbers are USDT | See [that section](#assume-unlabelled-numbers-are-usdt). |
| Annotate amounts inline | Appends the converted figure after labelled amounts on the page. |
| Wager / Loss / Win / Time limit | The four session thresholds. Blank = off. See [Limits](SESSIONS.md#limits). |
| Tax year starts in | Which month the *By year* report buckets on. January by default. |
| Toolbar badge | Session P/L on the icon, or the rate when no session is running. |
| Notify when a limit is crossed | Desktop notice, once per limit per session. |
| Alert when the rate rises above / falls below | Desktop notice when the rate crosses a line you set. Blank = off. |

## Rate alerts

Two thresholds, in your currency per USDT. A notice fires **on the crossing**, not while the
condition holds — a rate that sits above your line all afternoon is one notice, not one every
minute. It re-arms when the rate crosses back, so a figure oscillating around your threshold
tells you each time it genuinely moves through it.

Both compare the *effective* rate, after your off-ramp spread, so the alert agrees with the
number on the badge rather than with a mid-price you would never actually receive. Changing your
target currency converts the thresholds along with the money limits, at the same cross-rate.

## Language

**English only for now.** Every user-facing string still lives in
`_locales/en/messages.json` rather than in the markup, and the machinery that resolves and
publishes a bundle is intact — so adding a language is a new folder under `_locales` plus one
entry in `LANGUAGES`, not a rewrite.

`chrome.i18n` cannot be overridden at runtime; it answers with Chrome's display language and
nothing else, which is why an extension that only used it could be switched to another language
only by relaunching the whole browser in that language. So the service worker resolves the
language itself, loads the matching bundle, and publishes it: pages read it from state, the
overlay from its own storage key. `chrome.i18n` stays underneath as the fallback.

Every string also carries its English text at the call site, so a missing translation shows the
English rather than a raw message key. Language and target currency are independent axes: the
figures print `€1,234.50` whatever the interface language is.

Right-to-left support was written and then removed along with the Hebrew bundle — the bidi
isolation of figures and the flipped accents are in the git history if an RTL language returns.


## Off-ramp spread

The quoted rate is a mid-price. Nobody actually receives the mid-price — your exchange takes a
cut on the way out. Set the spread to what yours really charges and every figure the extension
shows becomes what you would actually get, not what a market data feed says a token is worth.
Leave it at 0 for the raw rate.

## Assume unlabelled numbers are USDT

Stake's header balance is a bare number next to a coin icon — there is no "USDT" text anywhere
in the element to key off. Turning this on lets hover convert it.

The cost is that it cannot then tell a balance from a `2.55x` multiplier, an odds figure or a
player count, so hover starts converting things that are not money. It is off by default, and
**pinning your balance is the better answer** — pinning always reads the number regardless of
this setting, because you have already told it what that element is.
