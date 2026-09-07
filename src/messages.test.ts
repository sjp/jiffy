// Headless unit test for the GIF fetch messaging contract.
// Run: `npm test`. `fetch` is stubbed so no network is touched.

import assert from "node:assert/strict";

import {
  base64ToBytes,
  bytesToBase64,
  isExitPickRequest,
  isFetchGifEvent,
  isFetchGifRequest,
  isPickEndedRequest,
  isPickGifRequest,
  streamFetchGif,
} from "./messages.ts";
import type { FetchGifEvent, StreamFetchGifOptions } from "./messages.ts";

// ---- isFetchGifRequest guard --------------------------------------------
assert.equal(isFetchGifRequest({ type: "FETCH_GIF", url: "http://x/a.gif" }), true);
assert.equal(isFetchGifRequest({ type: "FETCH_GIF" }), false, "missing url");
assert.equal(isFetchGifRequest({ type: "OTHER", url: "x" }), false, "wrong type");
assert.equal(isFetchGifRequest(null), false);
assert.equal(isFetchGifRequest("FETCH_GIF"), false);

// ---- isPickGifRequest guard ---------------------------------------------
assert.equal(isPickGifRequest({ type: "PICK_GIF" }), true);
assert.equal(isPickGifRequest({ type: "FETCH_GIF", url: "x" }), false, "wrong type");
assert.equal(isPickGifRequest(null), false);
assert.equal(isPickGifRequest(undefined), false);

// ---- cross-frame pick coordination guards --------------------------------
assert.equal(isPickEndedRequest({ type: "PICK_ENDED" }), true);
assert.equal(isPickEndedRequest({ type: "EXIT_PICK" }), false, "wrong type");
assert.equal(isPickEndedRequest(null), false);

assert.equal(isExitPickRequest({ type: "EXIT_PICK" }), true);
assert.equal(isExitPickRequest({ type: "PICK_ENDED" }), false, "wrong type");
assert.equal(isExitPickRequest(null), false);

// The pick messages must not cross-match each other or the fetch request.
assert.equal(isPickGifRequest({ type: "PICK_ENDED" }), false);
assert.equal(isFetchGifRequest({ type: "EXIT_PICK" }), false);

// ---- isFetchGifEvent guard ----------------------------------------------
assert.equal(isFetchGifEvent({ type: "FETCH_CHUNK", data: "AAAA" }), true);
assert.equal(isFetchGifEvent({ type: "FETCH_CHUNK" }), false, "chunk without data");
assert.equal(isFetchGifEvent({ type: "FETCH_DONE" }), true);
assert.equal(isFetchGifEvent({ type: "FETCH_ERROR", error: "nope" }), true);
assert.equal(isFetchGifEvent({ type: "FETCH_ERROR", error: 1 }), false, "error must be a string");
assert.equal(isFetchGifEvent({ type: "FETCH_GIF", url: "x" }), false, "wrong type");
assert.equal(isFetchGifEvent(null), false);

const realFetch = globalThis.fetch;
let fetchCalls = 0;
const stub = (impl: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>) => {
  (globalThis as { fetch: unknown }).fetch = (url: string, init?: { signal?: AbortSignal }) => {
    fetchCalls++;
    return impl(url, init);
  };
};

// Minimal Response-like value with independent control over the body stream and
// the headers (a real Response would recompute Content-Length).
const fakeResponse = (opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  bytes?: Uint8Array;
  contentLength?: number;
  contentType?: string;
}) => {
  const {
    ok = true,
    status = 200,
    statusText = "OK",
    bytes = new Uint8Array(),
    contentLength,
    contentType,
  } = opts;
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "content-length") return contentLength == null ? null : String(contentLength);
        if (key === "content-type") return contentType ?? null;
        return null;
      },
    },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
};

/** Drive one transfer to completion and hand back everything it posted. */
const run = async (url: string, opts: StreamFetchGifOptions = {}): Promise<FetchGifEvent[]> => {
  const events: FetchGifEvent[] = [];
  await streamFetchGif(url, (event) => events.push(event), {
    // The private-network guard needs a page; tests that care pass their own.
    pageUrl: "https://page.example/",
    ...opts,
  });
  return events;
};

/** The transferred bytes, reassembled the way the content client does. */
const payload = (events: FetchGifEvent[]): number[] => {
  const out: number[] = [];
  for (const event of events) {
    if (event.type === "FETCH_CHUNK") out.push(...base64ToBytes(event.data));
  }
  return out;
};

const errorOf = (events: FetchGifEvent[]): string => {
  const last = events.at(-1);
  return last?.type === "FETCH_ERROR" ? last.error : "";
};

const terminals = (events: FetchGifEvent[]) =>
  events.filter((e) => e.type !== "FETCH_CHUNK").map((e) => e.type);

// ---- base64 codec round-trips arbitrary bytes (incl. a chunk boundary) --
// Larger than the fallback encoder's 0x8000 spread chunk, so multi-chunk
// encoding is hit on runtimes without the native methods.
const B64_CHUNK_SPAN = 0x8000 + 5;
for (const len of [0, 1, 3, 255, B64_CHUNK_SPAN]) {
  const original = new Uint8Array(len);
  for (let i = 0; i < len; i++) original[i] = i % 256;
  const restored = base64ToBytes(bytesToBase64(original));
  assert.deepEqual([...restored], [...original], `base64 round-trip len=${len}`);
}

// ---- success: bytes arrive as base64 chunks, then FETCH_DONE ------------
// Base64 so they survive Chrome's JSON message serialisation (a raw
// ArrayBuffer would collapse to `{}`).
stub(async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3]) }));
const ok = await run("http://example.com/a.gif");
assert.deepEqual(terminals(ok), ["FETCH_DONE"], "one terminal message");
assert.deepEqual(payload(ok), [1, 2, 3], "decoded bytes");

// An empty body is a clean, chunk-less transfer rather than an error.
stub(async () => fakeResponse({ bytes: new Uint8Array() }));
assert.deepEqual(terminals(await run("http://example.com/empty.gif")), ["FETCH_DONE"]);

// ---- chunking: a body over chunkBytes is split, and rejoins intact ------
const big = new Uint8Array(4096);
for (let i = 0; i < big.length; i++) big[i] = i % 256;
stub(async () => fakeResponse({ bytes: big }));
const chunked = await run("http://example.com/big.gif", { chunkBytes: 512 });
// One `enqueue` of 4096 bytes flushes once — the coalescer never splits a read,
// it only stops accumulating — so the useful assertion is that nothing is lost.
assert.deepEqual(payload(chunked), [...big], "chunked transfer rejoins byte-for-byte");
assert.deepEqual(terminals(chunked), ["FETCH_DONE"]);

// A body arriving as many small reads is coalesced into few messages.
stub(
  async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(100).fill(i));
          c.close();
        },
      }),
    }) as unknown,
);
const coalesced = await run("http://example.com/drip.gif", { chunkBytes: 1000 });
const chunkCount = coalesced.filter((e) => e.type === "FETCH_CHUNK").length;
assert.equal(chunkCount, 4, "40 × 100-byte reads coalesce into 4 × 1000-byte messages");
assert.equal(payload(coalesced).length, 4000, "and carry every byte");

// ---- non-OK HTTP status → FETCH_ERROR -----------------------------------
stub(async () => fakeResponse({ ok: false, status: 404, statusText: "Not Found" }));
assert.match(errorOf(await run("http://example.com/missing.gif")), /404/, "error names the status");

// ---- network failure → FETCH_ERROR --------------------------------------
stub(async () => {
  throw new Error("network down");
});
assert.equal(errorOf(await run("http://example.com/a.gif")), "network down", "message preserved");

// ---- disallowed scheme is refused without fetching -----------------------
stub(async () => fakeResponse({ bytes: new Uint8Array([1]) }));
fetchCalls = 0;
assert.match(errorOf(await run("file:///etc/passwd")), /Refusing/, "file: scheme refused");
assert.equal(fetchCalls, 0, "no fetch attempted for a disallowed scheme");
assert.match(errorOf(await run("not a url")), /Refusing/, "unparseable URL refused");

// data: URLs are allowed (inline animated images) and skip the host guard.
assert.deepEqual(terminals(await run("data:image/gif;base64,AAAA")), ["FETCH_DONE"]);

// ---- private-network guard ----------------------------------------------
// A page on the public web must not use the extension's host access as a proxy
// into the user's LAN.
fetchCalls = 0;
for (const url of [
  "http://localhost:8080/a.gif",
  "http://127.0.0.1/a.gif",
  "http://10.1.2.3/a.gif",
  "http://192.168.0.9/a.gif",
  "http://172.20.0.1/a.gif",
  "http://169.254.169.254/a.gif",
  "http://intranet/a.gif",
  "http://nas.local/a.gif",
  "http://[::1]/a.gif",
  "http://[fd00::1]/a.gif",
]) {
  assert.match(errorOf(await run(url)), /Refusing to fetch/, `${url} refused for a public page`);
}
assert.equal(fetchCalls, 0, "a private target is refused before any request");

// A page already on that network keeps working — it can reach it anyway.
stub(async () => fakeResponse({ bytes: new Uint8Array([4]) }));
const fromIntranet = await run("http://10.1.2.3/a.gif", { pageUrl: "http://10.1.2.4/index.html" });
assert.deepEqual(payload(fromIntranet), [4], "private page may fetch its own network");
// …and a public host is fine from anywhere.
assert.deepEqual(payload(await run("https://cdn.example.com/a.gif")), [4], "public host allowed");

// ---- Content-Type: refuse what the server says isn't an image ------------
stub(async () =>
  fakeResponse({ bytes: new Uint8Array([1]), contentType: "text/html; charset=utf-8" }),
);
assert.match(errorOf(await run("http://example.com/login.html")), /not an image/, "HTML refused");
stub(async () => fakeResponse({ bytes: new Uint8Array([1]), contentType: "video/mp4" }));
assert.match(errorOf(await run("http://example.com/a.gif")), /not an image/, "video refused");

// image/* and the generic binary labels CDNs use are let through.
for (const contentType of ["image/gif", "IMAGE/WebP", "application/octet-stream"]) {
  stub(async () => fakeResponse({ bytes: new Uint8Array([5]), contentType }));
  assert.deepEqual(payload(await run("http://example.com/a.gif")), [5], `${contentType} allowed`);
}

// ---- size cap: declared Content-Length over the limit --------------------
stub(async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3]), contentLength: 9_999_999 }));
const tooBigHeader = await run("http://example.com/huge.gif", { maxBytes: 100 });
assert.match(errorOf(tooBigHeader), /limit/, "oversized Content-Length rejected");
assert.equal(payload(tooBigHeader).length, 0, "and nothing was sent");

// ---- size cap: streaming enforcement when the header lies/omits ----------
stub(async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3, 4, 5]) })); // no Content-Length
assert.match(
  errorOf(await run("http://example.com/sneaky.gif", { maxBytes: 2 })),
  /limit/,
  "oversized body rejected while streaming",
);

// ---- timeout: a hung request becomes a typed error -----------------------
const hang = () =>
  stub(
    (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
hang();
assert.match(
  errorOf(await run("http://example.com/slow.gif", { timeoutMs: 10 })),
  /timed out/,
  "hung request times out",
);

// ---- the caller hanging up aborts the fetch, silently --------------------
// The port is gone, so there is nobody left to send a FETCH_ERROR to.
hang();
const hangup = new AbortController();
const events: FetchGifEvent[] = [];
const pending = streamFetchGif("http://example.com/slow.gif", (e) => events.push(e), {
  pageUrl: "https://page.example/",
  signal: hangup.signal,
});
hangup.abort();
await pending;
assert.deepEqual(events, [], "an aborted transfer posts nothing");

globalThis.fetch = realFetch;
console.log("messages.test: OK");
