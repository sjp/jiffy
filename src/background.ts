// Background service worker — fetches cross-origin GIF bytes using host
// permissions, which a content script (or bookmarklet) could not (PRD §3).
// Message handling is implemented in issue 04.
export {};

console.debug('[jiffy] background script loaded');

