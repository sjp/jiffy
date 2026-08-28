// Shared engine types — the central engine↔UI contract.

import type { FrameSource } from "./frameSource";

/**
 * Floor for per-frame delays, in ms. Frame delays are unreliable across all the
 * formats we decode — `0`/`1` are common and browsers historically clamp to a
 * floor — so every decoder clamps to this shared value. Keeping it in one place
 * stops the floor drifting between GIF/WebP/APNG/AVIF.
 */
export const MIN_DELAY_MS = 20;

/**
 * Memory ceiling for a single decode, in bytes.
 *
 * Frames are no longer one full-canvas RGBA bitmap each (see ./frameSource):
 * only every KEYFRAME_INTERVAL-th frame keeps a bitmap, and the frames between
 * keep their much smaller source patch. So the budget is expressed in bytes and
 * each decoder works out its own peak — keyframe bitmaps (4 bytes/px) plus
 * retained patches, or whatever transient the decode itself needs, whichever is
 * larger — rather than everyone assuming 4 bytes per canvas pixel per frame.
 *
 * The ceiling is the same ~6 GB it has always effectively been (the old 1.5 Gpx
 * × 4 bytes). It is still far too generous to protect the tab — lowering it, and
 * deriving it from `navigator.deviceMemory`, is
 * `issues/06-realistic-decode-budget.md`. What changed here is the *cost model*,
 * so that when the number does come down it is applied to something real.
 */
export const MAX_DECODE_BYTES = 6_000_000_000;

/** Thrown when a decode's retained bytes would exceed MAX_DECODE_BYTES. */
export class DecodeBudgetError extends Error {
  constructor(message = "image too large to play") {
    super(message);
    this.name = "DecodeBudgetError";
  }
}

/** Bytes one full-canvas RGBA bitmap costs. */
export const bitmapBytes = (width: number, height: number): number => width * height * 4;

/**
 * Reject a decode that would retain more than the budget allows, before any
 * compositing work happens. `bytes` is what the finished `FrameSource` will
 * hold: keyframe bitmaps plus retained patches.
 */
export function assertDecodeBudget(bytes: number): void {
  if (bytes > MAX_DECODE_BYTES) {
    throw new DecodeBudgetError();
  }
}

/**
 * A frame's place on the timeline. Pixels live in the `FrameSource` — a frame
 * is addressed by index, and the overlay asks the source for its bitmap — so a
 * `Frame` is pure bookkeeping and costs nothing to hold.
 */
export interface Frame {
  /** Cumulative ms, end-of-frame convention (pick one and keep it). */
  time: number;
  /** Clamped frame delay in ms. */
  delay: number;
}

/**
 * Bail out of an in-progress decode when its `signal` has been aborted (the user
 * cancelled the load, or it was torn down). Called once per frame inside the
 * compositing loop. Throws a standard `AbortError` (matching the fetch
 * convention) which the pipeline treats as a silent cancel, not an error. The
 * caller is responsible for releasing whatever it has built so far.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("decode aborted", "AbortError");
  }
}

/** Snapshot of engine state handed to UI subscribers. */
export interface EngineState {
  playing: boolean;
  index: number;
  frameCount: number;
  currentTime: number;
  duration: number;
  /** Whether playback repeats; when false it parks on the last frame at the end. */
  loop: boolean;
  /** Playback rate multiplier (1 = normal). Scales how fast the clock advances. */
  speed: number;
  /** Whether playback runs backwards. */
  reverse: boolean;
  /** Whether playback bounces forwards↔backwards forever (overrides loop/reverse). */
  pingpong: boolean;
}

/** Playback engine — owns frames, time and the rAF loop; DOM/UI-agnostic. */
export interface Engine {
  readonly state: EngineState;
  play(): void;
  pause(): void;
  toggle(): void;
  step(delta: 1 | -1): void;
  seekToTime(t: number): void;
  seekToIndex(i: number): void;
  /** Enable/disable looping. Off → playback stops on the last frame at the end. */
  setLoop(enabled: boolean): void;
  /** Set the playback rate multiplier (1 = normal). Values must be > 0. */
  setSpeed(rate: number): void;
  /** Play backwards when enabled. */
  setReverse(enabled: boolean): void;
  /** Bounce forwards↔backwards forever when enabled. */
  setPingPong(enabled: boolean): void;
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(fn: (s: EngineState) => void): () => void;
}

/** Output of the decode + precompute step. */
export interface DecodeResult {
  /** Timeline only — one entry per frame, in order. */
  frames: Frame[];
  /** Pixels, addressed by frame index. Owned by the caller; `close()` it. */
  source: FrameSource;
  duration: number;
  /** Whether the source is meant to repeat (e.g. GIF NETSCAPE loop, APNG num_plays). */
  loops: boolean;
}
