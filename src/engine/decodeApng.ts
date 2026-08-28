// Animated PNG (APNG) decoder — same engine shape as GIF/WebP.
//
// APNG extends PNG with three extra chunk types:
//   acTL  Animation Control: num_frames, num_plays
//   fcTL  Frame Control:     position, size, delay, disposal, blend
//   fdAT  Frame Data:        compressed pixels (like IDAT but with a 4-byte seq prefix)
//
// Strategy mirrors decodeWebP: parse chunks once and reconstruct each frame as
// a standalone PNG blob. Those blobs are what we retain — the compressed
// sub-image, far smaller than its pixels — and ./frameSource composites them,
// keeping a full-canvas bitmap only every KEYFRAME_INTERVAL frames and decoding
// the rest on demand. CRC-32 is required here (unlike WebP RIFF) because the
// browser PNG decoder validates chunk checksums.
//
// APNG disposal ops (per APNG spec §4.3):
//   0 NONE        leave the canvas unchanged after this frame
//   1 BACKGROUND  clear frame region to transparent black after this frame
//   2 PREVIOUS    restore frame region to state before this frame was drawn
//
// APNG blend ops:
//   0 SOURCE  all components (incl. alpha) overwrite — clear-then-draw
//   1 OVER    alpha-blend onto canvas (drawImage default / source-over)

import {
  createFrameSource,
  keyframeCount,
  patchBytes,
  DISPOSE_BACKGROUND,
  DISPOSE_NONE,
  DISPOSE_PREVIOUS,
  type Dispose,
  type FrameStep,
} from "./frameSource";
import {
  MIN_DELAY_MS,
  assertDecodeBudget,
  bitmapBytes,
  type DecodeResult,
  type Frame,
} from "./types";

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const DISPOSE_OP_BACKGROUND = 1;
const DISPOSE_OP_PREVIOUS = 2;
const BLEND_OP_SOURCE = 0;

// ---- CRC-32 (ISO 3309 polynomial) -----------------------------------------
// Required for writing valid IDAT chunks in reconstructed per-frame PNGs.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build a PNG chunk: [length BE][type][data][crc(type+data) BE]
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC covers type bytes (out[4..8]) + data bytes (out[8..8+len])
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

// ---- PNG chunk parsing helpers -------------------------------------------

function readU32BE(buf: ArrayBuffer, byteOffset: number): number {
  return new DataView(buf, byteOffset, 4).getUint32(0, false);
}

function readChunkType(buf: ArrayBuffer, byteOffset: number): string {
  const v = new Uint8Array(buf, byteOffset, 4);
  return String.fromCharCode(v[0]!, v[1]!, v[2]!, v[3]!);
}

interface FcTLInfo {
  width: number;
  height: number;
  x: number;
  y: number;
  delayMs: number;
  disposeOp: number;
  blendOp: number;
  payloads: Uint8Array[]; // accumulated (fdAT seq-num stripped) or IDAT payloads
}

function parseApng(buf: ArrayBuffer): {
  canvasWidth: number;
  canvasHeight: number;
  ihdrData: Uint8Array; // 13-byte IHDR payload for reuse in frame blobs
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  bkgd: Uint8Array | null;
  numPlays: number;
  frames: FcTLInfo[];
} {
  if (buf.byteLength < 8) throw new Error("decodeApng: buffer too short");
  const sigView = new Uint8Array(buf, 0, 8);
  for (let i = 0; i < 8; i++) {
    if (sigView[i] !== PNG_SIG[i]) throw new Error("decodeApng: not a PNG file");
  }

  let canvasWidth = 0;
  let canvasHeight = 0;
  let ihdrData: Uint8Array | null = null;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  let bkgd: Uint8Array | null = null;
  // acTL num_plays: 0 = infinite, N = play N times. Default to infinite.
  let numPlays = 0;
  const frames: FcTLInfo[] = [];
  let pendingFcTL: FcTLInfo | null = null;
  // True once we've seen a fcTL before the first IDAT — means IDAT is frame 0.
  let fcTLBeforeIdat = false;
  let idatSeen = false;

  let offset = 8;
  while (offset + 12 <= buf.byteLength) {
    const dataLen = readU32BE(buf, offset);
    const type = readChunkType(buf, offset + 4);
    const dataOff = offset + 8;
    // Skip the 4-byte CRC — we don't validate on parse (same as GIF/WebP decoders).
    offset += 12 + dataLen;

    if (type === "IHDR") {
      canvasWidth = readU32BE(buf, dataOff);
      canvasHeight = readU32BE(buf, dataOff + 4);
      ihdrData = new Uint8Array(buf, dataOff, dataLen).slice();
    } else if (type === "PLTE") {
      plte = new Uint8Array(buf, dataOff, dataLen).slice();
    } else if (type === "tRNS") {
      trns = new Uint8Array(buf, dataOff, dataLen).slice();
    } else if (type === "bKGD") {
      bkgd = new Uint8Array(buf, dataOff, dataLen).slice();
    } else if (type === "acTL") {
      // num_frames is informational (we rely on fcTL/fdAT structure); num_plays
      // (offset +4 in the chunk data) is the loop count, 0 = infinite.
      numPlays = readU32BE(buf, dataOff + 4);
    } else if (type === "fcTL") {
      if (pendingFcTL) frames.push(pendingFcTL);
      const dv = new DataView(buf, dataOff, dataLen);
      const delayNum = dv.getUint16(20, false);
      const delayDen = dv.getUint16(22, false);
      if (!idatSeen) fcTLBeforeIdat = true;
      pendingFcTL = {
        width: dv.getUint32(4, false),
        height: dv.getUint32(8, false),
        x: dv.getUint32(12, false),
        y: dv.getUint32(16, false),
        delayMs: Math.round((delayNum / (delayDen || 100)) * 1000),
        disposeOp: dv.getUint8(24),
        blendOp: dv.getUint8(25),
        payloads: [],
      };
    } else if (type === "IDAT") {
      idatSeen = true;
      // If a fcTL preceded the first IDAT, these bytes are frame 0's pixel data.
      // Otherwise this IDAT is the default/fallback image for non-APNG viewers.
      if (fcTLBeforeIdat && pendingFcTL) {
        pendingFcTL.payloads.push(new Uint8Array(buf, dataOff, dataLen).slice());
      }
    } else if (type === "fdAT") {
      // First 4 bytes are the sequence number — strip them.
      if (pendingFcTL && dataLen > 4) {
        pendingFcTL.payloads.push(new Uint8Array(buf, dataOff + 4, dataLen - 4).slice());
      }
    } else if (type === "IEND") {
      if (pendingFcTL) frames.push(pendingFcTL);
      break;
    }
  }

  if (!ihdrData) throw new Error("decodeApng: missing IHDR chunk");
  if (!canvasWidth || !canvasHeight) throw new Error("decodeApng: zero canvas dimensions");
  if (frames.length === 0) throw new Error("decodeApng: no animation frames found");

  return {
    canvasWidth,
    canvasHeight,
    ihdrData,
    plte,
    trns,
    bkgd,
    numPlays,
    frames,
  };
}

// Wrap a single frame's pixel data in a minimal self-contained PNG suitable
// for createImageBitmap. Uses the frame's own dimensions (from fcTL) so the
// browser decodes just the sub-image; we composite it at (frame.x, frame.y).
function makeFrameBlob(
  frame: FcTLInfo,
  ihdrData: Uint8Array, // parent image's 13-byte IHDR payload
  plte: Uint8Array | null,
  trns: Uint8Array | null,
): Blob {
  // Replace canvas dimensions with this frame's dimensions; all other IHDR
  // fields (bit depth, color type, compression, filter, interlace) are kept.
  const frameIhdr = ihdrData.slice();
  const dv = new DataView(frameIhdr.buffer, frameIhdr.byteOffset);
  dv.setUint32(0, frame.width, false);
  dv.setUint32(4, frame.height, false);

  // Concatenate all payloads (from one or more fdAT/IDAT chunks) into one IDAT.
  let totalLen = 0;
  for (const p of frame.payloads) totalLen += p.length;
  const idatPayload = new Uint8Array(totalLen);
  let off = 0;
  for (const p of frame.payloads) {
    idatPayload.set(p, off);
    off += p.length;
  }

  const parts = [
    PNG_SIG,
    makeChunk("IHDR", frameIhdr),
    ...(plte ? [makeChunk("PLTE", plte)] : []),
    ...(trns ? [makeChunk("tRNS", trns)] : []),
    makeChunk("IDAT", idatPayload),
    makeChunk("IEND", new Uint8Array(0)),
  ];
  // TypeScript 6 narrows Uint8Array<ArrayBufferLike> which isn't assignable to
  // BlobPart's ArrayBufferView<ArrayBuffer>; all chunks here use fresh ArrayBuffers.
  return new Blob(parts as unknown as BlobPart[], { type: "image/png" });
}

// ---- Public API -----------------------------------------------------------

/**
 * Return true if bytes is an animated PNG.
 * Scans PNG chunks until it finds acTL (animated) or IDAT/IEND (static).
 * Returns false for single-frame APNGs (nothing to control).
 */
export function isAnimatedPng(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 8) return false;
  const sig = new Uint8Array(bytes, 0, 8);
  for (let i = 0; i < 8; i++) if (sig[i] !== PNG_SIG[i]) return false;

  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const dataLen = readU32BE(bytes, offset);
    const type = readChunkType(bytes, offset + 4);
    if (type === "acTL") {
      if (bytes.byteLength < offset + 12) return false;
      return readU32BE(bytes, offset + 8) > 1; // num_frames > 1
    }
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + dataLen;
  }
  return false;
}

/**
 * Resolve the bKGD chunk to a CSS colour, or null when there isn't one we can
 * render. Channel values are depth-scaled, so shift them down to 8-bit.
 */
function backgroundCss(
  bkgd: Uint8Array | null,
  ihdrData: Uint8Array,
  plte: Uint8Array | null,
): string | null {
  if (!bkgd) return null;
  const colorType = ihdrData[9]!;
  const bitDepth = ihdrData[8]!;
  const shift = bitDepth > 8 ? bitDepth - 8 : 0;
  const dv = new DataView(bkgd.buffer, bkgd.byteOffset);
  if (colorType === 0 || colorType === 4) {
    // Greyscale (± alpha): single 16-bit sample.
    const v = dv.getUint16(0, false) >> shift;
    return `rgb(${v},${v},${v})`;
  }
  if (colorType === 2 || colorType === 6) {
    // Truecolor (± alpha): three 16-bit samples.
    const r = dv.getUint16(0, false) >> shift;
    const g = dv.getUint16(2, false) >> shift;
    const b = dv.getUint16(4, false) >> shift;
    return `rgb(${r},${g},${b})`;
  }
  if (colorType === 3 && plte) {
    // Indexed: single byte palette index.
    const i = bkgd[0]! * 3;
    return `rgb(${plte[i]},${plte[i + 1]},${plte[i + 2]})`;
  }
  return null;
}

const toDispose = (disposeOp: number): Dispose =>
  disposeOp === DISPOSE_OP_BACKGROUND
    ? DISPOSE_BACKGROUND
    : disposeOp === DISPOSE_OP_PREVIOUS
      ? DISPOSE_PREVIOUS
      : DISPOSE_NONE;

/** Decode an animated PNG into a frame timeline + a frame source. */
export async function decodeApng(bytes: ArrayBuffer, signal?: AbortSignal): Promise<DecodeResult> {
  const {
    canvasWidth,
    canvasHeight,
    ihdrData,
    plte,
    trns,
    bkgd,
    numPlays,
    frames: rawFrames,
  } = parseApng(bytes);

  const steps: FrameStep[] = [];
  const frames: Frame[] = [];
  let elapsed = 0;
  for (const rf of rawFrames) {
    steps.push({
      patch: { kind: "blob", blob: makeFrameBlob(rf, ihdrData, plte, trns) },
      x: rf.x,
      y: rf.y,
      width: rf.width,
      height: rf.height,
      // BLEND_OP_SOURCE: clear first so transparent pixels copy, not blend.
      clear: rf.blendOp === BLEND_OP_SOURCE,
      dispose: toDispose(rf.disposeOp),
    });
    // The reconstructed blob holds everything we need; drop the raw payloads so
    // the uncompressed-in-JS copies aren't pinned for the player's lifetime.
    rf.payloads.length = 0;
    const delay = Math.max(rf.delayMs, MIN_DELAY_MS);
    elapsed += delay;
    frames.push({ time: elapsed, delay });
  }

  // Retained cost: the keyframe bitmaps plus every frame's reconstructed PNG.
  let retained = bitmapBytes(canvasWidth, canvasHeight) * keyframeCount(steps.length);
  for (const step of steps) retained += patchBytes(step);
  assertDecodeBudget(retained);

  const source = await createFrameSource({
    width: canvasWidth,
    height: canvasHeight,
    steps,
    // bKGD seeds the canvas so transparent areas match the native <img>, but
    // APNG's BACKGROUND disposal is defined as "clear to transparent black" —
    // it does NOT repaint bKGD — so there is no dispose fill.
    seedFill: backgroundCss(bkgd, ihdrData, plte),
    signal,
  });

  // num_plays 1 = play exactly once; 0 (infinite) or ≥2 means it repeats.
  return { frames, source, duration: elapsed, loops: numPlays !== 1 };
}
