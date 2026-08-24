// Content-side client for the background GIF fetch. Prefer `img.currentSrc`
// over `img.src` at the call site for srcset/lazy images — this helper just
// takes the resolved URL.
import { base64ToBytes } from "../messages";
import type { FetchGifRequest, FetchGifResponse } from "../messages";

/**
 * Resolve `promise`, but reject with an `AbortError` the moment `signal` aborts.
 * The underlying work (here, the background fetch) isn't cancelled — we just stop
 * awaiting it. The `abort` listener is removed once the promise settles so a
 * completed fetch leaves nothing attached to the signal.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Ask the background script for a GIF's bytes; throws on a typed error.
 *
 * The optional `signal` lets a caller bail out promptly (the user cancelled the
 * load): we can't stop the background fetch itself — it runs in another context
 * and is already bounded by its own size/timeout caps — but we stop *waiting* on
 * it so the UI unwinds immediately, rejecting with an `AbortError`.
 */
export async function fetchGifBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const request: FetchGifRequest = { type: "FETCH_GIF", url };
  const message = browser.runtime.sendMessage(request) as Promise<FetchGifResponse | undefined>;
  const response = signal ? await raceAbort(message, signal) : await message;
  if (!response) {
    throw new Error("fetchGifBytes: no response from background script");
  }
  if (!response.ok) throw new Error(response.error);
  // The bytes arrive base64-encoded (Chrome's JSON message serialisation would
  // otherwise mangle a raw ArrayBuffer into `{}`); decode back to bytes here.
  // `base64ToBytes` allocates a fresh array, so `.buffer` is a plain ArrayBuffer.
  return base64ToBytes(response.data).buffer as ArrayBuffer;
}
