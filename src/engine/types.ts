// Shared engine types — the central engine↔UI contract.

import type { FrameSource } from "./frameSource";

/**
 * Floor for per-frame delays, in ms. Frame delays are unreliable across all the
 * formats we decode — `0`/`1` are common and browsers historically clamp to a
 * floor — so every decoder clamps to this shared value. Keeping it in one place
 * stops the floor drifting between GIF/WebP/APNG/AVIF.
 */
export const MIN_DELAY_MS = 20;

// The decode memory budget.
//
// Frames are not one full-canvas RGBA bitmap each (see ./frameSource): only
// every KEYFRAME_INTERVAL-th frame keeps a bitmap, and the frames between keep
// their much smaller source patch. So the budget is expressed in bytes and each
// decoder works out its own peak — keyframe bitmaps (4 bytes/px) plus retained
// patches, or whatever transient the decode itself needs, whichever is larger —
// rather than everyone assuming 4 bytes per canvas pixel per frame.
//
// The ceiling has to be a number the machine can actually hold, because going
// over it doesn't degrade: the tab dies, taking the page with it. We are a guest
// in someone else's document, so one image gets a slice of the machine's memory,
// not most of it.

/**
 * Share of the machine's RAM a single decode may hold. The page has its own
 * memory to spend and the other tabs are competing for the rest, so a seventh
 * is about as far as one image can reasonably reach.
 */
const DEVICE_MEMORY_SHARE = 0.15;

/**
 * Ceiling used when the machine's RAM is unknown — only Chromium implements
 * `navigator.deviceMemory`. ~1.2 GB is 300 Mpx of RGBA: several times what a
 * real animation retains under the keyframe scheme (a 500-frame 800×600 GIF
 * holds ~300 MB even if every frame patches the whole canvas) while still being
 * survivable on the 4 GB machine that is the pessimistic end of "we can't
 * tell".
 */
export const DEFAULT_MAX_DECODE_BYTES = 1_200_000_000;

/**
 * Floor for the derived ceiling. `deviceMemory` bottoms out at 0.25 GiB, and a
 * share of that would refuse animations that would have played fine; below this
 * point it is better to attempt the decode and let the browser be the judge.
 */
export const MIN_MAX_DECODE_BYTES = 256_000_000;

/**
 * Derive the ceiling from the machine's RAM. `navigator.deviceMemory` reports
 * GiB, rounded down to a power of two and clamped by the spec to 0.25–8, so the
 * result spans MIN_MAX_DECODE_BYTES (≤ 2 GiB of RAM) to the static default
 * (8 GiB). Absent — Firefox, Safari — the static default stands.
 *
 * Separate from the value below so tests can exercise the mapping directly.
 */
export function computeMaxDecodeBytes(deviceMemoryGiB?: number): number {
  if (!deviceMemoryGiB || !Number.isFinite(deviceMemoryGiB)) return DEFAULT_MAX_DECODE_BYTES;
  const share = deviceMemoryGiB * 1024 ** 3 * DEVICE_MEMORY_SHARE;
  return Math.min(Math.max(share, MIN_MAX_DECODE_BYTES), DEFAULT_MAX_DECODE_BYTES);
}

/**
 * This machine's ceiling, resolved once at load: the amount of RAM doesn't
 * change and every decode consults it.
 */
export const MAX_DECODE_BYTES = computeMaxDecodeBytes(
  typeof navigator === "undefined" ? undefined : navigator.deviceMemory,
);

/**
 * Bytes as a rough human size, for the message a user sees when their image is
 * refused. Deliberately coarse (one decimal, powers of 1000): the input is an
 * estimate, so precision would be a lie.
 */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Thrown when a decode's retained bytes would exceed MAX_DECODE_BYTES. */
export class DecodeBudgetError extends Error {
  /** What the decode would have held, when the caller measured it. */
  readonly bytes: number | undefined;

  constructor(bytes?: number, limit = MAX_DECODE_BYTES) {
    super(
      bytes === undefined
        ? "image too large to play"
        : `image too large to play (~${formatBytes(bytes)}, budget ~${formatBytes(limit)})`,
    );
    this.name = "DecodeBudgetError";
    this.bytes = bytes;
  }
}

/** Bytes one full-canvas RGBA bitmap costs. */
export const bitmapBytes = (width: number, height: number): number => width * height * 4;

/**
 * Reject a decode that would retain more than the budget allows, before any
 * compositing work happens. `bytes` is what the finished `FrameSource` will
 * hold: keyframe bitmaps plus retained patches. `limit` exists so tests can
 * pin behaviour without depending on the host machine's RAM.
 */
export function assertDecodeBudget(bytes: number, limit = MAX_DECODE_BYTES): void {
  if (bytes > limit) {
    throw new DecodeBudgetError(bytes, limit);
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
