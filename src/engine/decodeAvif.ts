// Animated AVIF decoder — WebCodecs ImageDecoder strategy.
//
// AVIF wraps AV1 bitstreams in the ISOBMFF container. Real animated AVIFs are
// inter-coded: every frame after the first references earlier frames, so a single
// sample can't be decoded in isolation — only a decoder that maintains
// reference-frame state across the whole sequence yields correct pixels. The
// browser-native WebCodecs `ImageDecoder` does exactly that: it demuxes the
// container and decodes any frame by index, inter-frames included. We snapshot
// each decoded VideoFrame onto an OffscreenCanvas → ImageBitmap so playback and
// seek stay O(1), matching the GIF/WebP/APNG decoders' output contract.
//
// This is why we don't hand-roll an ISOBMFF demux + per-frame re-wrap like
// decodeWebP/decodeApng do: that approach only works for all-intra AVIF (rare in
// the wild) and produces undecodable inter-frames. ImageDecoder sidesteps both
// the container parsing and the AV1 decoding.
//
// Availability: ImageDecoder ships in Chromium and Safari; Firefox does not yet
// support it in stable. When it's unavailable decodeAvif throws, and the content
// pipeline (which catches per-image decode failures) simply leaves the image as
// the browser's own native AVIF animation — no jiffy controls, but no breakage.

import { MIN_DELAY_MS, type DecodeResult, type Frame } from './types';

// Fallback per-frame delay when the decoder reports no per-frame duration.
const DEFAULT_DELAY_MS = 100;

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
  if (readCC(v, 4) !== 'ftyp') return false;
  const ftypSize = Math.min(new DataView(bytes, 0, 4).getUint32(0, false), bytes.byteLength);
  if (readCC(v, 8) === 'avis') return true; // major brand
  // Compatible brands: 4-byte tags from offset 16 to the end of the ftyp box.
  for (let o = 16; o + 4 <= ftypSize; o += 4) {
    if (readCC(v, o) === 'avis') return true;
  }
  return false;
}

/** True if the runtime can decode AVIF frames via WebCodecs ImageDecoder. */
export function canDecodeAvif(): boolean {
  return typeof ImageDecoder !== 'undefined';
}

/** Decode an animated AVIF into pre-composited full-canvas frames + duration. */
export async function decodeAvif(bytes: ArrayBuffer): Promise<DecodeResult> {
  if (!canDecodeAvif()) {
    throw new Error('decodeAvif: WebCodecs ImageDecoder is unavailable in this browser');
  }

  const decoder = new ImageDecoder({ data: bytes, type: 'image/avif' });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) throw new Error('decodeAvif: no image track');
    const frameCount = track.frameCount;
    if (!frameCount) throw new Error('decodeAvif: zero frames');

    // Canvas is sized from the first decoded frame's display dimensions.
    let canvas: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    const frames: Frame[] = [];
    let elapsed = 0;

    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      // VideoFrame.duration is microseconds; read it before closing the frame.
      const durationUs = image.duration;
      if (!ctx) {
        canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('decodeAvif: failed to acquire 2D context');
      }
      // Each ImageDecoder frame is already fully composited, so just clear and
      // draw it whole (clear so any transparency copies rather than blends).
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx.drawImage(image, 0, 0);
      image.close(); // release the VideoFrame's backing memory promptly

      const durationMs = durationUs != null ? durationUs / 1000 : DEFAULT_DELAY_MS;
      const delay = Math.max(Math.round(durationMs), MIN_DELAY_MS);
      elapsed += delay;
      frames.push({ bitmap: await createImageBitmap(canvas!), time: elapsed, delay });
    }

    return { frames, duration: elapsed };
  } finally {
    decoder.close();
  }
}
