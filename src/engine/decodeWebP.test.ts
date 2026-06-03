// Headless tests for the animated-WebP decoder.
//
// Covers isAnimatedWebP (pure RIFF/VP8X byte scanning, no canvas needed) and the
// decodeWebP bookkeeping — frame count, monotonic cumulative-time array,
// duration, and delay clamping — against a hand-built minimal 2-frame WebP.
// Canvas/bitmap APIs are shimmed like decode.test.ts; real VP8 pixel decode
// needs a browser and is verified manually.

import assert from "node:assert/strict";

// ---- canvas shim (same shape as decode.test.ts) ---------------------------

class FakeCtx {
  fillStyle = "";
  clearRect() {}
  drawImage() {}
  fillRect() {}
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
// createImageBitmap is shimmed, so the actual frame bitstream is never decoded —
// the bytes only need to parse structurally and carry a readable fourCC.
g.Blob = class {
  constructor(public parts: unknown[]) {}
};

const { isAnimatedWebP, decodeWebP } = await import("./decodeWebP.ts");

// ---- byte-builders --------------------------------------------------------

const enc = new TextEncoder();
const cat = (parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());
const u32le = (n: number): number[] => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
  (n >> 24) & 0xff,
];
const u24le = (n: number): number[] => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
];
const fourCC = (s: string): number[] => Array.from(enc.encode(s));
/** A RIFF chunk: fourCC + u32 LE size + payload (+ pad to even). */
const chunk = (cc: string, payload: number[]): number[] => {
  const out = [...fourCC(cc), ...u32le(payload.length), ...payload];
  if (payload.length & 1) out.push(0); // even-boundary padding
  return out;
};
const ab = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// VP8X payload: flags byte (anim = 0x02) + 3 reserved + (w-1) u24 + (h-1) u24.
const vp8x = (w: number, h: number, animFlag: boolean): number[] => [
  animFlag ? 0x02 : 0x00,
  0,
  0,
  0,
  ...u24le(w - 1),
  ...u24le(h - 1),
];
// ANIM payload: background colour (BGRA) + u16 loop count.
const anim = (): number[] => [0xff, 0xff, 0xff, 0xff, 0, 0];
// A frame's inner data: a single "VP8 " sub-chunk (content irrelevant — the
// decode is shimmed; makeFrameBlob only reads the leading fourCC).
const vp8FrameData = (): number[] => chunk("VP8 ", [0, 0, 0, 0]);
// ANMF payload: x/y/(w-1)/(h-1) u24, duration u24, flags byte, then frame data.
const anmf = (durationMs: number): number[] => [
  ...u24le(0), // x
  ...u24le(0), // y
  ...u24le(3), // width - 1  → 4px
  ...u24le(3), // height - 1 → 4px
  ...u24le(durationMs),
  0x00, // flags: keep canvas, alpha-blend
  ...vp8FrameData(),
];

const buildWebP = (chunks: number[][]): Uint8Array => {
  const body = cat([fourCC("WEBP"), ...chunks]);
  return cat([fourCC("RIFF"), u32le(body.length), [...body]]);
};

// ---- isAnimatedWebP -------------------------------------------------------

assert.equal(isAnimatedWebP(new ArrayBuffer(0)), false, "empty buffer");
assert.equal(isAnimatedWebP(new ArrayBuffer(20)), false, "too short (< 21)");

// Right length but not a RIFF container.
const notRiff = cat([
  fourCC("XXXX"),
  u32le(0),
  fourCC("WEBP"),
  new Array(9).fill(0),
]);
assert.equal(isAnimatedWebP(ab(notRiff)), false, "not RIFF");

// RIFF but not WEBP.
const notWebp = cat([
  fourCC("RIFF"),
  u32le(0),
  fourCC("XXXX"),
  new Array(9).fill(0),
]);
assert.equal(isAnimatedWebP(ab(notWebp)), false, "not WEBP");

// RIFF/WEBP but the first chunk isn't VP8X.
const noVp8x = buildWebP([chunk("VP8 ", new Array(12).fill(0))]);
assert.equal(isAnimatedWebP(ab(noVp8x)), false, "no VP8X chunk");

// VP8X present but the animation flag (bit 1) is clear → a still extended WebP.
const stillExtended = buildWebP([chunk("VP8X", vp8x(4, 4, false))]);
assert.equal(
  isAnimatedWebP(ab(stillExtended)),
  false,
  "VP8X without the animation flag",
);

// A full animated WebP → true.
const animated = buildWebP([
  chunk("VP8X", vp8x(4, 4, true)),
  chunk("ANIM", anim()),
  chunk("ANMF", anmf(20)),
  chunk("ANMF", anmf(100)),
]);
assert.equal(isAnimatedWebP(ab(animated)), true, "animated WebP");

// ---- decodeWebP bookkeeping -----------------------------------------------
// Frame 0 duration 10ms → clamped up to the 20ms floor; frame 1 is 100ms.
const file = buildWebP([
  chunk("VP8X", vp8x(4, 4, true)),
  chunk("ANIM", anim()),
  chunk("ANMF", anmf(10)),
  chunk("ANMF", anmf(100)),
]);

const { frames, duration, loops } = await decodeWebP(ab(file));

assert.equal(frames.length, 2, "frame count");

// ANIM loop count is 0 (infinite) → loops.
assert.equal(loops, true, "loop count 0 (infinite) → loops");

// A loop count of exactly 1 means play once → does not loop.
const playOnce = buildWebP([
  chunk("VP8X", vp8x(4, 4, true)),
  chunk("ANIM", [0xff, 0xff, 0xff, 0xff, 1, 0]), // BGRA + loop count = 1
  chunk("ANMF", anmf(10)),
  chunk("ANMF", anmf(100)),
]);
assert.equal(
  (await decodeWebP(ab(playOnce))).loops,
  false,
  "loop count 1 → plays once",
);

assert.equal(frames[0]!.delay, 20, "frame 0 delay clamped to the 20ms floor");
assert.equal(frames[1]!.delay, 100, "frame 1 delay (100ms, above floor)");

// End-of-frame cumulative convention: monotonically increasing.
assert.equal(frames[0]!.time, 20, "frame 0 cumulative time");
assert.equal(frames[1]!.time, 120, "frame 1 cumulative time");
assert.ok(frames[1]!.time > frames[0]!.time, "time array is monotonic");

assert.equal(duration, 120, "total duration == final cumulative time");

for (const f of frames) assert.ok(f.bitmap, "frame has a bitmap");

// ---- malformed input rejects ----------------------------------------------
await assert.rejects(
  () => decodeWebP(ab(cat([fourCC("RIFF"), u32le(0), fourCC("WEBP")]))),
  /missing VP8X|no ANMF/,
  "a WEBP with no frames is rejected",
);

console.log(
  "decodeWebP.test: OK — %d frames, duration %dms",
  frames.length,
  duration,
);
