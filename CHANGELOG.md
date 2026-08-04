# Changelog

The version in `manifest.json` is the single source of truth; a release is a
`v<version>` tag, and CI attaches the zip to it.

## Unreleased

- **By game.** Every bet already carried its game name and it was thrown away
  when the session was archived. Sessions now accumulate per-game totals as
  bets arrive — not rolled up from the per-bet log at close, which only holds
  the last 50 — and keep them in history. Options gets a *By game* table with
  bets, turnover, P/L and return per game per coin.
- **Lifetime money in and out.** `funded` was recorded every session and never
  summed. Deposits and withdrawals are now totalled per coin and kept apart
  rather than netted, since ten in against ten out is not nothing happening.
- **Realized return.** What came back per unit staked, per coin and per game.
  Blank below 200 recorded bets, because under that it is variance with a
  percent sign on it.

- **Sites are a closed list.** `CASINOS` in `src/lib/settings.js` names every
  casino and every domain it answers on; the extension runs nowhere else, and
  the manifest is checked against the registry by the test suite. Duel's
  `duel.limited`, `duel.vip` and `duel.net` now work out of the box.
- A casino may declare switchable domains that ship off and are turned on from
  Options → *Sites*, which asks Chrome for access to that host and registers
  the content scripts at runtime. This build ships none.
- Fixes a silent failure: an unrecognised Duel domain fell through to the Stake
  adapter, so it watched for a bet table that does not exist and session
  tracking was dead with no fault reported anywhere.
- Stake's header capture now happens only on the account operations it can
  actually replay, rather than on any request to the GraphQL endpoint.
- `ROADMAP.md` and `docs/ADAPTERS.md`.

## 1.4.0

- Renamed to **Casino Currency Tracker** — the old name led with a third-party
  trademark and a currency the extension is no longer limited to.
- Full backup: one JSON file with settings and recorded sessions (never the API
  key), and a validating import that merges instead of replacing.
- Rate alerts: a desktop notice when the effective rate crosses a threshold you
  set, in either direction.
- First-install page explaining what leaves the machine and what the two
  privacy-relevant switches cause the extension to request.
- **English only.** The Hebrew bundle and all right-to-left layout support are
  removed; localisation returns when there is more than one translation to
  carry. The bundle machinery stays, so a language is a data change.
- `PRIVACY.md`, for the store listing and for anyone who wants it written down.
- Repository: git history, CI running the three test suites, `tools/package.mjs`
  building a reproducible release zip.

## 1.3.0

Last of the pre-repository versions. Multi-currency conversion (45 fiats),
session tracking on Stake and Duel, session limits with desktop notices,
history with frozen-rate snapshots restateable across currencies, fiscal-year
grouping, CSV exports, English and Hebrew.
