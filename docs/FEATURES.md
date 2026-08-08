# What you get

**The toolbar popup** — the current rate, a two-way calculator, the live session with its P/L
curve, and the four session limits, editable in place. Works everywhere, not just on the casino.

**The toolbar badge** — session P/L in your currency on the icon itself while a session is running,
the rate when one is not. Green up, red down, exact figure in the tooltip. Turn it off in
Options → *Alerts* if you would rather the icon stayed quiet.

**A streamer overlay** — a separate window with the live session, large, on a flat colour.
Options → *Streamer overlay*, then capture it in OBS as a **Window Capture** with a **Chroma
Key** filter on the background. It is a window rather than a URL because OBS's Browser Source
runs its own browser and cannot open an extension page; the background is a colour rather than
transparent because window capture composites against the browser's own opaque backdrop, so a
page with no background of its own is captured as white.

**The labels are yours to write.** Every field has a text box beside its tick, and whatever you
type is what goes on screen — any language, any script, or something that is not a translation
of anything. Leave one blank and it falls back to the default. This is the one surface where the
extension does not choose the words, because an overlay is read by an audience whose language it
has no way of knowing.

Six figures to choose from, a row or a stack, one text size and two colours. Only P/L and
turnover are on by default and the rest are ticked one at a time — this is the one surface whose
audience is not the person playing, and a bet count and a win rate say more about somebody than
they may have meant to put on screen. Profit stays green and loss stays red whatever colours you
pick, because that is what a glance at a stream is reading.

**The floating readout** on the casino — the live rate, plus one amount of your choosing pinned
to it. Drag it by its header; it remembers where you put it.

**Your balance is followed automatically.** The readout tracks each site's own balance chip
without being told to — `coin-toggle` on Stake, `currency-value` on Duel. Those are
`data-testid` hooks both sites keep stable across deploys, while the markup underneath them is
regenerated every time the balance changes, which is exactly why the chip is the thing worth
following and the digits are not.

**Pin an amount** only when you want a *different* number. Click *Pin an amount on the page*,
then click it; it is converted once a second from then on. Pins are remembered **per site**, so
one made on Stake is not carried to Duel and found missing there.

Three things are tried in order on every read — this site's pin, the single pin from before pins
were per site, then the balance chip — and the first that actually resolves is used. "First that
resolves" rather than "first that is set" is what stops a pin ever needing to be made again:
both sites re-render whole subtrees when you navigate, so a stored path can quietly stop
matching, and the readout falls back to the chip instead of asking you to point at it again. The
order lives in `pinCandidates` in `lib/scrape.js`, where it is a pure function with tests on it,
rather than in the content script where only half of it could be exercised.

Only if none of the three resolves does the readout say *element not on this page*, rather than
freezing a stale figure.

**Currency is detected, not assumed.** Stake tags its currency chip (`data-ds-icon="USDT"`), so
the readout names the coin it found — and it is priced in its own right. Duel's header renders
`$` whatever the wallet holds, so there the coin comes off the account reader and the bet ledger
instead, both of which name it outright. Either way the USDT lookup carries fourteen more coins
in the same request (`/simple/price` takes an id list, so pricing fifteen coins costs exactly
what pricing one did), which is what lets a BTC session show money and be held to a money
limit. A coin that request did not price says *no BTC rate yet* rather than running the balance
through the USDT rate and showing a confident number that is wrong by five orders of magnitude.

**Hover** over any amount for a tooltip. **Select** any number to convert it, whether or not it
carries a currency label — selecting something is an explicit "convert this".
