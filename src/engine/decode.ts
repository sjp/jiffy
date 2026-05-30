// gifuct-js wrapper + precompute to full-canvas bitmaps (issue 03 / PRD §3–§4).
//
// Bytes in, frames out — zero playback/DOM awareness. Each raw GIF frame is a
// (possibly partial) patch governed by a disposal method; we composite every
// frame ONCE, up front, into a full-canvas ImageBitmap and record a cumulative
// time array. That precompute is what makes step *and* seek O(1) at playback
// time instead of replaying from a keyframe (PRD §4).
//
// Memory tradeoff (known, deferred — PRD §4): N frames → N full-resolution
// bitmaps held in memory. Fine for typical GIFs. The patches + keyframe-index
// fallback for very large GIFs lives in issue 14; start with the simple version.

import { parseGIF, decompressFrames } from 'gifuct-js';
import type { FrameDims } from 'gifuct-js';
import type { DecodeResult, Frame } from './types';

/**
 * Delay clamp (PRD §4). GIF delays are unreliable — `0`/`1` centiseconds are
 * common and browsers historically clamp to a floor — so we clamp ourselves so
 * the timeline matches user expectation. gifuct-js already normalises `delay`
 * to milliseconds, so `toMs` is the identity here.
 */
const MIN_DELAY_MS = 20;
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
 * **ends** (end-of-frame), so `duration` equals the final frame's `time`
 * (PRD §4/§8). The array is monotonically increasing by construction.
 *
 * Uses `OffscreenCanvas` + `createImageBitmap`, so it runs headless (no page
 * DOM) and is unit-testable.
 */
export async function decode(bytes: ArrayBuffer): Promise<DecodeResult> {
  const gif = parseGIF(bytes);
  // `true` → build per-frame RGBA `patch` arrays for us.
  const rawFrames = decompressFrames(gif, true);

  const { width, height } = gif.lsd;

  // Work canvas at the GIF's native (logical screen) resolution. The snapshots
  // we take from it are full-canvas at native resolution, ready to blit.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('decode: failed to acquire 2D context');

  const frames: Frame[] = [];
  let elapsed = 0;

  // Disposal bookkeeping carried from the PREVIOUS frame — disposal is applied
  // before drawing the *next* patch (off-by-one here is the classic source of
  // garbage frames, PRD §3).
  let prevDisposalType = 0;
  let prevDims: FrameDims | null = null;
  // Canvas snapshot saved before a restore-to-previous frame is drawn.
  let restoreSnapshot: ImageData | null = null;

  for (const rf of rawFrames) {
    // 1. Apply the previous frame's disposal to the work canvas.
    if (prevDims) {
      if (prevDisposalType === DISPOSAL_RESTORE_BACKGROUND) {
        ctx.clearRect(prevDims.left, prevDims.top, prevDims.width, prevDims.height);
      } else if (prevDisposalType === DISPOSAL_RESTORE_PREVIOUS && restoreSnapshot) {
        ctx.putImageData(restoreSnapshot, 0, 0);
      }
    }

    // 2. If THIS frame is restore-to-previous, snapshot the canvas as it stands
    //    now (after prev disposal, before this patch) so the next iteration can
    //    revert to it.
    if (rf.disposalType === DISPOSAL_RESTORE_PREVIOUS) {
      restoreSnapshot = ctx.getImageData(0, 0, width, height);
    }

    // 3. Draw this frame's patch with proper alpha compositing. `putImageData`
    //    would clobber transparency (overwriting unchanged pixels with alpha 0),
    //    so route the patch through an ImageBitmap + drawImage (source-over).
    if (rf.patch) {
      const patchData = new ImageData(rf.patch, rf.dims.width, rf.dims.height);
      const patchBitmap = await createImageBitmap(patchData);
      ctx.drawImage(patchBitmap, rf.dims.left, rf.dims.top);
      patchBitmap.close();
    }

    // 4. Snapshot the full composited canvas → ready-to-blit bitmap.
    const bitmap = await createImageBitmap(canvas);

    const delay = clampDelay(rf.delay);
    elapsed += delay;
    frames.push({ bitmap, time: elapsed, delay });

    prevDisposalType = rf.disposalType;
    prevDims = rf.dims;
  }

  return { frames, duration: elapsed };
}
