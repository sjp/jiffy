// The decode worker — one whole decode, off the host page's main thread.
//
// `decode()` is a second or more of solid CPU on a large animation: LZW
// decompression or container parsing, then the compositing pass in
// ./frameSource that expands every frame's patch onto a canvas. It used to run
// in the content script, on the page's own main thread, so scrolling stalled,
// the page's animations froze, and even our "Loading…" toast couldn't repaint.
// Run here it costs the page nothing.
//
// What goes back is `FrameSourceData` — the keyframe bitmaps plus the steps to
// replay between them — not a live `FrameSource`, which closes over an
// `OffscreenCanvas` and can't be posted anywhere. The client hydrates its own
// playback half from that data, so replay stays on the thread that draws, which
// is where it belongs: it's at most KEYFRAME_INTERVAL patch draws per frame, not
// the whole animation.
//
// The decoders were already DOM-free (`OffscreenCanvas` throughout) so nothing
// here needed changing to run in a worker.
//
// Cancellation is the client terminating this worker, not a message: the
// container parse is one long synchronous block, and a worker sitting inside one
// can't process an `abort`. So there is deliberately no abort handling here, and
// no `AbortSignal` threaded into `decode`.
//
// AVIF is the one format that stays on the main thread: its frame source IS a
// live WebCodecs `ImageDecoder`, which can't be moved across a thread boundary.
// The client sniffs for it and never sends it here; the `unsupported` reply
// below is the backstop if that ever drifts.

import { NotAnimatedError, decode } from "./decode";
import type {
  DecodeFailure,
  DecodeRequest,
  DecodeResponse,
  DecodeWorkerReady,
} from "./decodeMessages";
import { closeFrameSourceData, frameSourceTransferables } from "./frameSource";
import { DecodeBudgetError } from "./types";

/** The dedicated-worker global, typed (see types/worker.d.ts for the cast). */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Flatten an error into something the client can rebuild (see DecodeFailure). */
function toFailure(err: unknown): DecodeFailure {
  if (err instanceof NotAnimatedError) return { kind: "not-animated", message: err.message };
  if (err instanceof DecodeBudgetError) {
    return { kind: "too-large", message: err.message, bytes: err.bytes };
  }
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

async function run(request: DecodeRequest): Promise<void> {
  let response: DecodeResponse;
  try {
    const { frames, source, duration, loops } = await decode(request.bytes);
    const data = source.detach?.();
    if (!data) {
      // A source whose pixels can't be moved. Nothing to hand over, so free it.
      source.close();
      ctx.postMessage({ ok: false, failure: { kind: "unsupported" } } satisfies DecodeResponse);
      return;
    }
    try {
      ctx.postMessage(
        { ok: true, frames, duration, loops, source: data } satisfies DecodeResponse,
        frameSourceTransferables(data),
      );
    } catch (err) {
      // The frames never left, so nothing on the other side will free them.
      closeFrameSourceData(data);
      throw err;
    }
    return;
  } catch (err) {
    response = { ok: false, failure: toFailure(err) };
  }
  ctx.postMessage(response);
}

ctx.onmessage = (event: MessageEvent): void => {
  void run(event.data as DecodeRequest);
};

// Proof of life, before any work is asked of us. See DecodeWorkerReady.
ctx.postMessage({ ready: true } satisfies DecodeWorkerReady);
