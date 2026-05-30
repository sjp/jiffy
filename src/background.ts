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
