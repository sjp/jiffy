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
// The frame durations still need one pass over the whole sequence up front (the
// engine needs the full timeline before playback), but that pass closes every
// VideoFrame it decodes instead of retaining a bitmap for it.
//
// This is why we don't hand-roll an ISOBMFF demux + per-frame re-wrap like
// decodeWebP/decodeApng do: that approach only works for all-intra AVIF (rare in
// the wild) and produces undecodable inter-frames. ImageDecoder sidesteps both
// the container parsing and the AV1 decoding.

import type { FrameSource } from "./frameSource";
import {
  MIN_DELAY_MS,
  assertDecodeBudget,
  bitmapBytes,
  throwIfAborted,
  type DecodeResult,
  type Frame,
} from "./types";

// Fallback per-frame delay when the decoder reports no per-frame duration.
const DEFAULT_DELAY_MS = 100;

/**
 * Decoded frames kept resident. Small enough that memory stays bounded on a
 * long animation, big enough that stepping back and forth over a few frames —
 * the common scrubbing gesture — doesn't re-decode.
 */
const CACHE_SIZE = 8;

function readCC(v: Uint8Array, offset: number): string {
  return String.fromCharCode(v[offset]!, v[offset + 1]!, v[offset + 2]!, v[offset + 3]!);
}

/**
 * Return true if bytes is an animated AVIF. Reads the ftyp box and treats the
 * file as animated when the major brand is 'avis' or 'avis' appears among the
 * compatible brands. (Major brand 'avif' alone is a still image.) This is a cheap
 * byte sniff — actual decode happens via ImageDecoder in decodeAvif.
 */
export function isAnimatedAvif(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 16) return false;
  const v = new Uint8Array(bytes);
  if (readCC(v, 4) !== "ftyp") return false;
  const ftypSize = Math.min(new DataView(bytes, 0, 4).getUint32(0, false), bytes.byteLength);
  if (readCC(v, 8) === "avis") return true; // major brand
  // Compatible brands: 4-byte tags from offset 16 to the end of the ftyp box.
  for (let o = 16; o + 4 <= ftypSize; o += 4) {
    if (readCC(v, o) === "avis") return true;
  }
  return false;
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

/** Decode an animated AVIF into a frame timeline + a decoder-backed frame source. */
export async function decodeAvif(bytes: ArrayBuffer, signal?: AbortSignal): Promise<DecodeResult> {
  if (!canDecodeAvif()) {
    throw new Error("decodeAvif: WebCodecs ImageDecoder is unavailable in this browser");
  }

  const decoder = new ImageDecoder({ data: bytes, type: "image/avif" });
  let source: FrameSource | null = null;
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) throw new Error("decodeAvif: no image track");
    const frameCount = track.frameCount;
    if (!frameCount) throw new Error("decodeAvif: zero frames");

    // Timeline pass: the engine needs every frame's duration before playback can
    // start, and ImageDecoder only reports it on a decoded VideoFrame. Each frame
    // is closed straight away — nothing is retained here.
    const frames: Frame[] = [];
    let elapsed = 0;
    let width = 0;
    let height = 0;

    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(signal);

      const { image } = await decoder.decode({
        frameIndex: i,
        completeFramesOnly: true,
      });
      // VideoFrame.duration is microseconds; read it before closing the frame.
      const durationUs = image.duration;
      if (!width) {
        width = image.displayWidth;
        height = image.displayHeight;
      }
      image.close();

      const durationMs = durationUs != null ? durationUs / 1000 : DEFAULT_DELAY_MS;
      const delay = Math.max(Math.round(durationMs), MIN_DELAY_MS);
      elapsed += delay;
      frames.push({ time: elapsed, delay });
    }

    // Dimensions are only known once a frame has decoded. Retained memory is the
    // LRU, not the frame count, so the budget scales with the canvas alone.
    assertDecodeBudget(bitmapBytes(width, height) * CACHE_SIZE);

    source = createDecoderSource(decoder, width, height, frameCount);
    // WebCodecs ImageDecoder doesn't expose the container's loop count, so we
    // can't tell whether this AVIF is meant to repeat. Default to looping (the
    // common case, and matches the historical always-loop behaviour).
    return { frames, source, duration: elapsed, loops: true };
  } finally {
    // The source takes ownership of the decoder; close it here only when we
    // never got that far (an error, or a cancelled decode).
    if (!source) decoder.close();
  }
}
