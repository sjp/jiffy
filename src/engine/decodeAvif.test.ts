// Headless tests for the AVIF decoder (WebCodecs ImageDecoder strategy).
//
// Covers isAnimatedAvif (pure ftyp byte scanning), the "ImageDecoder
// unavailable" guard, the decodeAvif bookkeeping — frame count, monotonic
// cumulative-time array, duration, delay normalisation, the track's loop count —
// the ISOBMFF sample-table read that keeps the timeline off the decoder, and the
// decoder-backed frame source, against a mock ImageDecoder / VideoFrame. Real
// pixel decode needs a browser with WebCodecs (verified manually).

import assert from "node:assert/strict";

import { installFakeCanvas } from "../test/fakeCanvas.ts";

installFakeCanvas();
const g = globalThis as Record<string, unknown>;

const { isAnimatedAvif, decodeAvif, canDecodeAvif } = await import("./decodeAvif.ts");
const { UnsupportedFormatError } = await import("./types.ts");

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

// A browser with no ImageDecoder (Firefox for Android, desktop Firefox before
// 133) can't play this file at all — a distinct outcome from a decode that
// failed, so the toast can name the format instead of blaming the image.
delete g.ImageDecoder;
assert.equal(canDecodeAvif(), false, "no ImageDecoder → cannot decode");
await assert.rejects(
  () => decodeAvif(ab(avisMajor)),
  (err: unknown) =>
    err instanceof UnsupportedFormatError &&
    err.format === "Animated AVIF" &&
    /ImageDecoder/.test(err.message),
  "an unsupported browser throws UnsupportedFormatError naming the format",
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
// What every decoded VideoFrame reports as its duration. `null` is what
// ImageDecoder gives for an AVIF whose samples carry no duration of their own.
let frameDurationUs: number | null = 100_000;
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
    return { image: new FakeVideoFrame(frameDurationUs), complete: true };
  }
  close() {
    closed = true;
  }
}
g.ImageDecoder = FakeImageDecoder;

assert.equal(canDecodeAvif(), true, "ImageDecoder present → can decode");

const { frames, source, duration, repeat } = await decodeAvif(ab(avisMajor));

assert.equal(frames.length, 3, "frame count");
// A track reporting no repetitionCount at all lands on the looping default.
assert.equal(repeat, Infinity, "no declared loop count → repeats forever");
// With no container timing to read, the timeline pass visits every frame...
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

// ---- the loop count comes from the track ----------------------------------
// `ImageTrack.repetitionCount` counts repetitions the way DecodeResult does — 0
// plays once, N repeats N times, Infinity loops forever — so it passes straight
// through, and a one-shot AVIF starts with looping off like a one-shot GIF.

{
  class OnceDecoder extends FakeImageDecoder {
    override tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: 3, animated: true, repetitionCount: 0 },
    };
  }
  g.ImageDecoder = OnceDecoder;
  const once = await decodeAvif(ab(avisMajor));
  assert.equal(once.repeat, 0, "repetitionCount 0 → plays once");
  once.source.close();

  class TwiceDecoder extends FakeImageDecoder {
    override tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: 3, animated: true, repetitionCount: 2 },
    };
  }
  g.ImageDecoder = TwiceDecoder;
  const twice = await decodeAvif(ab(avisMajor));
  assert.equal(twice.repeat, 2, "a finite repetitionCount passes through");
  twice.source.close();

  class ForeverDecoder extends FakeImageDecoder {
    override tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: 3, animated: true, repetitionCount: Infinity },
    };
  }
  g.ImageDecoder = ForeverDecoder;
  const forever = await decodeAvif(ab(avisMajor));
  assert.equal(forever.repeat, Infinity, "repetitionCount Infinity → loops forever");
  forever.source.close();

  g.ImageDecoder = FakeImageDecoder;
}

// ---- the timeline is read from the container's sample table ---------------
// ImageDecoder only reports a duration on a DECODED frame, so asking it for the
// timeline means decoding the whole sequence before anything is on screen. The
// ISOBMFF sample table already holds it: `stts` is a run-length list of sample
// durations in the timescale `mdhd` declares.

/** An `mdhd` box (version 0) declaring the media timescale. */
const mdhd = (timescale: number): Uint8Array =>
  box(
    "mdhd",
    u32(0), // version + flags
    u32(0), // creation time
    u32(0), // modification time
    u32(timescale),
    u32(0), // duration
    u32(0), // language + pre_defined
  );

/** An `stts` box from `[sample count, sample delta]` runs. */
const stts = (runs: Array<[number, number]>): Uint8Array =>
  box(
    "stts",
    u32(0), // version + flags
    u32(runs.length),
    ...runs.flatMap(([samples, delta]) => [u32(samples), u32(delta)]),
  );

/** An animated AVIF whose movie box carries nothing but that timing. */
const timedAvif = (timescale: number, runs: Array<[number, number]>): ArrayBuffer =>
  ab(
    cat([
      avisMajor,
      box("moov", box("trak", box("mdia", mdhd(timescale), box("minf", box("stbl", stts(runs)))))),
    ]),
  );

decodedIndexes.length = 0;
{
  const timed = await decodeAvif(
    timedAvif(1000, [
      [1, 1000],
      [2, 500],
    ]),
  );
  // Frame 0 is still decoded — nothing else reports the sequence's dimensions.
  assert.deepEqual(decodedIndexes, [0], "declared timing costs one decode, not the sequence");
  assert.deepEqual(
    timed.frames.map((f) => f.delay),
    [1000, 500, 500],
    "the run-length table expands to one delay per frame",
  );
  assert.deepEqual(
    timed.frames.map((f) => f.time),
    [1000, 1500, 2000],
    "cumulative times follow",
  );
  assert.equal(timed.duration, 2000, "duration from the container");
  assert.equal(liveFrames, 0, "the dimension probe retains no frame");
  timed.source.close();
}

// A timescale that doesn't divide into whole milliseconds (30000/1001 — NTSC
// rates are common in AVIF sequences) keeps its fraction rather than drifting.
decodedIndexes.length = 0;
{
  const ntsc = await decodeAvif(timedAvif(30000, [[3, 1001]]));
  assert.ok(
    Math.abs(ntsc.frames[0]!.delay - 33.3667) < 0.001,
    "a fractional frame delay is kept as it is",
  );
  ntsc.source.close();
}

// A sample count that disagrees with the decoder means we read the wrong track,
// or misread it — fall back to the decode pass rather than trust it.
decodedIndexes.length = 0;
{
  const mismatched = await decodeAvif(timedAvif(1000, [[5, 40]]));
  assert.deepEqual(decodedIndexes, [0, 1, 2], "a sample-count mismatch falls back to decoding");
  assert.deepEqual(
    mismatched.frames.map((f) => f.delay),
    [100, 100, 100],
    "the fallback times the frames by their decoded durations",
  );
  mismatched.source.close();
}

// ---- the short-delay rule reaches both timing paths ------------------------
// AVIF is the one format whose delays can come from two places, so both have to
// go through normalizeDelay or the same file plays at two different speeds
// depending on whether its sample table could be read.
decodedIndexes.length = 0;
{
  // 5/1000 s = 5 ms, declared by the container.
  const brisk = await decodeAvif(timedAvif(1000, [[3, 5]]));
  assert.deepEqual(decodedIndexes, [0], "still read from the container");
  assert.deepEqual(
    brisk.frames.map((f) => f.delay),
    [100, 100, 100],
    "a container delay of 5ms plays at the browser's 100ms",
  );
  assert.equal(brisk.duration, 300, "duration follows the normalised delays");
  brisk.source.close();
}

// The same, from the decode pass: no container timing, and the decoder reports
// a 5 ms duration per frame.
decodedIndexes.length = 0;
frameDurationUs = 5_000;
{
  const brisk = await decodeAvif(ab(avisMajor));
  assert.deepEqual(decodedIndexes, [0, 1, 2], "no container timing → the decode pass");
  assert.deepEqual(
    brisk.frames.map((f) => f.delay),
    [100, 100, 100],
    "a decoder-reported 5ms plays at the browser's 100ms too",
  );
  brisk.source.close();
}

// A sequence whose samples declare no duration at all: WebCodecs reports null,
// which must land on the same 100 ms rather than escaping as NaN into the
// cumulative times.
decodedIndexes.length = 0;
frameDurationUs = null;
{
  const untimed = await decodeAvif(ab(avisMajor));
  assert.deepEqual(
    untimed.frames.map((f) => f.delay),
    [100, 100, 100],
    "an absent duration becomes the browser's 100ms",
  );
  assert.ok(
    untimed.frames.every((f) => Number.isFinite(f.time)),
    "every cumulative time is finite",
  );
  assert.equal(untimed.duration, 300, "duration is positive and finite");
  untimed.source.close();
}
frameDurationUs = 100_000;

console.log("decodeAvif.test: OK — %d frames, duration %dms", frames.length, duration);
