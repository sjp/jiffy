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
  frames: Frame[];
  duration: number;
  /** Whether the source is meant to repeat (e.g. GIF NETSCAPE loop, APNG num_plays). */
  loops: boolean;
}
