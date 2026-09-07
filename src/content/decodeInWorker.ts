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
//
// There are two ways to get the worker started, tried in that order and never by
// sniffing the browser:
//
//   1. `new Worker(runtime.getURL(…))`. A dedicated worker's script must be
//      same-origin with the document that creates it, and a content script counts
//      as the page for that — so `chrome-extension://…` is cross-origin and
//      Chrome throws `SecurityError` here. Firefox's expanded content-script
//      principal may allow it; asking is cheaper than knowing.
//   2. Fetch that same (web-accessible) bundle and construct the worker from a
//      `blob:` URL, which *is* same-origin with the page. This is the path that
//      works in Chrome. A page CSP whose `worker-src` excludes `blob:` blocks it,
//      and then there is nothing left to try. The worker has no `browser.*` this
//      way — it never uses any.
//
// A worker that is constructed but silently never runs is treated as a no as
// well (see `READY_TIMEOUT_MS`), which demotes to the next way of spawning one.

import { NotAnimatedError, decode } from "../engine/decode";
import { isAnimatedAvif } from "../engine/decodeAvif";
import type {
  DecodeFailure,
  DecodeRequest,
  DecodeResponse,
  DecodeWorkerMessage,
} from "../engine/decodeMessages";
import { closeFrameSourceData, hydrateFrameSource } from "../engine/frameSource";
import { DecodeBudgetError, UnsupportedFormatError, type DecodeResult } from "../engine/types";

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
 * How the next worker will be spawned: from the extension URL, from a `blob:`
 * URL of the same bundle, or not at all. Only ever demoted, and only when a
 * worker can't be constructed or never starts — so a context where a given way
 * doesn't work pays for that discovery exactly once. A worker that started and
 * *then* failed doesn't demote anything: that's one bad decode, not a verdict on
 * the context.
 */
let mode: "direct" | "blob" | "none" = "direct";

/** Move to the next way of spawning a worker after this one didn't work out. */
function demote(): void {
  mode = mode === "direct" ? "blob" : "none";
}

/** The `blob:` URL of the worker bundle, fetched once and reused per decode. */
let blobUrl: Promise<string | null> | undefined;

/** Whether the "decoding here instead" note has been logged loudly already. */
let noted = false;

/**
 * Say — once at `info`, and at `debug` from then on — that the decode is
 * happening on this thread. The first one is the discoverable record of which
 * spawn paths this browser refused; the rest are noise.
 */
function note(what: string, err?: unknown): void {
  const message = `[jiffy] ${what}`;
  if (noted) console.debug(message, err);
  else console.info(message, err);
  noted = true;
}

/** A worker that never got going, as opposed to one that failed mid-decode. */
class WorkerUnavailable extends Error {}

/** The AbortError shape the pipeline treats as a silent cancel (see engine/types). */
const abortError = (): DOMException => new DOMException("decode aborted", "AbortError");

/**
 * Rebuild the real error from a failure the worker flattened for the wire.
 * `not-transferable` isn't one: it's a "decode this yourself" instruction,
 * handled before anything gets here.
 */
function fromFailure(failure: Exclude<DecodeFailure, { kind: "not-transferable" }>): Error {
  switch (failure.kind) {
    case "not-animated":
      return new NotAnimatedError(failure.message);
    case "too-large":
      return new DecodeBudgetError(failure.bytes);
    case "unsupported-format":
      return new UnsupportedFormatError(failure.format, failure.message);
    case "error":
      return new Error(failure.message);
  }
}

/**
 * Fetch the worker bundle and wrap it in a `blob:` URL the page's origin will
 * accept as a worker script. Fetched once per page: the URL outlives the worker
 * built from it, and every decode spawns a fresh worker from the same bundle.
 *
 * The bundle is web-accessible, which is what makes this fetch legal — on Chrome
 * under `use_dynamic_url`, where `runtime.getURL()` hands back that session's
 * random origin rather than the extension's own (see the manifests). The blob is
 * a copy, so it stays good even if that origin rotates under us.
 */
function workerBlobUrl(): Promise<string | null> {
  blobUrl ??= (async () => {
    try {
      const response = await fetch(browser.runtime.getURL(WORKER_BUNDLE));
      if (!response.ok) throw new Error(`fetching the worker bundle gave ${response.status}`);
      // Re-typed rather than passed through: a worker script has to arrive with
      // a JavaScript MIME type, and this is the one place that's ours to set.
      const source = await response.text();
      return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    } catch (err) {
      note("the decode worker bundle could not be loaded", err);
      return null;
    }
  })();
  return blobUrl;
}

/** Construct a worker, or null once no way of spawning one is left. */
async function spawn(): Promise<Worker | null> {
  if (mode === "direct") {
    try {
      return new Worker(browser.runtime.getURL(WORKER_BUNDLE));
    } catch (err) {
      // Chrome, every time: the extension URL is cross-origin with the page.
      console.debug("[jiffy] no worker from the extension URL; trying a blob URL", err);
      mode = "blob";
    }
  }
  if (mode === "blob") {
    const url = await workerBlobUrl();
    if (url) {
      try {
        return new Worker(url);
      } catch (err) {
        // A page CSP without `blob:` in `worker-src`, most likely.
        note("no decode worker here; decoding on the main thread", err);
        mode = "none";
        return null;
      }
    }
    mode = "none";
  }
  return null;
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
      worker.onmessageerror = null;
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
    // The reply was built but couldn't be structured-cloned across. The worker
    // is fine and the decode was real; it just can't be handed over, so this
    // settles as an ordinary failure and the caller decodes here instead. Left
    // unhandled it would hang the "Loading…" toast until the user cancelled.
    worker.onmessageerror = (): void => {
      settle(() => reject(new Error("decode worker reply could not be transferred")));
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
  if (mode === "none" || isAnimatedAvif(bytes)) return decode(bytes, signal);
  const worker = await spawn();
  if (!worker) return decode(bytes, signal);
  // Spawning can await (the blob path fetches the bundle), so a cancel that
  // landed while it was in flight has to be caught before the bytes go out.
  if (signal?.aborted) {
    worker.terminate();
    throw abortError();
  }

  let response: DecodeResponse;
  try {
    response = await post(worker, bytes, signal);
  } catch (err) {
    worker.terminate();
    if (signal?.aborted) throw err;
    // The worker failed rather than the decode. Do it here — and if the worker
    // never even started, stop spawning them that way.
    if (err instanceof WorkerUnavailable) {
      demote();
      note("the decode worker never started; decoding on the main thread", err);
    } else {
      console.debug("[jiffy] decode worker failed; decoding on the main thread", err);
    }
    return decode(bytes, signal);
  }
  worker.terminate();

  if (!response.ok) {
    if (response.failure.kind === "not-transferable") return decode(bytes, signal);
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
    repeat: response.repeat,
  };
}
