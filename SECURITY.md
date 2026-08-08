# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead: the **Security** tab of this repository →
**Report a vulnerability**. That opens a private thread visible only to the maintainers.

If that is unavailable to you, email **steve1lion2@gmail.com** with `casino-currency-tracker` in
the subject line. Plain email is not encrypted — send enough to establish that a problem exists
and we can move somewhere better before you send details.

Please include what you would want to receive yourself: the version (`manifest.json`), the
browser, which site it happens on, what an attacker gains, and the smallest reproduction you can
manage. A synthetic reproduction is worth more than a real one — **never attach a real account
identifier, authorisation header, session cookie, balance dump, or bet ledger.** Redact them.

Expect an acknowledgement within a week. There is no bug bounty; this is an unpaid personal
project, and the only reward available is credit in the changelog, which you may decline.

## Supported versions

Only the latest release is supported. Fixes land on `main` and ship in the next tagged version.

## What this extension is, in security terms

It runs in the browser with access to a logged-in gambling session. That makes a handful of
things genuinely sensitive, and they are the reports most worth making:

- **Stake's `authorization` header.** The page-world bridge (`src/lib/stakebridge.js`) captures
  the header the casino's own app already sends, so it can recognise the responses it cares
  about. It is designed to stay inside a closure in the page world, never be stored, never cross
  the message bus, and never leave the machine. Anything that gets it out is a serious finding.
- **The message bus between page world and content script.** Every page on the site can listen
  to it. Bet data is trimmed of seeds and balances *before* it reaches the bus, by design. A
  path that puts more on the bus than intended is a finding.
- **The optional CoinGecko API key.** A user credential, deliberately kept in
  `chrome.storage.local` rather than `chrome.storage.sync`, and deliberately withheld from the
  content script. Anything that leaks it into the page, into sync storage, or onto the network
  other than to CoinGecko is a finding.
- **The polling features.** They originate requests against the user's own account and are off
  by default. A path that makes them fire without being switched on, from a hidden or unfocused
  tab, or at a higher rate than the floor, is a finding.
- **Anything that transmits user data anywhere.** The extension has no server and no analytics.
  Any outbound request to a host other than `api.coingecko.com` and `open.er-api.com` is, by
  itself, a bug.
- **Injection.** Amounts scraped from a hostile page reach the extension's own surfaces. A path
  from scraped text to script execution in the popup, options, or overlay is a finding.

The invariants above are pinned in `tools/bridgetest.mjs` and `tools/domtest.mjs`. If you find a
break, a failing test case makes the fix much faster.

## Out of scope

- The casino's own site, infrastructure, or account security — report those to the operator.
- CoinGecko and exchangerate-api. Report to them.
- Anything requiring the user to install a malicious extension, run attacker-supplied code in
  their own console, or hand over their own credentials.
- Rate inaccuracy, stale prices, or a session total that reads low. Those are correctness bugs —
  the public issue tracker is the right place, and [DISCLAIMER.md](DISCLAIMER.md) describes the
  limits deliberately accepted.
- Denial of service against the two rate providers, or anything that involves generating load
  against a third party. Do not test that.

## Disclosure

Please give a reasonable window — 90 days is the default assumption — before publishing, and
coordinate the timing if a fix is in progress. Fixed issues are described in the changelog, with
credit unless you would rather not have it.
