// Content-side image fetch, in two tiers. Prefer `img.currentSrc` over `img.src`
// at the call site for srcset/lazy images — this helper just takes the resolved
// URL.
//
// Tier 1 — fetch from the content script itself. It runs in the page's origin,
// so it sends the page's cookies and Referer (login-gated and hotlink-protected
// images that 403 the background), it usually hits the bytes the browser already
// downloaded for the <img>, it can resolve `blob:` URLs (which exist only in that
// origin), and it yields an ArrayBuffer with no base64 round-trip.
//
// Tier 2 — ask the background script (see ../messages). Its fetch runs on the
// extension's own host access, so it's the only one that can reach a cross-origin
// server sending no CORS headers at all — but it re-downloads the bytes and pays
// a ~33% base64 transfer overhead, so it's the fallback, not the default. That
// access is optional and off by default (the popup's "all sites" checkbox), so
// this tier can also come back empty-handed; the caller reports that like any
// other failure.
import {
  assertDeclaredSize,
  DIRECT_SCHEMES,
  ImageTooLargeError,
  isAllowedUrl,
  MAX_BYTES,
  readCapped,
} from "../fetchLimits";
import { base64ToBytes } from "../messages";
import type { FetchGifRequest, FetchGifResponse } from "../messages";

/** Collaborators, injected so the tier selection is testable headless. */
export interface FetchGifDeps {
  /** Tier 1: the page-context fetch. */
  fetch: typeof globalThis.fetch;
  /** Tier 2: the background round-trip. */
  sendMessage: (request: FetchGifRequest) => Promise<FetchGifResponse | undefined>;
  maxBytes?: number;
}

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
 * Tier 1. Throws on any failure; the caller decides whether that's worth a
 * fallback. `signal` cancels the transfer for real here (unlike tier 2).
 *
 * There's no timeout: a stalled transfer keeps showing the loading banner, whose
 * cancel button aborts `signal` — the background tier's timeout exists only
 * because a hung fetch there would pin the message channel open.
 */
async function fetchDirect(
  url: string,
  signal: AbortSignal | undefined,
  deps: FetchGifDeps,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const response = await deps.fetch(url, {
    // Reuse whatever the browser already downloaded for the <img>.
    cache: "force-cache",
    // Cookies for same-origin images — but deliberately not `include`, which
    // would make the `Access-Control-Allow-Origin: *` that image CDNs send fail
    // the CORS check and push every one of them onto the slow tier. Cookie-gated
    // cross-origin images fall through to the background, as they did before.
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  assertDeclaredSize(response, maxBytes);
  return readCapped(response, maxBytes);
}

/** Tier 2: the background fetch, decoded from the base64 wire format. */
async function fetchViaBackground(
  url: string,
  signal: AbortSignal | undefined,
  deps: FetchGifDeps,
): Promise<ArrayBuffer> {
  const message = deps.sendMessage({ type: "FETCH_GIF", url });
  const response = signal ? await raceAbort(message, signal) : await message;
  if (!response) {
    throw new Error("fetchGifBytes: no response from background script");
  }
  if (!response.ok) throw new Error(response.error);
  // `base64ToBytes` allocates a fresh array, so `.buffer` is a plain ArrayBuffer.
  return base64ToBytes(response.data).buffer as ArrayBuffer;
}

/**
 * Build the two-tier fetch over the given collaborators. `fetchGifBytes` below is
 * the wiring used in the browser; tests inject their own.
 */
export function createFetchGifBytes(
  deps: FetchGifDeps,
): (url: string, signal?: AbortSignal) => Promise<ArrayBuffer> {
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  return async function fetchGifBytes(url, signal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (isAllowedUrl(url, DIRECT_SCHEMES)) {
      try {
        return await fetchDirect(url, signal, deps, maxBytes);
      } catch (err) {
        // The user cancelled: report that, whatever the aborted fetch threw.
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        // Too big for us — it won't shrink because the background downloads it.
        if (err instanceof ImageTooLargeError) throw err;
        // Anything else (CORS refusal, a server that dislikes the `Origin`
        // header, a plain network error) may still work with host permissions.
        console.debug("[jiffy] direct fetch failed, retrying via background", url, err);
      }
    }
    return fetchViaBackground(url, signal, deps);
  };
}

/** Default wiring: the page's `fetch`, the extension's message channel. */
export const fetchGifBytes = createFetchGifBytes({
  fetch: (...args) => fetch(...args),
  sendMessage: (request) =>
    browser.runtime.sendMessage(request) as Promise<FetchGifResponse | undefined>,
});
