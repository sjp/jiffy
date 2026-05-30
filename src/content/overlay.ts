// Canvas-over-img overlay: positioning + scroll/resize sync (issue 05).

export interface Overlay {
  canvas: HTMLCanvasElement;
  /** Tear down listeners and remove the canvas. */
  destroy(): void;
}

/**
 * Position a canvas exactly over an `<img>` and keep it synced.
 * Stub — implemented in issue 05.
 */
export function createOverlay(_img: HTMLImageElement): Overlay {
  throw new Error('createOverlay: not implemented (issue 05)');
}
