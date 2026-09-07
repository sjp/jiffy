// Module declaration for gifuct-js.
//
// The package does ship an `index.d.ts`, but it declares the per-frame Graphic
// Control Extension fields (`delay`, `disposalType`, `transparentIndex`) as
// always present. They are not: a frame with no GCE — every GIF87a frame, and
// any GIF89a frame needing neither transparency nor a delay — leaves all three
// `undefined`, which is what put `NaN` on the timeline (issue 02). This
// declaration shadows the shipped one so the optionality is visible to the
// compiler; the block shapes below otherwise mirror it.
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
    /**
     * Frame delay in ms. All three of these come from the frame's Graphic
     * Control Extension, which is optional — GIF87a has none at all — and the
     * library leaves them `undefined` when the frame carries no GCE.
     */
    delay?: number;
    /** Disposal method: how to treat the canvas before the next frame. */
    disposalType?: number;
    /**
     * RGBA pixel data for this frame's rectangle (present when patches built).
     * Backed by a plain `ArrayBuffer` so it satisfies the `ImageData`
     * constructor's `ImageDataArray` (not `SharedArrayBuffer`).
     */
    patch?: Uint8ClampedArray<ArrayBuffer>;
    /** Raw colour-indexed pixels for this frame. */
    pixels: number[];
    colorTable: Array<[number, number, number]>;
    transparentIndex?: number | null;
  }

  /**
   * An image block — one frame, still LZW-compressed. Only the descriptor is
   * declared here: `width`/`height` is the patch's real size, known from
   * `parseGIF` alone before anything is decompressed, which is what lets the
   * decode budget cost a GIF exactly.
   */
  export interface GifImageBlock {
    image: {
      descriptor: FrameDims & { lct: { exists: boolean } };
    };
  }

  /** An application extension block — NETSCAPE2.0 (looping) and friends. */
  export interface GifApplicationBlock {
    application: { id: string; blocks: number[] };
  }

  /**
   * `parseGIF` keeps every block it walked, images and extensions alike, in one
   * array — so `frames.length` is not the frame count.
   */
  export type GifBlock = GifImageBlock | GifApplicationBlock;

  export interface ParsedGif {
    lsd: { width: number; height: number };
    frames: GifBlock[];
    [key: string]: unknown;
  }

  export function parseGIF(data: ArrayBuffer | Uint8Array): ParsedGif;
  export function decompressFrames(gif: ParsedGif, buildImagePatches: boolean): ParsedFrame[];
}
