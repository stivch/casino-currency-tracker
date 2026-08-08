// Self-exclusion, the cooldown screen, and locked limits.
//
// These are the three places the extension stops reporting and starts
// intervening, which is a reversal of its founding posture and was chosen
// deliberately — see DISCLAIMER.md. Each is opt-in and off by default.
//
// Pure logic: no chrome.*, no DOM, no clock of its own — `now` is always passed
// in. Every other module in this codebase is wrong by showing a bad number.
// This one is wrong by letting somebody back in early, so the rules that decide
// that live here, in a file a test can exercise without a browser.
//
// The honest limit, stated here because it must also be stated on screen: none
// of this can be enforced. Chrome disables or removes an extension in two
// clicks and takes its storage with it. What follows raises friction; it does
// not build a wall, and anyone who needs a wall needs their operator's own
// self-exclusion, which can close the account.

/**
 * Periods a self-exclusion can be set for.
 *
 * `id` is what is stored, so renaming one is a migration. Hours rather than
 * days throughout, because a "day" that meant 24 hours in one place and a
 * calendar day in another is the kind of ambiguity that ends an exclusion a
 * few hours early.
 *
 * The list starts at a day and ends at a year. Nothing shorter, because an
 * exclusion measured in hours is a cooldown and there is a cooldown already;
 * nothing longer, because an extension that cannot promise to exist in a year
 * should not offer to be trusted for five.
 */
export const EXCLUSION_PERIODS = [
  { id: '1d', hours: 24 },
  { id: '3d', hours: 24 * 3 },
  { id: '7d', hours: 24 * 7 },
  { id: '30d', hours: 24 * 30 },
  { id: '90d', hours: 24 * 90 },
  { id: '180d', hours: 24 * 180 },
  { id: '365d', hours: 24 * 365 },
];

/** Longest a cooldown screen will hold you, in seconds. */
export const COOLDOWN_MAX_SECONDS = 600;

/** Shortest that is still a pause rather than a flicker. */
export const COOLDOWN_MIN_SECONDS = 5;

/** The period with this id, or null. */
export function periodById(id) {
  return EXCLUSION_PERIODS.find((p) => p.id === id) || null;
}

/**
 * What the stored exclusion means right now.
 *
 * `until` in the past is not an error and not something to clean up on read —
 * an expired exclusion is simply inactive, and the background worker clears the
 * record when its alarm fires. Reads stay side-effect free so that a popup
 * rendering twice cannot end an exclusion.
 */
export function exclusionState(settings = {}, now = Date.now()) {
  const until = Number(settings.exclusionUntil);
  const started = Number(settings.exclusionStarted);

  if (!Number.isFinite(until) || until <= now) {
    return { active: false, until: null, started: null, msRemaining: 0, msTotal: 0 };
  }

  const from = Number.isFinite(started) ? started : null;

  return {
    active: true,
    until,
    started: from,
    msRemaining: until - now,
    msTotal: from === null ? 0 : Math.max(0, until - from),
  };
}

/** Is the user excluded from the casinos at this instant? */
export function isExcluded(settings = {}, now = Date.now()) {
  return exclusionState(settings, now).active;
}

/**
 * The settings patch that starts an exclusion, or null if it cannot start.
 *
 * Refuses to shorten. Setting a week while a month is already running would be
 * an off switch wearing a period picker, so a second exclusion is only ever
 * accepted when it ends later than the one already running — which makes
 * "extend" the one thing this can do to a live exclusion, and extending is
 * always allowed.
 */
export function beginExclusion(settings = {}, periodId, now = Date.now()) {
  const period = periodById(periodId);
  if (!period) return null;

  const until = now + period.hours * 3600_000;
  const current = exclusionState(settings, now);

  if (current.active && until <= current.until) return null;

  return {
    exclusionUntil: until,
    exclusionStarted: current.active ? current.started ?? now : now,
    // Turning the feature on is implied by using it, and this is also what
    // stops the toggle being the way out: `lockedKeys` freezes it while the
    // exclusion runs, so it cannot be switched off to release the block.
    selfExclusion: true,
  };
}

/**
 * Which settings keys must not change right now, and why.
 *
 * The point of the whole feature. An exclusion with a reachable off switch is
 * not an exclusion, and the off switch is not only the period control — it is
 * also the feature toggle beside it, and the mirror list that decides which
 * domains the block covers. All three freeze together.
 *
 * Returned as a Map rather than a Set because the caller has to say *why* a
 * control is disabled. "Locked until 4 March" is a different message from a
 * greyed-out box with no explanation, and the second one reads as a bug.
 */
export function lockedKeys(settings = {}, now = Date.now(), { sessionLive = false } = {}) {
  const locked = new Map();
  const state = exclusionState(settings, now);

  if (state.active) {
    locked.set('selfExclusion', 'excluded');
    locked.set('exclusionUntil', 'excluded');
    locked.set('mirrors', 'excluded');
  }

  // A switch that turns off an intervention is a way around that intervention,
  // and it is a *better* way around than the thing it guards: refusing to raise
  // a loss limit mid-session achieves nothing if the switch enforcing it can be
  // flicked off first. Both freeze while a session is live, and both are freely
  // editable between sessions, which is the same rule the limits themselves get.
  if (sessionLive) {
    if (settings.lockLimits) locked.set('lockLimits', 'session-live');
    if (settings.cooldownScreen) locked.set('cooldownScreen', 'session-live');
  }

  return locked;
}

/**
 * Is this settings patch allowed?
 *
 * Anything touching a locked key is refused outright rather than silently
 * dropped: a save that reports success while discarding half of what was asked
 * teaches the user that the lock is soft.
 *
 * Extending an exclusion is the one exception, and it is checked by value
 * rather than by key — `exclusionUntil` moving later is an extension, moving
 * earlier is an escape.
 */
export function patchAllowed(settings = {}, patch = {}, now = Date.now(), context = {}) {
  const locked = lockedKeys(settings, now, context);
  const state = exclusionState(settings, now);

  for (const key of Object.keys(patch)) {
    if (!locked.has(key)) continue;

    if (key === 'exclusionUntil' && state.active) {
      const next = Number(patch.exclusionUntil);
      if (Number.isFinite(next) && next > state.until) continue;
    }

    // Writing a key its own current value is not a change, and options pages
    // send whole forms. Refusing those would make an unrelated save fail.
    if (sameValue(settings[key], patch[key])) continue;

    return { allowed: false, key, reason: locked.get(key) };
  }

  return { allowed: true, key: null, reason: null };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Would this patch loosen a session limit?
 *
 * "Loosen" is the only direction that matters. Tightening a limit mid-session
 * is the player doing the thing the feature exists to encourage, and refusing
 * it would be perverse.
 *
 * null is the loosest value there is — it means the limit is off — so moving to
 * null always counts as loosening, and moving from null to a number always
 * counts as tightening. Every one of the four reads the same way: a bigger
 * number is more room, including the win limit, where a higher target means
 * playing on rather than stopping.
 */
export const LIMIT_KEYS = ['limitWager', 'limitLoss', 'limitWin', 'limitMinutes'];

export function loosensLimit(settings = {}, patch = {}) {
  for (const key of LIMIT_KEYS) {
    if (!(key in patch)) continue;

    const before = settings[key];
    const after = patch[key];

    const wasOff = before === null || before === undefined || !Number.isFinite(Number(before));
    const isOff = after === null || after === undefined || !Number.isFinite(Number(after));

    if (isOff && !wasOff) return key;
    if (isOff || wasOff) continue;
    if (Number(after) > Number(before)) return key;
  }

  return null;
}

/**
 * May the limits be edited this way, given a session may be running?
 *
 * The pre-commitment rule, and it applies only while a session is live: a limit
 * chosen while calm and unavailable while playing is a different instrument
 * from one that can be raised the moment it bites. Between sessions every limit
 * is freely editable, because that is when the choosing is supposed to happen.
 */
export function limitEditAllowed(settings = {}, patch = {}, { sessionLive = false } = {}) {
  if (!settings.lockLimits || !sessionLive) return { allowed: true, key: null };

  const key = loosensLimit(settings, patch);
  return key ? { allowed: false, key } : { allowed: true, key: null };
}

/**
 * How long the cooldown screen holds, in ms, or 0 if it should not show.
 *
 * `crossed` is the set of limit ids the session has crossed; `acknowledged` is
 * what the user has already sat through. A limit only ever produces one
 * cooldown, so a session that crosses its loss limit and keeps playing is not
 * interrupted every few seconds by the same screen — the second crossing of the
 * same limit is not news, and a pause that fires repeatedly gets dismissed
 * reflexively, which is the failure mode this is meant to avoid.
 */
export function cooldownFor(settings = {}, { crossed = [], acknowledged = [] } = {}) {
  if (!settings.cooldownScreen) return { limit: null, ms: 0 };

  const seen = new Set(acknowledged);
  const limit = crossed.find((id) => !seen.has(id));
  if (!limit) return { limit: null, ms: 0 };

  return { limit, ms: clampCooldown(settings.cooldownSeconds) * 1000 };
}

export function clampCooldown(seconds) {
  const n = Math.round(Number(seconds));
  if (!Number.isFinite(n)) return 30;
  return Math.min(COOLDOWN_MAX_SECONDS, Math.max(COOLDOWN_MIN_SECONDS, n));
}

/**
 * Round an exclusion's remaining time to something worth saying out loud.
 *
 * Deliberately coarse. A countdown to the second turns an exclusion into a
 * thing to watch, and watching the clock is the state this is trying to
 * interrupt; the last hour is the only place a finer figure helps, because that
 * is where "today" stops being useful.
 */
export function remainingParts(msRemaining) {
  const ms = Math.max(0, Number(msRemaining) || 0);
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 1) return { unit: 'days', value: days + (hours % 24 >= 12 ? 1 : 0) };
  if (hours >= 1) return { unit: 'hours', value: hours };
  return { unit: 'minutes', value: Math.max(1, minutes) };
}
