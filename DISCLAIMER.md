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

## It reports; it does not intervene

The limits, alerts, and session tracking exist to show you what is happening. They do **not**
block a bet, close a session, lock the site, restrict a deposit, or enforce anything. The
extension cannot move funds and never touches the casino's account or wallet controls. If you
need a tool that actually stops play, use your operator's own deposit limits, cool-off, and
self-exclusion features, or a blocking product built for that purpose.

## No warranty

The software is provided **as is**, without warranty of any kind. See [LICENSE](LICENSE) for the
full terms. In particular, the author is not liable for losses arising from a stale rate, a
floored session total, a missed bet, a limit that reported rather than intervened, a scraper
broken by a site redesign, or any decision you made while looking at this extension's output.

## Gambling can be harmful

If gambling has stopped being entertainment, help exists and it is free and confidential.

- **Gambling Therapy** — international, many languages: <https://www.gamblingtherapy.org>
- **Gamblers Anonymous** — international meeting finder: <https://www.gamblersanonymous.org>
- **GamCare** (UK) — 0808 8020 133, <https://www.gamcare.org.uk>
- **National Council on Problem Gambling** (US) — 1-800-522-4700, <https://www.ncpgambling.org>

Services and helpline numbers differ by country; search for the one operating where you live.
Your operator is also required, in most licensed markets, to offer deposit limits, cool-off
periods, and self-exclusion — those act, and this extension does not.

## Reporting a problem

Accuracy bugs, broken scrapers, and anything that produced a misleading number belong in the
issue tracker. Security issues follow [SECURITY.md](SECURITY.md) instead. Privacy behaviour is
described in [PRIVACY.md](PRIVACY.md), third-party data terms in [NOTICE.md](NOTICE.md).
