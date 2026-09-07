// Headless tests for the two-tier content-script fetch: which tier handles a
// given URL, when a tier-1 failure is worth a fallback, how the port's chunks
// are reassembled, and that cancellation unwinds whichever tier is in flight.
// Both collaborators are injected, so no network and no `browser.*` are touched.

import assert from "node:assert/strict";

import { bytesToBase64 } from "../messages.ts";
import type { FetchGifEvent, FetchGifRequest } from "../messages.ts";
import { createFetchGifBytes } from "./fetchGif.ts";
import type { FetchPort } from "./fetchGif.ts";

/** Minimal Response-like value, as in messages.test.ts. */
const fakeResponse = (opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  bytes?: Uint8Array;
  contentLength?: number;
}) => {
  const {
    ok = true,
    status = 200,
    statusText = "OK",
    bytes = new Uint8Array(),
    contentLength,
  } = opts;
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" && contentLength != null
          ? String(contentLength)
          : null,
    },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  } as unknown as Response;
};

/**
 * A fetch port that hands the request to `reply`, which posts events back at its
 * leisure. Records what the client asked for and whether it hung up.
 */
class FakePort implements FetchPort {
  readonly requests: FetchGifRequest[] = [];
  disconnected = false;
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  constructor(private readonly reply: (port: FakePort, request: FetchGifRequest) => void) {}

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => {
      this.messageListeners.push(listener);
    },
  };
  readonly onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnectListeners.push(listener);
    },
  };

  postMessage(request: FetchGifRequest): void {
    this.requests.push(request);
    this.reply(this, request);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Background → content. Ignored once the client has hung up, as a real port is. */
  emit(event: FetchGifEvent): void {
    if (this.disconnected) return;
    for (const listener of this.messageListeners) listener(event);
  }

  /** The background side going away without a terminal message. */
  drop(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

/** Records what each tier was asked to do. */
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type ReplyImpl = (port: FakePort, request: FetchGifRequest) => void;

interface Harness {
  fetchGifBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  direct: { url: string; init?: RequestInit }[];
  ports: FakePort[];
  /** Every request that reached the background, across all ports. */
  requests: FetchGifRequest[];
}

/** The default background: one chunk of [7, 8], then done. */
const defaultReply: ReplyImpl = (port) => {
  port.emit({ type: "FETCH_CHUNK", data: bytesToBase64(new Uint8Array([7, 8])) });
  port.emit({ type: "FETCH_DONE" });
};

const harness = (
  impls: { fetch?: FetchImpl; reply?: ReplyImpl; maxBytes?: number } = {},
): Harness => {
  const direct: { url: string; init?: RequestInit }[] = [];
  const ports: FakePort[] = [];
  const fetchGifBytes = createFetchGifBytes({
    fetch: ((url: string, init?: RequestInit) => {
      direct.push({ url, init });
      return (impls.fetch ?? (async () => fakeResponse({})))(url, init);
    }) as unknown as typeof globalThis.fetch,
    connect: () => {
      const port = new FakePort(impls.reply ?? defaultReply);
      ports.push(port);
      return port;
    },
    maxBytes: impls.maxBytes,
  });
  return {
    fetchGifBytes,
    direct,
    ports,
    get requests() {
      return ports.flatMap((p) => p.requests);
    },
  };
};

const bytesOf = (buf: ArrayBuffer) => [...new Uint8Array(buf)];
const corsFailure = () => new TypeError("Failed to fetch");

// ---- tier 1 handles what it can, with no port to the background ---------
{
  const h = harness({ fetch: async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3]) }) });
  const buf = await h.fetchGifBytes("http://example.com/a.gif");
  assert.deepEqual(bytesOf(buf), [1, 2, 3], "bytes come straight from the direct fetch");
  assert.equal(h.ports.length, 0, "background not involved");
  // force-cache reuses the bytes the <img> already downloaded; credentials stay
  // at same-origin so a CDN's `Access-Control-Allow-Origin: *` still passes.
  assert.equal(h.direct[0]?.init?.cache, "force-cache");
  assert.equal(h.direct[0]?.init?.credentials, "same-origin");
}

// blob: only resolves in the page's origin — it must never reach the background.
{
  const h = harness({ fetch: async () => fakeResponse({ bytes: new Uint8Array([9]) }) });
  const buf = await h.fetchGifBytes("blob:http://example.com/2f8c-4f2a");
  assert.deepEqual(bytesOf(buf), [9], "blob: fetched directly");
  assert.equal(h.ports.length, 0, "no port opened for blob:");
}

// ---- tier 2 fallback ----------------------------------------------------
// A cross-origin image with no CORS headers fails the direct fetch; the
// background's host permissions get it.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
  });
  const buf = await h.fetchGifBytes("http://cdn.example.com/a.gif");
  assert.deepEqual(bytesOf(buf), [7, 8], "bytes come from the background");
  assert.deepEqual(h.requests, [{ type: "FETCH_GIF", url: "http://cdn.example.com/a.gif" }]);
  assert.equal(h.ports[0]?.disconnected, true, "the port is closed once the bytes are in");
}

// Multi-chunk transfers rejoin in order.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    reply: (port) => {
      for (const part of [[1, 2], [3], [4, 5, 6]]) {
        port.emit({ type: "FETCH_CHUNK", data: bytesToBase64(new Uint8Array(part)) });
      }
      port.emit({ type: "FETCH_DONE" });
    },
  });
  const buf = await h.fetchGifBytes("http://cdn.example.com/big.gif");
  assert.deepEqual(bytesOf(buf), [1, 2, 3, 4, 5, 6], "chunks are concatenated in arrival order");
}

// A transfer with no chunks at all is an empty image, not a hang.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    reply: (port) => port.emit({ type: "FETCH_DONE" }),
  });
  assert.deepEqual(bytesOf(await h.fetchGifBytes("http://cdn.example.com/e.gif")), []);
}

// A server that answers the content script's request with an error status may
// still answer the background's, so that's worth a retry too.
{
  const h = harness({
    fetch: async () => fakeResponse({ ok: false, status: 403, statusText: "Forbidden" }),
  });
  const buf = await h.fetchGifBytes("http://hotlink.example.com/a.gif");
  assert.deepEqual(bytesOf(buf), [7, 8], "403 falls back to the background");
  assert.equal(h.ports.length, 1);
}

// A scheme the direct tier won't touch skips tier 1 entirely.
{
  const h = harness({
    reply: (port) => port.emit({ type: "FETCH_ERROR", error: "refused" }),
  });
  await assert.rejects(() => h.fetchGifBytes("file:///etc/passwd"), /refused/);
  assert.equal(h.direct.length, 0, "no direct fetch for a disallowed scheme");
  assert.equal(h.ports.length, 1, "the background does the refusing");
  assert.equal(h.ports[0]?.disconnected, true, "and the port is closed after the error");
}

// Both tiers failing surfaces the background's error.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    reply: (port) => port.emit({ type: "FETCH_ERROR", error: "HTTP 404 Not Found" }),
  });
  await assert.rejects(() => h.fetchGifBytes("http://example.com/missing.gif"), /404/);
}

// A port that closes without a terminal message is an error, not a hang.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    reply: (port) => port.drop(),
  });
  await assert.rejects(() => h.fetchGifBytes("http://example.com/a.gif"), /no response/);
}

// ---- the size cap is enforced on tier 1 too, without a retry ------------
{
  const h = harness({
    fetch: async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3, 4, 5]) }),
    maxBytes: 2,
  });
  await assert.rejects(() => h.fetchGifBytes("http://example.com/huge.gif"), /limit/);
  assert.equal(h.ports.length, 0, "an oversized image is not re-downloaded by the background");
}
{
  const h = harness({
    fetch: async () => fakeResponse({ bytes: new Uint8Array([1]), contentLength: 9_999_999 }),
    maxBytes: 2,
  });
  await assert.rejects(() => h.fetchGifBytes("http://example.com/huge.gif"), /limit/);
  assert.equal(h.ports.length, 0, "declared oversize rejected before reading");
}

// ---- cancellation -------------------------------------------------------
// Already aborted: neither tier runs.
{
  const h = harness();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => h.fetchGifBytes("http://example.com/a.gif", ac.signal), {
    name: "AbortError",
  });
  assert.equal(h.direct.length + h.ports.length, 0, "nothing attempted after an abort");
}

// Aborting mid-transfer cancels tier 1 for real, and doesn't fall back.
{
  const ac = new AbortController();
  const h = harness({
    fetch: (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  });
  const pending = h.fetchGifBytes("http://example.com/a.gif", ac.signal);
  ac.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  assert.equal(h.direct[0]?.init?.signal, ac.signal, "the signal reaches the real fetch");
  assert.equal(h.ports.length, 0, "a cancelled load is not retried via the background");
}

// Aborting while the background tier is in flight unwinds immediately and hangs
// up the port — which is what stops the download on the other side.
{
  const ac = new AbortController();
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    reply: () => {}, // never answers
  });
  const pending = h.fetchGifBytes("http://example.com/a.gif", ac.signal);
  await new Promise((resolve) => setTimeout(resolve, 0)); // tier 1 fails, tier 2 starts
  ac.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  assert.equal(h.ports[0]?.disconnected, true, "the abort closes the port");
}

// Chunks that arrive after the client has settled are ignored, not appended.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    reply: (port) => {
      port.emit({ type: "FETCH_CHUNK", data: bytesToBase64(new Uint8Array([1])) });
      port.emit({ type: "FETCH_DONE" });
      port.emit({ type: "FETCH_CHUNK", data: bytesToBase64(new Uint8Array([2])) });
      port.drop();
    },
  });
  assert.deepEqual(bytesOf(await h.fetchGifBytes("http://example.com/a.gif")), [1]);
}

console.log("fetchGif.test: OK");
