// Headless test for the background event page's wiring.
//
// The logic it drives (the message guards, streamFetchGif) is covered in
// ./messages.test.ts; what is only testable here is that background.ts hangs
// that logic on the right runtime events, at the top level, and that the port's
// lifetime is managed — a listener registered on the wrong event, or under a
// name that never matches, is a silent dead extension.
//
// `browser` has to exist before the module body runs, so the fake runtime is
// installed first and background.ts is imported dynamically below.
import assert from "node:assert/strict";

import { FETCH_PORT } from "./messages.ts";
import type { FetchGifEvent } from "./messages.ts";

// ---- fake runtime ----------------------------------------------------------

type MessageListener = (
  message: unknown,
  sender: { tab?: { id?: number }; url?: string },
) => unknown;
type ConnectListener = (port: FakePort) => void;
type PortListener = (message: unknown) => void;

const onMessageListeners: MessageListener[] = [];
const onConnectListeners: ConnectListener[] = [];
/** Every `tabs.sendMessage` the module made, as [tabId, message]. */
const sent: Array<[number, unknown]> = [];
/** Set to reject the next sendMessage, as a frame that went away does. */
let sendFails = false;

/** The half of a `runtime.Port` the background sees, plus test-side drivers. */
class FakePort {
  readonly posted: FetchGifEvent[] = [];
  /** Set to make postMessage throw, as a port whose other end is gone does. */
  postThrows = false;
  disconnected = false;
  private readonly messageListeners: PortListener[] = [];
  private readonly disconnectListeners: Array<() => void> = [];

  constructor(
    readonly name: string,
    readonly sender?: { url?: string },
  ) {}

  readonly onMessage = {
    addListener: (fn: PortListener) => this.messageListeners.push(fn),
  };
  readonly onDisconnect = {
    addListener: (fn: () => void) => this.disconnectListeners.push(fn),
  };
  postMessage(event: FetchGifEvent): void {
    if (this.postThrows) throw new Error("Attempt to postMessage on disconnected port");
    this.posted.push(event);
  }

  /** Test side: deliver a message from the content script. */
  send(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }
  /** Test side: hang up, as the loading toast's ✕ does. */
  disconnect(): void {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) fn();
  }
  get listenerCount(): number {
    return this.messageListeners.length;
  }
}

(globalThis as Record<string, unknown>).browser = {
  runtime: {
    onMessage: { addListener: (fn: MessageListener) => onMessageListeners.push(fn) },
    onConnect: { addListener: (fn: ConnectListener) => onConnectListeners.push(fn) },
  },
  tabs: {
    sendMessage: (tabId: number, message: unknown) => {
      sent.push([tabId, message]);
      return sendFails
        ? Promise.reject(new Error("Could not establish connection"))
        : Promise.resolve();
    },
  },
};

// ---- fake network ----------------------------------------------------------

const BODY = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
let fetched: Array<{ url: string; signal?: AbortSignal }> = [];
/** Resolves the in-flight fetch, so a disconnect can land while it is pending. */
let releaseFetch: (() => void) | undefined;

(globalThis as Record<string, unknown>).fetch = (url: string, init?: { signal?: AbortSignal }) => {
  fetched.push({ url, signal: init?.signal });
  const respond = () =>
    new Response(BODY, { headers: { "content-type": "image/gif" } }) as unknown as Response;
  if (!releaseFetch) return Promise.resolve(respond());
  return new Promise<Response>((resolve, reject) => {
    releaseFetch = () => resolve(respond());
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
};

await import("./background.ts");

/** Let the fetch pipeline's microtasks and stream reads settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

// ---- listeners are registered at the top level -----------------------------
// Firefox's MV3 event page re-runs this file every time it wakes, and only
// listeners added during that first turn are re-registered. Registering from
// inside a callback (or after an await) would work in testing and then quietly
// stop working once the page had been suspended once.
assert.equal(onMessageListeners.length, 1, "one runtime.onMessage listener, registered on load");
assert.equal(onConnectListeners.length, 1, "one runtime.onConnect listener, registered on load");
const onMessage = onMessageListeners[0]!;
const onConnect = onConnectListeners[0]!;

// ---- PICK_ENDED is relayed to every frame of the sending tab ---------------
{
  const result = onMessage({ type: "PICK_ENDED" }, { tab: { id: 7 } });
  assert.deepEqual(
    sent,
    [[7, { type: "EXIT_PICK" }]],
    "PICK_ENDED broadcasts EXIT_PICK to the tab",
  );
  // No frameId, so it reaches every frame — including the sender, for which
  // leaving pick mode is idempotent.
  assert.equal(result, undefined, "returns undefined so other listeners still see the message");
}

// ---- anything else is left alone -------------------------------------------
// Returning a value here would claim the message and starve any other listener,
// and a truthy return would hold the reply channel open forever.
sent.length = 0;
for (const message of [
  { type: "EXIT_PICK" },
  { type: "PICK_GIF" },
  { type: "FETCH_GIF", url: "http://example.com/a.gif" },
  null,
  "PICK_ENDED",
]) {
  assert.equal(
    onMessage(message, { tab: { id: 7 } }),
    undefined,
    "non-pick messages return undefined",
  );
}
assert.deepEqual(sent, [], "and broadcast nothing");

// ---- a sender with no tab has nothing to broadcast to ----------------------
// PICK_ENDED from an extension page (the popup) has no tab id; sendMessage
// would throw on `undefined`.
onMessage({ type: "PICK_ENDED" }, {});
assert.deepEqual(sent, [], "a tab-less sender is dropped, not passed on as undefined");

// ---- a frame that went away mid-pick doesn't reject into the console -------
sendFails = true;
onMessage({ type: "PICK_ENDED" }, { tab: { id: 9 } });
await flush();
assert.deepEqual(sent, [[9, { type: "EXIT_PICK" }]], "the broadcast is still attempted");
sendFails = false;

// ---- only the fetch port is claimed -----------------------------------------
{
  const other = new FakePort("some-other-extension-port");
  onConnect(other as never);
  assert.equal(other.listenerCount, 0, "a port with another name is left for its owner");
}

// ---- the fetch port streams the bytes back ---------------------------------
{
  fetched = [];
  const port = new FakePort(FETCH_PORT, { url: "http://example.com/page.html" });
  onConnect(port as never);
  assert.equal(port.listenerCount, 1, "the fetch port gets a message listener");
  assert.equal(port.posted.length, 0, "and nothing is fetched until it asks");

  port.send({ type: "FETCH_GIF", url: "http://example.com/a.gif" });
  await flush();

  assert.equal(fetched.length, 1, "the request reached fetch()");
  assert.equal(fetched[0]!.url, "http://example.com/a.gif", "…for the URL that was asked for");
  assert.deepEqual(
    port.posted.map((e) => e.type),
    ["FETCH_CHUNK", "FETCH_DONE"],
    "the body comes back as chunks then one terminal message",
  );

  // One fetch per port: a second request (or a message that isn't one) is
  // ignored rather than starting a parallel download onto the same port.
  port.send({ type: "FETCH_GIF", url: "http://example.com/b.gif" });
  port.send({ type: "PICK_GIF" });
  await flush();
  assert.equal(fetched.length, 1, "a second request on the same port is ignored");
}

// ---- the page's origin is passed through for the private-network guard -----
// A public page must not use the background as a proxy into the user's own
// network...
{
  fetched = [];
  const port = new FakePort(FETCH_PORT, { url: "https://example.com/page.html" });
  onConnect(port as never);
  port.send({ type: "FETCH_GIF", url: "http://127.0.0.1/a.gif" });
  await flush();
  assert.deepEqual(fetched, [], "a private target is refused before the network is touched");
  assert.deepEqual(
    port.posted.map((e) => e.type),
    ["FETCH_ERROR"],
    "and the refusal comes back as an error",
  );
}
// ...but a page already on a private host can reach its own network, and the
// only thing that tells the two apart is `port.sender.url` being passed on.
{
  fetched = [];
  const port = new FakePort(FETCH_PORT, { url: "http://localhost:8080/page.html" });
  onConnect(port as never);
  port.send({ type: "FETCH_GIF", url: "http://127.0.0.1/a.gif" });
  await flush();
  assert.equal(fetched.length, 1, "a private page's own network is still fetched");
  assert.deepEqual(
    port.posted.map((e) => e.type),
    ["FETCH_CHUNK", "FETCH_DONE"],
    "and streams back normally",
  );
}

// ---- disconnecting aborts the download for real ----------------------------
// This is what the loading toast's ✕ does. Without the abort the transfer would
// run to completion with nobody listening, holding the bytes and the socket.
{
  fetched = [];
  releaseFetch = () => {};
  const port = new FakePort(FETCH_PORT, { url: "http://example.com/page.html" });
  onConnect(port as never);
  port.send({ type: "FETCH_GIF", url: "http://example.com/slow.gif" });
  await flush();
  const signal = fetched[0]!.signal!;
  assert.equal(signal.aborted, false, "the fetch is in flight");
  port.disconnect();
  assert.equal(signal.aborted, true, "disconnect aborts it");
  await flush();
  assert.deepEqual(port.posted, [], "and nobody is told — the other end has gone");
  releaseFetch = undefined;
}

// ---- a port that dies mid-transfer stops the transfer ----------------------
// postMessage throws once the other end is gone; swallowing that and carrying on
// would read the whole body into a void.
{
  fetched = [];
  releaseFetch = () => {};
  const port = new FakePort(FETCH_PORT, { url: "http://example.com/page.html" });
  onConnect(port as never);
  port.postThrows = true;
  port.send({ type: "FETCH_GIF", url: "http://example.com/gone.gif" });
  await flush();
  const signal = fetched[0]!.signal!;
  releaseFetch!(); // the response arrives, and the first chunk can't be posted
  await flush();
  assert.equal(signal.aborted, true, "a throwing postMessage aborts the fetch");
  releaseFetch = undefined;
}

console.log("background.test: OK");
