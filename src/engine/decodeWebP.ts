// Animated WebP decoder.
//
// Animated WebP uses a RIFF container with ANMF chunks for each frame. Each
// frame's VP8/VP8L bitstream is extracted, wrapped in a minimal standalone WebP
// envelope, and decoded via createImageBitmap (browser-native — no WASM needed).
// Compositing mirrors the GIF decode strategy: all frames are pre-composited into
// full-canvas ImageBitmaps at load time so playback and seeking are O(1).
//
// WebP disposal/blending (per WebP Container Specification):
//   ANMF flags byte, bit 0 (Disposal):  0 = leave canvas,  1 = fill rect with bg
//   ANMF flags byte, bit 1 (Blending):  0 = alpha-blend,   1 = overwrite

import { MIN_DELAY_MS, type DecodeResult, type Frame } from "./types";

const DISPOSAL_BACKGROUND = 0x01;
const BLENDING_OVERWRITE = 0x02;

function readU24LE(buf: ArrayBuffer, byteOffset: number): number {
  const v = new Uint8Array(buf, byteOffset, 3);
  return v[0]! | (v[1]! << 8) | (v[2]! << 16);
}

function readU16LE(buf: ArrayBuffer, byteOffset: number): number {
  return new DataView(buf, byteOffset, 2).getUint16(0, true);
}

function readU32LE(buf: ArrayBuffer, byteOffset: number): number {
  return new DataView(buf, byteOffset, 4).getUint32(0, true);
}

function readCC(buf: ArrayBuffer, byteOffset: number): string {
  const v = new Uint8Array(buf, byteOffset, 4);
  return String.fromCharCode(v[0]!, v[1]!, v[2]!, v[3]!);
}

interface RawFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  durationMs: number;
  disposeToBackground: boolean;
  overwrite: boolean;
  frameData: ArrayBuffer;
}

function parseAnimatedWebP(buf: ArrayBuffer): {
  canvasWidth: number;
  canvasHeight: number;
  bgRGBA: readonly [number, number, number, number];
  loopCount: number;
  frames: RawFrame[];
} {
  if (buf.byteLength < 12) throw new Error("decodeWebP: buffer too short");
  if (readCC(buf, 0) !== "RIFF") throw new Error("decodeWebP: not a RIFF file");
  if (readCC(buf, 8) !== "WEBP") throw new Error("decodeWebP: not a WebP file");

  let canvasWidth = 0;
  let canvasHeight = 0;
  // Background colour from ANIM chunk, converted from spec BGRA to RGBA.
  let bgRGBA: readonly [number, number, number, number] = [255, 255, 255, 255];
  // ANIM loop count: 0 = infinite, N = play N times. Default to infinite.
  let loopCount = 0;
  const frames: RawFrame[] = [];
  let offset = 12;

  while (offset + 8 <= buf.byteLength) {
    const cc = readCC(buf, offset);
    const chunkSize = readU32LE(buf, offset + 4);
    const data = offset + 8;

    if (cc === "VP8X") {
      // Canvas dimensions are uint24 LE at offsets +4 and +7 within the payload.
      canvasWidth = readU24LE(buf, data + 4) + 1;
      canvasHeight = readU24LE(buf, data + 7) + 1;
    } else if (cc === "ANIM") {
      const b = new Uint8Array(buf, data, 4); // stored as B G R A
      bgRGBA = [b[2]!, b[1]!, b[0]!, b[3]!];
      loopCount = readU16LE(buf, data + 4); // u16 LE following the BGRA bytes
    } else if (cc === "ANMF") {
      const flags = new Uint8Array(buf, data + 15, 1)[0]!;
      frames.push({
        x: readU24LE(buf, data) * 2,
        y: readU24LE(buf, data + 3) * 2,
        width: readU24LE(buf, data + 6) + 1,
        height: readU24LE(buf, data + 9) + 1,
        durationMs: readU24LE(buf, data + 12),
        disposeToBackground: (flags & DISPOSAL_BACKGROUND) !== 0,
        overwrite: (flags & BLENDING_OVERWRITE) !== 0,
        frameData: buf.slice(data + 16, data + chunkSize),
      });
    }

    offset = data + chunkSize + (chunkSize & 1); // pad to even boundary
  }

  if (!canvasWidth || !canvasHeight)
    throw new Error("decodeWebP: missing VP8X canvas dimensions");
  if (frames.length === 0) throw new Error("decodeWebP: no ANMF frames found");

  return { canvasWidth, canvasHeight, bgRGBA, loopCount, frames };
}

/**
 * Wrap a frame's inner VP8/VP8L/ALPH bytes in a standalone WebP container so
 * that createImageBitmap can decode it natively.
 *
 * Simple frames (VP8 or VP8L) only need a RIFF+WEBP header prepended.
 * Frames with an alpha channel (ALPH chunk preceding VP8) also need a
 * synthesized VP8X header that declares the alpha flag and frame dimensions.
 */
function makeFrameBlob(
  frameData: ArrayBuffer,
  width: number,
  height: number,
): Blob {
  const cc = readCC(frameData, 0);

  if (cc === "VP8 " || cc === "VP8L") {
    const hdr = new Uint8Array(12);
    const dv = new DataView(hdr.buffer);
    hdr.set([0x52, 0x49, 0x46, 0x46]); // 'RIFF'
    dv.setUint32(4, 4 + frameData.byteLength, true);
    hdr.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
    return new Blob([hdr, new Uint8Array(frameData)], { type: "image/webp" });
  }

  // Extended frame (ALPH + VP8): synthesize a VP8X chunk (18 bytes total)
  // with the alpha flag set, then follow with the original frame chunks.
  const vp8x = new Uint8Array(18);
  const xdv = new DataView(vp8x.buffer);
  vp8x.set([0x56, 0x50, 0x38, 0x58]); // 'VP8X'
  xdv.setUint32(4, 10, true); // VP8X payload is always 10 bytes
  vp8x[8] = 0x10; // flags byte: ALPHA_FLAG = 0x10
  const w1 = width - 1;
  const h1 = height - 1;
  vp8x[12] = w1 & 0xff;
  vp8x[13] = (w1 >> 8) & 0xff;
  vp8x[14] = (w1 >> 16) & 0xff;
  vp8x[15] = h1 & 0xff;
  vp8x[16] = (h1 >> 8) & 0xff;
  vp8x[17] = (h1 >> 16) & 0xff;

  const hdr = new Uint8Array(12);
  const dv = new DataView(hdr.buffer);
  hdr.set([0x52, 0x49, 0x46, 0x46]);
  dv.setUint32(4, 4 + vp8x.byteLength + frameData.byteLength, true);
  hdr.set([0x57, 0x45, 0x42, 0x50], 8);
  return new Blob([hdr, vp8x, new Uint8Array(frameData)], {
    type: "image/webp",
  });
}

/** Decode animated WebP bytes into pre-composited full-canvas frames + duration. */
export async function decodeWebP(bytes: ArrayBuffer): Promise<DecodeResult> {
  const {
    canvasWidth,
    canvasHeight,
    bgRGBA,
    loopCount,
    frames: rawFrames,
  } = parseAnimatedWebP(bytes);

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("decodeWebP: failed to acquire 2D context");

  const [r, g, b, a] = bgRGBA;
  const bgCss = `rgba(${r},${g},${b},${a / 255})`;

  // Seed the canvas with the declared background colour so that transparent
  // frame areas match what the browser shows for the native <img>.
  if (a > 0) {
    ctx.fillStyle = bgCss;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  const frames: Frame[] = [];
  let elapsed = 0;
  let prev: RawFrame | null = null;

  for (const rf of rawFrames) {
    // 1. Apply the previous frame's disposal before drawing the next frame.
    if (prev?.disposeToBackground) {
      ctx.clearRect(prev.x, prev.y, prev.width, prev.height);
      if (a > 0) {
        ctx.fillStyle = bgCss;
        ctx.fillRect(prev.x, prev.y, prev.width, prev.height);
      }
    }

    // 2. Decode this frame's compressed bitstream via browser-native WebP.
    const frameBmp = await createImageBitmap(
      makeFrameBlob(rf.frameData, rf.width, rf.height),
    );

    // 3. Composite onto the work canvas.
    //    Overwrite: clear the frame rect first so the frame's transparent pixels
    //    replace whatever was underneath (clear + source-over = copy semantics).
    if (rf.overwrite) ctx.clearRect(rf.x, rf.y, rf.width, rf.height);
    ctx.drawImage(frameBmp, rf.x, rf.y);
    frameBmp.close();

    // 4. Snapshot full composited canvas → ready-to-blit bitmap.
    const bitmap = await createImageBitmap(canvas);
    const delay = Math.max(rf.durationMs, MIN_DELAY_MS);
    elapsed += delay;
    frames.push({ bitmap, time: elapsed, delay });

    prev = rf;
  }

  // loopCount 1 = play exactly once; 0 (infinite) or ≥2 means it repeats.
  return { frames, duration: elapsed, loops: loopCount !== 1 };
}

/**
 * Return true if bytes is an animated WebP.
 * Checks RIFF+WEBP signature, VP8X fourCC (required for animation), and
 * the animation flag at bit 1 of the VP8X flags byte (file offset 20).
 */
export function isAnimatedWebP(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 21) return false;
  const v = new Uint8Array(bytes);
  if (v[0] !== 0x52 || v[1] !== 0x49 || v[2] !== 0x46 || v[3] !== 0x46)
    return false; // RIFF
  if (v[8] !== 0x57 || v[9] !== 0x45 || v[10] !== 0x42 || v[11] !== 0x50)
    return false; // WEBP
  if (v[12] !== 0x56 || v[13] !== 0x50 || v[14] !== 0x38 || v[15] !== 0x58)
    return false; // VP8X
  return (v[20]! & 0x02) !== 0; // animation flag
}
