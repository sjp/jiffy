// Playback engine — state + rAF loop + commands, DOM/UI-agnostic. This is
// "video semantics over a frame sequence": given the decoded
// frames[] (each with an end-of-frame cumulative `time`) and a `duration`, the
// engine owns a current position and a requestAnimationFrame loop that advances
// it as wall-clock time passes, notifying subscribers so the UI can reflect
// state. The UI never touches rAF.
import type { Engine, EngineState, Frame } from "./types";

/**
 * Clock + frame-scheduler abstraction. Defaults wrap `performance.now()` and
 * `requestAnimationFrame`; tests inject a fake clock to drive the loop
 * deterministically.
 */
export interface EngineClock {
  now(): number;
  schedule(cb: () => void): number;
  cancel(handle: number): void;
}

const defaultClock: EngineClock = {
  now: () => performance.now(),
  schedule: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Construct a playback engine over a decoded frame array.
 *
 * Position model: a single continuous `clock` in `[0, duration)` is the source
 * of truth; `index` and `currentTime` are derived from it so they can never
 * drift apart. `frames[i].time` is the end-of-frame cumulative time, so frame
 * `i` is shown while `clock` is in `[frameStart(i), frames[i].time)`.
 *
 * Conventions:
 * - `step` **clamps** at both ends (stepping past the last frame stays on it).
 * - `play()` while on the last frame restarts from 0 (replay).
 * - When `loop` is on (default) the clock wraps modulo `duration`; when off,
 *   reaching the end parks on the last frame and pauses (video-style).
 */
export function createEngine(
  frames: Frame[],
  duration: number,
  clock: EngineClock = defaultClock,
): Engine {
  const frameCount = frames.length;

  let playing = false;
  let position = 0; // continuous clock, ms, in [0, duration)
  let index = 0;
  let rafHandle: number | null = null;
  let lastTick = 0;
  // Default on (preserves the historical always-loop behaviour); callers override
  // via setLoop with the source's own loop setting.
  let loop = true;

  const subscribers = new Set<(s: EngineState) => void>();

  /** End-exclusive lookup: first frame whose end-time is past `t`, clamped. */
  const indexForTime = (t: number): number => {
    if (frameCount === 0) return 0;
    let lo = 0;
    let hi = frameCount; // search [lo, hi)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid]!.time > t) hi = mid;
      else lo = mid + 1;
    }
    return Math.min(lo, frameCount - 1);
  };

  /** Start time of frame `i` = previous frame's end time (0 for the first). */
  const frameStart = (i: number): number => (i <= 0 ? 0 : frames[i - 1]!.time);

  const snapshot = (): EngineState => ({
    playing,
    index,
    frameCount,
    currentTime: position,
    duration,
    loop,
  });

  const notify = (): void => {
    const s = snapshot();
    for (const fn of subscribers) fn(s);
  };

  /** rAF body: advance the clock by elapsed wall time, notify on index change. */
  const tick = (): void => {
    if (!playing) return;
    const now = clock.now();
    const delta = now - lastTick;
    lastTick = now;

    position += delta;
    if (duration > 0 && position >= duration) {
      if (loop) {
        position %= duration; // wrap and keep playing
      } else {
        // Looping off: park on the last frame and stop, like a video ending.
        // play() restarts from 0, so the play button replays.
        position = duration;
        index = frameCount - 1;
        playing = false;
        stopLoop();
        notify();
        return;
      }
    }
    const next = indexForTime(position);
    if (next !== index) {
      index = next;
      notify(); // once per frame advance, not per tick
    }
    rafHandle = clock.schedule(tick);
  };

  const stopLoop = (): void => {
    if (rafHandle !== null) {
      clock.cancel(rafHandle);
      rafHandle = null;
    }
  };

  const play = (): void => {
    if (playing || frameCount === 0) return;
    // Restart from the top if parked on the last frame (nothing left to play).
    if (index >= frameCount - 1) {
      position = 0;
      index = 0;
    }
    playing = true;
    lastTick = clock.now();
    notify();
    rafHandle = clock.schedule(tick);
  };

  const pause = (): void => {
    if (!playing) return;
    playing = false;
    stopLoop();
    notify();
  };

  const toggle = (): void => {
    if (playing) pause();
    else play();
  };

  const step = (delta: 1 | -1): void => {
    if (frameCount === 0) return;
    if (playing) pause(); // stepping is a paused, exact operation
    const target = Math.min(Math.max(index + delta, 0), frameCount - 1);
    if (target === index) return;
    index = target;
    position = frameStart(index);
    notify();
  };

  const seekToIndex = (i: number): void => {
    if (frameCount === 0) return;
    const target = Math.min(Math.max(Math.trunc(i), 0), frameCount - 1);
    index = target;
    position = frameStart(target);
    // Keep the loop coherent if it's running: it reads `position` next tick.
    lastTick = clock.now();
    notify();
  };

  const setLoop = (enabled: boolean): void => {
    if (loop === enabled) return;
    loop = enabled;
    notify();
  };

  const seekToTime = (t: number): void => {
    if (frameCount === 0) return;
    position = Math.min(Math.max(t, 0), duration);
    index = indexForTime(position);
    lastTick = clock.now();
    notify();
  };

  const subscribe = (fn: (s: EngineState) => void): (() => void) => {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  };

  return {
    get state() {
      return snapshot();
    },
    play,
    pause,
    toggle,
    step,
    seekToTime,
    seekToIndex,
    setLoop,
    subscribe,
  };
}
