// Content-side client for the background GIF fetch (issue 06; wired in issue 11).
// Prefer `img.currentSrc` over `img.src` at the call site for srcset/lazy images
// (PRD §3) — this helper just takes the resolved URL.
import type { FetchGifRequest, FetchGifResponse } from '../messages';

/** Ask the background script for a GIF's bytes; throws on a typed error. */
export async function fetchGifBytes(url: string): Promise<ArrayBuffer> {
  const request: FetchGifRequest = { type: 'FETCH_GIF', url };
  const response = (await browser.runtime.sendMessage(request)) as
    | FetchGifResponse
    | undefined;
  if (!response) {
    throw new Error('fetchGifBytes: no response from background script');
  }
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
