// Fetch hardening shared by both tiers of the image fetch.
//
// The URL is attacker-influenced (the page supplies the <img> src the user
// clicks), so every fetch of it is bounded: the scheme is restricted, and the
// body is capped so an unbounded image can't OOM the tab or the worker.
//
// Two callers use this: the content script's direct fetch (`content/fetchGif`)
// and the background's privileged fetch (`messages`). Like `messages`, this
// module is environment-agnostic (no `browser.*`) and unit-testable headless.

/** Body size cap. The whole thing is buffered before decoding. */
export const MAX_BYTES = 256 * 1024 * 1024; // 256 MB

/**
 * Schemes the background may fetch. `data:` is allowed so pages that inline an
 * animated image as a data URI still work; everything else (`file:`, `ftp:`, …)
 * is refused. `blob:` is pointless here — a blob URL only resolves in the origin
 * that created it, never in the extension's context.
 */
export const BACKGROUND_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "data:"]);

/**
 * Schemes the content script may fetch directly. Same list plus `blob:`, which
 * *does* resolve there: the content script shares the page's origin for URL
 * resolution, so images from lazy-loading libraries that hand out blob URLs work.
 */
export const DIRECT_SCHEMES: ReadonlySet<string> = new Set([...BACKGROUND_SCHEMES, "blob:"]);

/** Is `url` a parseable absolute URL with one of `schemes`? */
export function isAllowedUrl(url: string, schemes: ReadonlySet<string>): boolean {
  try {
    return schemes.has(new URL(url).protocol);
  } catch {
    return false; // not a parseable absolute URL
  }
}

/** Thrown when a body is (or declares itself) larger than the cap. */
export class ImageTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Image exceeds ${maxBytes} byte limit`);
    this.name = "ImageTooLargeError";
  }
}

/**
 * Reject a response that *declares* an oversized body, before reading a byte of
 * it. A missing or unparseable Content-Length is fine — `readCapped` still
 * enforces the cap while streaming.
 */
export function assertDeclaredSize(response: Response, maxBytes: number): void {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ImageTooLargeError(maxBytes);
}

/**
 * Read a response body into an ArrayBuffer, aborting if it exceeds `maxBytes`.
 * Streams so an oversized body is rejected without buffering the whole thing
 * (and catches servers that omit or understate Content-Length). Falls back to
 * buffering when the response exposes no readable stream.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new ImageTooLargeError(maxBytes);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ImageTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
