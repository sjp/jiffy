// Headless unit test for the keyboard-shortcut map.
//
// handleControlKey is a pure function of (key, engine) — exactly so it can be
// tested without rendering. We drive it with a recording fake engine and assert
// the precise mapping (which engine method, which argument) plus the boolean
// "handled" contract the caller relies on to decide whether to preventDefault.
//
// Run: `npm test`.
import assert from "node:assert/strict";
import { handleControlKey } from "./keymap.ts";
import type { Engine, EngineState } from "../engine/types.ts";

// ---- recording fake engine ------------------------------------------------
// Records every call so we can assert the exact mapping. `duration` is fixed so
// we can check that End seeks to it.
const DURATION = 200;
function makeEngine() {
  const calls: string[] = [];
  const state: EngineState = {
    playing: false,
    index: 0,
    frameCount: 3,
    currentTime: 0,
    duration: DURATION,
  };
  const engine = {
    state,
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    toggle: () => calls.push("toggle"),
    step: (d: 1 | -1) => calls.push(`step(${d})`),
    seekToTime: (t: number) => calls.push(`seekToTime(${t})`),
    seekToIndex: (i: number) => calls.push(`seekToIndex(${i})`),
    subscribe: () => () => {},
  } as Engine;
  return { engine, calls };
}

// ---- each handled key maps to exactly one engine call ---------------------
const cases: Array<[string, string]> = [
  [" ", "toggle"],
  ["Spacebar", "toggle"], // legacy key value for Space
  ["ArrowLeft", "step(-1)"],
  ["ArrowRight", "step(1)"],
  ["Home", "seekToIndex(0)"],
  ["End", `seekToTime(${DURATION})`],
];

for (const [key, expected] of cases) {
  const { engine, calls } = makeEngine();
  const handled = handleControlKey(key, engine);
  assert.equal(handled, true, `"${key}" is reported handled`);
  assert.deepEqual(calls, [expected], `"${key}" maps to exactly ${expected}`);
}

// ---- unrelated keys are not handled and touch the engine not at all -------
for (const key of ["a", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"]) {
  const { engine, calls } = makeEngine();
  const handled = handleControlKey(key, engine);
  assert.equal(handled, false, `"${key}" is not handled`);
  assert.deepEqual(calls, [], `"${key}" leaves the engine untouched`);
}

// ---- End reads the live duration off the engine ---------------------------
// Regression guard: End must seek to whatever the engine currently reports as
// its duration, not a captured constant.
{
  const { engine, calls } = makeEngine();
  (engine.state as EngineState).duration = 1234;
  handleControlKey("End", engine);
  assert.deepEqual(calls, ["seekToTime(1234)"], "End uses the live duration");
}

console.log("keymap.test: OK");
