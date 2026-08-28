// Wire protocol between the decode worker and its client.
//
// Its own module so neither end has to import the other: the client
// (../content/decodeInWorker) reaches for `browser.runtime`, the worker
// (./decode.worker) installs a message handler the moment it's imported, and
// pulling either into the other's bundle would be wrong.

import type { FrameSourceData } from "./frameSource";
import type { Frame } from "./types";

/** Sent to the worker: the encoded image bytes, and nothing else. */
export interface DecodeRequest {
  bytes: ArrayBuffer;
}

/**
 * Why a decode produced no frames, in a form that survives `postMessage`.
 *
 * Structured clone flattens a custom `Error` subclass — a `name` that isn't one
 * of the standard error names is dropped — so the client can't `instanceof` its
 * way back to `NotAnimatedError` / `DecodeBudgetError`. The kind travels
 * explicitly instead and the client rebuilds the real error from it, which is
 * what keeps the toast able to say "Not an animated image" or name the size,
 * rather than falling back to "Couldn't load this image".
 */
export type DecodeFailure =
  /** No animated-format sniffer matched — a static image, or not an image. */
  | { kind: "not-animated"; message: string }
  /** Over the decode memory budget; `bytes` is what the decoder measured. */
  | { kind: "too-large"; message: string; bytes?: number }
  /** Anything else that went wrong inside the decode. */
  | { kind: "error"; message: string }
  /**
   * The format's frame source can't leave the worker — AVIF's live WebCodecs
   * `ImageDecoder`. The client decodes this one on its own thread instead.
   */
  | { kind: "unsupported" };

/** Posted back by the worker: a finished decode, or why there isn't one. */
export type DecodeResponse =
  | {
      ok: true;
      frames: Frame[];
      duration: number;
      loops: boolean;
      /** Hydrate with `hydrateFrameSource` to get the playback-side source. */
      source: FrameSourceData;
    }
  | { ok: false; failure: DecodeFailure };

/**
 * Posted the moment the worker's bundle has run, ahead of any decode: proof of
 * life. A worker that can't start is *supposed* to fire an `error` event at its
 * client, but whether a content script may run one from a `moz-extension://` URL
 * at all is exactly the thing we can't be sure of, so the client doesn't rely on
 * being told — silence where this should have been is its cue to give up and
 * decode on its own thread.
 */
export interface DecodeWorkerReady {
  ready: true;
}

/** Everything the worker posts, in order: `ready`, then one `DecodeResponse`. */
export type DecodeWorkerMessage = DecodeWorkerReady | DecodeResponse;
