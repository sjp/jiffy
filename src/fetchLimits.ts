// Fetch hardening shared by both tiers of the image fetch.
//
// The URL is attacker-influenced (the page supplies the <img> src the user
// clicks), so every fetch of it is bounded: the scheme is restricted, and the
// body is capped so an unbounded image can't OOM the tab or the worker.
//
// Two callers use this: the content script's direct fetch (`content/fetchGif`)
// and the background's privileged fetch (`messages`). The background's runs on
// the extension's host access rather than the page's origin, so it gets two
// extra checks that don't apply to the direct tier — a private-network guard
// and a Content-Type sniff. Like `messages`, this module is
// environment-agnostic (no `browser.*`) and unit-testable headless.

/** Body size cap. Both tiers stream, so this bounds the decoded image, not a message. */
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

/** Thrown when a response's Content-Type rules it out as an image. */
export class NotAnImageError extends Error {
  constructor(contentType: string) {
    super(`Refusing to fetch ${contentType}: not an image`);
    this.name = "NotAnImageError";
  }
}

/** Thrown when a public page asks the background to reach into a private network. */
export class PrivateAddressError extends Error {
  constructor(hostname: string) {
    super(`Refusing to fetch ${hostname} for a page that can't reach it`);
    this.name = "PrivateAddressError";
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
 * Generic binary types. Plenty of CDNs and object stores label a GIF
 * `application/octet-stream`, so those are let through and left to the byte
 * sniff in the decoder; a missing header is treated the same way.
 */
const OPAQUE_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/x-binary",
]);

/**
 * Refuse anything the response itself says is not an image, before buffering it.
 * Without this the background downloads an HTML error page, or the 200 MB video
 * behind a `.gif` URL, in full and only then fails the sniff. Deliberately not
 * a strict `image/*` requirement — see `OPAQUE_TYPES`.
 */
export function assertImageContentType(response: Response): void {
  const header = response.headers.get("content-type");
  if (header == null) return;
  const type = header.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "" || type.startsWith("image/") || OPAQUE_TYPES.has(type)) return;
  throw new NotAnImageError(type);
}

/**
 * Is `hostname` (as `URL.hostname` gives it) somewhere only this machine or this
 * network can reach? Covers loopback, the RFC 1918 / CGNAT / link-local IPv4
 * ranges, IPv6 loopback, unique-local and link-local, and the names that can't
 * resolve publicly: `localhost`, mDNS `.local`, and any single-label host
 * (`http://intranet/…`).
 *
 * Approximate by design — it is a policy check, not a resolver, and DNS can
 * still point a public name at a private address. It stops the obvious case.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "") return true; // e.g. a file: page
  if (host.startsWith("[")) {
    const addr = host.slice(1, -1);
    if (addr === "::" || addr === "::1") return true;
    if (/^f[cd]/.test(addr)) return true; // fc00::/7, unique-local
    if (/^fe[89ab]/.test(addr)) return true; // fe80::/10, link-local
    // ::ffff:10.0.0.1 and friends — judge the embedded IPv4 address.
    const mapped = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    return mapped?.[1] != null && isPrivateHost(mapped[1]);
  }
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !host.includes(".")
  );
}

/**
 * Guard the background tier against being used as a proxy into the user's
 * private network. The page hands Jiffy the URL; a page on the public web that
 * points an <img> at `http://10.0.0.5/report.gif` could never read those bytes
 * itself, and the background fetch must not read them on its behalf. A page
 * that is *already* on a private host keeps working — it can reach its own
 * network anyway.
 *
 * Only http(s) is checked: `data:` carries its bytes inline and has no host.
 */
export function assertReachableFromPage(url: URL, pageUrl: string | undefined): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (!isPrivateHost(url.hostname)) return;
  try {
    if (pageUrl != null && isPrivateHost(new URL(pageUrl).hostname)) return;
  } catch {
    // Unparseable sender URL — treat the page as public and refuse.
  }
  throw new PrivateAddressError(url.hostname);
}

/**
 * Stream a response body, aborting if it exceeds `maxBytes`. Yielding as the
 * chunks arrive lets the background forward them without ever holding the whole
 * image, and rejects an oversized body without buffering it (catching servers
 * that omit or understate Content-Length). Falls back to buffering when the
 * response exposes no readable stream.
 */
export async function* readCappedChunks(
  response: Response,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new ImageTooLargeError(maxBytes);
    yield new Uint8Array(buf);
    return;
  }
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new ImageTooLargeError(maxBytes);
      yield value;
    }
  } finally {
    // Covers the cap, a thrown consumer and an early `break` alike.
    await reader.cancel().catch(() => {});
  }
}

/** Join `chunks`, whose lengths are already known to sum to `total`. */
export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Read a whole response body into an ArrayBuffer, capped at `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readCappedChunks(response, maxBytes)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return concatBytes(chunks, total).buffer;
}
