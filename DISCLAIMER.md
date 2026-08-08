# Disclaimer

**Casino Currency Tracker** — please read this before installing.

This document is not legal advice. It is a plain statement of what this project is, what it is
not, and which risks land on you rather than on the person who wrote it.

## No affiliation

This project is an independent, unofficial tool. It is **not** affiliated with, endorsed by,
sponsored by, or connected to Stake, Duel, or any casino, betting operator, or gambling
platform. It is not affiliated with CoinGecko or exchangerate-api either, beyond being a
consumer of their public price endpoints.

"Stake", "Duel", and every other operator or product name that appears in this repository are
the trademarks of their respective owners. They are used here only to describe, factually,
which sites the extension reads — nominative use. No casino logo, wordmark, or brand asset is
bundled, reproduced, or imitated anywhere in this project; the icons are drawn in code
(`tools/make-icons.js`).

## No endorsement

This project does not promote, endorse, encourage, or facilitate gambling. It is a currency
converter and a record-keeper for people who have already decided to play. It arranges no wagers,
takes no stake, processes no payments, and is not compensated by anyone for any of it — no
affiliate links, no referral codes, no sponsorship, no revenue of any kind. Nothing in this
repository is a recommendation to gamble, to gamble more, or to gamble anywhere in particular.

## Adults only

This is a tool for use alongside gambling sites, which are themselves restricted to adults. Do
not install or use it if you are under the legal gambling age where you live.

## The casino's terms of service — this risk is yours

Most casinos, Stake included, prohibit automation, scraping, and unauthorised third-party tools
interacting with their service. This extension:

- reads amounts from the page and reads responses the casino's own app already receives — passive,
  but still plausibly "unauthorised tooling" under terms as they are usually written;
- and, **only if you switch on the optional polling features**, originates requests to account
  endpoints from your own logged-in session, which is exactly the shape of traffic bot-handling
  systems look for.

Any consequence of that falls on **your account, not on the author** — a flag, a restriction, a
closure, or confiscation of funds under the operator's terms. The polling switches are off by
default for this reason. Read your operator's terms and decide for yourself. If you are not
willing to accept that risk, do not use the extension, or leave *Track session P/L* and *Use the
casino's own price table* switched off.

## Legality where you live

Online gambling is regulated, restricted, or outright illegal in many jurisdictions. This
extension does not provide, facilitate, or arrange gambling, does not process wagers or
payments, and does not circumvent any access control, geoblock, or ISP block. It is display-only
tooling that converts numbers already on your screen. Whether you may lawfully use the
underlying gambling service is a question about you and your jurisdiction, and it is yours to
answer.

## Not financial, tax, investment, or legal advice

Nothing produced by this extension is advice of any kind.

- The **By year** report and the CSV exports are an informational readout, not an accounting
  record. The figures are **floors**: they count what the extension was able to observe, and the
  extension tells you when it detects a gap. Your operator's own records and your own bank and
  exchange statements are authoritative. Gambling taxation differs by country; consult a
  qualified professional.
- Exchange and crypto rates are third-party data, cached, and can be stale, wrong, or briefly
  unavailable. Never treat a converted figure as the amount you would actually receive.
- Nothing here is a recommendation to gamble, to gamble more, to gamble on a particular game, or
  to hold or convert any currency or cryptocurrency.

## What it does, and does not, stop

By default it reports and nothing more. The limits, alerts, and session tracking exist to show
you what is happening; they do **not** block a bet, close a session, restrict a deposit, or
enforce anything, and the extension can never move funds or touch the casino's account and
wallet controls.

Three features are the exception, and all three are **off until you switch them on**:

- **Self-exclusion** blocks every casino this extension knows about for a period you choose.
  Once set it cannot be shortened or cancelled from anywhere in the extension.
- **The cooldown screen** holds the page for a few seconds the first time a session crosses each
  limit you set.
- **Locked limits** refuse to raise or switch off a session limit while a session is running.
  Tightening one is always allowed.

**None of them can be enforced, and this matters.** Chrome removes an extension in two clicks and
takes its settings with it. Nothing here can close your account, reach a device this extension is
not installed on, or stop you playing somewhere it has never heard of. What these do is raise the
cost of a decision made in the moment — which is worth something, and is not the same as being
stopped.

**If you need something that actually holds, ask the casino for their own self-exclusion.** Theirs
can close the account, and in licensed markets they are required to offer it. Use their deposit
limits and cool-off periods too, or a blocking product built for the job. Treat this extension as
a supplement to those, never as a replacement for them.

## No warranty

The software is provided **as is**, without warranty of any kind. See [LICENSE](LICENSE) for the
full terms. In particular, the author is not liable for losses arising from a stale rate, a
floored session total, a missed bet, a limit that reported rather than intervened, a scraper
broken by a site redesign, or any decision you made while looking at this extension's output.

## If you want to stop

This extension shows you the numbers. It does not stop anything, and it was never built to. The
controls that actually act are your operator's own deposit limits, cool-off periods, and
self-exclusion, which licensed markets require it to offer.

If gambling has stopped being entertainment,
[Gambling Therapy](https://www.gamblingtherapy.org) is free, confidential, international, and
staffed in many languages.

## Reporting a problem

Accuracy bugs, broken scrapers, and anything that produced a misleading number belong in the
issue tracker. Security issues follow [SECURITY.md](SECURITY.md) instead. Privacy behaviour is
described in [PRIVACY.md](PRIVACY.md), third-party data terms in [NOTICE.md](NOTICE.md).
