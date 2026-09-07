// Animated AVIF decoder — WebCodecs ImageDecoder strategy.
//
// AVIF wraps AV1 bitstreams in the ISOBMFF container. Real animated AVIFs are
// inter-coded: every frame after the first references earlier frames, so a single
// sample can't be decoded in isolation — only a decoder that maintains
// reference-frame state across the whole sequence yields correct pixels. The
// browser-native WebCodecs `ImageDecoder` does exactly that: it demuxes the
// container and decodes any frame by index, inter-frames included.
//
// That also rules out the keyframe+patch storage the other decoders use (see
// ./frameSource): there are no independent patches to replay. Instead we keep
// the `ImageDecoder` itself alive for the life of the player and re-decode by
// index on demand, holding only a small LRU of recent frames. Memory is then
// bounded by the cache rather than by the frame count, at the cost of one decode
// per displayed frame — which is what the browser does for the native <img>.
//
// The engine needs the whole timeline before playback starts, and a duration is
// something ImageDecoder only reports on a decoded frame. Rather than decode the
// sequence twice over, the delays are read from the container's own sample table
// (see "container timing" below); only a file that won't give them up pays for a
// pass over every frame, and that pass closes each VideoFrame instead of
// retaining a bitmap for it.
//
// This is why we don't hand-roll an ISOBMFF demux + per-frame re-wrap like
// decodeWebP/decodeApng do: that approach only works for all-intra AVIF (rare in
// the wild) and produces undecodable inter-frames. ImageDecoder sidesteps both
// the container parsing and the AV1 decoding.

import type { FrameSource } from "./frameSource";
import {
  assertDecodeBudget,
  bitmapBytes,
  normalizeDelay,
  throwIfAborted,
  UnsupportedFormatError,
  type DecodeResult,
  type Frame,
} from "./types";

/**
 * Decoded frames kept resident. Small enough that memory stays bounded on a
 * long animation, big enough that stepping back and forth over a few frames —
 * the common scrubbing gesture — doesn't re-decode.
 */
const CACHE_SIZE = 8;

/** The four-character box type at `offset`. Callers bounds-check first. */
function readCC(v: DataView, offset: number): string {
  return String.fromCharCode(
    v.getUint8(offset),
    v.getUint8(offset + 1),
    v.getUint8(offset + 2),
    v.getUint8(offset + 3),
  );
}

/**
 * Return true if bytes is an animated AVIF. Reads the ftyp box and treats the
 * file as animated when the major brand is 'avis' or 'avis' appears among the
 * compatible brands. (Major brand 'avif' alone is a still image.) This is a cheap
 * byte sniff — actual decode happens via ImageDecoder in decodeAvif.
 */
export function isAnimatedAvif(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 16) return false;
  const v = new DataView(bytes);
  if (readCC(v, 4) !== "ftyp") return false;
  const ftypSize = Math.min(v.getUint32(0, false), bytes.byteLength);
  if (readCC(v, 8) === "avis") return true; // major brand
  // Compatible brands: 4-byte tags from offset 16 to the end of the ftyp box.
  for (let o = 16; o + 4 <= ftypSize; o += 4) {
    if (readCC(v, o) === "avis") return true;
  }
  return false;
}

// ---- container timing ------------------------------------------------------
//
// The engine needs every frame's delay before playback can start, and
// `ImageDecoder` only reports one on a decoded `VideoFrame` — so asking the
// decoder means decoding the entire sequence before anything appears on screen,
// which on a long AVIF is the whole animation's CPU spent behind a "Loading…"
// toast.
//
// The container already knows. An AVIF sequence is an ISOBMFF movie: its track's
// `stts` box is a run-length table of sample durations, counted in the timescale
// its `mdhd` declares. Both are a few dozen bytes of a file that is already in
// memory, so the timeline costs a walk of the box tree instead of a decode pass.
//
// Strictly best-effort: anything unexpected — a shape we don't parse, a sample
// count that disagrees with the decoder — returns null and the decode pass takes
// over. Nothing here is trusted enough to be worth being wrong about.

/** A box's payload bounds within the file, `[start, end)`. */
interface Box {
  type: string;
  start: number;
  end: number;
}

/**
 * Walk the boxes directly inside `[start, end)`. Stops at the first header that
 * doesn't add up rather than guessing its way past it — a malformed tree just
 * means fewer boxes found, and the caller falls back.
 */
function* boxes(v: DataView, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    const declared = v.getUint32(offset, false);
    const type = readCC(v, offset + 4);
    let payload = offset + 8;
    let size = declared;
    if (declared === 1) {
      // size 1 → the real size is the 64-bit `largesize` after the type.
      if (payload + 8 > end) return;
      size = Number(v.getBigUint64(payload, false));
      payload += 8;
    } else if (declared === 0) {
      size = end - offset; // size 0 → runs to the end of the enclosing box
    }
    const boxEnd = offset + size;
    if (boxEnd > end || payload > boxEnd) return;
    yield { type, start: payload, end: boxEnd };
    offset = boxEnd;
  }
}

/** The first child box of `parent` with this type, or null. */
function findBox(v: DataView, parent: Box, type: string): Box | null {
  for (const box of boxes(v, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** Follow a chain of nested box types down from `parent`. */
function descend(v: DataView, parent: Box, path: readonly string[]): Box | null {
  let box: Box | null = parent;
  for (const type of path) {
    box = findBox(v, box, type);
    if (!box) return null;
  }
  return box;
}

/** The media timescale (units per second) from an `mdhd`, or null. */
function readTimescale(v: DataView, mdhd: Box): number | null {
  if (mdhd.start + 4 > mdhd.end) return null;
  const version = v.getUint8(mdhd.start);
  // version + flags (4), then creation and modification times: 4 bytes each in
  // version 0, 8 each in version 1. The timescale follows them.
  const offset = mdhd.start + 4 + (version === 1 ? 16 : 8);
  if (offset + 4 > mdhd.end) return null;
  return v.getUint32(offset, false) || null;
}

/**
 * Expand an `stts` run-length table into one delay per sample, in ms. Returns
 * null unless it describes exactly `frameCount` samples — the cross-check that
 * says this is the track `ImageDecoder` selected, and the bound that keeps a
 * bogus run length from expanding into a huge array.
 */
function readSampleDelays(
  v: DataView,
  stts: Box,
  timescale: number,
  frameCount: number,
): number[] | null {
  if (stts.start + 8 > stts.end) return null;
  const entries = v.getUint32(stts.start + 4, false); // after version + flags
  let offset = stts.start + 8;
  if (offset + entries * 8 > stts.end) return null;
  const delays: number[] = [];
  for (let i = 0; i < entries; i++) {
    const samples = v.getUint32(offset, false);
    const delta = v.getUint32(offset + 4, false);
    offset += 8;
    if (delays.length + samples > frameCount) return null;
    const ms = (delta / timescale) * 1000;
    for (let s = 0; s < samples; s++) delays.push(ms);
  }
  return delays.length === frameCount ? delays : null;
}

/**
 * Per-frame delays in ms straight from the container, or null when the file
 * doesn't give them up in a shape we're sure of.
 *
 * An AVIF sequence can carry more than one track — an alpha auxiliary track
 * alongside the colour one — so every track is tried and the sample count is
 * what identifies the one being played.
 */
function containerDelays(bytes: ArrayBuffer, frameCount: number): number[] | null {
  const v = new DataView(bytes);
  const file: Box = { type: "", start: 0, end: bytes.byteLength };
  const moov = findBox(v, file, "moov");
  if (!moov) return null;
  for (const trak of boxes(v, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = findBox(v, trak, "mdia");
    if (!mdia) continue;
    const mdhd = findBox(v, mdia, "mdhd");
    const stts = descend(v, mdia, ["minf", "stbl", "stts"]);
    if (!mdhd || !stts) continue;
    const timescale = readTimescale(v, mdhd);
    if (!timescale) continue;
    const delays = readSampleDelays(v, stts, timescale, frameCount);
    if (delays) return delays;
  }
  return null;
}

/** True if the runtime can decode AVIF frames via WebCodecs ImageDecoder. */
export function canDecodeAvif(): boolean {
  return typeof ImageDecoder !== "undefined";
}

/**
 * A frame source backed by a live `ImageDecoder`: every frame is produced by
 * asking the decoder for it again, with an LRU of recent results in front. The
 * source owns the decoder and closes it on teardown.
 */
function createDecoderSource(
  decoder: ImageDecoder,
  width: number,
  height: number,
  frameCount: number,
): FrameSource {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("decodeAvif: failed to acquire 2D context");

  const cache = new Map<number, ImageBitmap>(); // insertion-ordered → LRU
  let closed = false;
  // The one work canvas is shared, so decodes must not interleave.
  let queue: Promise<unknown> = Promise.resolve();

  const render = (i: number): Promise<ImageBitmap> => {
    const result = queue.then(async () => {
      if (closed) throw new Error("decodeAvif: source closed");
      const hit = cache.get(i);
      if (hit) return hit;
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      // Each ImageDecoder frame is already fully composited, so just clear and
      // draw it whole (clear so any transparency copies rather than blends).
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0);
      image.close(); // release the VideoFrame's backing memory promptly
      const bitmap = await createImageBitmap(canvas);
      if (closed) {
        bitmap.close();
        throw new Error("decodeAvif: source closed");
      }
      cache.set(i, bitmap);
      while (cache.size > CACHE_SIZE) {
        const oldest = cache.keys().next().value as number;
        cache.get(oldest)!.close();
        cache.delete(oldest);
      }
      return bitmap;
    });
    // The queue must survive a rejection, or one failure stalls every later frame.
    queue = result.catch(() => {});
    return result;
  };

  return {
    width,
    height,
    frameCount,
    getBitmap(index: number): ImageBitmap | Promise<ImageBitmap> {
      const i = Math.min(Math.max(Math.trunc(index), 0), frameCount - 1);
      const hit = cache.get(i);
      if (hit) {
        cache.delete(i); // re-insert → most recently used
        cache.set(i, hit);
        return hit;
      }
      return render(i);
    },
    close(): void {
      closed = true;
      for (const bitmap of cache.values()) bitmap.close();
      cache.clear();
      decoder.close();
    },
  };
}

/** A VideoFrame duration (microseconds, or absent) as a playable delay in ms. */
const durationToDelay = (durationUs: number | null): number =>
  normalizeDelay(durationUs == null ? undefined : durationUs / 1000);

/**
 * Every frame's delay in ms, in order: from the container where the sample table
 * can be read, and otherwise by decoding the sequence for the durations
 * `ImageDecoder` reports. Frame 0's duration is passed in because it has already
 * been decoded for the dimensions.
 *
 * The decode pass retains nothing — each VideoFrame is closed as soon as its
 * duration has been read.
 */
async function readDelays(
  decoder: ImageDecoder,
  bytes: ArrayBuffer,
  frameCount: number,
  firstDurationUs: number | null,
  signal?: AbortSignal,
): Promise<number[]> {
  const declared = containerDelays(bytes, frameCount);
  if (declared) return declared.map((ms) => normalizeDelay(ms));

  const delays = [durationToDelay(firstDurationUs)];
  for (let i = 1; i < frameCount; i++) {
    throwIfAborted(signal);
    const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
    // VideoFrame.duration is microseconds; read it before closing the frame.
    const durationUs = image.duration;
    image.close();
    delays.push(durationToDelay(durationUs));
  }
  return delays;
}

/** Decode an animated AVIF into a frame timeline + a decoder-backed frame source. */
export async function decodeAvif(bytes: ArrayBuffer, signal?: AbortSignal): Promise<DecodeResult> {
  if (!canDecodeAvif()) {
    // Recognised, decodable nowhere here: reported as its own kind of failure so
    // the user is told the browser can't play this format rather than being left
    // with a generic error over an image that animates fine in the page.
    throw new UnsupportedFormatError(
      "Animated AVIF",
      "decodeAvif: WebCodecs ImageDecoder is unavailable in this browser",
    );
  }

  const decoder = new ImageDecoder({ data: bytes, type: "image/avif" });
  let source: FrameSource | null = null;
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) throw new Error("decodeAvif: no image track");
    const frameCount = track.frameCount;
    if (!frameCount) throw new Error("decodeAvif: zero frames");

    throwIfAborted(signal);
    // Frame 0 is decoded whichever way the timeline is read: the canvas needs
    // the sequence's dimensions and nothing on the track reports them.
    const { image } = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const width = image.displayWidth;
    const height = image.displayHeight;
    const firstDurationUs = image.duration;
    image.close();

    // Retained memory is the LRU, not the frame count, so the budget scales with
    // the canvas alone — and it is checked before the timeline, which is the
    // part that can take a while.
    assertDecodeBudget(bitmapBytes(width, height) * CACHE_SIZE);

    const delays = await readDelays(decoder, bytes, frameCount, firstDurationUs, signal);
    const frames: Frame[] = [];
    let elapsed = 0;
    for (const delay of delays) {
      elapsed += delay;
      frames.push({ time: elapsed, delay });
    }

    source = createDecoderSource(decoder, width, height, frameCount);
    // The track's loop count, the same figure GIF/WebP/APNG take from their own
    // containers: 0 plays once, Infinity loops forever, N repeats N times. A
    // runtime that doesn't report one leaves it undefined, which lands on the
    // looping default — the common case for an animated AVIF.
    const loops = track.repetitionCount !== 0;
    return { frames, source, duration: elapsed, loops };
  } finally {
    // The source takes ownership of the decoder; close it here only when we
    // never got that far (an error, or a cancelled decode).
    if (!source) decoder.close();
  }
}
