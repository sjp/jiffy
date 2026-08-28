// Headless tests for the AVIF decoder (WebCodecs ImageDecoder strategy).
//
// Covers isAnimatedAvif (pure ftyp byte scanning), the "ImageDecoder
// unavailable" guard, the decodeAvif bookkeeping — frame count, monotonic
// cumulative-time array, duration, delay clamping — and the decoder-backed
// frame source, against a mock ImageDecoder / VideoFrame. Real pixel decode
// needs a browser with WebCodecs (verified manually).

import assert from "node:assert/strict";

import { installFakeCanvas } from "../test/fakeCanvas.ts";

installFakeCanvas();
const g = globalThis as Record<string, unknown>;

const { isAnimatedAvif, decodeAvif, canDecodeAvif } = await import("./decodeAvif.ts");

// ---- ftyp byte-builder ----------------------------------------------------

const enc = new TextEncoder();
const cat = (parts: Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32 = (n: number): Uint8Array => {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n, false);
  return a;
};
const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const payload = cat(parts);
  return cat([u32(payload.length + 8), enc.encode(type), payload]);
};
const ab = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// ---- isAnimatedAvif --------------------------------------------------------

assert.equal(isAnimatedAvif(new ArrayBuffer(0)), false, "empty buffer");
assert.equal(isAnimatedAvif(new ArrayBuffer(8)), false, "too short");
assert.equal(isAnimatedAvif(ab(box("moov", u32(0), u32(0)))), false, "no ftyp");

const still = box("ftyp", enc.encode("avif"), u32(0), enc.encode("avif"), enc.encode("mif1"));
assert.equal(isAnimatedAvif(ab(still)), false, "still avif");

const avisMajor = box("ftyp", enc.encode("avis"), u32(0), enc.encode("avif"), enc.encode("mif1"));
assert.equal(isAnimatedAvif(ab(avisMajor)), true, "avis major brand");

const avisCompat = box(
  "ftyp",
  enc.encode("avif"),
  u32(0),
  enc.encode("avif"),
  enc.encode("avis"),
  enc.encode("miaf"),
);
assert.equal(isAnimatedAvif(ab(avisCompat)), true, "avis compatible brand");

// ---- ImageDecoder unavailable → throws ------------------------------------

delete g.ImageDecoder;
assert.equal(canDecodeAvif(), false, "no ImageDecoder → cannot decode");
await assert.rejects(
  () => decodeAvif(ab(avisMajor)),
  /ImageDecoder/,
  "throws when ImageDecoder unavailable",
);

// ---- decodeAvif bookkeeping (mock ImageDecoder) ---------------------------
// 3 frames, each duration 100000µs = 100ms → cumulative 100/200/300.

let liveFrames = 0;
class FakeVideoFrame {
  displayWidth = 4;
  displayHeight = 4;
  duration: number | null;
  constructor(durationUs: number | null) {
    this.duration = durationUs;
    liveFrames++;
  }
  close() {
    liveFrames--;
  }
}
const decodedIndexes: number[] = [];
let closed = false;
class FakeImageDecoder {
  tracks: {
    ready: Promise<void>;
    selectedTrack: { frameCount: number; animated: boolean } | null;
  } = {
    ready: Promise.resolve(),
    selectedTrack: { frameCount: 3, animated: true },
  };
  constructor(_init: unknown) {}
  async decode({ frameIndex }: { frameIndex: number }) {
    decodedIndexes.push(frameIndex);
    return { image: new FakeVideoFrame(100_000), complete: true };
  }
  close() {
    closed = true;
  }
}
g.ImageDecoder = FakeImageDecoder;

assert.equal(canDecodeAvif(), true, "ImageDecoder present → can decode");

const { frames, source, duration, loops } = await decodeAvif(ab(avisMajor));

assert.equal(frames.length, 3, "frame count");
// ImageDecoder doesn't expose loop count, so AVIF defaults to looping.
assert.equal(loops, true, "AVIF defaults to looping (loop count unavailable)");
// The timeline pass has to visit every frame to read its duration...
assert.deepEqual(decodedIndexes, [0, 1, 2], "decoded every frame index in order");
// ...but it retains none of them: each VideoFrame is closed as soon as its
// duration has been read, which is the whole point of the lazy source.
assert.equal(liveFrames, 0, "the timeline pass retains no decoded frames");
assert.equal(frames[0]!.delay, 100, "frame 0 delay (100000µs → 100ms)");
assert.equal(frames[0]!.time, 100, "frame 0 cumulative time");
assert.equal(frames[1]!.time, 200, "frame 1 cumulative time");
assert.equal(frames[2]!.time, 300, "frame 2 cumulative time");
assert.ok(frames[2]!.time > frames[1]!.time, "time array is monotonic");
assert.equal(duration, 300, "total duration");
assert.equal(source.frameCount, 3, "frame source frame count");
assert.equal(source.width, 4, "frame source width from the first decoded frame");
assert.equal(source.height, 4, "frame source height from the first decoded frame");

// ---- the frame source re-decodes by index --------------------------------
// AVIF frames are inter-coded, so they can't be replayed from patches; the
// source keeps the decoder alive and asks it again, caching recent results.
assert.ok(!closed, "the decoder stays open for the frame source");

decodedIndexes.length = 0;
assert.ok(await source.getBitmap(2), "frame 2 decoded on demand");
assert.deepEqual(decodedIndexes, [2], "asked the decoder for exactly that frame");

// A second request for a cached frame is answered synchronously, without going
// back to the decoder.
assert.ok(!(source.getBitmap(2) instanceof Promise), "a cached frame is synchronous");
assert.deepEqual(decodedIndexes, [2], "a cache hit doesn't re-decode");

// Out-of-range indices clamp.
decodedIndexes.length = 0;
assert.ok(await source.getBitmap(99), "an out-of-range index clamps to the last frame");
assert.deepEqual(decodedIndexes, [], "clamping landed on the cached last frame");

source.close();
assert.ok(closed, "close() closes the decoder");
await assert.rejects(
  async () => source.getBitmap(0),
  /closed/,
  "a closed source refuses to decode",
);

// ---- a pre-aborted signal cancels the decode -----------------------------
const abortedAvif = new AbortController();
abortedAvif.abort();
await assert.rejects(
  () => decodeAvif(ab(avisMajor), abortedAvif.signal),
  (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  "an aborted signal rejects the AVIF decode with AbortError",
);

// ---- a failed decode closes the decoder ---------------------------------
// Nothing takes ownership when we never reach the frame source, so decodeAvif
// must close the decoder itself rather than leaking it.
closed = false;
class NoTrackDecoder extends FakeImageDecoder {
  override tracks = { ready: Promise.resolve(), selectedTrack: null };
}
g.ImageDecoder = NoTrackDecoder;
await assert.rejects(() => decodeAvif(ab(avisMajor)), /no image track/, "no track rejects");
assert.ok(closed, "a failed decode closes the decoder");
g.ImageDecoder = FakeImageDecoder;

console.log("decodeAvif.test: OK — %d frames, duration %dms", frames.length, duration);
