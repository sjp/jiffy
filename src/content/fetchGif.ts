// Content-side client for the background GIF fetch. Prefer `img.currentSrc`
// over `img.src` at the call site for srcset/lazy images — this helper just
// takes the resolved URL.
import { base64ToBytes } from "../messages";
import type { FetchGifRequest, FetchGifResponse } from "../messages";

/** Ask the background script for a GIF's bytes; throws on a typed error. */
export async function fetchGifBytes(url: string): Promise<ArrayBuffer> {
  const request: FetchGifRequest = { type: "FETCH_GIF", url };
  const response = (await browser.runtime.sendMessage(request)) as
    | FetchGifResponse
    | undefined;
  if (!response) {
    throw new Error("fetchGifBytes: no response from background script");
  }
  if (!response.ok) throw new Error(response.error);
  // The bytes arrive base64-encoded (Chrome's JSON message serialisation would
  // otherwise mangle a raw ArrayBuffer into `{}`); decode back to bytes here.
  // `base64ToBytes` allocates a fresh array, so `.buffer` is a plain ArrayBuffer.
  return base64ToBytes(response.data).buffer as ArrayBuffer;
}
