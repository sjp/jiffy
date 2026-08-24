// Minimal type declaration for gifuct-js, which ships without its own types.
// Covers the surface consumed by the decode module. Expand as needed.
declare module "gifuct-js" {
  export interface FrameDims {
    top: number;
    left: number;
    width: number;
    height: number;
  }

  export interface ParsedFrame {
    /** Sub-rectangle this frame patches. */
    dims: FrameDims;
    /** Frame delay, normalised to milliseconds by the library. */
    delay: number;
    /** Disposal method: how to treat the canvas before the next frame. */
    disposalType: number;
    /**
     * RGBA pixel data for this frame's rectangle (present when patches built).
     * Backed by a plain `ArrayBuffer` so it satisfies the `ImageData`
     * constructor's `ImageDataArray` (not `SharedArrayBuffer`).
     */
    patch?: Uint8ClampedArray<ArrayBuffer>;
    /** Raw colour-indexed pixels for this frame. */
    pixels: number[];
    colorTable: Array<[number, number, number]>;
    transparentIndex: number | null;
  }

  export interface ParsedGif {
    lsd: { width: number; height: number };
    frames: unknown[];
    [key: string]: unknown;
  }

  export function parseGIF(data: ArrayBuffer | Uint8Array): ParsedGif;
  export function decompressFrames(gif: ParsedGif, buildImagePatches: boolean): ParsedFrame[];
}
