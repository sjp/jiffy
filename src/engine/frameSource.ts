// Frame pixels, addressed by index — the memory-bounded replacement for "one
// full-canvas ImageBitmap per frame".
//
// The old contract kept every frame pre-composited, so seek was O(1) but memory
// was `frames × width × height × 4` bytes: a 500-frame 800×600 GIF pinned ~1 GB.
// This module keeps a full-canvas bitmap only for KEYFRAME_INTERVAL-th frames
// and, for the frames between, only what the decoder already had — the source
// patch (a palette-indexed rectangle for GIF, a compressed sub-image blob for
// WebP/APNG), its rect, and the disposal method. Any frame is then produced by
// restoring the nearest keyframe and replaying at most `KEYFRAME_INTERVAL - 1`
// patch draws.
//
// The other half of the design is that the decoders no longer composite at all:
// they parse their container into a format-agnostic `FrameStep[]` and hand it
// here. GIF/WebP/APNG disposal is the same state machine with different names
// for the same three operations, so it now lives in exactly one place, and the
// "all-bitmap" behaviour is just this same code with `keyframeInterval: 1`
// (which is how the pixel-equivalence test pins the two paths together).
//
// Cost of the trade: sequential playback costs one patch draw plus one
// `createImageBitmap` per displayed frame, instead of zero. Seeks cost up to
// `KEYFRAME_INTERVAL` patch draws. A small LRU keeps recently produced frames
// so scrubbing back and forth over the same neighbourhood stays cheap.

import { throwIfAborted } from "./types";

/**
 * Frames between keyframes. 16 is the knee of the curve: memory drops ~16× for
 * the frames' bitmaps while a worst-case seek replays only 15 patch draws
 * (sub-millisecond for a typical patch).
 */
export const KEYFRAME_INTERVAL = 16;

/** Recomposited frames kept around, so scrubbing over a region doesn't re-replay. */
const CACHE_SIZE = 8;

/** How to treat this frame's rect once the frame has been shown. */
export const DISPOSE_NONE = 0;
/** Clear the rect (GIF restore-to-background, WebP dispose, APNG BACKGROUND). */
export const DISPOSE_BACKGROUND = 1;
/** Revert the canvas to its state before this frame was drawn. */
export const DISPOSE_PREVIOUS = 2;
export type Dispose = typeof DISPOSE_NONE | typeof DISPOSE_BACKGROUND | typeof DISPOSE_PREVIOUS;

/**
 * A frame's pixels as the container stored them — the compact representation we
 * retain instead of a composited bitmap.
 *
 * - `indexed`: GIF. One byte per pixel into a 3-bytes-per-entry palette, which
 *   is a quarter of the RGBA patch gifuct-js would hand us and exactly what the
 *   LZW decode already produced.
 * - `blob`: WebP/APNG. The frame's own compressed sub-image, rewrapped as a
 *   standalone file the browser can decode natively — typically two orders of
 *   magnitude smaller than its pixels.
 */
export type FramePatch =
  | {
      kind: "indexed";
      pixels: Uint8Array;
      /** Flattened RGB triples; `pixels[i] * 3` indexes it. */
      palette: Uint8Array;
      /** Palette index that means "transparent", or -1 for none. */
      transparentIndex: number;
    }
  | { kind: "blob"; blob: Blob };

/** One frame's contribution to the canvas — everything needed to replay it. */
export interface FrameStep {
  /** Pixels for the rect below; null for a frame that draws nothing. */
  patch: FramePatch | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Clear the rect before drawing, so the patch's transparent pixels *replace*
   * what was underneath instead of blending over it (WebP "overwrite" blending,
   * APNG `BLEND_OP_SOURCE`). GIF always blends.
   */
  clear: boolean;
  /** Applied after this frame has been shown, before the next is drawn. */
  dispose: Dispose;
}

/** Bytes a step's retained patch costs. */
export function patchBytes(step: FrameStep): number {
  const p = step.patch;
  if (!p) return 0;
  return p.kind === "indexed" ? p.pixels.byteLength + p.palette.byteLength : p.blob.size;
}

/** Number of full-canvas bitmaps a `frameCount`-frame source will retain. */
export const keyframeCount = (frameCount: number, interval = KEYFRAME_INTERVAL): number =>
  Math.max(1, Math.ceil(frameCount / interval));

/**
 * Pixels for an animation, addressed by frame index. The overlay asks for the
 * current frame rather than holding the frames itself, so how those pixels are
 * stored (keyframes + patches, or a live decoder) is the source's business.
 *
 * `getBitmap` returns synchronously when the frame is already resident (a
 * keyframe or a cache hit) and a promise when it has to be produced. The
 * returned bitmap is **owned by the source** — draw from it, don't keep it, and
 * don't close it; `close()` releases everything at once.
 */
export interface FrameSource {
  /** Full-canvas (native) pixel dimensions — what the overlay sizes itself to. */
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  getBitmap(index: number): ImageBitmap | Promise<ImageBitmap>;
  /** Release every bitmap (and any decoder) this source holds. */
  close(): void;
}

/**
 * Firefox content scripts run in a sandbox realm while the `OffscreenCanvas`
 * pixel buffer lives in the page realm, exposed through an Xray wrapper.
 * `.wrappedJSObject` returns the underlying page-realm object; on Chrome / Node
 * (no Xray) the value is returned unchanged. Canvas pixel APIs refuse to read a
 * typed array from another realm, so every write into an `ImageData` goes
 * through this first.
 */
const unwrapXray = <T>(value: T): T => (value as { wrappedJSObject?: T }).wrappedJSObject ?? value;

export interface FrameSourceOptions {
  width: number;
  height: number;
  steps: FrameStep[];
  /**
   * CSS colour painted over the blank canvas before frame 0 (WebP's ANIM
   * background, APNG's bKGD), so transparent areas match what the browser shows
   * for the native <img>. Null leaves the canvas transparent.
   */
  seedFill?: string | null;
  /**
   * CSS colour repainted into the rect on DISPOSE_BACKGROUND. WebP disposes to
   * its declared background colour; GIF and APNG dispose to transparent (null).
   */
  disposeFill?: string | null;
  keyframeInterval?: number;
  signal?: AbortSignal;
}

/**
 * Composite `steps` once, keeping every `keyframeInterval`-th result, and return
 * a source that can reproduce any frame from those keyframes plus the steps.
 *
 * The single build pass is also the only place the disposal state machine runs
 * forwards from a clean canvas, so it doubles as the definition of "correct":
 * with `keyframeInterval: 1` every frame is a keyframe and the result is the
 * old all-bitmap behaviour, byte for byte.
 */
export async function createFrameSource(opts: FrameSourceOptions): Promise<FrameSource> {
  const {
    width,
    height,
    steps,
    seedFill = null,
    disposeFill = null,
    keyframeInterval = KEYFRAME_INTERVAL,
    signal,
  } = opts;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("frameSource: failed to acquire 2D context");

  // Staging canvas for indexed patches: putImageData writes raw RGBA (clobbering
  // alpha), so the patch is staged at its own size and then drawImage'd, which
  // composites source-over and honours transparency.
  let stage: OffscreenCanvas | null = null;
  let stageCtx: OffscreenCanvasRenderingContext2D | null = null;

  /** A retained, fully composited frame plus what its own disposal needs. */
  interface Keyframe {
    bitmap: ImageBitmap;
    /**
     * Canvas state this keyframe's DISPOSE_PREVIOUS reverts to. Only a keyframe
     * needs it stored: mid-run the replay produces its own snapshots, but a
     * replay *starting* just after this frame would otherwise have no way to
     * undo it.
     */
    restore: ImageData | null;
  }

  const keyframes = new Map<number, Keyframe>();
  const cache = new Map<number, ImageBitmap>(); // insertion-ordered → LRU
  let closed = false;

  // Replay cursor: the frame the work canvas currently shows, and the snapshot
  // that frame's disposal would restore. -1 means "unknown" — before the build
  // starts, and after a failed replay — and always forces a keyframe rewind.
  let cursor = -1;
  let restoreSnapshot: ImageData | null = null;

  const seed = (): void => {
    ctx.clearRect(0, 0, width, height);
    if (seedFill) {
      ctx.fillStyle = seedFill;
      ctx.fillRect(0, 0, width, height);
    }
    cursor = -1;
    restoreSnapshot = null;
  };

  /** Paint an indexed patch through the staging canvas. */
  const drawIndexed = (step: FrameStep, patch: Extract<FramePatch, { kind: "indexed" }>): void => {
    if (step.width === 0 || step.height === 0) return; // nothing to stage
    if (!stage || !stageCtx) {
      stage = new OffscreenCanvas(step.width, step.height);
      stageCtx = stage.getContext("2d");
      if (!stageCtx) throw new Error("frameSource: failed to acquire patch 2D context");
    } else {
      // Assigning either dimension resets the canvas, so the previous patch
      // can't bleed through; putImageData below covers it entirely regardless.
      stage.width = step.width;
      stage.height = step.height;
    }
    const image = stageCtx.createImageData(step.width, step.height);
    // Expand palette indices straight into the (page-realm) canvas buffer.
    // createImageData zeroes it, so transparent pixels need no write at all.
    const data = unwrapXray(image.data);
    const { pixels, palette, transparentIndex } = patch;
    for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
      const index = pixels[i]!;
      if (index === transparentIndex) continue;
      const c = index * 3;
      data[o] = palette[c]!;
      data[o + 1] = palette[c + 1]!;
      data[o + 2] = palette[c + 2]!;
      data[o + 3] = 255;
    }
    stageCtx.putImageData(image, 0, 0);
    ctx.drawImage(stage, step.x, step.y);
  };

  /** Draw frame `i` onto the work canvas; frame `i-1`'s disposal is already applied. */
  const drawStep = async (i: number): Promise<void> => {
    const step = steps[i]!;
    // Snapshot BEFORE this frame's pixels land, so its disposal can undo it.
    if (step.dispose === DISPOSE_PREVIOUS) {
      restoreSnapshot = ctx.getImageData(0, 0, width, height);
    }
    if (step.clear) ctx.clearRect(step.x, step.y, step.width, step.height);
    const patch = step.patch;
    if (patch) {
      if (patch.kind === "blob") {
        const bitmap = await createImageBitmap(patch.blob);
        ctx.drawImage(bitmap, step.x, step.y);
        bitmap.close();
      } else {
        drawIndexed(step, patch);
      }
    }
    cursor = i;
  };

  /** Apply frame `i`'s disposal, readying the canvas for frame `i+1`. */
  const applyDispose = (i: number): void => {
    const step = steps[i]!;
    if (step.dispose === DISPOSE_BACKGROUND) {
      ctx.clearRect(step.x, step.y, step.width, step.height);
      if (disposeFill) {
        ctx.fillStyle = disposeFill;
        ctx.fillRect(step.x, step.y, step.width, step.height);
      }
    } else if (step.dispose === DISPOSE_PREVIOUS && restoreSnapshot) {
      ctx.putImageData(restoreSnapshot, 0, 0);
    }
  };

  // ---- build pass --------------------------------------------------------
  // One forward composite of the whole animation, keeping every Nth result.
  seed();
  try {
    for (let i = 0; i < steps.length; i++) {
      throwIfAborted(signal);
      if (i > 0) applyDispose(i - 1);
      await drawStep(i);
      if (i % keyframeInterval === 0) {
        keyframes.set(i, {
          bitmap: await createImageBitmap(canvas),
          restore: steps[i]!.dispose === DISPOSE_PREVIOUS ? restoreSnapshot : null,
        });
      }
    }
  } catch (err) {
    // Cancelled or failed mid-build: the caller never sees the source, so free
    // the keyframes here rather than leaking them.
    for (const kf of keyframes.values()) kf.bitmap.close();
    keyframes.clear();
    throw err;
  }

  // ---- playback ----------------------------------------------------------

  /** Put the work canvas back to the state right after keyframe `key` was drawn. */
  const restoreKeyframe = (key: number): void => {
    const kf = keyframes.get(key)!;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(kf.bitmap, 0, 0);
    cursor = key;
    restoreSnapshot = kf.restore;
  };

  /** Bring the work canvas to frame `i`, replaying as few steps as possible. */
  const advanceTo = async (i: number): Promise<void> => {
    const key = Math.floor(i / keyframeInterval) * keyframeInterval;
    // Playing forwards, the canvas is already on frame i-1 — just step it once.
    // Anything else (a seek, reverse) rewinds to the nearest keyframe first.
    // A cursor of -1 is "unknown", which is always before a keyframe, so it
    // forces the rewind.
    if (cursor > i || cursor < key) restoreKeyframe(key);
    try {
      for (let j = cursor + 1; j <= i; j++) {
        applyDispose(j - 1);
        await drawStep(j);
      }
    } catch (err) {
      // A half-drawn frame leaves the canvas in a state no cursor describes.
      // Forget where we are so the next request starts from a keyframe again.
      cursor = -1;
      throw err;
    }
  };

  const remember = (i: number, bitmap: ImageBitmap): void => {
    cache.set(i, bitmap);
    while (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value as number;
      cache.get(oldest)!.close();
      cache.delete(oldest);
    }
  };

  // Every render shares the one work canvas, so they must not interleave.
  // Chaining them onto a queue keeps a burst of seeks correct (and in order)
  // without any locking.
  let queue: Promise<unknown> = Promise.resolve();

  const render = (i: number): Promise<ImageBitmap> => {
    const result = queue.then(async () => {
      if (closed) throw new Error("frameSource: closed");
      // The queue may have produced it while we were waiting our turn.
      const hit = cache.get(i);
      if (hit) return hit;
      await advanceTo(i);
      const bitmap = await createImageBitmap(canvas);
      if (closed) {
        bitmap.close();
        throw new Error("frameSource: closed");
      }
      remember(i, bitmap);
      return bitmap;
    });
    // The queue must survive a rejection, or one failure stalls every later frame.
    queue = result.catch(() => {});
    return result;
  };

  return {
    width,
    height,
    frameCount: steps.length,
    getBitmap(index: number): ImageBitmap | Promise<ImageBitmap> {
      const i = Math.min(Math.max(Math.trunc(index), 0), steps.length - 1);
      const kf = keyframes.get(i);
      if (kf) return kf.bitmap;
      const hit = cache.get(i);
      if (hit) {
        cache.delete(i); // re-insert → most recently used
        cache.set(i, hit);
        return hit;
      }
      return render(i);
    },
    close(): void {
      closed = true;
      for (const kf of keyframes.values()) kf.bitmap.close();
      keyframes.clear();
      for (const bitmap of cache.values()) bitmap.close();
      cache.clear();
    },
  };
}

/**
 * A source over frames that are already bitmaps and can't be recomposited from
 * patches. Kept for decoders that hand us finished pixels; it has the old
 * memory profile, so only use it when nothing smaller will do.
 */
export function createBitmapSource(
  width: number,
  height: number,
  bitmaps: ImageBitmap[],
): FrameSource {
  return {
    width,
    height,
    frameCount: bitmaps.length,
    getBitmap(index: number): ImageBitmap {
      const i = Math.min(Math.max(Math.trunc(index), 0), bitmaps.length - 1);
      return bitmaps[i]!;
    },
    close(): void {
      for (const bitmap of bitmaps) bitmap.close();
      bitmaps.length = 0;
    },
  };
}
