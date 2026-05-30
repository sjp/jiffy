// Headless unit test for the GIF fetch messaging contract (issue 06).
// Run: `npm test`. `fetch` is stubbed so no network is touched.

import assert from 'node:assert/strict';
import { handleFetchGif, isFetchGifRequest } from './messages.ts';

// ---- isFetchGifRequest guard --------------------------------------------
assert.equal(isFetchGifRequest({ type: 'FETCH_GIF', url: 'http://x/a.gif' }), true);
assert.equal(isFetchGifRequest({ type: 'FETCH_GIF' }), false, 'missing url');
assert.equal(isFetchGifRequest({ type: 'OTHER', url: 'x' }), false, 'wrong type');
assert.equal(isFetchGifRequest(null), false);
assert.equal(isFetchGifRequest('FETCH_GIF'), false);

const realFetch = globalThis.fetch;
const stub = (impl: () => Promise<unknown>) => {
  (globalThis as { fetch: unknown }).fetch = impl;
};

// ---- success: returns bytes ---------------------------------------------
stub(async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
}));
const okRes = await handleFetchGif('http://example.com/a.gif');
assert.equal(okRes.ok, true, 'ok response');
assert.equal(okRes.ok && okRes.data.byteLength, 3, 'byte length');

// ---- non-OK HTTP status → typed error -----------------------------------
stub(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
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

globalThis.fetch = realFetch;
console.log('messages.test: OK');
