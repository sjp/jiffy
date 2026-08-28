// Headless tests for the frame export: file-name derivation, the PNG encode
// (through the software canvas in ../test/fakeCanvas), and the two sinks —
// clipboard write and <a download> — with their platform APIs stubbed.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { FakeImageBitmap, installFakeCanvas } from "../test/fakeCanvas.ts";
import { createFrameExport, frameFileName, frameToPng } from "./exportFrame.ts";

installFakeCanvas();

// ---- file names ------------------------------------------------------------
// Frame numbers are 1-based (matching the readout) and zero-padded to three, so
// a directory of saved frames sorts in play order.
assert.equal(frameFileName("https://example.com/cat.gif", 0), "cat-f001.png");
assert.equal(frameFileName("https://example.com/cat.gif", 11), "cat-f012.png");
assert.equal(frameFileName("https://example.com/cat.gif", 999), "cat-f1000.png");

// The query string and fragment name nothing; the extension is replaced.
assert.equal(frameFileName("https://cdn.example.com/a/b/dance.webp?v=3#x", 0), "dance-f001.png");
assert.equal(frameFileName("https://example.com/no-extension", 0), "no-extension-f001.png");

// Percent-encoding is a transport detail; an undecodable one falls back to the
// raw segment rather than throwing.
assert.equal(frameFileName("https://example.com/happy%20cat.gif", 0), "happy-cat-f001.png");
assert.equal(frameFileName("https://example.com/100%.gif", 0), "100-f001.png");

// Anything the file system might object to is folded into '-'; leading dots
// (hidden files) and trailing dots (Windows) are trimmed.
assert.equal(frameFileName("https://example.com/a:b*c?.gif", 0), "a-b-c-f001.png");
assert.equal(frameFileName("https://example.com/.hidden.gif", 0), "hidden-f001.png");

// Names that carry nothing usable, and schemes whose path is an artefact
// rather than a name, fall back to a generic stem.
assert.equal(frameFileName("https://example.com/gallery/", 0), "frame-f001.png");
assert.equal(frameFileName("data:image/gif;base64,R0lGODlh", 0), "frame-f001.png");
assert.equal(frameFileName("blob:https://example.com/0e4a-11ee", 0), "frame-f001.png");

// A CDN path can be absurdly long; the stem is capped.
const long = frameFileName(`https://example.com/${"x".repeat(300)}.gif`, 0);
assert.equal(long.length, 64 + "-f001.png".length, "stem is truncated");

// ---- encoding a frame ------------------------------------------------------
// A source whose frames are 2x2 bitmaps; frame 1 answers with a promise, as a
// real source does for a frame it has to recomposite.
const bitmapFor = (index: number) =>
  new FakeImageBitmap({
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(16).fill(index + 1),
  });
let requested: number[] = [];
const source = {
  width: 2,
  height: 2,
  getBitmap(index: number) {
    requested.push(index);
    const bitmap = bitmapFor(index);
    return index === 1 ? Promise.resolve(bitmap) : bitmap;
  },
};

const png = await frameToPng(source, 0);
assert.equal(png.type, "image/png", "encodes as PNG");
assert.equal(png.size, 2 * 2 * 4, "the whole canvas is encoded");
assert.deepEqual(requested, [0], "asked the source for exactly the frame requested");

// The frame belongs to the source, so the export must leave it open for playback.
const owned = bitmapFor(0);
await frameToPng({ width: 2, height: 2, getBitmap: () => owned }, 0);
assert.equal(owned.closed, false, "the source's bitmap is drawn from, not consumed");

// A frame that has to be recomposited (promise) works the same way.
requested = [];
assert.equal((await frameToPng(source, 1)).size, 2 * 2 * 4, "awaits an async frame");
assert.deepEqual(requested, [1]);

// ---- clipboard -------------------------------------------------------------
// Stand-in for the platform clipboard, recording what it was handed.
interface Written {
  types: string[];
  data: unknown;
}
let written: Written[] = [];
let writeError: Error | null = null;
let writesStarted = 0;

class FakeClipboardItem {
  constructor(readonly items: Record<string, unknown>) {}
}
const globals = globalThis as Record<string, unknown>;
globals.ClipboardItem = FakeClipboardItem;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    async write(items: FakeClipboardItem[]): Promise<void> {
      writesStarted++;
      if (writeError) throw writeError;
      for (const item of items) {
        for (const [type, data] of Object.entries(item.items)) {
          written.push({ types: [type], data: await data });
        }
      }
    },
  },
});

const exporter = createFrameExport(source, "https://example.com/cat.gif");

// The write must start while the click's user activation is still live, so the
// PNG goes into the ClipboardItem as a pending promise rather than being
// awaited first: the clipboard is called before the encode has resolved.
const copying = exporter.copy(0);
assert.equal(writesStarted, 1, "clipboard.write is called synchronously with the copy");
await copying;
assert.equal(written.length, 1, "one clipboard item written");
assert.deepEqual(written[0]!.types, ["image/png"], "written as a PNG");
assert.equal((written[0]!.data as Blob).size, 2 * 2 * 4, "carries the encoded frame");

// An engine that refuses a pending promise inside a ClipboardItem gets a second
// attempt with the resolved blob.
written = [];
writesStarted = 0;
let firstWrite = true;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    async write(items: FakeClipboardItem[]): Promise<void> {
      writesStarted++;
      if (firstWrite) {
        firstWrite = false;
        throw new TypeError("promise values are not supported");
      }
      for (const item of items) {
        for (const [type, data] of Object.entries(item.items)) {
          assert.ok(data instanceof Blob, "the retry hands over a resolved blob");
          written.push({ types: [type], data });
        }
      }
    },
  },
});
await exporter.copy(0);
assert.equal(writesStarted, 2, "retried once");
assert.equal(written.length, 1, "the retry put the frame on the clipboard");

// A clipboard that can't take images at all rejects, so the caller can say so.
Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
await assert.rejects(() => exporter.copy(0), /clipboard/, "no clipboard → rejects");

// ---- download --------------------------------------------------------------
// The anchor click would navigate in jsdom; intercept it to observe the
// download instead (and to keep the virtual console quiet).
let clicked: { download: string; href: string } | null = null;
document.addEventListener(
  "click",
  (event) => {
    const anchor = event.target as HTMLAnchorElement;
    clicked = { download: anchor.download, href: anchor.href };
    event.preventDefault();
  },
  true,
);

const revoked: string[] = [];
let objectUrls = 0;
globals.URL = Object.assign(URL, {
  createObjectURL: () => `blob:test/${++objectUrls}`,
  revokeObjectURL: (url: string) => revoked.push(url),
});

// Capture the deferred revoke instead of waiting out its real delay.
const realSetTimeout = globalThis.setTimeout;
let deferred: (() => void) | null = null;
globals.setTimeout = (fn: () => void, ms: number) => {
  deferred = fn;
  assert.ok(ms > 0, "the revoke is deferred, not queued for the next tick");
  return 0;
};
await exporter.save(4);
globals.setTimeout = realSetTimeout;

assert.ok(clicked, "the download was triggered");
assert.equal(clicked!.download, "cat-f005.png", "named after the image and the frame");
assert.equal(clicked!.href, "blob:test/1", "points at the encoded frame");
assert.equal(document.querySelector("a[download]"), null, "the anchor is not left behind");

// The object URL is released, but only after the browser has had a chance to
// start reading it — revoking inline can cancel the download.
assert.deepEqual(revoked, [], "not revoked while the download is starting");
assert.ok(deferred, "a revoke was scheduled");
deferred!();
assert.deepEqual(revoked, ["blob:test/1"], "the blob is released afterwards");

console.log("exportFrame.test: OK");
