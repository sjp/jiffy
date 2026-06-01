// Background event page — fetches cross-origin GIF bytes using host permissions,
// which a content script (or bookmarklet) could not (PRD §2, §3). The fetch
// contract + logic live in ./messages; this file just wires it onto the runtime.
import { handleFetchGif, isFetchGifRequest } from './messages';

console.debug('[jiffy] background script loaded');

// Register at the top level so Firefox's MV3 event page re-registers the
// listener every time it wakes. Returning a Promise keeps the message channel
// open until the bytes resolve; non-matching messages return undefined so other
// listeners can handle them.
browser.runtime.onMessage.addListener((message) => {
  if (!isFetchGifRequest(message)) return undefined;
  return handleFetchGif(message.url);
});

// Disable the toolbar button on pages where the content script can't run, so the
// popup can't get into a dead state where its only action is a no-op (issue #3).
// Content scripts (matched on <all_urls>) only inject on http(s) pages; privileged
// pages (about:*, view-source:, the add-ons gallery, the PDF viewer, …) get no
// receiver. With our <all_urls> host permission, `tab.url` is populated for pages
// we can control and absent for privileged ones, so the absence of an http(s) URL
// is the gate — no extra `tabs` permission required.
function isControllable(url: string | undefined): boolean {
  return url != null && /^https?:/i.test(url);
}

async function syncActionState(tabId: number, url: string | undefined): Promise<void> {
  try {
    if (isControllable(url)) {
      await browser.action.enable(tabId);
    } else {
      await browser.action.disable(tabId);
    }
  } catch {
    // Tab closed between event and update — nothing to sync.
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // React to navigations: `changeInfo.url` on SPA/address-bar changes, and the
  // `loading` status (with `tab.url`) for full document loads.
  if (changeInfo.url != null || changeInfo.status === 'loading') {
    void syncActionState(tabId, changeInfo.url ?? tab.url);
  }
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  void browser.tabs
    .get(tabId)
    .then((tab) => syncActionState(tabId, tab.url))
    .catch(() => {});
});
