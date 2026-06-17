// gifuct-js wrapper + precompute to full-canvas bitmaps.
//
// Bytes in, frames out — zero playback/DOM awareness. Each raw GIF frame is a
// (possibly partial) patch governed by a disposal method; we composite every
// frame ONCE, up front, into a full-canvas ImageBitmap and record a cumulative
// time array. That precompute is what makes step *and* seek O(1) at playback
// time instead of replaying from a keyframe.
//
// Memory tradeoff (known, deferred): N frames → N full-resolution bitmaps held
// in memory. Fine for typical GIFs.

import { parseGIF, decompressFrames } from "gifuct-js";
import type { FrameDims } from "gifuct-js";
import {
  MIN_DELAY_MS,
  assertDecodeBudget,
  throwIfAborted,
  type DecodeResult,
  type Frame,
} from "./types";
import { decodeWebP, isAnimatedWebP } from "./decodeWebP";
import { decodeApng, isAnimatedPng } from "./decodeApng";
import { decodeAvif, isAnimatedAvif } from "./decodeAvif";

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
 * Firefox content scripts run in a sandbox realm while the `OffscreenCanvas`
 * pixel buffer lives in the page realm, exposed through an Xray wrapper.
 * `.wrappedJSObject` returns the underlying page-realm object; on Chrome / Node
 * (no Xray) the value is returned unchanged.
 */
const unwrapXray = <T>(value: T): T =>
  (value as { wrappedJSObject?: T }).wrappedJSObject ?? value;

/**
 * Copy gifuct's `patch` bytes into the canvas-backed ImageData.
 *
 * On Chrome / Node a plain `.set` works. In a Firefox content script the patch
 * is a sandbox-realm typed array while the canvas buffer is a page-realm one,
 * and `TypedArray.set(src)` refuses to read a source from another realm
 * ("Permission denied to access object"). `cloneInto` can't help here because
 * the sandbox `globalThis` isn't the page realm, so it clones into the wrong
 * realm. The reliable bridge is an element-wise copy through unwrapped views:
 * it only ever touches numeric indices, never an object across the boundary.
 *
 * The realm boundary is a property of the environment, not of any individual
 * frame, so we probe `.set` once and cache the result — otherwise Firefox would
 * throw+catch on *every* patch of *every* GIF (the fast path never taken). Once
 * we know `.set` is blocked, go straight to the element-wise copy.
 */
let setWorksAcrossRealm: boolean | undefined;

function copyPatchInto(
  dest: Uint8ClampedArray,
  patch: Uint8ClampedArray,
): void {
  if (setWorksAcrossRealm !== false) {
    try {
      dest.set(patch);
      setWorksAcrossRealm = true;
      return;
    } catch {
      setWorksAcrossRealm = false;
    }
  }
  const d = unwrapXray(dest);
  const s = unwrapXray(patch);
  for (let i = 0; i < s.length; i++) d[i] = s[i]!;
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
const DISPOSAL_RESTORE_BACKGROUND = 2;
const DISPOSAL_RESTORE_PREVIOUS = 3;

/**
 * Decode GIF bytes into pre-composited full-canvas frames + total duration.
 *
 * Time convention: `frames[i].time` is the cumulative ms at which frame `i`
 * **ends** (end-of-frame), so `duration` equals the final frame's `time`.
 * The array is monotonically increasing by construction.
 *
 * Uses `OffscreenCanvas` + `createImageBitmap`, so it runs headless (no page
 * DOM) and is unit-testable.
 */
export async function decode(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<DecodeResult> {
  if (isAnimatedWebP(bytes)) return decodeWebP(bytes, signal);
  if (isAnimatedPng(bytes)) return decodeApng(bytes, signal);
  if (isAnimatedAvif(bytes)) return decodeAvif(bytes, signal);
  // No animated sniffer matched and it isn't a GIF: a static image (or not an
  // image at all). Throw a typed error rather than letting parseGIF fail opaquely
  // on non-GIF bytes, so the content script can surface "Not an animated image".
  if (!isGif(bytes)) throw new NotAnimatedError();
  const gif = parseGIF(bytes);
  // `true` → build per-frame RGBA `patch` arrays for us.
  const rawFrames = decompressFrames(gif, true);

  // Loop setting from the NETSCAPE2.0 application extension. Its presence means
  // the GIF repeats (count 0 = infinite, count N = N repeats); a GIF without it
  // plays through once. gifuct keeps the extension as an `application` entry in
  // the raw `gif.frames` (the decompressed `rawFrames` above hold only images).
  const loops = (
    gif.frames as ReadonlyArray<{ application?: { id?: string } }>
  ).some((f) => f.application?.id === "NETSCAPE2.0");

  const { width, height } = gif.lsd;
  // Reject an image whose pre-composited frames would blow the memory budget,
  // before we start building bitmaps.
  assertDecodeBudget(width, height, rawFrames.length);

  // Work canvas at the GIF's native (logical screen) resolution. The snapshots
  // we take from it are full-canvas at native resolution, ready to blit.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("decode: failed to acquire 2D context");

  const frames: Frame[] = [];
  let elapsed = 0;

  // Disposal bookkeeping carried from the PREVIOUS frame — disposal is applied
  // before drawing the *next* patch (off-by-one here is the classic source of
  // garbage frames).
  let prevDisposalType = 0;
  let prevDims: FrameDims | null = null;
  // Canvas snapshot saved before a restore-to-previous frame is drawn.
  let restoreSnapshot: ImageData | null = null;

  for (const rf of rawFrames) {
    // Cancelled mid-decode (large GIF, user hit ✕): stop compositing and free
    // the frames built so far instead of grinding to the end of the loop.
    throwIfAborted(signal, frames);

    // 1. Apply the previous frame's disposal to the work canvas.
    if (prevDims) {
      if (prevDisposalType === DISPOSAL_RESTORE_BACKGROUND) {
        ctx.clearRect(
          prevDims.left,
          prevDims.top,
          prevDims.width,
          prevDims.height,
        );
      } else if (
        prevDisposalType === DISPOSAL_RESTORE_PREVIOUS &&
        restoreSnapshot
      ) {
        ctx.putImageData(restoreSnapshot, 0, 0);
      }
    }

    // 2. If THIS frame is restore-to-previous, snapshot the canvas as it stands
    //    now (after prev disposal, before this patch) so the next iteration can
    //    revert to it.
    if (rf.disposalType === DISPOSAL_RESTORE_PREVIOUS) {
      restoreSnapshot = ctx.getImageData(0, 0, width, height);
    }

    // 3. Composite this frame's patch onto the work canvas with correct alpha.
    //    - putImageData straight onto the work canvas would clobber transparency
    //      (the patch's alpha-0 pixels overwrite real ones), so we stage the patch
    //      on its own transparent temp canvas and drawImage it (source-over).
    //    - In a Firefox content script the gifuct patch lives in the extension
    //      sandbox realm while the canvas buffer lives in the page realm (seen
    //      through an Xray wrapper). Canvas pixel APIs refuse to read a typed
    //      array across that boundary ("Failed to extract Uint8ClampedArray" /
    //      "Permission denied to access object" / "Accessing from Xray wrapper is
    //      not supported"). We make the copy same-realm by unwrapping the
    //      destination (page realm) and cloning the source patch INTO it. Both
    //      helpers are no-ops outside Firefox.
    if (rf.patch) {
      const { width: pw, height: ph, left, top } = rf.dims;
      const patchCanvas = new OffscreenCanvas(pw, ph);
      const patchCtx = patchCanvas.getContext("2d");
      if (!patchCtx)
        throw new Error("decode: failed to acquire patch 2D context");
      const patchData = patchCtx.createImageData(pw, ph);
      copyPatchInto(patchData.data, rf.patch);
      patchCtx.putImageData(patchData, 0, 0);
      ctx.drawImage(patchCanvas, left, top);
    }

    // 4. Snapshot the full composited canvas → ready-to-blit bitmap.
    const bitmap = await createImageBitmap(canvas);

    const delay = clampDelay(rf.delay);
    elapsed += delay;
    frames.push({ bitmap, time: elapsed, delay });

    prevDisposalType = rf.disposalType;
    prevDims = rf.dims;
  }

  return { frames, duration: elapsed, loops };
}
