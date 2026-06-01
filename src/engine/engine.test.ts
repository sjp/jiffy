// Headless unit test for the playback engine.
//
// Run: `npm test`. The engine's clock is injected, so we drive the rAF loop
// deterministically with a fake clock — no real requestAnimationFrame needed.

import assert from "node:assert/strict";
import { createEngine } from "./engine.ts";

// ---- fake clock ----------------------------------------------------------
let t = 0;
let pending: (() => void) | null = null;
const clock = {
  now: () => t,
  schedule: (cb: () => void) => {
    pending = cb;
    return 1;
  },
  cancel: () => {
    pending = null;
  },
};
/** Advance wall-clock to `newT` and run the one queued rAF callback. */
function runTickAt(newT: number) {
  t = newT;
  const cb = pending;
  pending = null;
  if (cb) cb();
}

// Two 100ms frames; cumulative end-times [100, 200]; duration 200.
const frames = [
  { bitmap: {}, time: 100, delay: 100 },
  { bitmap: {}, time: 200, delay: 100 },
] as never;

const engine = createEngine(frames, 200, clock);

// Record every state pushed to subscribers.
const log: unknown[] = [];
const unsubscribe = engine.subscribe((s) => log.push(s));

// ---- initial state -------------------------------------------------------
assert.deepEqual(engine.state, {
  playing: false,
  index: 0,
  frameCount: 2,
  currentTime: 0,
  duration: 200,
});

// ---- playback advances across frame boundaries + loops -------------------
t = 0;
engine.play();
assert.equal(engine.state.playing, true, "playing after play()");

runTickAt(50); // within frame 0 — no index change, no extra notify
assert.equal(engine.state.index, 0, "still frame 0 at t=50");

runTickAt(100); // crosses into frame 1
assert.equal(engine.state.index, 1, "frame 1 at t=100");

runTickAt(200); // reaches duration → wraps to frame 0 (loop)
assert.equal(engine.state.index, 0, "wrapped to frame 0 at t=200");
assert.equal(engine.state.currentTime, 0, "clock wrapped to 0");

// Notifications happened on: play, cross→1, wrap→0 (not on the t=50 tick).
assert.equal(log.length, 3, "one notify per state change, not per tick");

// ---- pause halts advancement ---------------------------------------------
engine.pause();
assert.equal(engine.state.playing, false, "paused");
const afterPause = log.length;
runTickAt(500); // no pending callback — nothing should happen
assert.equal(log.length, afterPause, "no notifications after pause");

// ---- step clamps at both ends --------------------------------------------
engine.seekToIndex(0);
engine.step(1);
assert.equal(engine.state.index, 1, "step +1 → frame 1");
assert.equal(engine.state.currentTime, 100, "currentTime = start of frame 1");
engine.step(1); // clamp at last frame
assert.equal(engine.state.index, 1, "step +1 clamps at last frame");
engine.step(-1);
assert.equal(engine.state.index, 0, "step -1 → frame 0");
engine.step(-1); // clamp at first frame
assert.equal(engine.state.index, 0, "step -1 clamps at first frame");

// ---- seekToTime maps time → index, clamps out-of-range -------------------
engine.seekToTime(150);
assert.equal(engine.state.index, 1, "seekToTime(150) → frame 1");
assert.equal(engine.state.currentTime, 150, "currentTime is continuous");
engine.seekToTime(9999);
assert.equal(engine.state.index, 1, "seekToTime past end clamps to last frame");
assert.equal(engine.state.currentTime, 200, "clamped to duration");
engine.seekToTime(-5);
assert.equal(engine.state.index, 0, "seekToTime below 0 clamps to frame 0");
assert.equal(engine.state.currentTime, 0, "clamped to 0");

// ---- seekToIndex clamps --------------------------------------------------
engine.seekToIndex(99);
assert.equal(engine.state.index, 1, "seekToIndex past end clamps");
engine.seekToIndex(-1);
assert.equal(engine.state.index, 0, "seekToIndex below 0 clamps");

// ---- play() while on the last frame restarts from 0 ----------------------
engine.seekToIndex(1);
t = 1000;
engine.play();
assert.equal(engine.state.index, 0, "play() at end restarts at frame 0");
assert.equal(engine.state.currentTime, 0, "restart clock = 0");
engine.pause();

// ---- unsubscribe ---------------------------------------------------------
const before = log.length;
unsubscribe();
engine.play();
engine.step(1);
assert.equal(log.length, before, "no callbacks after unsubscribe");

console.log("engine.test: OK");
