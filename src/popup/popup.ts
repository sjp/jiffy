// Toolbar popup (issue 11 trigger). Its single button tells the active tab's
// content script to enter "pick a GIF" mode, then closes the popup. Messaging to
// the tab is covered by the extension's host permissions (no extra permission).
import type { PickGifRequest } from '../messages';

const button = document.getElementById('pick');

button?.addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    const message: PickGifRequest = { type: 'PICK_GIF' };
    await browser.tabs.sendMessage(tab.id, message);
  }
  window.close();
});
