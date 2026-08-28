// Headless tests for the two-tier content-script fetch: which tier handles a
// given URL, when a tier-1 failure is worth a fallback, and that cancellation
// unwinds whichever tier is in flight. Both collaborators are injected, so no
// network and no `browser.*` are touched.

import assert from "node:assert/strict";

import { bytesToBase64 } from "../messages.ts";
import type { FetchGifRequest, FetchGifResponse } from "../messages.ts";
import { createFetchGifBytes } from "./fetchGif.ts";

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

/** Records what each tier was asked to do. */
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type SendImpl = (request: FetchGifRequest) => Promise<FetchGifResponse | undefined>;

interface Harness {
  fetchGifBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  direct: { url: string; init?: RequestInit }[];
  messages: FetchGifRequest[];
}

const harness = (
  impls: { fetch?: FetchImpl; sendMessage?: SendImpl; maxBytes?: number } = {},
): Harness => {
  const direct: { url: string; init?: RequestInit }[] = [];
  const messages: FetchGifRequest[] = [];
  const fetchGifBytes = createFetchGifBytes({
    fetch: ((url: string, init?: RequestInit) => {
      direct.push({ url, init });
      return (impls.fetch ?? (async () => fakeResponse({})))(url, init);
    }) as unknown as typeof globalThis.fetch,
    sendMessage: (request) => {
      messages.push(request);
      return (
        impls.sendMessage ??
        (async () => ({ ok: true, data: bytesToBase64(new Uint8Array([7, 8])) }))
      )(request);
    },
    maxBytes: impls.maxBytes,
  });
  return { fetchGifBytes, direct, messages };
};

const bytesOf = (buf: ArrayBuffer) => [...new Uint8Array(buf)];
const corsFailure = () => new TypeError("Failed to fetch");

// ---- tier 1 handles what it can, with no message to the background ------
{
  const h = harness({ fetch: async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3]) }) });
  const buf = await h.fetchGifBytes("http://example.com/a.gif");
  assert.deepEqual(bytesOf(buf), [1, 2, 3], "bytes come straight from the direct fetch");
  assert.equal(h.messages.length, 0, "background not involved");
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
  assert.equal(h.messages.length, 0, "no background message for blob:");
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
  assert.deepEqual(h.messages, [{ type: "FETCH_GIF", url: "http://cdn.example.com/a.gif" }]);
}

// A server that answers the content script's request with an error status may
// still answer the background's, so that's worth a retry too.
{
  const h = harness({
    fetch: async () => fakeResponse({ ok: false, status: 403, statusText: "Forbidden" }),
  });
  const buf = await h.fetchGifBytes("http://hotlink.example.com/a.gif");
  assert.deepEqual(bytesOf(buf), [7, 8], "403 falls back to the background");
  assert.equal(h.messages.length, 1);
}

// A scheme the direct tier won't touch skips tier 1 entirely.
{
  const h = harness({ sendMessage: async () => ({ ok: false, error: "refused" }) });
  await assert.rejects(() => h.fetchGifBytes("file:///etc/passwd"), /refused/);
  assert.equal(h.direct.length, 0, "no direct fetch for a disallowed scheme");
  assert.equal(h.messages.length, 1, "the background does the refusing");
}

// Both tiers failing surfaces the background's error.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    sendMessage: async () => ({ ok: false, error: "HTTP 404 Not Found" }),
  });
  await assert.rejects(() => h.fetchGifBytes("http://example.com/missing.gif"), /404/);
}

// A missing background reply is still an error, not an empty buffer.
{
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    sendMessage: async () => undefined,
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
  assert.equal(h.messages.length, 0, "an oversized image is not re-downloaded by the background");
}
{
  const h = harness({
    fetch: async () => fakeResponse({ bytes: new Uint8Array([1]), contentLength: 9_999_999 }),
    maxBytes: 2,
  });
  await assert.rejects(() => h.fetchGifBytes("http://example.com/huge.gif"), /limit/);
  assert.equal(h.messages.length, 0, "declared oversize rejected before reading");
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
  assert.equal(h.direct.length + h.messages.length, 0, "nothing attempted after an abort");
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
  assert.equal(h.messages.length, 0, "a cancelled load is not retried via the background");
}

// Aborting while the background tier is in flight unwinds immediately.
{
  const ac = new AbortController();
  const h = harness({
    fetch: async () => {
      throw corsFailure();
    },
    sendMessage: () => new Promise(() => {}), // never settles
  });
  const pending = h.fetchGifBytes("http://example.com/a.gif", ac.signal);
  await new Promise((resolve) => setTimeout(resolve, 0)); // tier 1 fails, tier 2 starts
  ac.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
}

console.log("fetchGif.test: OK");
