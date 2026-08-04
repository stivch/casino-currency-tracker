// Content script. Everything it draws lives in a closed-off shadow root hanging
// off <html>, never inside the page's own tree.
//
// That is not tidiness, it is a hard constraint. Both casinos are compiled
// reactive apps — Stake a Svelte one (its markup carries svelte-xxxxxx scoped
// class hashes), Duel a Vue one (data-v-xxxxxxxx) — and their compiled output
// holds direct references to the nodes they created and to the anchor nodes
// they insert before. Adding or removing children inside a component's subtree
// desynchronises those references, so the next update writes to the wrong place
// or throws on a node that is no longer where it was left.
//
// The overlay is therefore a sibling of <body>, outside every component, and
// the one inline mode annotates via a data- attribute read back by a CSS
// ::after rule — an attribute no component owns, adding no node to any
// component's subtree.
//
// This file is deliberately standalone: content scripts are not ES modules, so
// the few formatting helpers below are a small copy of src/lib/format.js.

(() => {
  'use strict';

  if (window.__stakeIlsConverterLoaded) return;
  window.__stakeIlsConverterLoaded = true;

  const ATTR = 'data-stake-ils';
  const POLL_MS = 1000;

  // Which casino this is. Everything site-specific — where the bet ledger
  // lives, what the wallet chip looks like, what to call the account box — is
  // named in lib/scrape.js and read from here; nothing else in this file
  // branches on a hostname.
  //
  // Re-resolved once settings arrive, because a user-added mirror is not
  // knowable from the hostname alone. Until then a built-in host answers
  // correctly and anything else assumes Stake, which is the shape of every
  // site this runs on bar one.
  const resolveSite = (mirrors) =>
    globalThis.StakeScrape.siteFor(location.hostname, mirrors) || globalThis.StakeScrape.SITES.stake;

  let SITE = resolveSite(null);

  // The language the service worker resolved, published under its own storage
  // key. chrome.i18n is the fallback underneath it — it can only ever answer
  // with Chrome's display language, which is exactly what the setting exists
  // to override.
  let messages = null;
  let language = null;

  /**
   * Localised text, with the English written at the call site as the fallback.
   * The overlay is drawn from a template literal, so a missing message degrades
   * to the string that was always there rather than to a raw key.
   */
  function t(key, fallback, subs) {
    const entry = messages?.[key];
    if (entry?.message) {
      let message = entry.message;
      for (const [name, spec] of Object.entries(entry.placeholders || {})) {
        const index = Number(String(spec.content).replace('$', '')) - 1;
        const value = Array.isArray(subs) ? subs[index] : subs;
        message = message.replace(new RegExp(`\\$${name}\\$`, 'gi'), value ?? '');
      }
      return message;
    }
    return chrome.i18n?.getMessage(key, subs) || fallback;
  }

  /** @returns true when the language actually changed. */
  function applyBundle(bundle) {
    if (!bundle || bundle.lang === language) return false;
    language = bundle.lang;
    messages = bundle.messages || null;
    return true;
  }

  /**
   * The overlay bakes its strings in when it is built, so a language change is
   * a rebuild rather than a re-render. It happens about as often as someone
   * changes the setting, which is to say almost never.
   */
  function relocalise(bundle) {
    if (!applyBundle(bundle) || !host) return;
    teardown();
    if (lastState) guard('apply state', () => applyState(lastState));
  }

  /**
   * Is this script still attached to a live extension?
   *
   * Reloading or updating the extension orphans every content script already
   * running in a page: the DOM keeps them alive, but `chrome.runtime` is dead
   * and every call through it throws *synchronously* — which is why a trailing
   * .catch() does not save you, and why an orphan used to sit there throwing
   * "Extension context invalidated" on a 1-second timer forever.
   */
  const alive = () => Boolean(chrome.runtime?.id);

  /** Fire-and-forget message. Never throws, and retires the script if orphaned. */
  function send(message) {
    if (!alive()) return void shutdown();
    try {
      chrome.runtime.sendMessage(message)?.catch?.(() => {});
    } catch {
      shutdown();
    }
  }

  /**
   * Run something that touches Stake's DOM, reporting a failure instead of
   * swallowing it. Stake re-renders constantly, and without this a broken
   * scraper leaves the overlay sitting there with stale numbers on it and the
   * only evidence buried in the page's own console, where nobody is looking.
   */
  function guard(where, fn) {
    if (!alive()) return void shutdown();
    try {
      return fn();
    } catch (error) {
      // The reporting path is the one place that must not be able to throw:
      // an error inside the error handler is what reaches the page as uncaught.
      send({ type: 'contentError', where, message: String(error?.message || error).slice(0, 300) });
      return undefined;
    }
  }

  let settings = null;
  let rate = null;
  let session = null;
  let diagnostics = [];
  let stake = null;
  let currentCurrency = null;

  let host = null;
  let shadow = null;
  let hud = null;
  let tip = null;
  let outline = null;

  let picking = false;
  let accountBusy = false;
  let accountBusyTimer = null;
  let accountNote = null;
  let lastState = null;
  let heartbeat = null;
  let trackTimer = null;
  let annotateObserver = null;
  let annotateTimer = null;
  let hoverTarget = null;

  // ------------------------------------------------------------- formatting

  const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/;
  const CURRENCY_RE = /USDT|USDC|USD|₮|\$/i;

  function parseAmount(str) {
    const cleaned = String(str).replace(/[,\s ]/g, '');
    if (!/^\d+\.?\d*$|^\.\d+$/.test(cleaned)) return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function extractAmount(text, assumeUnlabeled) {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 64) return null;
    const match = trimmed.match(NUMBER_RE);
    if (!match) return null;
    const labeled = CURRENCY_RE.test(trimmed);
    if (!labeled && !assumeUnlabeled) return null;
    const value = parseAmount(match[0]);
    return value === null ? null : { value, labeled };
  }

  /** The fiat everything here is shown in. Same setting the pages read. */
  const target = () => settings?.targetCurrency || 'ILS';

  /**
   * Money, formatted for the target currency — the same rule as lib/format.js,
   * repeated because content scripts are not modules and cannot import it.
   * Intl decides the symbol, its placement and the currency's own precision; a
   * currency with no minor unit (the yen) is pinned to zero decimals, because
   * the "decimal places" setting is a rounding preference and there is no
   * half-yen to round.
   */
  function formatMoney(value) {
    const code = target();
    let natural = 2;
    try {
      natural = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
        .resolvedOptions().maximumFractionDigits;
    } catch {
      natural = 2;
    }
    const decimals = natural === 0 ? 0 : settings?.decimals ?? natural;

    try {
      const nf = new Intl.NumberFormat('en-US', {
        style: 'currency', currency: code, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      });
      if (Number.isFinite(value)) return nf.format(value);
      const symbol = nf.formatToParts(0).find((part) => part.type === 'currency')?.value || code;
      return /[A-Za-z]$/.test(symbol) ? `${symbol} —` : `${symbol}—`;
    } catch {
      return Number.isFinite(value) ? `${code} ${formatNum(value, decimals)}` : `${code} —`;
    }
  }

  function formatNum(value, decimals = 2) {
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  /** The rate to multiply by: manual override and off-ramp spread already applied. */
  function usableRate() {
    return Number.isFinite(rate?.effective) ? rate.effective : null;
  }

  function toTarget(usdt) {
    const r = usableRate();
    return r === null ? null : usdt * r;
  }

  /**
   * Target-currency units per unit of a given coin. Dollar-pegged tokens ride
   * the USDT rate; everything else needs its own quote, which the background
   * now fetches in the same request. Null means this rate does not price that
   * coin — better than a confident number that is wrong by five orders of
   * magnitude.
   */
  function coinRateFor(currency) {
    if (!currency || DOLLAR_PEGGED.has(currency)) return usableRate();
    const coin = rate?.coins?.[currency];
    return Number.isFinite(coin) ? coin : null;
  }

  // --------------------------------------------------------------- overlay

  const STYLE = `
    /*
     * The overlay's whole stylesheet. It cannot link ui.css — this lives in a
     * shadow root inside the casino's document — so the palette is repeated
     * here, and only here. Same four steps of depth and the same one meaning
     * per colour: green is money up, red is money down, amber warns, and blue
     * is the only thing you can click.
     */
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }

    .hud {
      position: fixed; pointer-events: auto;
      min-width: 232px; max-width: 300px;
      background: #101f2b; color: #e4eef6;
      border: 1px solid #2a4356; border-radius: 14px;
      box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 10px 34px rgba(0,0,0,.5);
      font-size: 12px; line-height: 1.4;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* The one part of the panel you are meant to grab, so it looks like a
       handle: a shade lighter than the body, with the grip cursor on it. */
    .hud-head {
      display: flex; align-items: center; gap: 7px;
      padding: 8px 9px; background: #16293a; cursor: grab;
      border-bottom: 1px solid #24394b; user-select: none;
    }
    .hud-head.dragging { cursor: grabbing; }
    .hud-title { flex: 1; font-weight: 700; font-size: 10.5px; letter-spacing: .7px; color: #8aa9bf; text-transform: uppercase; }

    /* Glows rather than sitting flat: at 8px a plain circle reads as a bullet
       point, and this is the panel's only status light. */
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #00e701; flex: none; box-shadow: 0 0 0 3px rgba(0,231,1,.14); }
    .dot.stale { background: #f5a623; box-shadow: 0 0 0 3px rgba(245,166,35,.16); }
    .dot.dead { background: #ff5b55; box-shadow: 0 0 0 3px rgba(255,91,85,.16); }

    .icon {
      all: unset; cursor: pointer; color: #7d9db3;
      padding: 3px 6px; border-radius: 6px; font-size: 12px; line-height: 1;
      transition: background .12s, color .12s;
    }
    .icon:hover { background: #22394b; color: #e4eef6; }
    .icon:disabled { cursor: default; opacity: .4; background: none; color: #7d9db3; }

    .hud-body { padding: 11px 12px 12px; }

    .rate-val { font-size: 16px; font-weight: 700; color: #fff; letter-spacing: -.2px; }
    .rate-meta { display: block; margin-top: 3px; color: #5f7e95; font-size: 10.5px; line-height: 1.4; }
    .rate-meta.warn { color: #f5a623; }

    /* Each block is a well rather than a band between hairlines: at this size a
       1px rule is the only thing separating four different subjects, and four
       subjects in a 300px column need more than that. */
    .track, .account, .session {
      margin-top: 10px; padding: 9px 10px;
      background: #16293a; border: 1px solid #1f3546; border-radius: 10px;
    }

    .track-label { color: #5f7e95; font-size: 9.5px; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 4px; }
    .track-usdt { color: #8aa9bf; font-size: 11px; font-variant-numeric: tabular-nums; }
    .track-money {
      font-size: 21px; font-weight: 700; color: #00e701; margin-top: 2px;
      letter-spacing: -.4px; font-variant-numeric: tabular-nums;
      min-height: 30px; /* one line at 21px, kept when the 13px message takes over */
    }
    .track-money.warn { font-size: 13px; font-weight: 600; color: #f5a623; letter-spacing: 0; }

    .btn {
      all: unset; cursor: pointer; display: block; width: 100%; text-align: center;
      padding: 7px 8px; border-radius: 8px; font-size: 11px; font-weight: 600;
      background: linear-gradient(180deg, #2b6d96, #23597b); color: #eaf6ff;
      border: 1px solid #34799f; box-sizing: border-box;
    }
    .btn:hover { background: linear-gradient(180deg, #327ba8, #27638a); }
    .link { all: unset; cursor: pointer; color: #5f7e95; font-size: 10px; text-decoration: underline; text-underline-offset: 2px; margin-top: 6px; display: inline-block; }
    .link:hover { color: #58b6f0; }

    .sess-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
    .sess-title { flex: 1; color: #5f7e95; font-size: 9.5px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase; }
    .sess-dur { color: #7d9db3; font-size: 10px; font-variant-numeric: tabular-nums; }
    .sess-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 2px 0; }
    .sess-row span { color: #5f7e95; font-size: 10.5px; }
    .sess-row b { font-size: 12.5px; font-weight: 650; color: #e4eef6; font-variant-numeric: tabular-nums; }
    .sess-row b small { color: #5f7e95; font-weight: 400; font-size: 9.5px; margin-left: 5px; }
    .sess-row b.up { color: #00e701; }
    .sess-row b.down { color: #ff5b55; }
    .sess-note { margin-top: 6px; color: #f5a623; font-size: 9.5px; line-height: 1.4; }
    /* A ledger that does not reconcile is not a warning about the session, it
       is a warning about the numbers on screen. It gets said louder. */
    .sess-note.bad {
      padding: 6px 8px; border-radius: 8px; font-weight: 600;
      background: rgba(255,91,85,.12); border: 1px solid rgba(255,91,85,.5); color: #ffb3b0;
    }

    .spark { display: block; width: 100%; height: 38px; margin: 8px 0 10px; }
    .spark-line { fill: none; stroke: #00e701; stroke-width: 1.75; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
    .spark-line.down { stroke: #ff5b55; }
    .spark-zero { stroke: #2b4557; stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
    .spark-fill.up { fill: rgba(0,231,1,.16); }
    .spark-fill.down { fill: rgba(255,91,85,.16); }

    .acct-note { margin-top: 7px; color: #f5a623; font-size: 9.5px; line-height: 1.4; }
    .vip-bar { height: 4px; margin: 5px 0 1px; background: #22394b; border-radius: 999px; overflow: hidden; }
    .vip-bar i { display: block; height: 100%; width: 0; background: #7d9db3; border-radius: 999px; transition: width .25s; }

    /*
     * A limit bar is a fuel gauge, not a score. It starts in the panel's own
     * blue and warms to amber and then red as it fills, because "62% of the way
     * to your loss limit" is not a thing to congratulate anyone for — which is
     * exactly what a green bar was doing. Only the win target is green, because
     * only that one is somewhere you want to get to.
     */
    .limit-bar { height: 4px; margin: 6px 0 7px; background: #22394b; border-radius: 999px; overflow: hidden; }
    .limit-bar i { display: block; height: 100%; width: 0; background: #4a7fa5; border-radius: 999px; transition: width .25s, background .25s; }
    .limit-bar.warn i { background: #f5a623; }
    .limit-bar.over i { background: #ff5b55; }
    .limit-bar.win i { background: #00e701; }

    /*
     * A gauge that is configured but has nothing to read right now. It keeps
     * its box and shows nothing, rather than collapsing and springing back
     * every time the session crosses zero or the coin loses its price — the
     * panel used to jump 55px and back for exactly that.
     */
    .limit-bar.hold, .limit-left.hold { visibility: hidden; }

    .limit-left {
      margin: -4px 0 7px; text-align: end; color: #5f7e95; font-size: 9.5px;
      font-variant-numeric: tabular-nums; min-height: 13px;
    }
    .limit-left.warn { color: #f5a623; }
    .limit-left.win { color: #00e701; }

    .limit-alert {
      margin-top: 8px; padding: 7px 9px; border-radius: 8px;
      background: rgba(255,91,85,.12); border: 1px solid rgba(255,91,85,.5); color: #ffb3b0;
      font-size: 10px; line-height: 1.4; font-weight: 600;
    }
    /* Hitting a win target is not a warning, so it does not read like one. */
    .limit-alert.win { background: rgba(0,231,1,.1); border-color: rgba(0,231,1,.45); color: #9df0a8; }

    .diag {
      margin-top: 8px; padding: 7px 9px; border-radius: 8px;
      background: rgba(245,166,35,.1); border: 1px solid rgba(245,166,35,.45); color: #f7cf8a;
      font-size: 9.5px; line-height: 1.4;
    }

    .tip {
      position: fixed; pointer-events: none;
      background: #101f2b; color: #fff; border: 1px solid #2a4356;
      border-radius: 10px; padding: 6px 10px; font-size: 12px; font-weight: 650;
      box-shadow: 0 6px 20px rgba(0,0,0,.5); white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .tip small { display: block; font-weight: 400; font-size: 10px; color: #7d9db3; margin-top: 1px; }

    .outline {
      position: fixed; pointer-events: none;
      border: 2px solid #00e701; border-radius: 6px;
      background: rgba(0,231,1,.10);
      box-shadow: 0 0 0 9999px rgba(0,0,0,.35);
    }
    .pick-banner {
      position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
      pointer-events: none; background: #00e701; color: #04121a;
      padding: 7px 16px; border-radius: 999px; font-size: 12px; font-weight: 700;
      box-shadow: 0 6px 20px rgba(0,0,0,.45);
    }
    [hidden] { display: none !important; }
  `;

  function buildOverlay() {
    host = document.createElement('div');
    host.id = 'stake-ils-converter';
    // Full-viewport but transparent to the mouse; only the HUD opts back in.
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:2147483647;';

    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.append(style);

    hud = document.createElement('div');
    hud.className = 'hud';
    // The overlay is ours, not Stake's: left-to-right regardless of the page.
    hud.dir = 'ltr';
    hud.innerHTML = `
      <div class="hud-head">
        <span class="dot"></span>
        <span class="hud-title">${t('hudTitle', `USDT → ${target()}`, [target()])}</span>
        <button class="icon" data-act="refresh" title="${t('hudRefresh', 'Refresh rate')}">⟳</button>
        <button class="icon" data-act="hide" title="${t('hudHide', 'Hide overlay')}">✕</button>
      </div>
      <div class="hud-body">
        <span class="rate-val">—</span>
        <span class="rate-meta"></span>
        <div class="track">
          <div class="track-empty">
            <button class="btn" data-act="pick">${t('hudPin', 'Pin an amount on the page')}</button>
          </div>
          <div class="track-live" hidden>
            <div class="track-label"></div>
            <div class="track-usdt"></div>
            <div class="track-money"></div>
            <button class="link" data-act="pick">${t('hudRepin', 're-pin')}</button>
          </div>
        </div>
        <div class="account" hidden>
          <div class="sess-head">
            <span class="sess-title">${t('siteAccount', `${SITE.name.toUpperCase()} ACCOUNT`, [SITE.name.toUpperCase()])}</span>
            <span class="sess-dur acct-age"></span>
            <button class="icon" data-act="refresh-account" title="${t('hudRefreshAccount', 'Read rakeback and VIP again now')}">⟳</button>
          </div>
          <div class="sess-row"><span>${t('rakeback', 'Rakeback')}</span><b class="rake">—</b></div>
          <div class="sess-row"><span>${t('vip', 'VIP')}</span><b class="vip">—</b></div>
          <div class="vip-bar" hidden><i></i></div>
          <div class="acct-note" hidden></div>
        </div>
        <div class="session" hidden>
          <div class="sess-head">
            <span class="sess-title">${t('popSession', 'SESSION')}</span>
            <span class="sess-dur"></span>
            <button class="icon" data-act="reset-session" title="${t('hudNewSession', 'Start a new session')}">↺</button>
          </div>
          <div class="limit-bar" data-limit="time" hidden><i></i></div>
          <div class="sess-row"><span>${t('popPl', 'P/L')}</span><b class="sess-pl">—</b></div>
          <div class="limit-bar" data-limit="pl" hidden><i></i></div>
          <div class="limit-left" hidden></div>
          <svg class="spark" viewBox="0 0 200 32" preserveAspectRatio="none" hidden></svg>
          <div class="sess-row"><span>${t('popWagered', 'Wagered')}</span><b class="sess-wag">—</b></div>
          <div class="limit-bar" data-limit="wager" hidden><i></i></div>
          <div class="sess-row"><span>${t('popBets', 'Bets')}</span><b class="sess-bets">—</b></div>
          <div class="sess-note" hidden></div>
          <div class="limit-alert" hidden></div>
        </div>
        <div class="diag" hidden></div>
      </div>`;

    tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;

    outline = document.createElement('div');
    outline.className = 'outline';
    outline.hidden = true;

    shadow.append(hud, tip, outline);
    document.documentElement.append(host);

    hud.addEventListener('click', onHudClick);
    hud.querySelector('.hud-head').addEventListener('mousedown', onDragStart);
  }

  function positionHud() {
    if (!hud || !settings) return;
    hud.style.right = `${settings.hudRight ?? 16}px`;
    hud.style.bottom = `${settings.hudBottom ?? 16}px`;
  }

  // ------------------------------------------------------------- HUD render

  function renderHud() {
    if (!hud || !settings) return;

    hud.hidden = !settings.showHud;
    if (!settings.showHud) return;

    const dot = hud.querySelector('.dot');
    const value = hud.querySelector('.rate-val');
    const meta = hud.querySelector('.rate-meta');

    const r = usableRate();
    if (r === null) {
      dot.className = 'dot dead';
      value.textContent = t('hudNoRate', 'no rate');
      meta.textContent = rate?.error ? rate.error : 'fetching…';
      meta.className = 'rate-meta warn';
    } else {
      dot.className = 'dot' + (rate.stale ? ' stale' : '');
      value.textContent = t('hudRateLine', `1 USDT = ${formatMoney(r)}`, [formatMoney(r)]);

      const bits = [];
      bits.push(rate.providerLabel || t('rateSourceUnknown', 'unknown source'));
      if (rate.fetchedAt && !rate.manual) bits.push(age(rate.fetchedAt));
      if (rate.approximate) bits.push(t('rateViaUsd', 'via USD'));
      if (settings.feePercent) {
        bits.push(t('rateSpread', `incl. ${settings.feePercent}% spread`, [String(settings.feePercent)]));
      }
      meta.textContent = bits.join(' · ');
      meta.className = 'rate-meta' + (rate.stale || rate.error ? ' warn' : '');
    }

    renderTracked();
    renderAccount();
    renderSession();
    renderDiagnostics();
  }

  function age(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 10) return t('ageJustNow', 'just now');
    if (seconds < 60) return t('ageSeconds', `${seconds}s ago`, [String(seconds)]);

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('ageMinutes', `${minutes}m ago`, [String(minutes)]);

    const hours = Math.round(minutes / 60);
    return t('ageHours', `${hours}h ago`, [String(hours)]);
  }

  function renderTracked() {
    if (!hud) return;
    const empty = hud.querySelector('.track-empty');
    const live = hud.querySelector('.track-live');

    const selector = settings?.trackedSelector;
    if (!selector) {
      empty.hidden = false;
      live.hidden = true;
      return;
    }

    empty.hidden = true;
    live.hidden = false;

    const el = safeQuery(selector);
    const label = hud.querySelector('.track-label');
    const usdt = hud.querySelector('.track-usdt');
    const money = hud.querySelector('.track-money');

    if (!el) {
      // Stake re-renders whole subtrees on navigation, so a pinned selector can
      // simply stop resolving. Say so rather than freezing a stale number.
      label.textContent = settings.trackedLabel || t('hudPinnedAmount', 'pinned amount');
      usdt.textContent = t('hudNotOnPage', 'element not on this page');
      money.textContent = formatMoney(NaN);
      return;
    }

    const found = extractAmount(readPinnedText(el), true);
    const currency = detectCurrency(el);

    label.textContent = currency
      ? t('hudBalance', `${currency} balance`, [currency])
      : settings.trackedLabel || t('hudPinnedAmount', 'pinned amount');
    money.className = 'track-money';

    if (!found) {
      usdt.textContent = t('hudNoNumber', 'no number in element');
      money.textContent = formatMoney(NaN);
      return;
    }

    usdt.textContent = `${formatNum(found.value, Math.min(8, settings.decimals + 2))} ${currency || 'USDT'}`;
    reportBalance(found.value, currency);

    // Only convert what this rate actually prices.
    const coinRate = coinRateFor(currency);
    if (coinRate === null) {
      money.textContent = currency ? t('hudNoCoinRate', `no ${currency} rate yet`, [currency]) : formatMoney(NaN);
      money.className = 'track-money warn';
      return;
    }

    money.textContent = formatMoney(found.value * coinRate);
  }

  /**
   * Rakeback and VIP progress, when the bridge has seen them. Rakeback is a
   * balance like any other, so it converts; VIP progress is a fraction of the
   * way to the next tier and converts to nothing at all.
   */
  function renderAccount() {
    if (!hud) return;
    const box = hud.querySelector('.account');
    // Shown as soon as reading is switched on rather than once something has
    // been read: before the first reading lands, the refresh button in this
    // header is the only thing here worth having.
    const on = Boolean(settings?.trackRakeback);

    box.hidden = !on;
    if (!on) return;

    // Reading is passive, so these figures are as old as the last time Stake's
    // own app happened to ask for them. That age is the reason the refresh
    // button next to it exists, so it is shown rather than left to be guessed.
    hud.querySelector('.acct-age').textContent = accountBusy
      ? t('hudRefreshingShort', 'asking…')
      : stake?.at ? age(stake.at) : t('hudAccountUnread', 'not read yet');
    hud.querySelector('[data-act="refresh-account"]').disabled = accountBusy;

    const note = hud.querySelector('.acct-note');
    note.hidden = !accountNote;
    note.textContent = accountNote || '';

    const balances = stake?.rakeback || [];
    const wallet = currentCurrency || 'USDT';
    // The coin you are playing in, or else the biggest balance sitting there.
    const pick = balances.find((row) => row.currency === wallet)
      || [...balances].sort((a, b) => b.amount - a.amount)[0]
      || null;

    const rake = hud.querySelector('.rake');
    if (!pick) {
      rake.textContent = '—';
    } else {
      const coinRate = coinRateFor(pick.currency);
      const coin = `${formatNum(pick.amount, 6)} ${pick.currency}`;
      rake.innerHTML = coinRate === null
        ? coin
        : `${formatMoney(pick.amount * coinRate)}<small>${coin}</small>`;
    }

    const vip = hud.querySelector('.vip');
    const bar = hud.querySelector('.vip-bar');
    const progress = stake?.vip?.progress;
    const flag = stake?.vip?.flag;

    // A tier with no fraction attached to it is Duel: it has levels rather than
    // Stake's progress towards the next one, and the xp curve that would turn
    // one into the other is not published. So the tier is shown on its own
    // rather than dropped for want of a percentage to put beside it.
    if (!Number.isFinite(progress)) {
      vip.textContent = flag || '—';
      bar.hidden = true;
      return;
    }

    const percent = Math.max(0, Math.min(100, progress * 100));
    vip.innerHTML = `${percent.toFixed(1)}%<small>${stake.vip.flag || ''}</small>`;
    bar.hidden = false;
    bar.querySelector('i').style.width = `${percent}%`;
  }

  function renderSession() {
    if (!hud) return;
    const block = hud.querySelector('.session');
    const s = session;

    block.hidden = !(settings?.trackSession && s && s.bets > 0);
    if (block.hidden) return;

    hud.querySelector('.sess-dur').textContent = shortDuration(Date.now() - s.startedAt);

    const sessionRate = coinRateFor(s.currency);
    const money = (value) => {
      const coin = `${formatNum(Math.abs(value), 4)} ${s.currency || 'USDT'}`;
      if (sessionRate === null) return coin;
      return `${formatMoney(Math.abs(value) * sessionRate)}<small>${coin}</small>`;
    };

    const profit = s.profit ?? 0;
    const pl = hud.querySelector('.sess-pl');
    pl.className = 'sess-pl' + (profit > 0 ? ' up' : profit < 0 ? ' down' : '');
    pl.innerHTML = (profit > 0 ? '+' : profit < 0 ? '−' : '') + money(profit);

    hud.querySelector('.sess-wag').innerHTML = money(s.wagered);
    hud.querySelector('.sess-bets').innerHTML =
      `${s.bets}<small>${t('winLoss', `${s.wins}W / ${s.losses}L`, [String(s.wins), String(s.losses)])}</small>`;

    // Both of these mean the totals are not the whole truth, so they are stated
    // rather than left for the user to discover by disagreeing with Stake.
    const note = hud.querySelector('.sess-note');
    const warnings = [];
    if (s.gaps > 0) {
      warnings.push(t('sessGaps', `${s.gaps} gaps — bets scrolled past unseen, so these totals are a floor`, [String(s.gaps)]));
    }
    if (s.currency && currentCurrency && s.currency !== currentCurrency) {
      warnings.push(t('sessCoinSwitch',
        `session is in ${s.currency}, wallet is now ${currentCurrency} — new bets are not counted`,
        [s.currency, currentCurrency]));
    }

    // The wallet is a second, independent account of the same session. With no
    // funds moving mid-session there is no innocent reason for it to disagree,
    // so a settled mismatch is stated as a fault — but only once it has settled,
    // or it would fire every few seconds mid-hand.
    const check = s.check;
    const broken = Boolean(check?.known && !check.ok && !check.settling);
    if (broken) {
      const wallet = formatNum(check.balance, 8);
      const ledger = formatNum(check.ledger, 8);
      const missing = formatNum(Math.abs(check.drift), 8);
      warnings.unshift(t('hudIncomplete',
        `INCOMPLETE — wallet moved ${wallet} but bets account for ${ledger} ${s.currency || 'USDT'}. ${missing} unaccounted.`,
        [wallet, ledger, s.currency || 'USDT', missing]));
    }

    note.hidden = warnings.length === 0;
    note.className = 'sess-note' + (broken ? ' bad' : '');
    note.textContent = warnings.join(' · ');

    renderSparkline(s.curve, profit);
    renderLimits(s, sessionRate);
  }

  /** Duplicated from lib/chart.js — content scripts cannot import modules. */
  function plotSeries(values, width, height, pad = 2) {
    if (!Array.isArray(values) || values.length < 2) return null;

    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const span = max - min || 1;
    const inner = height - pad * 2;

    const x = (i) => (i / (values.length - 1)) * width;
    const y = (v) => pad + (1 - (v - min) / span) * inner;

    const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const zeroY = +y(0).toFixed(1);

    // Closed along the baseline rather than the floor: the filled area is the
    // profit or the loss, not the distance from the bottom of a box.
    return { line, area: `${line} L${width},${zeroY} L0,${zeroY} Z`, zeroY };
  }

  function renderSparkline(curve, profit) {
    const svg = hud.querySelector('.spark');
    const plot = plotSeries(curve, 200, 32);

    // One bet is a dot, not a shape; nothing to read from it.
    //
    // toggleAttribute, not `.hidden`: that property is defined on HTMLElement
    // and an <svg> is not one, so assigning to it sets a plain expando and
    // leaves the attribute exactly where it was. The markup ships with `hidden`
    // on this element, so `svg.hidden = false` had been silently doing nothing
    // and the curve had never once been drawn.
    svg.toggleAttribute('hidden', !plot);
    if (!plot) return;

    // Where the session opened is the dashed line; above it is green, below it
    // is red, and the fill fades away from that line rather than sitting as a
    // slab — an evening spent entirely down puts the baseline at the top of the
    // box, and a solid block that size reads as a background, not as an area.
    // The ids are scoped to this shadow root, so they cannot collide with
    // anything the casino defines. The gradient goes on a style attribute
    // because the class rule sets `fill`, and a presentation attribute loses.
    svg.innerHTML = `
      <defs>
        <clipPath id="sparkUp"><rect x="0" y="0" width="200" height="${plot.zeroY}"></rect></clipPath>
        <clipPath id="sparkDown"><rect x="0" y="${plot.zeroY}" width="200" height="${32 - plot.zeroY}"></rect></clipPath>
        <linearGradient id="sparkUpFade" x1="0" y1="${plot.zeroY}" x2="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#00e701" stop-opacity=".32"></stop>
          <stop offset="1" stop-color="#00e701" stop-opacity="0"></stop>
        </linearGradient>
        <linearGradient id="sparkDownFade" x1="0" y1="${plot.zeroY}" x2="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ff5b55" stop-opacity=".32"></stop>
          <stop offset="1" stop-color="#ff5b55" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <path class="spark-fill up" d="${plot.area}" clip-path="url(#sparkUp)" style="fill:url(#sparkUpFade)"></path>
      <path class="spark-fill down" d="${plot.area}" clip-path="url(#sparkDown)" style="fill:url(#sparkDownFade)"></path>
      <line class="spark-zero" x1="0" x2="200" y1="${plot.zeroY}" y2="${plot.zeroY}"></line>
      <path class="spark-line${profit < 0 ? ' down' : ''}" d="${plot.line}"></path>`;
  }

  /**
   * Money limits are set in the target currency because that is the unit the
   * money is actually in; the session's own coin rate converts to it, so a BTC
   * session is held to the same figure a USDT one is. Time needs no rate.
   */
  function renderLimits(s, sessionRate) {
    const alert = hud.querySelector('.limit-alert');
    const profit = s.profit ?? 0;
    const crossed = [];

    const left = hud.querySelector('.limit-left');

    /**
     * The caption under the P/L gauge, in one of three states.
     *
     * `gone` — no P/L limit is set at all, so there is nothing to caption and
     * nothing to keep room for. `hold` — a limit is set but has no reading
     * right now, so the line keeps its place and says nothing. `text` — a
     * reading.
     */
    const caption = (state, text = '', tone = '') => {
      left.hidden = state === 'gone';
      left.className = 'limit-left' + (state === 'hold' ? ' hold' : tone ? ` ${tone}` : '');
      left.textContent = state === 'text' ? text : '';
    };

    /**
     * How much of the P/L limit is used up, as a fraction of it: "45%/100%".
     *
     * Only this bar carries it. Wager and time run one way and you can see
     * where they are; the P/L bar is the one that swings both directions
     * between bets, and "how far along am I" is the question it is actually
     * being watched for. The 100% is spelled out rather than left implied,
     * because a bare percentage under a bar could as easily be read as the
     * amount left.
     *
     * No message key: digits and percent signs read the same in every language,
     * and there is no word here to translate.
     *
     * Held blank once it is crossed — the alert underneath takes over there and
     * says it better, in money rather than in percent, but the line keeps its
     * place so that crossing a limit does not also shuffle the panel.
     */
    const showProgress = (pct, kind) => {
      if (pct >= 100) return caption('hold');

      // A decimal only in the last tenth, where the difference between 95% and
      // 95.6% is the difference between two more bets and one. Below that it is
      // noise on a figure nobody is reading closely.
      const shown = pct.toFixed(pct >= 90 ? 1 : 0);
      caption('text', `${shown}%/100%`, kind === 'win' ? 'win' : pct >= 80 ? 'warn' : '');
    };

    /**
     * One gauge, in one of the same three states as the caption.
     *
     * The middle one is the point. A limit that is set but cannot be measured
     * right now — the coin lost its price, or the session is exactly level —
     * used to collapse the gauge and take the rows below it up with it, so the
     * whole panel jumped 55px and sprang back the moment a rate arrived. Whether
     * a gauge exists is a question about your settings, not about this second's
     * reading, so the space it occupies now follows the setting.
     *
     * @param reserve  True when this limit is configured, whatever the reading.
     */
    const bar = (name, value, limit, kind, label, format, reserve = false) => {
      const element = hud.querySelector(`.limit-bar[data-limit="${name}"]`);
      const readable = Boolean(limit) && value !== null && value > 0;

      if (!readable) {
        element.hidden = !reserve;
        element.className = 'limit-bar hold';
        element.querySelector('i').style.width = '0%';
        if (name === 'pl') caption(reserve ? 'hold' : 'gone');
        return;
      }

      const pct = (value / limit) * 100;
      element.hidden = false;
      element.className =
        'limit-bar' + (kind === 'win' ? ' win' : pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');
      element.querySelector('i').style.width = `${Math.min(100, pct)}%`;

      if (name === 'pl') showProgress(pct, kind);

      if (pct >= 100) {
        crossed.push({ kind, text: `${label} — ${format(value)} ${t('limitOf', 'of')} ${format(limit)}` });
      }
    };

    // Null rate means this coin is not priced, so the money limits sit out
    // rather than being measured against a rate that is not theirs.
    // The rate converts into the target currency, so a limit still tagged with
    // a different one is not comparable with it — the same guard lib/session.js
    // applies for the popup and the desktop notice. It lasts only as long as it
    // takes the service worker to convert them, but "only a moment" is not a
    // reason to draw a bar measuring shekels against euros.
    const comparable = !settings.limitCurrency || !settings.targetCurrency
      || settings.limitCurrency === settings.targetCurrency;

    const converted = (coin) => (sessionRate === null || !comparable ? null : coin * sessionRate);
    const minutes = (value) => `${Math.round(value)} ${t('unitMin', 'min')}`;

    bar('wager', converted(s.wagered), settings.limitWager, 'wager',
      t('notifyWagerTitle', 'Wager limit reached'), formatMoney, Boolean(settings.limitWager));

    // Loss and win are the same figure read in opposite directions, so one bar
    // serves both and shows whichever way the session is actually going — and
    // it keeps its place if *either* is set, so a session crossing zero does not
    // make the gauge come and go under the player.
    const plSet = Boolean(settings.limitWin || settings.limitLoss);
    if (profit >= 0) bar('pl', converted(profit), settings.limitWin, 'win', t('notifyWinTitle', 'Win target reached'), formatMoney, plSet);
    else bar('pl', converted(-profit), settings.limitLoss, 'loss', t('notifyLossTitle', 'Loss limit reached'), formatMoney, plSet);

    bar('time', (Date.now() - s.startedAt) / 60_000, settings.limitMinutes, 'time',
      t('notifyTimeTitle', 'Time limit reached'), minutes, Boolean(settings.limitMinutes));

    alert.hidden = crossed.length === 0;
    alert.textContent = crossed.map((c) => c.text).join(' · ');
    // Red unless the only thing crossed was the win target.
    alert.className = 'limit-alert' + (crossed.length && crossed.every((c) => c.kind === 'win') ? ' win' : '');
  }

  function renderDiagnostics() {
    if (!hud) return;
    const box = hud.querySelector('.diag');
    const errors = diagnostics || [];

    box.hidden = errors.length === 0;
    if (box.hidden) return;

    const [newest] = errors;
    box.textContent =
      `⚠ ${newest.where} failed: ${newest.message}` +
      (newest.count > 1 ? ` (×${newest.count})` : '') +
      (errors.length > 1 ? ` — ${errors.length} issues, see extension options` : '');
  }

  function shortDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'just started';
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function safeQuery(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null; // a stored selector can go invalid; never let it throw here
    }
  }

  // ------------------------------------------------------------ HUD actions

  function onHudClick(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    switch (button.dataset.act) {
      case 'refresh':
        send({ type: 'refresh' });
        break;
      case 'hide':
        patch({ showHud: false });
        break;
      case 'pick':
        startPicking();
        break;
      case 'refresh-account':
        refreshAccount();
        break;
      case 'reset-session':
        // Archives the session and opens a fresh one that inherits its bet ids,
        // so the rows still on screen are not counted into the new session.
        send({ type: 'endSession' });
        break;
    }
  }

  function patch(changes) {
    send({ type: 'setSettings', patch: changes });
  }

  // Drag the HUD by its header, persisting only on release so a drag is one write.
  function onDragStart(event) {
    if (event.target.closest('[data-act]')) return;
    event.preventDefault();

    const head = hud.querySelector('.hud-head');
    head.classList.add('dragging');

    const rect = hud.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startRight = window.innerWidth - rect.right;
    const startBottom = window.innerHeight - rect.bottom;

    const onMove = (moveEvent) => {
      const right = clamp(startRight - (moveEvent.clientX - startX), 0, window.innerWidth - rect.width);
      const bottom = clamp(startBottom - (moveEvent.clientY - startY), 0, window.innerHeight - rect.height);
      hud.style.right = `${right}px`;
      hud.style.bottom = `${bottom}px`;
    };

    const onUp = () => {
      head.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      patch({
        hudRight: Math.round(Number.parseFloat(hud.style.right) || 16),
        hudBottom: Math.round(Number.parseFloat(hud.style.bottom) || 16),
      });
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // ---------------------------------------------------------- element picker

  const PICK_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click'];

  function startPicking() {
    if (picking) return;
    picking = true;

    const banner = document.createElement('div');
    banner.className = 'pick-banner';
    banner.textContent = t('hudPickBanner', 'Click the amount to pin · Esc to cancel');
    shadow.append(banner);

    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('keydown', onPickKey, true);
    for (const type of PICK_EVENTS) document.addEventListener(type, onPickClick, true);
  }

  function stopPicking() {
    if (!picking) return; // teardown may call this after the overlay is gone
    picking = false;
    outline.hidden = true;
    shadow.querySelector('.pick-banner')?.remove();
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('keydown', onPickKey, true);
    for (const type of PICK_EVENTS) document.removeEventListener(type, onPickClick, true);
  }

  function onPickMove(event) {
    const el = pageTarget(event);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    outline.hidden = false;
    outline.style.left = `${rect.left - 2}px`;
    outline.style.top = `${rect.top - 2}px`;
    outline.style.width = `${rect.width + 4}px`;
    outline.style.height = `${rect.height + 4}px`;
  }

  function onPickKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    stopPicking();
  }

  function onPickClick(event) {
    const el = pageTarget(event);
    // Swallow the whole click sequence so pinning a balance never also opens a
    // bet slip or navigates away.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type !== 'click' || !el) return;

    stopPicking();
    // Pin the element that was clicked, not the descendant holding the digits:
    // the clicked node is the one with a stable hook on it (Stake's chip carries
    // data-testid="coin-toggle"), while its innards get re-rendered on every
    // balance change. The number is re-found underneath it on each read.
    const found = extractAmount(readPinnedText(el), true);
    patch({
      trackedSelector: cssPath(el),
      trackedLabel: found ? detectCurrency(el) || 'balance' : 'pinned element',
    });
  }

  /** The page element under an event, or null if the event came from our overlay. */
  function pageTarget(event) {
    const path = event.composedPath?.() || [];
    if (path.includes(host)) return null;
    const el = event.target;
    return el && el.nodeType === 1 && el !== document.documentElement ? el : null;
  }

  /**
   * A selector stable enough to survive a re-render. Prefers an id, then a test
   * hook, then structural position — good enough to re-find a header balance,
   * and re-pinnable in two clicks when it is not.
   */
  function cssPath(el) {
    const parts = [];
    let node = el;

    // The cap used to be 8, which silently truncated deep paths into an
    // unanchored fragment that querySelector would happily match against some
    // other element entirely. Stake's balance sits 14 levels down.
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 20) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }

      let part = node.tagName.toLowerCase();
      // Keep the attribute's real name: writing data-test's value into a
      // data-testid selector produces a selector that matches nothing.
      const hookAttr = ['data-testid', 'data-test', 'data-cy'].find((name) => node.hasAttribute(name));
      const hook = hookAttr ? node.getAttribute(hookAttr) : null;

      if (hook && !/["\\]/.test(hook)) {
        part += `[${hookAttr}="${hook}"]`;
      } else {
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName)
          : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }

      parts.unshift(part);
      node = node.parentElement;
    }

    return parts.join(' > ');
  }

  /** Just this element's own text nodes — no descendants. */
  function ownText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.nodeValue;
    }
    return text;
  }

  /**
   * The text an element itself displays, for hover and inline annotation.
   * Own text first, falling back to descendant text only for small nodes:
   * ambient conversion must not read a whole container's contents just because
   * the cursor passed over it.
   */
  function readText(el) {
    const own = ownText(el);
    if (own.trim()) return own;

    const all = el.textContent || '';
    return all.trim().length <= 32 && el.querySelectorAll('*').length <= 6 ? all : '';
  }

  const DIGIT_RE = /\d/;

  /**
   * The element that actually carries the number, searching downward from `root`.
   *
   * This is the pinning path, and it is deliberately not readText's rule. Stake
   * wraps its balance about six levels deep — the clickable button holds no text
   * of its own and has eleven descendants — so anything that only looks at an
   * element's own text, or gives up past a small descendant count, reports "no
   * number in element" for the exact thing the user just clicked on. Pinning is
   * an explicit gesture at a specific number, so here we go and find it.
   */
  function findAmountElement(root) {
    if (!root) return null;
    if (DIGIT_RE.test(ownText(root))) return root;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        return DIGIT_RE.test(ownText(node)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    return walker.nextNode();
  }

  /**
   * The full amount text under a pinned element. Having found the node holding
   * the digits, climb back up while the subtree still shows nothing but this
   * amount — Stake splits some figures across sibling spans, and the leaf alone
   * would read "1,234" out of "1,234.56".
   */
  function readPinnedText(root) {
    const found = findAmountElement(root);
    if (!found) return '';

    let best = found;
    let node = found.parentElement;
    while (node && root.contains(node)) {
      const text = (node.textContent || '').trim();
      if (text.length > 32) break;
      best = node;
      node = node.parentElement;
    }
    return best.textContent || '';
  }

  // Tokens whose value is a dollar, so the USDT rate applies to them as-is.
  const DOLLAR_PEGGED = new Set(['USDT', 'USDC', 'USD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'PYUSD']);
  const TICKER_RE = /^(usdt|usdc|usd|tusd|dai|busd|usdp|pyusd|btc|eth|ltc|trx|xrp|doge|sol|bnb|ada|matic|pol|link|dot|shib|bch|eos|apt|sand|ape|near|ton|sui|xlm|atom|avax)$/i;

  /**
   * Which coin the pinned amount is denominated in. Stake tags its currency
   * chip with data-ds-icon="USDT" and aria-label="usdt", so this is readable
   * rather than guessed — and worth reading, because converting a BTC balance
   * at the USDT rate would produce a confident, badly wrong number.
   */
  function detectCurrency(el) {
    if (!el) return null;
    const scope = el.closest('button, [data-testid]') || el;
    const candidates = [scope, ...scope.querySelectorAll('[data-ds-icon], [data-currency], [aria-label], [alt]')];

    for (const node of candidates) {
      const raw =
        node.getAttribute?.('data-ds-icon') ||
        node.getAttribute?.('data-currency') ||
        node.getAttribute?.('aria-label') ||
        node.getAttribute?.('alt');
      if (raw && TICKER_RE.test(raw.trim())) return raw.trim().toUpperCase();
    }
    return null;
  }

  // ------------------------------------------------------- bet-table watcher
  //
  // Stake's "My Bets" table is the ledger: every row carries an exact stake, an
  // exact payout, and a UUID in data-test-id. Scraping it beats inferring bets
  // from balance movement, which cannot separate turnover from profit and
  // cannot tell a bet from a deposit.
  //
  // Duel has no such table, so nothing in this section runs there — its rows
  // arrive from the page-world bridge instead. See the bridge section below.
  //
  // This side only scrapes and forwards. De-duplication and accounting live in
  // the background, so two casino tabs cannot double-count one bet.

  // Table reading itself lives in lib/scrape.js, loaded by the manifest as the
  // content script before this one. It is the same code the DOM tests run.
  const { findMyBetsTable, scrapeBets, betsFromDuel, betsFromStakeGame } = globalThis.StakeScrape;

  let betObserver = null;
  let betTimer = null;
  let betDebounce = null;
  let watchedTable = null;

  /**
   * The coin the wallet is currently showing, independent of any pin.
   *
   * Duel's header says "$0.00" whatever the wallet holds, so there is no ticker
   * in the markup to read: what the account reader saw on /api/v2/user stands
   * in for it, and failing that the ledger rows carry the coin themselves.
   */
  function activeCurrency() {
    const chip = document.querySelector(SITE.currencyChip);
    const found = chip ? detectCurrency(chip) : null;
    if (found) return found;
    const pinned = settings?.trackedSelector ? safeQuery(settings.trackedSelector) : null;
    return (pinned ? detectCurrency(pinned) : null) || stake?.wallet || null;
  }

  let lastReportedBalance = null;

  /**
   * Tell the background what the wallet says, so the bet ledger can be checked
   * against it. Only on change — the pinned amount is read once a second and
   * re-sending an unchanged figure would be a storage write per second.
   */
  function reportBalance(value, currency) {
    if (!Number.isFinite(value) || value === lastReportedBalance) return;
    lastReportedBalance = value;
    send({ type: 'balance', value, currency: currency || null });
  }

  function sendBets() {
    const found = findMyBetsTable();
    if (!found) return;
    const rows = scrapeBets(found.table, found.heads);
    if (!rows.length) return;
    currentCurrency = activeCurrency();
    send({ type: 'bets', rows, currency: currentCurrency });
  }

  const scheduleSend = () => {
    clearTimeout(betDebounce);
    betDebounce = setTimeout(() => guard('scrape bets', sendBets), 250);
  };

  function attachBetObserver() {
    const found = findMyBetsTable();

    if (!found) {
      // Navigated off a game page; the table will come back.
      betObserver?.disconnect();
      betObserver = null;
      watchedTable = null;
      return;
    }
    if (watchedTable === found.table && watchedTable.isConnected) return;

    betObserver?.disconnect();
    watchedTable = found.table;
    betObserver = new MutationObserver(scheduleSend);
    betObserver.observe(found.table, { childList: true, subtree: true, characterData: true });
    scheduleSend();
  }

  function syncBetWatcher() {
    // On a site whose ledger is an API rather than markup there is no table to
    // find and no re-render to watch, so this whole watcher sits out and the
    // bridge does the reading.
    const wanted = Boolean(settings?.enabled && settings?.trackSession && SITE.ledger === 'table');

    if (!wanted) {
      clearInterval(betTimer);
      clearTimeout(betDebounce);
      betTimer = null;
      betObserver?.disconnect();
      betObserver = null;
      watchedTable = null;
      return;
    }
    if (betTimer) return;

    // The table is re-created on navigation between games, so re-attaching is
    // a poll rather than a one-off.
    betTimer = setInterval(() => guard('attach bet observer', attachBetObserver), 2000);
    guard('attach bet observer', attachBetObserver);
  }

  // ----------------------------------------------------------- stake bridge
  //
  // The other half of this lives in lib/stakebridge.js, in the page's own
  // world. Only figures cross the gap: the token it authenticates with stays
  // where it already was.

  const BRIDGE_CHANNEL = 'stake-ils-bridge';

  window.addEventListener('message', (event) => {
    // Same window only, and only our channel. Everything on this bus is
    // readable by the page, so it is treated as untrusted input either way.
    if (event.source !== window || event.data?.channel !== BRIDGE_CHANNEL) return;

    // The price table is public data on its own switch, so it is handled
    // before the account gate rather than behind it. Which shape it is in is
    // decided by `source`, and read in lib/rates.js.
    if (event.data.kind === 'rates') {
      if (settings?.stakeRates) {
        send({ type: 'stakeRates', source: event.data.source || 'stake', rates: event.data.rates });
      }
      return;
    }

    // Bets read out of an API rather than a table — Duel only. Normalised here
    // rather than in the page world, so the one tested reader covers both
    // sites' rows before anything is counted.
    if (event.data.kind === 'bets') {
      if (!settings?.enabled || !settings?.trackSession) return;
      const { rows, currency } = betsFromDuel({ data: event.data.feed });
      if (!rows.length) return;
      currentCurrency = currency || activeCurrency();
      send({ type: 'bets', rows, currency: currentCurrency });
      return;
    }

    // One round of a Stake original, seen as the page plays it. Exact stake,
    // exact multiplier and the round's own coin — so this needs neither the
    // bet table nor the wallet chip, and it does not wait for either to
    // re-render. The table stays as the reader for everything Stake does not
    // run itself: provider slots and sports.
    if (event.data.kind === 'round') {
      if (!settings?.enabled || !settings?.trackSession) return;
      const { rows, currency, mismatch } = betsFromStakeGame(event.data.round);
      if (!rows.length) return;

      // The one thing a zero-stake capture could not settle. If Stake's own
      // payout figure ever disagrees with stake times multiplier, the reading
      // is wrong in one direction or the other and it says so rather than
      // quietly picking one.
      if (mismatch) {
        send({
          type: 'contentError',
          where: 'stake round',
          message: `payout disagrees with stake × multiplier on ${mismatch.id}: `
            + `${mismatch.amount} × ${mismatch.multiplier} = ${mismatch.computed}, but the reply said ${mismatch.stated}.`,
        });
      }

      currentCurrency = currency || activeCurrency();
      send({ type: 'bets', rows, currency: currentCurrency });
      return;
    }

    // Ahead of the account gate, because the bridge complains about the bet
    // ledger too. Behind it, a game whose rounds cannot be read would only
    // ever be reported to somebody who had switched on rakeback tracking —
    // which is off by default, so in practice to nobody.
    if (event.data.kind === 'problem') {
      send({ type: 'contentError', where: 'stake api', message: String(event.data.message).slice(0, 300) });
      return;
    }

    if (!settings?.trackRakeback) return;

    if (event.data.kind === 'meta') {
      send({ type: 'stakeMeta', meta: event.data.meta, forced: Boolean(event.data.forced) });
    } else if (event.data.kind === 'refresh') {
      // The outcome of a click, success or otherwise. Every way this fails
      // sends the request and leaves the same number on screen, so the reason
      // is shown here rather than only filed in diagnostics.
      clearAccountBusy();
      accountNote = event.data.ok ? null : String(event.data.message || 'refresh failed').slice(0, 160);
      renderAccount();
    }
  });

  /**
   * Ask the bridge to re-read rakeback and VIP now.
   *
   * The figures are read passively — they update when Stake's own app happens
   * to fetch them, which on a page you are sitting still on can be a long time.
   * This repeats that one request on demand, whether or not the minute poll is
   * switched on, so the number next to a rakeback claim is the current one.
   */
  function refreshAccount() {
    if (!settings?.enabled || !settings?.trackRakeback || accountBusy) return;
    window.postMessage({ channel: BRIDGE_CHANNEL, kind: 'poll' }, window.location.origin);

    accountBusy = true;
    accountNote = null;
    renderAccount();

    // The answer arrives as a state write, and there are ways for it never to
    // arrive at all — nothing captured to replay, a request still in flight
    // when the page navigates. So the spinner ends on a timer as well.
    // The bridge answers every forced round, one way or the other, so reaching
    // this timer means the message never got there at all — a page loaded
    // before reading was switched on has no bridge listening in it.
    clearTimeout(accountBusyTimer);
    accountBusyTimer = setTimeout(() => {
      accountBusy = false;
      accountNote = t('hudAccountNoBridge', 'No answer from the page — reload Stake and try again.');
      guard('render account', renderAccount);
    }, 8000);
  }

  function clearAccountBusy() {
    clearTimeout(accountBusyTimer);
    accountBusyTimer = null;
    accountBusy = false;
  }

  let bridgeConfig = null;

  function syncBridge() {
    const capture = Boolean(settings?.enabled && settings?.trackRakeback);
    const config = {
      channel: BRIDGE_CHANNEL,
      kind: 'config',
      // Which adapter the bridge should use. It cannot work this out for a
      // user-added mirror — it runs in the page's world with no access to
      // settings — so the answer is resolved here and handed over. It rides on
      // the config that already exists rather than a message of its own,
      // because nothing is inspected until that config arrives.
      site: SITE.id,
      capture,
      // Two independent switches: one reads the account, the other reads the
      // price table. Neither implies the other.
      rates: Boolean(settings?.enabled && settings?.stakeRates),
      poll: capture && Boolean(settings?.rakebackPoll),
      seconds: 60,
      // "Read bets from the page's own traffic." What that costs differs by
      // site and the bridge decides which: on Stake the game endpoints go past
      // on their own and are only watched, on Duel there is no bet table so
      // the transaction feed has to be asked for. Neither is a separate opt-in
      // from session tracking — switching tracking on and having it read
      // nothing would be worse than either.
      bets: Boolean(settings?.enabled && settings?.trackSession),
      betSeconds: 15,
    };

    // Only on a real change. This runs on every state write — about once a
    // minute — and the bridge restarts its timer whenever it is configured, so
    // resending the same config would reset a 60-second poll every 60 seconds
    // and it would never fire.
    const encoded = JSON.stringify(config);
    if (encoded === bridgeConfig) return;
    bridgeConfig = encoded;

    window.postMessage(config, window.location.origin);
  }

  // -------------------------------------------------------------- tooltips

  function showTip(html, rect) {
    tip.innerHTML = html;
    tip.hidden = false;

    const bounds = tip.getBoundingClientRect();
    const left = clamp(rect.left + rect.width / 2 - bounds.width / 2, 4, window.innerWidth - bounds.width - 4);
    const above = rect.top - bounds.height - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${above > 4 ? above : rect.bottom + 8}px`;
  }

  const hideTip = () => { if (tip) tip.hidden = true; };

  function onMouseOver(event) {
    if (!settings?.hoverTooltip || picking) return;

    const el = pageTarget(event);
    if (!el || el === hoverTarget) return;
    hoverTarget = el;

    const found = extractAmount(readText(el), settings.assumeUnlabeled);
    if (!found) return void hideTip();

    const converted = toTarget(found.value);
    if (converted === null) return void hideTip();

    showTip(
      `${formatMoney(converted)}<small>${formatNum(found.value, 2)} USDT` +
        `${found.labeled ? '' : ' (assumed)'}</small>`,
      el.getBoundingClientRect(),
    );
  }

  function onMouseOut(event) {
    if (!pageTarget(event)) return;
    hoverTarget = null;
    hideTip();
  }

  // A selection is an explicit "convert this", so unlabeled numbers count here
  // regardless of the assumeUnlabeled setting.
  function onSelectionChanged() {
    if (!settings?.selectionTooltip || picking) return;

    const selection = window.getSelection();
    const text = selection?.toString() || '';
    if (!text.trim()) return;

    const found = extractAmount(text, true);
    if (!found) return;

    const converted = toTarget(found.value);
    if (converted === null) return;

    const range = selection.getRangeAt(0).getBoundingClientRect();
    if (!range.width && !range.height) return;

    showTip(`${formatMoney(converted)}<small>${formatNum(found.value, 2)} USDT</small>`, range);
  }

  // ------------------------------------------------------- inline annotation

  const INLINE_STYLE_ID = 'stake-ils-inline-style';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'SVG', 'CANVAS', 'IFRAME']);

  function ensureInlineStyle() {
    if (document.getElementById(INLINE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = INLINE_STYLE_ID;
    // ::after on an attribute we set. No node enters any Svelte component's
    // subtree, so nothing it holds a reference to moves.
    style.textContent = `
      [${ATTR}]::after {
        content: " " attr(${ATTR});
        color: #00e701; font-size: .82em; font-weight: 600;
        opacity: .9; white-space: nowrap;
      }`;
    (document.head || document.documentElement).append(style);
  }

  function annotate() {
    if (!settings?.inlineAnnotate || usableRate() === null) return;
    ensureInlineStyle();

    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (SKIP_TAGS.has(node.tagName) || node.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (node === host) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let scanned = 0;
    let node = walker.nextNode();
    while (node && scanned < 4000) {
      scanned++;
      // Labelled amounts only: without a currency token nearby, every odds
      // multiplier and player count on the page would sprout a money figure.
      const found = extractAmount(readText(node), false);
      if (found) {
        const converted = toTarget(found.value);
        const text = converted === null ? null : `≈ ${formatMoney(converted)}`;
        if (text && node.getAttribute(ATTR) !== text) node.setAttribute(ATTR, text);
      } else if (node.hasAttribute(ATTR)) {
        node.removeAttribute(ATTR);
      }
      node = walker.nextNode();
    }
  }

  function clearAnnotations() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
    document.getElementById(INLINE_STYLE_ID)?.remove();
  }

  function scheduleAnnotate() {
    clearTimeout(annotateTimer);
    annotateTimer = setTimeout(() => guard('annotate amounts', annotate), 400);
  }

  function syncAnnotateObserver() {
    const wanted = Boolean(settings?.enabled && settings?.inlineAnnotate);

    if (wanted && !annotateObserver) {
      annotateObserver = new MutationObserver(scheduleAnnotate);
      annotateObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scheduleAnnotate();
    } else if (!wanted && annotateObserver) {
      annotateObserver.disconnect();
      annotateObserver = null;
      clearTimeout(annotateTimer);
      clearAnnotations();
    }
  }

  // ------------------------------------------------------------------- wiring

  function applyState(state) {
    if (!state) return;
    lastState = state;

    // The overlay's header names the target currency, and it is baked in when
    // the panel is built rather than re-read on every render — so a change of
    // target is a rebuild, exactly like a change of language. Both happen about
    // as often as somebody opens the options page.
    const retitle = Boolean(host) && settings && settings.targetCurrency !== state.settings.targetCurrency;

    // A mirror declared in settings can change which casino this page is, and
    // the account box bakes the site's name in when it is built — so a change
    // here is a rebuild, exactly like a change of target currency. It settles
    // on the first state write and then never moves again.
    const resolved = resolveSite(state.settings.mirrors);
    const resite = resolved.id !== SITE.id;
    SITE = resolved;

    settings = state.settings;
    rate = state.rate;
    session = state.session;
    if (retitle || resite) teardown();
    // A new reading is the answer to a refresh, so the button stops spinning on
    // the data landing rather than on its timeout.
    const account = state.stake || null;
    if ((account?.at ?? null) !== (stake?.at ?? null)) {
      clearAccountBusy();
      accountNote = null;
    }
    stake = account;
    diagnostics = state.diagnostics || [];

    if (!settings.enabled) return teardown();
    if (!host) {
      buildOverlay();
      attachPageListeners();
    }
    if (!host.isConnected) document.documentElement.append(host);

    positionHud();
    renderHud();
    syncAnnotateObserver();
    syncBetWatcher();
    syncBridge();

    // No session stored — either a first run or a reset. Scrape now so the
    // visible bets are adopted as the starting point straight away, rather
    // than waiting for the table to happen to change.
    if (!session && settings.trackSession) scheduleSend();

    clearInterval(trackTimer);
    trackTimer = setInterval(() => {
      if (!settings?.showHud) return;
      guard('render pinned amount', renderTracked);
      guard('render session', renderSession);
    }, POLL_MS);
  }

  // Toggling the extension off and on again must not leave a second copy of
  // every handler behind, so attach/detach are symmetric and flag-guarded.
  let listening = false;

  function attachPageListeners() {
    if (listening) return;
    listening = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('mouseup', onSelectionChanged, true);
    document.addEventListener('keyup', onSelectionChanged, true);
    window.addEventListener('scroll', hideTip, true);
  }

  function detachPageListeners() {
    if (!listening) return;
    listening = false;
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('mouseup', onSelectionChanged, true);
    document.removeEventListener('keyup', onSelectionChanged, true);
    window.removeEventListener('scroll', hideTip, true);
  }

  /**
   * Retire an orphaned script. Same as teardown, but it also stops the
   * heartbeat — the one timer that outlives teardown, and therefore the one
   * that would keep an orphan spinning after the overlay was gone.
   */
  function shutdown() {
    clearInterval(heartbeat);
    heartbeat = null;
    try {
      teardown();
    } catch {
      // Nothing left to report to; going quiet is the whole point.
    }
  }

  function teardown() {
    stopPicking();
    clearAccountBusy();
    detachPageListeners();
    clearInterval(betTimer);
    clearTimeout(betDebounce);
    betObserver?.disconnect();
    betObserver = null;
    betTimer = null;
    watchedTable = null;
    clearInterval(trackTimer);
    clearTimeout(annotateTimer);
    annotateObserver?.disconnect();
    annotateObserver = null;
    clearAnnotations();
    host?.remove();
    host = shadow = hud = tip = outline = null;
  }

  /**
   * A refresh asked for from the popup, which has no way to reach this page
   * directly — messaging a tab costs the "tabs" permission this extension
   * deliberately does not take. It arrives as a storage write that every Stake
   * tab is already watching. An old ping is ignored, so a tab opened later does
   * not act on a request that was answered before it existed.
   */
  function onAccountPing(at) {
    if (!Number.isFinite(at) || Date.now() - at > 15_000) return;
    refreshAccount();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.i18n) guard('apply language', () => relocalise(changes.i18n.newValue));
    if (changes.mirror) guard('apply state', () => applyState(changes.mirror.newValue));
    if (changes.rakebackPing) guard('refresh account', () => onAccountPing(changes.rakebackPing.newValue));
  });

  try {
    chrome.storage.local.get(['mirror', 'i18n']).then(({ mirror, i18n }) => {
      applyBundle(i18n);
      if (mirror) return guard('apply state', () => applyState(mirror));
      // First run after install: the mirror may not be written yet.
      chrome.runtime.sendMessage({ type: 'getState' }).then(applyState).catch(() => {});
    }).catch(() => {});
  } catch {
    shutdown();
  }

  // Re-render the age line without re-fetching, so "3m ago" does not lie. Also
  // the orphan check: a script whose extension has been reloaded notices here
  // at the latest, even if the page never touches it again.
  heartbeat = setInterval(() => {
    if (!alive()) return shutdown();
    if (settings?.enabled && settings?.showHud) renderHud();
  }, 15_000);
})();
