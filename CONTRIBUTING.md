# Contributing

Contributions are welcome. This is a small, dependency-free project, so getting set up takes one
command and getting a change reviewed mostly comes down to whether the tests still pass and the
change fits the boundaries below.

## Getting set up

You need Node 22 or newer and Chrome 111 or newer. That is the whole toolchain — there is no
`npm install`, no build step, and no bundler.

```bash
git clone https://github.com/stivch/casino-currency-tracker.git
```

Load it into Chrome: `chrome://extensions` → **Developer mode** on → **Load unpacked** → select
the repository folder. Edits to the source take effect on reload; `manifest.json` changes need
the extension reloaded from that page.

## Running the tests

All four run in CI on every push, and all four should pass locally before you open a pull
request.

```bash
node tools/selftest.mjs
```

Parsing, formatting, spread maths, session accounting, limits, and a live fetch against both
rate providers. Because it talks to the real providers, a provider outage can fail it — CI
retries once for that reason. If it fails only on the provider step, say so in the pull request.

```bash
node tools/domtest.mjs
```

The bet-table scrapers, against a fake DOM built in the test file.

```bash
node tools/bridgetest.mjs
```

The page-world bridge, against a fake `window`, `document`, and `fetch`.

```bash
node tools/package.mjs
```

Builds the distributable zip. Worth running as a sanity check if you touched `manifest.json` or
added a file that needs to ship.

## What a good change looks like

- **Tests come with it.** Anything touching parsing, accounting, scraping, or the bridge needs a
  case pinned in the relevant test file. The bridge and the scrapers depend on someone else's
  markup and someone else's response shapes, which is exactly why they are the most tested parts
  of the codebase.
- **Match the surrounding code.** No framework, no dependency, no transpilation. Comments explain
  *why* a thing is the way it is, especially where it is defending against a site's behaviour.
- **Every user-facing string goes through `_locales`.** Every `i18n` call carries its English as
  a fallback. A language listed in `TRANSLATIONS` in `src/lib/i18n.js` must have a bundle behind
  it.
- **Update `CHANGELOG.md`.** Describe the behaviour that changed, not the diff.
- **Update the docs if behaviour changed.** If what is stored or transmitted changes at all,
  `PRIVACY.md` changes in the same pull request — that is a hard rule, not a nicety.
- One logical change per pull request. A refactor and a feature in one branch is two reviews
  wearing a trench coat.

## Boundaries

Some things are settled design positions rather than open questions. A pull request that crosses
one of these will be declined regardless of how well it is written, so please open an issue first
if you disagree.

- **No telemetry, no analytics, no remote configuration, no server.** Nothing is ever sent to the
  developer, because there is nowhere to send it. This is the project's central promise and it is
  not negotiable.
- **No new network hosts** beyond `api.coingecko.com` and `open.er-api.com` without a discussion
  first. Each one is a privacy-policy change and a manifest permission.
- **Nothing that acts on the user's behalf at the casino.** No auto-betting, no auto-cashout, no
  wallet or account controls, no clicking anything on the casino's page, and nothing that touches
  funds. This one has not moved.
- **Intervening is allowed only against the user's own prior instruction, and only opt-in.**
  Self-exclusion, the cooldown screen and locked limits block things, which the extension once
  said it would never do — the reversal was deliberate, and the rule that replaced it is narrow:
  an intervention must be switched on by the user, must act on a decision they made earlier
  rather than one this extension made for them, and must never oversell what it can enforce. A
  feature that blocks by default, or that implies it cannot be bypassed, is out. See
  [DISCLAIMER.md](DISCLAIMER.md).
- **Nothing that reads other players' data.** Stake's "All Bets" tab is explicitly refused and
  that refusal is pinned in the tests. Keep it that way.
- **New request-originating features stay off by default.** Gated on the tab being open, visible,
  and focused, and rate-floored. That is both the privacy posture and the legal one.
- **No casino branding.** No logos, wordmarks, or brand assets in icons, screenshots, or
  release material. Icons are drawn in code.
- **No bundled dependencies.** If a change needs a library, it probably needs a different design.

## Reporting bugs

Use the issue templates. For scraper breakage — which is the most common kind of bug here, since
both sites ship compiled markup that changes without notice — the useful details are the site,
the page, what the extension showed, what the page showed, and the contents of the Diagnostics
panel in Options.

**Redact before you paste.** Never include your account identifier, an `authorization` header, a
session cookie, a balance dump, or a raw bet ledger in a public issue. Replace figures with
plausible fake ones; the shape is what matters, not your numbers.

Security problems do not go in the issue tracker at all — see [SECURITY.md](SECURITY.md).

Anything that does not fit an issue, including a private word about conduct, goes to
**steve1lion2@gmail.com**.

## Licensing of contributions

By submitting a pull request you agree that your contribution is licensed under the MIT License,
the same terms as the rest of the project ([LICENSE](LICENSE)), and that you have the right to
submit it — that it is your own work, or that you have permission from whoever owns it,
including your employer where that applies.

## Conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
