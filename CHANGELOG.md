# Changelog

The version in `manifest.json` is the single source of truth; a release is a
`v<version>` tag, and CI attaches the zip to it.

## Unreleased

- **Stake's wallet, from its own books.** `UserBalances` joins `VipMeta` and
  `VipProgressMeta` as an operation the bridge reads when account reading is
  switched on. It gives the balance for every coin at once, so the readout has
  a figure even when the balance chip is not on the page — the last case where
  it had nothing to show.

  Only `available` is taken. `vault` is money set aside that cannot be bet from,
  and adding it in would make the wallet disagree with the bet ledger by exactly
  the amount put away. Only non-zero balances are forwarded, which is safe
  because the reply is exhaustive: a coin missing from the list holds nothing
  rather than being unknown. On the capture this was built against that is one
  row out of 174 — 54 bytes on the bus instead of 27 KB.

  It does **not** override the figure on screen. The API number is exact, but it
  arrives only when Stake's app asks for it, and that is a whole-wallet query
  rather than something re-run per bet; the number on the page updates the
  moment a bet settles. For a figure that exists to be compared against a
  growing bet ledger, fresh beats exact.

- **Fixed: the account-reading switch was wearing another row's label.** It and
  the *Rakeback % of the edge* field in Reports both used the `optRakeback` key,
  so once the message bundle loaded, the switch in *On the page* relabelled
  itself "Rakeback % of the edge" and described the cost report. Separate keys,
  and a test that fails when two elements share a key while carrying different
  English.

- **The balance is followed on its own, and pins are per site.** Two reasons a
  pin had to be made again, both now gone. There was one pin slot shared by both
  casinos, so pinning on Stake and then opening Duel left the readout saying
  *element not on this page* — which reads as a broken pin rather than as a pin
  for somewhere else. And a pin is a generated path into markup both sites
  re-render wholesale on navigation, so it could simply stop matching.

  With nothing pinned the readout now follows the site's own balance chip: the
  `data-testid` each adapter already carries for reading the wallet coin
  (`coin-toggle` on Stake, `currency-value` on Duel), which both sites keep
  stable across deploys while regenerating everything underneath it. Pinning is
  for choosing a *different* number, and what you choose is remembered against
  the casino you chose it on.

  On every read three candidates are tried in order — this site's pin, the old
  single pin, the balance chip — and the first that **resolves** wins, not the
  first that is set. That is the part that matters: a path that stops matching
  falls through to the chip instead of asking to be pinned again. The order is
  `pinCandidates` in `lib/scrape.js`, pure and tested; the content script keeps
  only the half that needs a document. Anyone who had pinned before this still
  has that pin, and it yields to a new one.

- **Settings, in sections.** The options page had grown to fourteen headings on
  one column, which put the refresh interval and the tax-year grouping the same
  distance from the top as each other and made neither findable. It is now a
  sidebar and one pane at a time: General, On the page, Session & limits, Alerts,
  Streamer overlay, Reports, Sites, Backup & data.

  Which pane is showing is the URL fragment and nothing else — so back and
  forward work, `options.html#reports` can be linked to, and there is no stored
  preference to fall out of step with the address bar. Below 860px the sidebar
  becomes a strip that scrolls sideways above the pane, which is the only
  arrangement that leaves neither half unusable. The version number sits under
  the extension's name, and "Saved." is now a pill pinned above the page instead
  of a line at the foot of it, where on a page that long nobody ever saw it.

- **Fixed: an English page in somebody else's language.** On a browser whose own
  UI language this extension ships no bundle for — Hebrew, say — the settings
  page named its currencies and months in that language while every other word
  on it stayed English: *Convert to* offered `שקל חדש — ILS`, reversed on screen
  because the page had also declared itself right-to-left. Recorded session
  dates and clock times went the same way.

  The cause was `activeLanguage()` falling back to `chrome.i18n.getUILanguage()`.
  That names the *browser*, which is a different question from what language this
  page is in: with only an English bundle, `chrome.i18n` serves English to a
  Hebrew browser and the page is English. Writing "he" into `<html lang>` was
  describing something untrue, and `Intl` believed it. It is now clamped to the
  languages actually shipped — `TRANSLATIONS` in `lib/i18n.js`, which a test
  holds against the folders in `_locales`. The currency and month pickers take
  the language from that rather than reading it back off the document, and every
  date, time and count on the options page passes it explicitly instead of
  defaulting to the browser's.

- **Streamer overlay.** A separate window showing the live session, large, on a
  flat colour — Options → *Streamer overlay*. Capture it in OBS as a Window
  Capture with a Chroma Key filter on the background. It is a window rather than
  a URL because OBS's Browser Source runs its own browser and cannot open an
  extension page, and the background is a colour rather than transparent because
  window capture composites against the browser's own opaque backdrop, so a page
  with no background is captured as white. Six fields to choose from, a row or a
  stack, a text size and two colours. It reads the same session everything else
  does through the state mirror in local storage: no request, no permission,
  and it writes nothing.

  **The labels are yours to write.** Each field carries a text box; whatever is
  typed there is what goes on screen, in any script, and a blank one falls back
  to the translated label. This is the one surface where the extension does not
  get to choose the words — an overlay is read by an audience whose language it
  has no way of knowing, and no translation was ever going to cover a streamer
  who wants "PROFIT" where the popup says "P/L".

  Two decisions worth naming. Only P/L and turnover are on by default and the
  rest are ticked one at a time, because this is the one surface whose audience
  is not the person playing — a bet count and a win rate say more about somebody
  than they may have meant to broadcast. And profit stays green and loss stays
  red whatever colours are picked, because that is what a glance at a stream is
  reading. A field with nothing to report yet is left out rather than shown as a
  dash: an empty box on screen reads as something broken.

- **Best multiplier and win rate.** Every session now keeps the highest payout
  multiplier it produced, with the game it happened in, and reports how often a
  bet came back at all. Both appear in the popup, the overlay, the lifetime
  totals, the history table and the CSV export. The multiplier is *derived* from
  the stake and the return already recorded rather than read off the page — three
  readers feed the accounting and only one of them publishes a multiplier, so
  taking it from a fourth place would be a fourth place for them to disagree.
  Gross over stake is the definition of the figure, so it can never contradict
  the turnover beside it. A zero-stake bet sets no record: a free spin returning
  anything divides by zero, and "∞×" is not a result. Win rate carries no minimum
  sample, unlike realized RTP — six of ten is exactly six of ten, where an RTP
  over ten bets is variance wearing a percent sign. Sessions closed before this
  landed show a dash, not a best of nothing.

- **What it costs.** A per-coin report of what the games took, what they were
  expected to take, and what came back. Rakeback is a percentage of the *house
  edge* — 3.5% per Stake's own help centre, not a flat share of turnover — so
  it returns the same fraction of expected loss whatever you play and cannot
  make one game better than another. The panel says so, because the affiliate
  ecosystem widely claims the opposite: a 4% slot pays more rakeback than a 1%
  original and is still four times more expensive. Rather than trusting any
  published rate, the extension watches the rakeback balance and sums its
  rises, so it can report the rate actually being paid.

- **Loss-chasing notice.** One desktop notice per session when the stakes reach
  around three times what the session opened with *while it is down*. Raising
  stakes to win back losses is close to invisible from the inside, because each
  raise on its own looks reasonable and nothing adds them up. The opening pace
  is frozen from the session's first ten bets rather than read back from the
  per-bet log, which only holds the last fifty — by the time a session has
  escalated, what it opened with has fallen out of it. It reports the figures
  and nothing else: no advice, and nothing is blocked. Off switch in Options →
  *Alerts*.

## 1.5.0 — 5 August 2026

- **Double-counting guard.** On Stake two readers see every original — the game
  endpoints and the bet table — and it all rests on them agreeing about a bet's
  id. They do agree, as far as anything has shown; but if they ever stop, every
  figure silently doubles and a doubled total looks entirely reasonable. Each
  bet now records which reader counted it, and a table row matching a
  just-counted round on game, stake and time raises a diagnostic saying so. It
  only ever warns: nothing is merged or dropped on a guess.

- **Stake rounds are read as they are played.** Stake's originals run on REST
  endpoints (`/_api/casino/<game>/bet`, `/next`, `/cashout`) and every reply
  carries the same envelope: round id, game, currency, stake and payout
  multiplier, with only `state` differing per game. Watching those gives an
  exact stake, the round's own coin, and the result the moment it lands —
  no bet table, no wallet chip, no ten-row window. Read only: the bridge never
  sends one, and a test asserts it with every timer firing.
  The bet table stays as the reader for what Stake does not run itself,
  provider slots and sports.

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
