// Headless tests for the GIF decode + frame-source handoff.
//
// Run: `npm test`.
//
// Node has no canvas APIs, so we install the software canvas from
// ../test/fakeCanvas — enough of OffscreenCanvas / createImageBitmap / ImageData
// to composite for real. That means this test covers both the *bookkeeping*
// (frame count, monotonic cumulative-time array, duration, delay normalisation)
// and
// the actual pixels the frame source produces for a real GIF decoded by
// gifuct-js. The disposal state machine itself is pinned against the
// all-bitmap path in frameSource.test.ts.

import assert from "node:assert/strict";

import { installFakeCanvas, pixelAt, type FakeImageBitmap } from "../test/fakeCanvas.ts";
import { GIF, gifBytes } from "../test/gifFixture.ts";
import {
  assertDecodeBudget,
  computeMaxDecodeBytes,
  DecodeBudgetError,
  DEFAULT_MAX_DECODE_BYTES,
  MAX_DECODE_BYTES,
  MIN_MAX_DECODE_BYTES,
  SHORT_DELAY_MS,
  normalizeDelay,
} from "./types.ts";

installFakeCanvas();

const { decode, NotAnimatedError } = await import("./decode.ts");

// ---- assertions ----------------------------------------------------------

// The fixture (see ../test/gifFixture) is 2×1, black/white, swapped between two
// frames, each with a 10-centisecond delay and no loop extension.
const { frames, source, duration, repeat } = await decode(gifBytes());

assert.equal(frames.length, 2, "frame count");
assert.equal(source.frameCount, 2, "frame source frame count");
assert.equal(source.width, 2, "frame source width");
assert.equal(source.height, 1, "frame source height");

// No NETSCAPE2.0 application extension → the GIF plays through once.
assert.equal(repeat, 0, "GIF without a loop extension does not repeat");

// gifuct normalises delay (10cs → 100ms), which is above the short-delay rule.
assert.equal(frames[0]!.delay, 100, "frame 0 delay (ms)");
assert.equal(frames[1]!.delay, 100, "frame 1 delay (ms)");

// End-of-frame cumulative convention: monotonically increasing.
assert.equal(frames[0]!.time, 100, "frame 0 cumulative time");
assert.equal(frames[1]!.time, 200, "frame 1 cumulative time");
assert.ok(frames[1]!.time > frames[0]!.time, "time array is monotonic");

// duration == final cumulative time.
assert.equal(duration, 200, "duration");

// Pixels: the GIF is 2×1 black/white, swapped between the two frames. Frame 0
// is a keyframe (index 0 always is) and comes back directly; frame 1 has to be
// recomposited from it — the two paths must agree with the source bytes.
const black: [number, number, number, number] = [0, 0, 0, 255];
const white: [number, number, number, number] = [255, 255, 255, 255];

const frame0 = (await source.getBitmap(0)) as unknown as FakeImageBitmap;
assert.deepEqual(pixelAt(frame0, 0, 0), black, "frame 0 left pixel is black");
assert.deepEqual(pixelAt(frame0, 1, 0), white, "frame 0 right pixel is white");

const frame1 = (await source.getBitmap(1)) as unknown as FakeImageBitmap;
assert.deepEqual(pixelAt(frame1, 0, 0), white, "frame 1 left pixel is white");
assert.deepEqual(pixelAt(frame1, 1, 0), black, "frame 1 right pixel is black");

// Seeking back to a keyframe must not disturb the recomposited frame.
const frame0Again = (await source.getBitmap(0)) as unknown as FakeImageBitmap;
assert.deepEqual(pixelAt(frame0Again, 0, 0), black, "frame 0 still correct after a seek");

source.close();

// ---- the looping application extension -----------------------------------
// The extension after the GCT carries a 16-bit count: 0 is forever, N is N
// repeats *after* the first play (N + 1 plays, the reading both engines
// implement). `ANIMEXTS1.0` is the same extension under its other identifier.
/** The 2-frame fixture with `id` declaring `count` repeats. */
// prettier-ignore
const loopingGif = (id: string, count: number) => new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,       // LSD: 2×1, global colour table (2)
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // GCT: black, white
  0x21, 0xff, 0x0b,                               // app extension, block size 11
  ...[...id].map((c) => c.charCodeAt(0)),         // "NETSCAPE2.0" / "ANIMEXTS1.0"
  0x03, 0x01, count & 0xff, count >> 8, 0x00,     // sub-block: id 1, loop count, terminator
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 0: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 0
  0x02, 0x02, 0x44, 0x0a, 0x00,                   // LZW: pixels [0,1]
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 1: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 1
  0x02, 0x02, 0x0c, 0x0a, 0x00,                   // LZW: pixels [1,0]
  0x3b,                                           // trailer
]);

const decodeLooping = async (id: string, count: number) => {
  const bytes = loopingGif(id, count);
  return decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

const looping = await decodeLooping("NETSCAPE2.0", 0);
assert.equal(looping.frames.length, 2, "looping GIF still decodes 2 frames");
assert.equal(looping.repeat, Infinity, "NETSCAPE2.0 count 0 → loops forever");
looping.source.close();

// A finite count is carried through instead of being flattened to "it loops":
// the browser plays such a GIF count + 1 times and then stops.
const thrice = await decodeLooping("NETSCAPE2.0", 3);
assert.equal(thrice.repeat, 3, "NETSCAPE2.0 count 3 → three repeats");
thrice.source.close();

const netscapeOnce = await decodeLooping("NETSCAPE2.0", 1);
assert.equal(netscapeOnce.repeat, 1, "NETSCAPE2.0 count 1 → one repeat, not forever");
netscapeOnce.source.close();

const animexts = await decodeLooping("ANIMEXTS1.0", 0);
assert.equal(animexts.repeat, Infinity, "ANIMEXTS1.0 is the same extension");
animexts.source.close();

// ---- the palette covers every index a pixel byte can name ----------------
// A GIF's colour table may be shorter than the indices its pixels name (a
// malformed file, or a local table smaller than its own maximum). Padding the
// flattened palette to the full 256 entries makes such a pixel opaque black —
// what gifuct's own patch builder paints — with no bounds check in the
// per-pixel expansion loop.
{
  const decoded = await decode(gifBytes());
  const patch = decoded.source.detach!().steps[0]!.patch;
  assert.equal(patch?.kind, "indexed", "GIF frames are indexed patches");
  const { palette } = patch as Extract<typeof patch, { kind: "indexed" }>;
  assert.equal(palette.length, 256 * 3, "palette spans every index a byte holds");
  // The fixture declares two colours; everything past them is black.
  assert.deepEqual(
    Array.from(palette.subarray(6)),
    Array.from({ length: palette.length - 6 }, () => 0),
    "indices past the declared table are black",
  );
}

// ---- the browser's short-delay rule --------------------------------------
// Both engines show any frame declaring ≤10 ms for 100 ms (the historic GIF
// workaround, applied to every animated format). A missing or nonsensical delay
// lands on the same value rather than escaping as NaN.
for (const [declared, expected] of [
  [0, 100],
  [1, 100],
  [10, 100],
  [11, 11],
  [20, 20],
  [100, 100],
  [1000, 1000],
] as const) {
  assert.equal(normalizeDelay(declared), expected, `normalizeDelay(${declared})`);
}
for (const missing of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(normalizeDelay(missing), SHORT_DELAY_MS, `normalizeDelay(${String(missing)})`);
}

// ---- a GIF whose frames declare 1 centisecond ----------------------------
// gifuct hands 1 cs back as 10 ms; the browser plays it at 100 ms, so we must
// too, or the overlay races 5× ahead of the <img> it replaced.
const oneCentisecond = new Uint8Array(GIF);
oneCentisecond[23] = 0x01; // GCE frame 0 delay byte: 10cs → 1cs
oneCentisecond[46] = 0x01; // GCE frame 1 delay byte: 10cs → 1cs
const fast = await decode(oneCentisecond.buffer.slice(0) as ArrayBuffer);
assert.deepEqual(
  fast.frames.map((f) => f.delay),
  [100, 100],
  "a 1cs declared delay plays at the browser's 100ms, not a 20ms floor",
);
assert.equal(fast.duration, 200, "duration follows the normalised delays");
fast.source.close();

// ---- a GIF with no Graphic Control Extension -----------------------------
// A GCE is optional: GIF87a has none, and GIF89a encoders omit it on frames
// needing neither transparency nor a delay. gifuct then leaves `delay`,
// `disposalType` and `transparentIndex` undefined, which used to make every
// cumulative time NaN — a mounted player stuck on the last frame.
// prettier-ignore
const NO_GCE_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,       // LSD: 2×1, global colour table (2)
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // GCT: black, white
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 0 (no GCE)
  0x02, 0x02, 0x44, 0x0a, 0x00,                   // LZW: pixels [0,1]
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 1 (no GCE)
  0x02, 0x02, 0x0c, 0x0a, 0x00,                   // LZW: pixels [1,0]
  0x3b,                                           // trailer
]);

const noGce = await decode(NO_GCE_GIF.buffer.slice(0) as ArrayBuffer);
assert.equal(noGce.frames.length, 2, "GCE-less GIF decodes both frames");
assert.deepEqual(
  noGce.frames.map((f) => f.delay),
  [100, 100],
  "an absent delay becomes the browser's 100ms",
);
assert.ok(
  noGce.frames.every((f) => Number.isFinite(f.time)),
  "every cumulative time is finite",
);
assert.equal(noGce.duration, 200, "duration is positive and finite");

// The pixels still decode: an absent disposal method is method 0 (leave the
// canvas alone), and an absent transparent index means no transparency.
const noGce0 = (await noGce.source.getBitmap(0)) as unknown as FakeImageBitmap;
assert.deepEqual(pixelAt(noGce0, 0, 0), black, "GCE-less frame 0 left pixel is black");
const noGce1 = (await noGce.source.getBitmap(1)) as unknown as FakeImageBitmap;
assert.deepEqual(pixelAt(noGce1, 0, 0), white, "GCE-less frame 1 left pixel is white");
noGce.source.close();

// ---- non-animated bytes throw a typed error ------------------------------
// Bytes matching no animated sniffer and lacking a GIF signature must throw
// NotAnimatedError (not parseGIF's opaque failure) so the content script can
// say "Not an animated image" rather than a generic error.
const notAnimated = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // a PNG signature, no APNG chunks
await assert.rejects(
  () => decode(notAnimated.buffer.slice(0)),
  (err: unknown) => err instanceof NotAnimatedError,
  "non-animated bytes throw NotAnimatedError",
);

// ---- a pre-aborted signal cancels the decode -----------------------------
// The compositing loop checks the signal once per frame, so an already-aborted
// signal bails on the first frame with a standard AbortError rather than
// compositing the whole GIF.
const aborted = new AbortController();
aborted.abort();
await assert.rejects(
  () => decode(gifBytes(), aborted.signal),
  (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  "an aborted signal rejects the decode with AbortError",
);

// ---- the ceiling adapts to the machine -----------------------------------
// `navigator.deviceMemory` is Chromium-only, so the fallback has to be the
// static default; where it is available the ceiling is a share of the reported
// RAM, floored so a small machine can still play an ordinary animation and
// capped so a large one doesn't go back to promising gigabytes.
assert.equal(
  computeMaxDecodeBytes(undefined),
  DEFAULT_MAX_DECODE_BYTES,
  "no deviceMemory (Firefox) falls back to the static default",
);
assert.equal(
  computeMaxDecodeBytes(8),
  DEFAULT_MAX_DECODE_BYTES,
  "the largest deviceMemory the spec reports is capped at the static default",
);
assert.equal(
  computeMaxDecodeBytes(4),
  4 * 1024 ** 3 * 0.15,
  "a mid-range machine gets its share of RAM",
);
assert.equal(
  computeMaxDecodeBytes(0.25),
  MIN_MAX_DECODE_BYTES,
  "the smallest deviceMemory is floored, not shrunk to nothing",
);
const ceilings = [0.25, 0.5, 1, 2, 4, 8].map((gib) => computeMaxDecodeBytes(gib));
assert.deepEqual(
  ceilings,
  [...ceilings].sort((a, b) => a - b),
  "more RAM never means a smaller ceiling",
);
assert.ok(
  MAX_DECODE_BYTES >= MIN_MAX_DECODE_BYTES && MAX_DECODE_BYTES <= DEFAULT_MAX_DECODE_BYTES,
  "the resolved ceiling stays inside the floor/default band",
);

// ---- decode budget rejects an oversized image ----------------------------
// The budget is the bytes a decode will RETAIN — keyframe bitmaps plus the
// patches between them — rather than 4 bytes per canvas pixel per frame. Tests
// pass an explicit limit so they don't depend on the RAM of the machine running
// them.
const LIMIT = 1_000_000_000;
assert.throws(
  () => assertDecodeBudget(LIMIT + 1, LIMIT),
  (err: unknown) => err instanceof DecodeBudgetError,
  "an over-budget image throws DecodeBudgetError",
);
assert.doesNotThrow(() => assertDecodeBudget(LIMIT, LIMIT), "the ceiling itself passes");

// The size travels with the error so the toast can say why the image was
// refused, rather than leaving the user to guess how far over it was.
const budgetErr = (() => {
  try {
    assertDecodeBudget(1_800_000_000, LIMIT);
  } catch (err) {
    return err as DecodeBudgetError;
  }
  return undefined;
})();
assert.equal(budgetErr?.bytes, 1_800_000_000, "the error carries the estimated size");
assert.match(budgetErr!.message, /1\.8 GB/, "the message reports the size in human units");

// The estimate is built from the frames' own image descriptors, which parseGIF
// hands over without decompressing anything, so an over-budget GIF is refused
// before a single pixel is expanded.
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
/**
 * A GIF declaring `count` image blocks of `w`×`h` on a `screen`×`screen` logical
 * screen. The LZW payload is the fixture's, which decodes to two pixels, so only
 * a case that is meant to decode needs a descriptor that agrees with it — one
 * that is refused never gets that far.
 */
const gifOf = (screen: number, count: number, w: number, h: number) => {
  const head = new Uint8Array(GIF.slice(0, 19)); // header + LSD + global colour table
  head.set([...u16(screen), ...u16(screen)], 6);
  // prettier-ignore
  const frameBlock = [
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE: delay=10cs
    0x2c, 0x00, 0x00, 0x00, 0x00,                   // image descriptor, at 0,0…
    ...u16(w), ...u16(h), 0x00,                     // …sized w×h
    0x02, 0x02, 0x44, 0x0a, 0x00,                   // LZW: pixels [0,1]
  ];
  const bytes = Uint8Array.from([
    ...head,
    ...Array.from({ length: count }, () => frameBlock).flat(),
    0x3b,
  ]);
  return bytes.buffer.slice(0) as ArrayBuffer;
};

// 100 full-canvas 4000×4000 patches: 1.6 Gpx, ~12.8 GB of gifuct's LZW output.
await assert.rejects(
  () => decode(gifOf(4000, 100, 4000, 4000)),
  (err: unknown) => err instanceof DecodeBudgetError,
  "an over-budget GIF is rejected before decompression",
);

// Twice the block count over a large canvas, but as the small patches real GIFs
// are made of. Costing each block at the logical screen instead put this at
// 1.6 GB and refused it; the patches actually decompress to 400 bytes.
const patched = await decode(gifOf(1000, 200, 2, 1));
assert.equal(patched.frames.length, 200, "small patches on a large canvas are not refused");

console.log("decode.test: OK — %d frames, duration %dms", frames.length, duration);
