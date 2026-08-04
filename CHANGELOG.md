# Changelog

The version in `manifest.json` is the single source of truth; a release is a
`v<version>` tag, and CI attaches the zip to it.

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
