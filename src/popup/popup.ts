// Toolbar popup (issue 11 trigger). Its single button tells the active tab's
// content script to enter "pick a GIF" mode, then closes the popup. Messaging to
// the tab is covered by the extension's host permissions (no extra permission).
import type { PickGifRequest } from '../messages';

const button = document.getElementById('pick');

button?.addEventListener('click', async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      const message: PickGifRequest = { type: 'PICK_GIF' };
      await browser.tabs.sendMessage(tab.id, message);
    }
  } catch {
    // No content script on this page (privileged page, no receiver) — nothing to
    // control. The toolbar button is normally disabled on such pages (see
    // background.ts), but swallow + close so the popup never gets stuck open.
  } finally {
    window.close();
  }
});
