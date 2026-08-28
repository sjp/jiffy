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
import type { ParsedFrame } from "gifuct-js";

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
  MIN_DELAY_MS,
  assertDecodeBudget,
  bitmapBytes,
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
 * Delay clamp. GIF delays are unreliable — `0`/`1` centiseconds are
 * common and browsers historically clamp to a floor — so we clamp ourselves so
 * the timeline matches user expectation. gifuct-js already normalises `delay`
 * to milliseconds, so `toMs` is the identity here. Floor is shared (engine/types).
 */
const clampDelay = (ms: number): number => Math.max(ms, MIN_DELAY_MS);

// GIF disposal methods (the GCE "disposal method" field):
//   0 unspecified / 1 do-not-dispose → leave the canvas as-is
//   2 restore-to-background          → clear the frame's rect
//   3 restore-to-previous            → revert to the canvas before this frame
/**
 * Bytes per pixel gifuct's LZW output costs while a decode is in flight. It
 * decompresses into `new Array(pixelCount)` — a plain JS array of small
 * integers, ~8 bytes an element in V8 — which we convert to a Uint8Array per
 * frame, but only after the whole GIF has been decompressed.
 */
const DECOMPRESS_BYTES_PER_PIXEL = 8;

const GIF_DISPOSAL_RESTORE_BACKGROUND = 2;
const GIF_DISPOSAL_RESTORE_PREVIOUS = 3;

const toDispose = (disposalType: number): Dispose =>
  disposalType === GIF_DISPOSAL_RESTORE_BACKGROUND
    ? DISPOSE_BACKGROUND
    : disposalType === GIF_DISPOSAL_RESTORE_PREVIOUS
      ? DISPOSE_PREVIOUS
      : DISPOSE_NONE;

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
  const flat = new Uint8Array(colorTable.length * 3);
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
  // we end up holding is small — one indexed byte per pixel per frame (worst
  // case: a full-canvas patch every frame) plus a keyframe bitmap every
  // KEYFRAME_INTERVAL — but gifuct expands the whole GIF's pixels in one go into
  // plain JS arrays first, and that transient dwarfs it, so the peak is what the
  // budget has to guard. `gif.frames` also holds non-image blocks (the loop
  // extension, comments), so its length is an upper bound on the frame count —
  // the safe direction for a guard.
  const rawCount = gif.frames.length;
  const pixels = width * height * rawCount;
  const retained = pixels + bitmapBytes(width, height) * keyframeCount(rawCount);
  assertDecodeBudget(Math.max(pixels * DECOMPRESS_BYTES_PER_PIXEL, retained));

  // `false` → skip gifuct's RGBA patch expansion; we keep the indexed pixels.
  const rawFrames = decompressFrames(gif, false);

  // Loop setting from the NETSCAPE2.0 application extension. Its presence means
  // the GIF repeats (count 0 = infinite, count N = N repeats); a GIF without it
  // plays through once. gifuct keeps the extension as an `application` entry in
  // the raw `gif.frames` (the decompressed `rawFrames` above hold only images).
  const loops = (gif.frames as ReadonlyArray<{ application?: { id?: string } }>).some(
    (f) => f.application?.id === "NETSCAPE2.0",
  );

  const palettes = new Map<unknown, Uint8Array>();
  const steps: FrameStep[] = [];
  const frames: Frame[] = [];
  let elapsed = 0;
  for (const rf of rawFrames) {
    steps.push(toStep(rf, palettes));
    const delay = clampDelay(rf.delay);
    elapsed += delay;
    frames.push({ time: elapsed, delay });
  }

  const source = await createFrameSource({ width, height, steps, signal });
  return { frames, source, duration: elapsed, loops };
}
