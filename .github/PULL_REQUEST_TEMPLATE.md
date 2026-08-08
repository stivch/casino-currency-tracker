# What this changes

<!-- The behaviour that is different afterwards, not a summary of the diff. -->

Closes #

## Why

<!-- What was wrong, or what was missing. If it is a site change, say what the site did. -->

## How it was verified

<!-- Which tests cover it, and what you checked by hand in a real browser. -->

- [ ] `node tools/selftest.mjs`
- [ ] `node tools/domtest.mjs`
- [ ] `node tools/bridgetest.mjs`
- [ ] `node tools/package.mjs`
- [ ] Loaded unpacked in Chrome and exercised the change

## Checklist

- [ ] New behaviour is pinned by a test case, especially anything touching parsing, accounting,
      scraping, or the page-world bridge.
- [ ] `CHANGELOG.md` describes the behaviour that changed.
- [ ] User-facing strings go through `_locales`, with an English fallback at every call site.
- [ ] No new dependency, no build step, no bundled library.
- [ ] No new network host. If there is one, `manifest.json`, `PRIVACY.md`, and `NOTICE.md` all
      changed in this pull request.
- [ ] **If anything about what is stored or transmitted changed, `PRIVACY.md` changed with it.**
- [ ] Nothing here acts on the user's behalf, touches funds, or reads another player's data.
- [ ] Any request-originating behaviour is off by default, gated on a visible and focused tab,
      and rate-floored.
- [ ] No real account identifier, credential, balance, or bet ledger appears in the diff, the
      fixtures, or this description.
- [ ] My contribution is licensed under the MIT License, and I have the right to submit it.
