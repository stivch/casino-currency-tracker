# Privacy policy

**Casino Currency Tracker** — last updated 4 August 2026.

## The short version

The developer of this extension receives no data from you, because there is nowhere for it to
go. There is no account, no server, no analytics, no telemetry, no advertising and no third-party
tracking of any kind. Everything the extension records stays in your own browser.

## What the extension stores, and where

All of it is in Chrome's own extension storage on your machine:

| Data | Where | Why |
|---|---|---|
| Settings (target currency, limits, alerts, display options) | `chrome.storage.sync` | So they follow your Chrome profile between your own machines, if you have Chrome sync on. Synced by Google under Google's terms, not sent to us. |
| Recorded sessions: bet counts, stakes, returns, profit, the rate at close | `chrome.storage.local` | The history and reports. Never leaves the machine. |
| The current session, cached exchange rates, diagnostics | `chrome.storage.local` | Working state. |
| Your optional CoinGecko API key | `chrome.storage.local` only | It is a credential. It is deliberately kept out of sync, and is never given to the script that runs inside the casino's page. |

Uninstalling the extension deletes all of it. There is no copy anywhere else — which is why the
extension offers a backup export you control.

## What is sent over the network

Two requests, to two rate providers, and nothing else:

- **CoinGecko** (`api.coingecko.com`) — cryptocurrency prices.
- **exchangerate-api** (`open.er-api.com`) — currency exchange rates.

These carry the coins and the currency being priced. They carry **no** personal data, no
identifier, no account information and nothing about your play. They are the same public price
lookups any currency converter makes. Each provider's own privacy policy governs what they log
about the request (an IP address, as with any web request).

Nothing is ever sent to the extension's developer. There is no endpoint to send it to.

## What the extension reads on the casino's site

While you have a Stake or Duel tab open, and only if the relevant setting is on:

- **Amounts shown on the page**, so they can be converted. Read in the browser, displayed in the
  browser, never transmitted.
- **Your bet ledger** — Stake's "My Bets" table, or Duel's transaction feed — to count your own
  session. Only your own bets: Stake's "All Bets" tab, which shows other players, is explicitly
  refused. *Off switch: Options → Track session P/L.*
- **Rakeback balance and VIP progress**, from responses the casino's own app already receives.
  *Off by default: Options → Read rakeback and VIP progress.*

All of it is stored locally and shown to you. None of it is transmitted anywhere.

The extension reads the authorisation header the casino's own page already uses, in order to
recognise those responses. It stays inside the page, is never stored, and is never sent anywhere.

## Data the developer receives

None.

## Children

The extension is intended for adults, as it is a tool for use alongside gambling sites, which are
themselves restricted to adults.

## Changes

Any change to what is stored or transmitted will be reflected here and in the changelog before
the version making it is released.

## Contact

Issues and questions: the repository's issue tracker.
