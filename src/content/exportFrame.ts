// Getting one frame back out: a PNG on the clipboard, or a PNG on disk.
//
// Frame-stepping to an exact moment is only half of what people want to do with
// it — the frame they stopped on is usually the point of the exercise. The
// pixels are already composited in the FrameSource, so an export is one draw
// plus one encode: nothing is re-fetched and nothing is re-decoded.
//
// The two sinks have deliberately different shapes:
//
//   Clipboard — browsers gate a clipboard write on the user gesture that asked
//     for it, and the PNG encode is asynchronous. So the encode is handed to
//     `ClipboardItem` as a PROMISE and `write()` is called immediately, inside
//     the click, rather than after awaiting the bytes.
//   Download — a temporary `<a download>` pointed at an object URL. This needs
//     no permission at all, where the `downloads` API would.
import type { FrameSource } from "../engine/frameSource";

const PNG_TYPE = "image/png";

/** Longest stem we build a file name from; a CDN path can be absurdly long. */
const MAX_STEM_LENGTH = 64;

/** Stem used when the URL carries no meaningful name of its own. */
const DEFAULT_STEM = "frame";

/**
 * Schemes whose "file name" is an artefact rather than a name: a `data:` URL's
 * path is its payload, and a `blob:` URL's is a UUID. Neither tells the user
 * anything, so both fall back to {@link DEFAULT_STEM}.
 */
const OPAQUE_SCHEME = /^(?:data|blob):/i;

/** The slice of a frame source an export needs: full-canvas size + pixels. */
export type ExportSource = Pick<FrameSource, "width" | "height" | "getBitmap">;

/** Copy/save the frame at an index. Both reject if the export can't be done. */
export interface FrameExport {
  /** Put the frame on the clipboard as a PNG. */
  copy(index: number): Promise<void>;
  /** Download the frame as a PNG named after the image. */
  save(index: number): Promise<void>;
}

/**
 * Name for a saved frame: the image's own basename plus the frame number, e.g.
 * `https://example.com/cat.gif` frame 12 → `cat-f012.png`. The number is
 * 1-based so it matches the readout in the control bar rather than the internal
 * index, and zero-padded so a directory of saved frames sorts in play order.
 */
export function frameFileName(url: string, index: number): string {
  return `${stemFromUrl(url)}-f${String(index + 1).padStart(3, "0")}.png`;
}

/** The image's basename, reduced to something safe to hand a file system. */
function stemFromUrl(url: string): string {
  if (OPAQUE_SCHEME.test(url)) return DEFAULT_STEM;
  // Neither the query string nor the fragment is part of the name, and a
  // trailing slash leaves an empty last segment (which falls through to the
  // default below).
  const segment = (url.split(/[?#]/, 1)[0] ?? "").split("/").pop() ?? "";
  let stem = segment;
  try {
    stem = decodeURIComponent(segment);
  } catch {
    // A stray '%' makes the segment undecodable; the raw text still names it.
  }
  stem = stem
    .replace(/\.[^./]*$/, "") // drop the extension — we always write a PNG
    .replace(/[^\w.-]+/g, "-") // anything a file system might object to
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") // leading dot = hidden file; trailing dot = Windows
    .slice(0, MAX_STEM_LENGTH);
  return stem || DEFAULT_STEM;
}

/**
 * Encode one frame as a PNG. The bitmap belongs to the source (it may be a
 * retained keyframe), so it is drawn from and left alone — never closed here.
 */
export async function frameToPng(source: ExportSource, index: number): Promise<Blob> {
  // `getBitmap` answers synchronously for a resident frame and with a promise
  // for one it has to recomposite; awaiting covers both.
  const bitmap = await source.getBitmap(index);
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("exportFrame: failed to acquire 2D context");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: PNG_TYPE });
}

/**
 * Put a pending PNG on the clipboard. `png` is passed in unresolved on purpose:
 * `write()` then starts inside the click that asked for it, so browsers that
 * require a transient user activation still see one while the encode runs.
 */
async function writeToClipboard(png: Promise<Blob>): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("exportFrame: this browser can't put an image on the clipboard");
  }
  try {
    await clipboard.write([new ClipboardItem({ [PNG_TYPE]: png })]);
  } catch {
    // Not every engine accepts a still-pending promise inside a ClipboardItem;
    // the resolved blob is the portable form. If the write itself was what
    // failed, this fails the same way and the caller reports it.
    await clipboard.write([new ClipboardItem({ [PNG_TYPE]: await png })]);
  }
}

/** How long an object URL is left alive after the download has been triggered. */
const OBJECT_URL_TTL_MS = 10_000;

/** Save `blob` to the user's downloads via a throwaway anchor. */
function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel a download the browser hasn't finished
  // reading; a short grace period frees the bytes without pinning them.
  setTimeout(() => URL.revokeObjectURL(href), OBJECT_URL_TTL_MS);
}

/** Bind the export actions to one image's frames and its URL (for the name). */
export function createFrameExport(source: ExportSource, url: string): FrameExport {
  return {
    // Not `async`: the encode must be handed over unresolved (see writeToClipboard).
    copy: (index) => writeToClipboard(frameToPng(source, index)),
    save: async (index) => {
      download(await frameToPng(source, index), frameFileName(url, index));
    },
  };
}
