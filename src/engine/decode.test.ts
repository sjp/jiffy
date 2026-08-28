// Headless tests for the GIF decode + frame-source handoff.
//
// Run: `npm test`.
//
// Node has no canvas APIs, so we install the software canvas from
// ../test/fakeCanvas — enough of OffscreenCanvas / createImageBitmap / ImageData
// to composite for real. That means this test covers both the *bookkeeping*
// (frame count, monotonic cumulative-time array, duration, delay clamping) and
// the actual pixels the frame source produces for a real GIF decoded by
// gifuct-js. The disposal state machine itself is pinned against the
// all-bitmap path in frameSource.test.ts.

import assert from "node:assert/strict";

import { installFakeCanvas, pixelAt, type FakeImageBitmap } from "../test/fakeCanvas.ts";
import { assertDecodeBudget, DecodeBudgetError, MAX_DECODE_BYTES } from "./types.ts";

installFakeCanvas();

const { decode, NotAnimatedError } = await import("./decode.ts");

// ---- a real, hand-built 2-frame GIF --------------------------------------
// 2×1, 2-colour (black/white). Frame 0 = [black, white], frame 1 = [white,
// black]. Each frame's GCE delay is 10 centiseconds (gifuct normalises → 100ms).
// prettier-ignore
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,       // LSD: 2×1, global colour table (2)
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // GCT: black, white
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 0: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 0
  0x02, 0x02, 0x44, 0x0a, 0x00,                   // LZW: pixels [0,1]
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 1: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 1
  0x02, 0x02, 0x0c, 0x0a, 0x00,                   // LZW: pixels [1,0]
  0x3b,                                           // trailer
]);

// ---- assertions ----------------------------------------------------------

const { frames, source, duration, loops } = await decode(
  GIF.buffer.slice(GIF.byteOffset, GIF.byteOffset + GIF.byteLength),
);

assert.equal(frames.length, 2, "frame count");
assert.equal(source.frameCount, 2, "frame source frame count");
assert.equal(source.width, 2, "frame source width");
assert.equal(source.height, 1, "frame source height");

// No NETSCAPE2.0 application extension → the GIF plays through once.
assert.equal(loops, false, "GIF without a loop extension does not loop");

// gifuct normalises delay (10cs → 100ms); clamp leaves it ≥ 20ms.
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

// ---- a looping GIF: same frames + a NETSCAPE2.0 loop extension -----------
// The application extension after the GCT marks the GIF as repeating (count 0 =
// infinite), so decode should report loops = true.
// prettier-ignore
const LOOPING_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,       // LSD: 2×1, global colour table (2)
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // GCT: black, white
  0x21, 0xff, 0x0b,                               // app extension, block size 11
  0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, // "NETSCAPE2.0"
  0x03, 0x01, 0x00, 0x00, 0x00,                   // sub-block: id 1, loop count 0, terminator
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 0: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 0
  0x02, 0x02, 0x44, 0x0a, 0x00,                   // LZW: pixels [0,1]
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 1: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 1
  0x02, 0x02, 0x0c, 0x0a, 0x00,                   // LZW: pixels [1,0]
  0x3b,                                           // trailer
]);

const looping = await decode(
  LOOPING_GIF.buffer.slice(LOOPING_GIF.byteOffset, LOOPING_GIF.byteOffset + LOOPING_GIF.byteLength),
);
assert.equal(looping.frames.length, 2, "looping GIF still decodes 2 frames");
assert.equal(looping.loops, true, "GIF with NETSCAPE2.0 extension loops");
looping.source.close();

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
  () => decode(GIF.buffer.slice(GIF.byteOffset, GIF.byteOffset + GIF.byteLength), aborted.signal),
  (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  "an aborted signal rejects the decode with AbortError",
);

// ---- decode budget rejects an oversized image ----------------------------
// The budget is now the bytes a decode will RETAIN — keyframe bitmaps plus the
// patches between them — rather than 4 bytes per canvas pixel per frame.
assert.throws(
  () => assertDecodeBudget(MAX_DECODE_BYTES + 1),
  (err: unknown) => err instanceof DecodeBudgetError,
  "an over-budget image throws DecodeBudgetError",
);
assert.doesNotThrow(() => assertDecodeBudget(MAX_DECODE_BYTES), "the ceiling itself passes");

// A GIF over the ceiling is rejected before a single pixel is decompressed: the
// check runs on `gif.lsd` and the raw frame count, ahead of decompressFrames.
// 4000×4000 × 100 frames would need 12.8 GB just to hold gifuct's LZW output.
const huge = new Uint8Array(GIF);
huge.set([0xa0, 0x0f, 0xa0, 0x0f], 6); // logical screen size → 4000×4000
// prettier-ignore
const frameBlock = [
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x44, 0x0a, 0x00,
];
const manyFrames = Uint8Array.from([
  ...huge.slice(0, 19), // header + LSD + global colour table
  ...Array.from({ length: 100 }, () => frameBlock).flat(),
  0x3b,
]);
await assert.rejects(
  () => decode(manyFrames.buffer.slice(0) as ArrayBuffer),
  (err: unknown) => err instanceof DecodeBudgetError,
  "an over-budget GIF is rejected before decompression",
);

console.log("decode.test: OK — %d frames, duration %dms", frames.length, duration);
