// Headless tests for the AVIF decoder (WebCodecs ImageDecoder strategy).
//
// Covers isAnimatedAvif (pure ftyp byte scanning), the "ImageDecoder
// unavailable" guard, and the decodeAvif bookkeeping — frame count, monotonic
// cumulative-time array, duration, delay clamping — against a mock ImageDecoder
// / VideoFrame. Canvas/bitmap APIs are shimmed like decode.test.ts. Real pixel
// decode needs a browser with WebCodecs (verified manually).

import assert from "node:assert/strict";

// ---- canvas shim ----------------------------------------------------------

class FakeCtx {
  clearRect() {}
  drawImage() {}
}
class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return new FakeCtx();
  }
}
const g = globalThis as Record<string, unknown>;
g.OffscreenCanvas = FakeOffscreenCanvas;
g.createImageBitmap = async () => ({ close() {} });

const { isAnimatedAvif, decodeAvif, canDecodeAvif } =
  await import("./decodeAvif.ts");

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

const still = box(
  "ftyp",
  enc.encode("avif"),
  u32(0),
  enc.encode("avif"),
  enc.encode("mif1"),
);
assert.equal(isAnimatedAvif(ab(still)), false, "still avif");

const avisMajor = box(
  "ftyp",
  enc.encode("avis"),
  u32(0),
  enc.encode("avif"),
  enc.encode("mif1"),
);
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

class FakeVideoFrame {
  displayWidth = 4;
  displayHeight = 4;
  duration: number | null;
  constructor(durationUs: number | null) {
    this.duration = durationUs;
  }
  close() {}
}
const decodedIndexes: number[] = [];
let closed = false;
class FakeImageDecoder {
  tracks = {
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

const { frames, duration } = await decodeAvif(ab(avisMajor));

assert.equal(frames.length, 3, "frame count");
assert.deepEqual(
  decodedIndexes,
  [0, 1, 2],
  "decoded every frame index in order",
);
assert.equal(frames[0]!.delay, 100, "frame 0 delay (100000µs → 100ms)");
assert.equal(frames[0]!.time, 100, "frame 0 cumulative time");
assert.equal(frames[1]!.time, 200, "frame 1 cumulative time");
assert.equal(frames[2]!.time, 300, "frame 2 cumulative time");
assert.ok(frames[2]!.time > frames[1]!.time, "time array is monotonic");
assert.equal(duration, 300, "total duration");
assert.ok(closed, "decoder closed after decode");
for (const f of frames) assert.ok(f.bitmap, "frame has a bitmap");

console.log(
  "decodeAvif.test: OK — %d frames, duration %dms",
  frames.length,
  duration,
);
