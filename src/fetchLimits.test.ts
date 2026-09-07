// Headless unit tests for the shared fetch hardening. `messages.test.ts` drives
// these through a whole background transfer; this file pins the boundaries of
// the two predicates a wrong answer would either break real images (too strict)
// or open a hole (too loose).

import assert from "node:assert/strict";

import {
  assertImageContentType,
  assertReachableFromPage,
  concatBytes,
  ImageTooLargeError,
  isPrivateHost,
  readCappedChunks,
} from "./fetchLimits.ts";

// ---- isPrivateHost: what counts as "only this network can reach it" ------
for (const host of [
  "localhost",
  "app.localhost",
  "nas.local",
  "intranet", // single label — can't be a public DNS name
  "0.0.0.0",
  "10.0.0.1",
  "127.0.0.1",
  "100.64.0.1", // CGNAT
  "100.127.255.254",
  "169.254.169.254", // link-local, incl. the cloud metadata endpoint
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "[::]",
  "[::1]",
  "[fc00::1]",
  "[fd12:3456::1]",
  "[fe80::1]",
  "[::ffff:10.0.0.1]", // IPv4-mapped
  "", // a file: page has no host
]) {
  assert.equal(isPrivateHost(host), true, `${host || "<empty>"} is private`);
}

// The near misses either side of each range must stay public, or ordinary
// images stop loading.
for (const host of [
  "example.com",
  "cdn.example.co.uk",
  "localhost.example.com", // not a suffix match
  "notlocal", // has no dot, but see above — deliberately private
  "1.1.1.1",
  "9.255.255.255",
  "11.0.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "126.255.255.255",
  "128.0.0.1",
  "169.253.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "192.167.0.1",
  "192.169.0.1",
  "[2001:db8::1]",
  "[fe00::1]",
  "[fec0::1]",
]) {
  assert.equal(isPrivateHost(host), host === "notlocal", `${host} is public`);
}

// ---- assertReachableFromPage --------------------------------------------
const reach = (url: string, pageUrl?: string) => () =>
  assertReachableFromPage(new URL(url), pageUrl);

assert.throws(reach("http://10.0.0.1/a.gif", "https://example.com/"), /Refusing to fetch/);
assert.throws(reach("http://10.0.0.1/a.gif"), /Refusing to fetch/, "no sender = treat as public");
assert.throws(reach("http://10.0.0.1/a.gif", "not a url"), /Refusing to fetch/);
assert.doesNotThrow(
  reach("http://10.0.0.1/a.gif", "http://10.0.0.2/"),
  "private page, private target",
);
assert.doesNotThrow(reach("http://10.0.0.1/a.gif", "file:///home/me/x.html"), "local file page");
assert.doesNotThrow(reach("https://cdn.example.com/a.gif", "https://example.com/"));
// data: has no host to judge and carries its bytes inline.
assert.doesNotThrow(reach("data:image/gif;base64,AAAA", "https://example.com/"));

// ---- assertImageContentType ---------------------------------------------
const withType = (value: string | null) =>
  ({ headers: { get: () => value } }) as unknown as Response;

for (const value of [
  null, // no header at all
  "",
  "image/gif",
  "image/webp; charset=binary",
  "  IMAGE/PNG  ",
  "application/octet-stream",
  "binary/octet-stream",
]) {
  assert.doesNotThrow(() => assertImageContentType(withType(value)), `${value} allowed`);
}
for (const value of ["text/html; charset=utf-8", "application/json", "video/mp4", "text/plain"]) {
  assert.throws(() => assertImageContentType(withType(value)), /not an image/, `${value} refused`);
}

// ---- readCappedChunks / concatBytes -------------------------------------
const streamed = (parts: number[][]) =>
  ({
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const part of parts) c.enqueue(new Uint8Array(part));
        c.close();
      },
    }),
  }) as unknown as Response;

const collect = async (response: Response, maxBytes: number) => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readCappedChunks(response, maxBytes)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return [...concatBytes(chunks, total)];
};

assert.deepEqual(await collect(streamed([[1, 2], [3]]), 10), [1, 2, 3], "reads stream through");
await assert.rejects(
  () =>
    collect(
      streamed([
        [1, 2],
        [3, 4],
      ]),
      3,
    ),
  ImageTooLargeError,
  "the cap trips mid-stream, not after buffering",
);

// A response with no readable body falls back to arrayBuffer(), cap and all.
const buffered = (bytes: number[]) =>
  ({
    body: null,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  }) as unknown as Response;
assert.deepEqual(await collect(buffered([5, 6]), 10), [5, 6]);
await assert.rejects(() => collect(buffered([5, 6]), 1), ImageTooLargeError);

console.log("fetchLimits.test: OK");
