// gifuct-js wrapper + format dispatch.
//
// Bytes in, frames out — zero playback/DOM awareness. Each raw GIF frame is a
// (possibly partial) patch governed by a disposal method. We do NOT composite
// here: the raw frames are translated into the format-agnostic `FrameStep[]`
// that ./frameSource understands, and it does the single compositing pass,
// keeping a full-canvas bitmap only every KEYFRAME_INTERVAL frames.
//
// The patch we retain is gifuct's palette-indexed output rather than its RGBA
// expansion: one byte per pixel plus a ≤768-byte palette, a quarter of the RGBA
// cost, and it's what the LZW decode produced anyway. Expanding it back to RGBA
// happens per patch draw during playback (see frameSource's drawIndexed).

import { parseGIF, decompressFrames } from "gifuct-js";
import type { ParsedFrame, ParsedGif } from "gifuct-js";

import { decodeApng, isAnimatedPng } from "./decodeApng";
import { decodeAvif, isAnimatedAvif } from "./decodeAvif";
import { decodeWebP, isAnimatedWebP } from "./decodeWebP";
import {
  createFrameSource,
  keyframeCount,
  DISPOSE_BACKGROUND,
  DISPOSE_NONE,
  DISPOSE_PREVIOUS,
  type Dispose,
  type FrameStep,
} from "./frameSource";
import {
  assertDecodeBudget,
  bitmapBytes,
  normalizeDelay,
  type DecodeResult,
  type Frame,
} from "./types";

/**
 * Thrown when the bytes aren't an animated image we can control — none of the
 * format sniffers match (a static PNG/WebP/AVIF, a non-image error page, …). The
 * content script distinguishes this from genuine fetch/decode failures so it can
 * tell the user "Not an animated image" rather than a generic error.
 */
export class NotAnimatedError extends Error {
  constructor(message = "not an animated image") {
    super(message);
    this.name = "NotAnimatedError";
  }
}

/** True if the bytes start with a GIF signature ("GIF87a" / "GIF89a"). */
function isGif(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 6) return false;
  const b = new Uint8Array(bytes, 0, 6);
  return (
    b[0] === 0x47 && // G
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x38 && // 8
    (b[4] === 0x37 || b[4] === 0x39) && // 7 | 9
    b[5] === 0x61 // a
  );
}

/**
 * Bytes per pixel gifuct's LZW output costs while a decode is in flight. It
 * decompresses into `new Array(pixelCount)` — a plain JS array of small
 * integers, ~8 bytes an element in V8 — which we convert to a Uint8Array per
 * frame, but only after the whole GIF has been decompressed.
 *
 * 8 is the pessimistic reading: V8 with pointer compression (every 64-bit
 * Chrome build under ~4 GB of heap) stores a SMI-only array at 4 bytes an
 * element, so the estimate is up to 2× the real transient there. Erring high on
 * a guard that only ever refuses is deliberate; a per-engine constant would buy
 * nothing but a second thing to keep true.
 */
const DECOMPRESS_BYTES_PER_PIXEL = 8;

const GIF_DISPOSAL_RESTORE_BACKGROUND = 2;
const GIF_DISPOSAL_RESTORE_PREVIOUS = 3;

// GIF disposal methods (the GCE "disposal method" field):
//   0 unspecified / 1 do-not-dispose → leave the canvas as-is
//   2 restore-to-background          → clear the frame's rect
//   3 restore-to-previous            → revert to the canvas before this frame
// A frame with no GCE declares nothing at all, which is method 0.
const toDispose = (disposalType: number | undefined): Dispose =>
  disposalType === GIF_DISPOSAL_RESTORE_BACKGROUND
    ? DISPOSE_BACKGROUND
    : disposalType === GIF_DISPOSAL_RESTORE_PREVIOUS
      ? DISPOSE_PREVIOUS
      : DISPOSE_NONE;

/**
 * Every index a GIF's one-byte pixels can name. A colour table is allowed to be
 * shorter, and a malformed file (or one whose local table is smaller than its
 * largest index) then points past the end of it. Padding the flattened palette
 * out to the full index space makes that pixel opaque black — what gifuct's own
 * patch builder paints for the same case — without a bounds check inside the
 * per-pixel expansion loop. The padding costs at most 768 bytes per table.
 */
const PALETTE_ENTRIES = 256;

/**
 * Flatten gifuct's `[r,g,b][]` colour table into the packed triples the frame
 * source indexes. Frames of a GIF using the global colour table share one array
 * instance, so the flattened palette is shared too — a per-frame copy would cost
 * 768 bytes × frameCount for nothing.
 */
function flattenPalette(
  colorTable: ReadonlyArray<readonly [number, number, number]>,
  cache: Map<unknown, Uint8Array>,
): Uint8Array {
  const hit = cache.get(colorTable);
  if (hit) return hit;
  const flat = new Uint8Array(Math.max(colorTable.length, PALETTE_ENTRIES) * 3);
  for (let i = 0; i < colorTable.length; i++) {
    const c = colorTable[i]!;
    flat[i * 3] = c[0];
    flat[i * 3 + 1] = c[1];
    flat[i * 3 + 2] = c[2];
  }
  cache.set(colorTable, flat);
  return flat;
}

/** Translate one gifuct frame into the frame source's replayable step. */
function toStep(rf: ParsedFrame, palettes: Map<unknown, Uint8Array>): FrameStep {
  const { left, top, width, height } = rf.dims;
  return {
    // gifuct hands `pixels` back as a plain number[]; a Uint8Array of the same
    // values is 8× smaller and is what we hold for the life of the player.
    patch: {
      kind: "indexed",
      pixels: Uint8Array.from(rf.pixels),
      palette: flattenPalette(rf.colorTable, palettes),
      transparentIndex: rf.transparentIndex ?? -1,
    },
    x: left,
    y: top,
    width,
    height,
    clear: false, // GIF patches always blend over the canvas
    dispose: toDispose(rf.disposalType),
  };
}

/**
 * The GIF's repeat count, as {@link DecodeResult.repeat} counts them.
 *
 * It lives in the looping application extension, whose one sub-block is
 * `[1, count-lo, count-hi]`: count 0 means forever, count N means N repeats
 * *after* the first play (N + 1 plays in total — the reading both Gecko and
 * Blink implement, and the one `gif2webp -loop_compatibility` converts away
 * from). A GIF carrying no such extension plays through exactly once.
 *
 * Netscape's `NETSCAPE2.0` is the identifier everything writes; `ANIMEXTS1.0`
 * is the equivalent from Animation Extensions, which browsers accept and some
 * older encoders emit. gifuct keeps both as `application` entries in the raw
 * `gif.frames` (the decompressed frames hold only images).
 */
function readLoopCount(gif: ParsedGif): number {
  for (const block of gif.frames) {
    if (!("application" in block)) continue;
    const { id, blocks } = block.application;
    if (id !== "NETSCAPE2.0" && id !== "ANIMEXTS1.0") continue;
    // A truncated or unrecognised sub-block tells us nothing about the count,
    // but the extension's presence still means "repeats" — forever is what
    // every encoder that writes one without a usable count intends.
    if (blocks.length < 3 || blocks[0] !== 1) return Infinity;
    const count = blocks[1]! | (blocks[2]! << 8);
    return count === 0 ? Infinity : count;
  }
  return 0;
}

/**
 * Decode GIF bytes into a frame timeline + a frame source, plus total duration.
 *
 * Time convention: `frames[i].time` is the cumulative ms at which frame `i`
 * **ends** (end-of-frame), so `duration` equals the final frame's `time`.
 * The array is monotonically increasing by construction.
 *
 * Uses `OffscreenCanvas` + `createImageBitmap`, so it runs headless (no page
 * DOM) and is unit-testable.
 */
export async function decode(bytes: ArrayBuffer, signal?: AbortSignal): Promise<DecodeResult> {
  if (isAnimatedWebP(bytes)) return decodeWebP(bytes, signal);
  if (isAnimatedPng(bytes)) return decodeApng(bytes, signal);
  if (isAnimatedAvif(bytes)) return decodeAvif(bytes, signal);
  // No animated sniffer matched and it isn't a GIF: a static image (or not an
  // image at all). Throw a typed error rather than letting parseGIF fail opaquely
  // on non-GIF bytes, so the content script can surface "Not an animated image".
  if (!isGif(bytes)) throw new NotAnimatedError();
  const gif = parseGIF(bytes);

  const { width, height } = gif.lsd;
  // Budget check BEFORE decompressing, because decompression is the peak. What
  // we end up holding is small — one indexed byte per patch pixel plus a
  // keyframe bitmap every KEYFRAME_INTERVAL — but gifuct expands every frame's
  // pixels in one go into plain JS arrays first, and that transient dwarfs it,
  // so the peak is what the budget has to guard.
  //
  // Both figures are the sum of the frames' *patch* areas, which `parseGIF`
  // already knows: each image block carries its descriptor, so the exact area is
  // free. Costing every block at the full logical screen instead (`gif.frames`
  // holds the loop extension and comments too, so its length isn't even the
  // frame count) over-estimates by orders of magnitude for the common GIF, which
  // is small patches over a static background, and refused images that fit.
  let patchPixels = 0;
  let imageCount = 0;
  for (const block of gif.frames) {
    if (!("image" in block)) continue;
    const { width: w, height: h } = block.image.descriptor;
    patchPixels += w * h;
    imageCount++;
  }
  const retained = patchPixels + bitmapBytes(width, height) * keyframeCount(imageCount);
  assertDecodeBudget(Math.max(patchPixels * DECOMPRESS_BYTES_PER_PIXEL, retained));

  // `false` → skip gifuct's RGBA patch expansion; we keep the indexed pixels.
  const rawFrames = decompressFrames(gif, false);

  const repeat = readLoopCount(gif);

  const palettes = new Map<unknown, Uint8Array>();
  const steps: FrameStep[] = [];
  const frames: Frame[] = [];
  let elapsed = 0;
  for (const rf of rawFrames) {
    steps.push(toStep(rf, palettes));
    // `delay` is absent on frames with no Graphic Control Extension (every
    // GIF87a frame, and GIF89a frames needing neither transparency nor a
    // delay); normalizeDelay resolves that to the browser's 100 ms rather than
    // letting `undefined` turn the whole timeline into NaN.
    const delay = normalizeDelay(rf.delay);
    elapsed += delay;
    frames.push({ time: elapsed, delay });
  }

  const source = await createFrameSource({ width, height, steps, signal });
  return { frames, source, duration: elapsed, repeat };
}
