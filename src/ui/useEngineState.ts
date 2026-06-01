// Engine → UI binding hook.
//
// Subscribes a component to the engine and returns the latest EngineState
// snapshot, re-rendering on every change and unsubscribing on unmount. The UI
// never touches rAF — all timing lives in the engine; this just reflects it.
import { useEffect, useState } from "preact/hooks";
import type { Engine, EngineState } from "../engine/types";

export function useEngineState(engine: Engine): EngineState {
  const [snapshot, setSnapshot] = useState<EngineState>(engine.state);
  useEffect(() => {
    // Resync in case state changed between initial render and effect, then
    // subscribe; the returned unsubscribe is the effect cleanup.
    setSnapshot(engine.state);
    return engine.subscribe(setSnapshot);
  }, [engine]);
  return snapshot;
}
