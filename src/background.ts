// Background event page — the hub for the two things a content script can't do
// on its own: fetch image bytes with the extension's own host access (the page's
// origin and CORS block that in the content script), and relay a message from
// one frame of a tab to the others. The fetch contract + logic live in
// ./messages; this file just wires them onto the runtime.
import { FETCH_PORT, isFetchGifRequest, isPickEndedRequest, streamFetchGif } from "./messages";
import type { ExitPickRequest, FetchGifEvent } from "./messages";

// Register at the top level so Firefox's MV3 event page re-registers the
// listener every time it wakes. Non-matching messages return undefined so other
// listeners can handle them.
browser.runtime.onMessage.addListener((message, sender) => {
  // One frame resolved a pick. Frames can't message each other, so relay it back
  // out to every frame of the sending tab and the rest drop out of pick mode.
  if (isPickEndedRequest(message)) broadcastExitPick(sender.tab?.id);
  return undefined;
});

// One port per image fetch. A port rather than a `sendMessage` reply because the
// bytes arrive in chunks (see ./messages) and because disconnecting it — which
// is what the loading toast's ✕ does — aborts the download for real instead of
// leaving it running with nobody listening.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== FETCH_PORT) return;
  const cancel = new AbortController();
  port.onDisconnect.addListener(() => cancel.abort());
  // Post-disconnect sends throw; the transfer is over either way.
  const post = (event: FetchGifEvent) => {
    try {
      port.postMessage(event);
    } catch {
      cancel.abort();
    }
  };
  let started = false;
  port.onMessage.addListener((message) => {
    if (started || !isFetchGifRequest(message)) return; // one fetch per port
    started = true;
    void streamFetchGif(message.url, post, { pageUrl: port.sender?.url, signal: cancel.signal });
  });
});

function broadcastExitPick(tabId: number | undefined): void {
  if (tabId == null) return;
  const message: ExitPickRequest = { type: "EXIT_PICK" };
  // Reaches every frame (no frameId), the sender included — leaving pick mode is
  // idempotent, so the echo costs nothing. Rejections just mean a frame went away
  // mid-pick.
  void browser.tabs.sendMessage(tabId, message).catch(() => {});
}
