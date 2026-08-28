// The dedicated-worker globals used by src/engine/decode.worker.ts.
//
// The project typechecks against the DOM lib, because every other entry point
// runs in a page, and TypeScript's DOM and WebWorker libs can't coexist (they
// declare the same names with different shapes). So the worker's own handful of
// globals is declared here and reached through a cast on `self`.
interface DedicatedWorkerGlobalScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}
