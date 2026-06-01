// Headless unit test for the GIF fetch messaging contract.
// Run: `npm test`. `fetch` is stubbed so no network is touched.

import assert from 'node:assert/strict';
import { handleFetchGif, isFetchGifRequest, isPickGifRequest } from './messages.ts';

// ---- isFetchGifRequest guard --------------------------------------------
assert.equal(isFetchGifRequest({ type: 'FETCH_GIF', url: 'http://x/a.gif' }), true);
assert.equal(isFetchGifRequest({ type: 'FETCH_GIF' }), false, 'missing url');
assert.equal(isFetchGifRequest({ type: 'OTHER', url: 'x' }), false, 'wrong type');
assert.equal(isFetchGifRequest(null), false);
assert.equal(isFetchGifRequest('FETCH_GIF'), false);

// ---- isPickGifRequest guard ---------------------------------------------
assert.equal(isPickGifRequest({ type: 'PICK_GIF' }), true);
assert.equal(isPickGifRequest({ type: 'FETCH_GIF', url: 'x' }), false, 'wrong type');
assert.equal(isPickGifRequest(null), false);
assert.equal(isPickGifRequest(undefined), false);

const realFetch = globalThis.fetch;
let fetchCalls = 0;
const stub = (impl: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>) => {
  (globalThis as { fetch: unknown }).fetch = (url: string, init?: { signal?: AbortSignal }) => {
    fetchCalls++;
    return impl(url, init);
  };
};

// Minimal Response-like value with independent control over the body stream and
// the Content-Length header (a real Response would recompute the header).
const fakeResponse = (opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  bytes?: Uint8Array;
  contentLength?: number;
}) => {
  const { ok = true, status = 200, statusText = 'OK', bytes = new Uint8Array(), contentLength } = opts;
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null,
    },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
};

// ---- success: returns bytes (streamed) ----------------------------------
stub(async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3]) }));
const okRes = await handleFetchGif('http://example.com/a.gif');
assert.equal(okRes.ok, true, 'ok response');
assert.equal(okRes.ok && okRes.data.byteLength, 3, 'byte length');

// ---- non-OK HTTP status → typed error -----------------------------------
stub(async () => fakeResponse({ ok: false, status: 404, statusText: 'Not Found' }));
const notFound = await handleFetchGif('http://example.com/missing.gif');
assert.equal(notFound.ok, false, 'non-ok status');
assert.match(notFound.ok ? '' : notFound.error, /404/, 'error mentions status');

// ---- network failure → typed error --------------------------------------
stub(async () => {
  throw new Error('network down');
});
const failed = await handleFetchGif('http://example.com/a.gif');
assert.equal(failed.ok, false, 'network failure');
assert.equal(failed.ok ? '' : failed.error, 'network down', 'error message preserved');

// ---- disallowed scheme is refused without fetching -----------------------
stub(async () => fakeResponse({ bytes: new Uint8Array([1]) }));
fetchCalls = 0;
const fileUrl = await handleFetchGif('file:///etc/passwd');
assert.equal(fileUrl.ok, false, 'file: scheme refused');
assert.equal(fetchCalls, 0, 'no fetch attempted for a disallowed scheme');
const garbage = await handleFetchGif('not a url');
assert.equal(garbage.ok, false, 'unparseable URL refused');

// data: URLs are allowed (inline animated images).
const dataUrl = await handleFetchGif('data:image/gif;base64,AAAA');
assert.equal(dataUrl.ok, true, 'data: scheme allowed');

// ---- size cap: declared Content-Length over the limit --------------------
stub(async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3]), contentLength: 9_999_999 }));
const tooBigHeader = await handleFetchGif('http://example.com/huge.gif', { maxBytes: 100 });
assert.equal(tooBigHeader.ok, false, 'oversized Content-Length rejected');
assert.match(tooBigHeader.ok ? '' : tooBigHeader.error, /limit/, 'error mentions the limit');

// ---- size cap: streaming enforcement when the header lies/omits ----------
stub(async () => fakeResponse({ bytes: new Uint8Array([1, 2, 3, 4, 5]) })); // no Content-Length
const tooBigStream = await handleFetchGif('http://example.com/sneaky.gif', { maxBytes: 2 });
assert.equal(tooBigStream.ok, false, 'oversized body rejected while streaming');
assert.match(tooBigStream.ok ? '' : tooBigStream.error, /limit/, 'stream error mentions the limit');

// ---- timeout: a hung request becomes a typed error -----------------------
stub(
  (_url, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
);
const timedOut = await handleFetchGif('http://example.com/slow.gif', { timeoutMs: 10 });
assert.equal(timedOut.ok, false, 'hung request times out');
assert.match(timedOut.ok ? '' : timedOut.error, /timed out/, 'error mentions the timeout');

globalThis.fetch = realFetch;
console.log('messages.test: OK');
