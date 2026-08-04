// The first-install page. Static text, localised the same way every other page
// is — it says what the extension does and what the two privacy-relevant
// switches cause it to ask for, which until now was knowledge that lived only
// in the README.

import { applyI18n, useMessages } from './lib/i18n.js';

try {
  const state = await chrome.runtime.sendMessage({ type: 'getState' });
  useMessages(state?.i18n);
} catch {
  // The service worker not answering costs the bundle, not the page: every
  // string is written in the markup as English underneath.
}

applyI18n();

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
