// Headless tests for the APNG decoder.
//
// Covers isAnimatedPng (pure byte scanning, no canvas needed) and the
// decodeApng bookkeeping — frame count, monotonic cumulative-time array,
// duration, delay clamping — using a hand-built minimal 2-frame APNG.
//
// Canvas/bitmap APIs are shimmed exactly like decode.test.ts; pixel
// correctness requires a real browser and is verified manually.

import assert from "node:assert/strict";

// ---- minimal canvas shim (same as decode.test.ts) -------------------------

class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c ?? 1;
    }
  }
}

class FakeCtx {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  clearRect() {}
  drawImage() {}
  putImageData() {}
  getImageData() {
    return new FakeImageData(this.w, this.h);
  }
  createImageData(w: number, h: number) {
    return new FakeImageData(w, h);
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return new FakeCtx(this.width, this.height);
  }
}

const g = globalThis as Record<string, unknown>;
g.ImageData = FakeImageData;
g.OffscreenCanvas = FakeOffscreenCanvas;
g.createImageBitmap = async () => ({ close() {} });

const { isAnimatedPng, decodeApng } = await import("./decodeApng.ts");

// ---- byte-array helpers ---------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// 1×1 RGBA (color type 6), 8-bit, no interlace — covers palette chunks too
const IHDR_1x1 = [
  0x00,
  0x00,
  0x00,
  0x0d, // chunk length = 13
  0x49,
  0x48,
  0x44,
  0x52, // "IHDR"
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // width=1, height=1
  0x08,
  0x06,
  0x00,
  0x00,
  0x00, // 8-bit RGBA, deflate, no filter, no interlace
  0x00,
  0x00,
  0x00,
  0x00, // CRC (parser does not validate)
];
// acTL with configurable num_frames
const actl = (n: number) => [
  0x00,
  0x00,
  0x00,
  0x08, // length = 8
  0x61,
  0x63,
  0x54,
  0x4c, // "acTL"
  (n >> 24) & 0xff,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff, // num_frames
  0x00,
  0x00,
  0x00,
  0x00, // num_plays = 0
  0x00,
  0x00,
  0x00,
  0x00, // CRC (fake)
];
const IDAT_1 = [
  0x00,
  0x00,
  0x00,
  0x01, // length = 1
  0x49,
  0x44,
  0x41,
  0x54, // "IDAT"
  0x00, // 1 byte of fake pixel data
  0x00,
  0x00,
  0x00,
  0x00, // CRC (fake)
];

// ---- isAnimatedPng --------------------------------------------------------

// Too short
assert.equal(isAnimatedPng(new ArrayBuffer(0)), false, "empty buffer");
assert.equal(isAnimatedPng(new Uint8Array([0x89]).buffer), false, "too short");

// Non-PNG signature
assert.equal(isAnimatedPng(new Uint8Array(16).buffer), false, "non-PNG");
const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
assert.equal(isAnimatedPng(gifBytes.buffer), false, "GIF mistaken for PNG");

// Static PNG: has IDAT before acTL → false
const staticPng = new Uint8Array([...PNG_SIG, ...IHDR_1x1, ...IDAT_1]);
assert.equal(
  isAnimatedPng(staticPng.buffer),
  false,
  "static PNG (IDAT before acTL)",
);

// APNG with num_frames=1 → false (single frame, nothing to control)
const apng1 = new Uint8Array([...PNG_SIG, ...IHDR_1x1, ...actl(1)]);
assert.equal(isAnimatedPng(apng1.buffer), false, "APNG num_frames=1");

// APNG with num_frames=2 → true
const apng2 = new Uint8Array([...PNG_SIG, ...IHDR_1x1, ...actl(2)]);
assert.equal(isAnimatedPng(apng2.buffer), true, "APNG num_frames=2");

// ---- decodeApng bookkeeping -----------------------------------------------
// Hand-built 2-frame APNG: 1×1 RGBA canvas, first fcTL before IDAT.
//   Frame 0: delay_num=5, delay_den=100 → 50ms  (clamp: max(50,20)=50ms)
//   Frame 1: delay_num=10, delay_den=100 → 100ms (clamp: max(100,20)=100ms)

// prettier-ignore
const APNG = new Uint8Array([
  // PNG signature
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  // IHDR: 1×1, 8-bit RGBA
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // acTL: num_frames=2, num_plays=0
  0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4C,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  // fcTL: seq=0, 1×1 at (0,0), delay 5/100 s = 50ms, dispose=0, blend=0
  0x00, 0x00, 0x00, 0x1A, 0x66, 0x63, 0x54, 0x4C,
  0x00, 0x00, 0x00, 0x00,                         // seq=0
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // w=1, h=1
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // x=0, y=0
  0x00, 0x05, 0x00, 0x64,                         // delay_num=5, delay_den=100
  0x00, 0x00,                                     // dispose=0, blend=0
  0x00, 0x00, 0x00, 0x00,
  // IDAT: 1 byte of fake data (frame 0 pixel data; createImageBitmap shimmed)
  0x00, 0x00, 0x00, 0x01, 0x49, 0x44, 0x41, 0x54,
  0x00, 0x00, 0x00, 0x00, 0x00,
  // fcTL: seq=1, 1×1 at (0,0), delay 10/100 s = 100ms, dispose=0, blend=0
  0x00, 0x00, 0x00, 0x1A, 0x66, 0x63, 0x54, 0x4C,
  0x00, 0x00, 0x00, 0x01,                         // seq=1
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x0A, 0x00, 0x64,                         // delay_num=10, delay_den=100
  0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  // fdAT: seq=2, 1 byte of fake data
  0x00, 0x00, 0x00, 0x05, 0x66, 0x64, 0x41, 0x54,
  0x00, 0x00, 0x00, 0x02,                         // seq=2
  0x00, 0x00, 0x00, 0x00, 0x00,
  // IEND
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0x00, 0x00, 0x00, 0x00,
]);

const { frames, duration, loops } = await decodeApng(
  APNG.buffer.slice(APNG.byteOffset, APNG.byteOffset + APNG.byteLength),
);

assert.equal(frames.length, 2, "frame count");

// acTL num_plays is 0 (infinite) → loops.
assert.equal(loops, true, "num_plays 0 (infinite) → loops");

assert.equal(
  frames[0]!.delay,
  50,
  "frame 0 delay (5/100 s → 50ms, above 20ms floor)",
);
assert.equal(frames[1]!.delay, 100, "frame 1 delay (10/100 s → 100ms)");

// End-of-frame cumulative convention: monotonically increasing.
assert.equal(frames[0]!.time, 50, "frame 0 cumulative time");
assert.equal(frames[1]!.time, 150, "frame 1 cumulative time");
assert.ok(frames[1]!.time > frames[0]!.time, "time array is monotonic");

assert.equal(duration, 150, "total duration");

for (const f of frames) assert.ok(f.bitmap, "frame has a bitmap");

console.log(
  "decodeApng.test: OK — %d frames, duration %dms",
  frames.length,
  duration,
);
