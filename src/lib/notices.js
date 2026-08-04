// Text for the one thing that happens *to* the user's settings rather than
// because of them: a change of target currency moving the money limits.
//
// It lives here rather than in either page because both have to say it. The
// popup is where the limits are usually set, and the options page is where the
// currency was just changed — a notice that appeared in only one of those would
// be missed by exactly the person it is for.

import { formatMoney } from './format.js';
import { t } from './i18n.js';

/**
 * What the last change of target did to the money limits, in one line.
 *
 * Converting them silently would leave three figures meaning something nobody
 * set; clearing them silently would leave a session running with no limit on it
 * and nobody the wiser. Both are said out loud, once, until a limit is edited.
 *
 * @param notice  The `limitSwitch` block from getState, or null.
 * @returns The sentence, or '' when there is nothing to say.
 */
export function limitSwitchText(notice) {
  if (!notice) return '';

  const { from, to } = notice;

  if (notice.kind === 'cleared') {
    return t('limitsCleared',
      `Your money limits were set in ${from} and no exchange rate was available to move them to ${to}, `
      + 'so they have been turned off. Set them again below.', [from, to]);
  }

  const moved = Object.values(notice.limits || {})
    .map((limit) => `${formatMoney(limit.was, from, null)} → ${formatMoney(limit.now, to, null)}`)
    .join(', ');

  return t('limitsConverted',
    `Your money limits were converted from ${from} to ${to} when you changed currency: ${moved}.`,
    [from, to, moved]);
}
