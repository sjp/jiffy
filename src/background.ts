// Background event page — the hub for the two things a content script can't do
// on its own: fetch image bytes with the extension's own host access (the page's
// origin and CORS block that in the content script), and relay a message from
// one frame of a tab to the others. The fetch contract + logic live in
// ./messages; this file just wires them onto the runtime.
import { handleFetchGif, isFetchGifRequest, isPickEndedRequest } from "./messages";
import type { ExitPickRequest } from "./messages";

// Register at the top level so Firefox's MV3 event page re-registers the
// listener every time it wakes. Returning a Promise keeps the message channel
// open until the bytes resolve; non-matching messages return undefined so other
// listeners can handle them.
browser.runtime.onMessage.addListener((message, sender) => {
  if (isFetchGifRequest(message)) return handleFetchGif(message.url);
  // One frame resolved a pick. Frames can't message each other, so relay it back
  // out to every frame of the sending tab and the rest drop out of pick mode.
  if (isPickEndedRequest(message)) broadcastExitPick(sender.tab?.id);
  return undefined;
});

function broadcastExitPick(tabId: number | undefined): void {
  if (tabId == null) return;
  const message: ExitPickRequest = { type: "EXIT_PICK" };
  // Reaches every frame (no frameId), the sender included — leaving pick mode is
  // idempotent, so the echo costs nothing. Rejections just mean a frame went away
  // mid-pick.
  void browser.tabs.sendMessage(tabId, message).catch(() => {});
}
