# Casino Currency Tracker

[![CI](https://github.com/stivch/casino-currency-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/stivch/casino-currency-tracker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Chrome extension that shows casino amounts in your own currency at a live rate — any of
forty-five fiats, shekels by default. Works on **Stake** and on **Duel**. No account, no API
key, no build step.

> An independent, unofficial tool. Not affiliated with Stake, Duel, or any casino. It reports; it
> does not intervene, and it cannot touch funds. Using a third-party tool on a casino site may
> breach that operator's terms, and that risk lands on your account — read
> **[DISCLAIMER.md](DISCLAIMER.md)** before installing.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open Stake or Duel. A small readout appears in the bottom-right corner.

Chrome 111 or newer. A packaged zip is attached to each
[tagged release](https://github.com/stivch/casino-currency-tracker/releases) if you would rather
not clone.

**It is not on the Chrome Web Store, and there are no plans to put it there.** This repository
and its releases are the distribution. One consequence worth knowing: Chrome nags about
developer-mode extensions on startup, which is its blanket warning for anything loaded unpacked
rather than anything specific to this one.

## What it does

- **Converts every amount on the casino** — a floating readout that follows your balance, plus
  hover and selection tooltips. Nothing is injected into the page's own DOM.
- **Tracks the session from the site's own bet ledger**, not from balance movement, so turnover
  and bet count are exact and no bet is ever counted twice.
- **Four limits** — loss, turnover, time, bet count — that warn and report. They do not block
  anything, by design.
- **Reports**: recorded sessions, a P/L curve, best multiplier, win rate, CSV export, and
  grouping by fiscal year.
- **A streamer overlay** for OBS, with labels you write yourself.
- **Rakeback and VIP progress**, read from responses the casino's app already receives. Off by
  default.

Everything stays on your machine. Two network calls exist, both to public rate providers, and
neither carries anything about you — see [PRIVACY.md](PRIVACY.md).

## Documentation

| | |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | Every surface — readout, popup, badge, overlay, pinning, tooltips. |
| [docs/SESSIONS.md](docs/SESSIONS.md) | Session accounting, unsettled bets, the balance cross-check, limits, reports, exports. |
| [docs/RATES.md](docs/RATES.md) | The three rate sources, the casino's own price table, refresh timing, the optional CoinGecko key. |
| [docs/SETTINGS.md](docs/SETTINGS.md) | Options, rate alerts, language, off-ramp spread. |
| [docs/RAKEBACK.md](docs/RAKEBACK.md) | Rakeback and VIP progress, and what reading them costs. |
| [docs/SITES.md](docs/SITES.md) | How Stake and Duel differ, and why the domain list is closed. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Tests, file layout, the shadow-root decision, diagnostics. |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | What is unproven, unsupported, or deliberately refused. |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | The contract for adding a casino. |

Plans and history: [CHANGELOG.md](CHANGELOG.md), [ROADMAP.md](ROADMAP.md).

## Development

No dependencies and no build step — Node 22 and Chrome 111 are the whole toolchain.

```bash
node tools/selftest.mjs && node tools/domtest.mjs && node tools/bridgetest.mjs
```

Full details, including the file layout and what each test pins, are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Before opening a pull request, read
[CONTRIBUTING.md](CONTRIBUTING.md) — it lists the design positions that are settled.

## Legal, privacy and policies

| | |
|---|---|
| [DISCLAIMER.md](DISCLAIMER.md) | No affiliation, trademarks, adults only, the operator's terms of service, and why nothing here is financial or tax advice. Read this one. |
| [PRIVACY.md](PRIVACY.md) | What is stored, where, and the two hosts anything is ever sent to. |
| [NOTICE.md](NOTICE.md) | Provider attribution and terms — CoinGecko and exchangerate-api — and the fact that nothing third-party is bundled. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability privately, and which invariants matter most. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, tests, and the design positions that are settled. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | How to behave in the issue tracker. |
| [LICENSE](LICENSE) | MIT, with the warranty disclaimer the limits lean on. |

**This project does not promote, endorse, encourage, or facilitate gambling.** It converts
numbers and keeps a record for people who have already decided to play. It arranges no wagers,
processes no payments, and earns nothing either way — no affiliate links, no referral codes, no
revenue of any kind. It reports; it does not intervene, and it cannot touch funds.
