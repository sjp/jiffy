// Shared engine types — the central engine↔UI contract.

/**
 * Floor for per-frame delays, in ms. Frame delays are unreliable across all the
 * formats we decode — `0`/`1` are common and browsers historically clamp to a
 * floor — so every decoder clamps to this shared value. Keeping it in one place
 * stops the floor drifting between GIF/WebP/APNG/AVIF.
 */
export const MIN_DELAY_MS = 20;

/** A pre-composited, ready-to-blit full-canvas frame. */
export interface Frame {
  bitmap: ImageBitmap;
  /** Cumulative ms, end-of-frame convention (pick one and keep it). */
  time: number;
  /** Clamped frame delay in ms. */
  delay: number;
}

/** Snapshot of engine state handed to UI subscribers. */
export interface EngineState {
  playing: boolean;
  index: number;
  frameCount: number;
  currentTime: number;
  duration: number;
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
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(fn: (s: EngineState) => void): () => void;
}

/** Output of the decode + precompute step. */
export interface DecodeResult {
  frames: Frame[];
  duration: number;
}
