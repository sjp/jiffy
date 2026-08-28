// Worker-backed decode — the pipeline's `decode` with the CPU moved off the
// page's main thread.
//
// Same signature as `engine/decode`, so this is just another implementation of
// `PipelineDeps.decode` (see ./controller); ./player picks which one to inject.
// The worker does the whole decode and hands back `FrameSourceData`, which
// hydrates here into the playback-side `FrameSource` the overlay draws from.
//
// One worker per decode, terminated as soon as it answers. That's what makes
// cancellation actually work: a worker part-way through a synchronous LZW or
// container parse can't process an `abort` message, but it can be terminated
// mid-block. It also means a decode that dies takes nothing with it. The cost is
// spinning up (and parsing the bundle in) a worker per picked image, which is
// milliseconds against a decode measured in seconds.
//
// Everything here falls back to decoding on this thread rather than failing.
// Whether a content script may run a worker from a `moz-extension://` URL at all
// is the open question — so it's answered by trying, and by treating silence as
// a no (see `READY_TIMEOUT_MS`), never by sniffing the browser.

import { NotAnimatedError, decode } from "../engine/decode";
import { isAnimatedAvif } from "../engine/decodeAvif";
import type {
  DecodeFailure,
  DecodeRequest,
  DecodeResponse,
  DecodeWorkerMessage,
} from "../engine/decodeMessages";
import { closeFrameSourceData, hydrateFrameSource } from "../engine/frameSource";
import { DecodeBudgetError, type DecodeResult } from "../engine/types";

/** Built output name of the worker bundle (see scripts/build.mjs + the manifests). */
const WORKER_BUNDLE = "decode-worker.js";

/**
 * How long a spawned worker has to announce itself before we conclude it never
 * started (see DecodeWorkerReady). Generous — all it has to do is fetch and
 * parse its own bundle, which doesn't queue behind the page's busy main thread —
 * because tripping this on a worker that was merely slow costs a whole decode.
 */
const READY_TIMEOUT_MS = 5000;

/**
 * Whether spawning a decode worker is worth attempting here. Cleared for good
 * the first time one can't be constructed or never starts, so a context where
 * workers don't work pays for that discovery exactly once. A worker that started
 * and *then* failed doesn't clear it: that's one bad decode, not a verdict on the
 * context.
 */
let workersUsable = true;

/** A worker that never got going, as opposed to one that failed mid-decode. */
class WorkerUnavailable extends Error {}

/** The AbortError shape the pipeline treats as a silent cancel (see engine/types). */
const abortError = (): DOMException => new DOMException("decode aborted", "AbortError");

/**
 * Rebuild the real error from a failure the worker flattened for the wire.
 * `unsupported` isn't one: it's a "decode this yourself" instruction, handled
 * before anything gets here.
 */
function fromFailure(failure: Exclude<DecodeFailure, { kind: "unsupported" }>): Error {
  switch (failure.kind) {
    case "not-animated":
      return new NotAnimatedError(failure.message);
    case "too-large":
      return new DecodeBudgetError(failure.bytes);
    case "error":
      return new Error(failure.message);
  }
}

/** Construct a worker, or null if this context won't allow one. */
function spawn(): Worker | null {
  try {
    return new Worker(browser.runtime.getURL(WORKER_BUNDLE));
  } catch (err) {
    console.debug("[jiffy] no decode worker here; decoding on the main thread", err);
    workersUsable = false;
    return null;
  }
}

/**
 * Send the bytes and wait for the decode reply, for `signal` to cancel, or for
 * the worker to show it isn't there.
 *
 * The reply is preceded by the worker's `ready` message, which is what the
 * startup deadline watches for. Once that lands the deadline is dropped: the
 * decode itself gets no time limit — being slow is the whole reason it's out
 * there.
 */
function post(worker: Worker, bytes: ArrayBuffer, signal?: AbortSignal): Promise<DecodeResponse> {
  return new Promise<DecodeResponse>((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let started = false;

    const settle = (act: () => void): void => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      act();
    };
    const onAbort = (): void => settle(() => reject(abortError()));

    worker.onmessage = (event: MessageEvent): void => {
      const message = event.data as DecodeWorkerMessage;
      if (!("ok" in message)) {
        // Proof of life. It can now take as long as the decode takes.
        started = true;
        clearTimeout(deadline);
        return;
      }
      settle(() => resolve(message));
    };
    // Fires when the worker script fails to load or throws at the top level —
    // decode failures come back as an `ok: false` message, not through here.
    worker.onerror = (event: ErrorEvent): void => {
      const message = event.message || "decode worker failed";
      settle(() => reject(started ? new Error(message) : new WorkerUnavailable(message)));
    };

    if (signal?.aborted) {
      settle(() => reject(abortError()));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(
      () => settle(() => reject(new WorkerUnavailable("decode worker never started"))),
      READY_TIMEOUT_MS,
    );
    // Deliberately NOT transferred: a worker that turns out not to work has to
    // leave us able to decode here instead, and a transferred buffer would be
    // gone. Copying the compressed bytes is a few MB against the hundreds the
    // decode itself moves back the other way.
    const request: DecodeRequest = { bytes };
    worker.postMessage(request);
  });
}

/** Decode `bytes` in a worker where that's possible, on this thread where it isn't. */
export async function decodeInWorker(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<DecodeResult> {
  // AVIF's frame source is a live ImageDecoder that can't cross the boundary,
  // and it has no big up-front compositing pass to move anyway.
  if (!workersUsable || isAnimatedAvif(bytes)) return decode(bytes, signal);
  const worker = spawn();
  if (!worker) return decode(bytes, signal);

  let response: DecodeResponse;
  try {
    response = await post(worker, bytes, signal);
  } catch (err) {
    worker.terminate();
    if (signal?.aborted) throw err;
    // The worker failed rather than the decode. Do it here — and if the worker
    // never even started, stop reaching for one at all.
    if (err instanceof WorkerUnavailable) workersUsable = false;
    console.debug("[jiffy] decode worker failed; decoding on the main thread", err);
    return decode(bytes, signal);
  }
  worker.terminate();

  if (!response.ok) {
    if (response.failure.kind === "unsupported") return decode(bytes, signal);
    throw fromFailure(response.failure);
  }
  // Cancelled while the reply was in flight: the frames arrived to no owner.
  if (signal?.aborted) {
    closeFrameSourceData(response.source);
    throw abortError();
  }
  return {
    frames: response.frames,
    source: hydrateFrameSource(response.source),
    duration: response.duration,
    loops: response.loops,
  };
}
