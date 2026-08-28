// A tiny software canvas for headless tests.
//
// Node has no canvas APIs, and the decoders' whole job is compositing, so the
// shims most tests used to carry (no-op clearRect/drawImage) can only check
// bookkeeping. This module implements just enough of OffscreenCanvas /
// CanvasRenderingContext2D / ImageData / createImageBitmap — an RGBA byte
// buffer, source-over `drawImage`, `clearRect`, `fillRect`, and the ImageData
// round-trip — to verify actual pixels.
//
// Only the operations engine/frameSource performs are supported; there is no
// scaling, no transform, no clipping and no path API.

/** Anything that can be drawn from: a canvas, a bitmap, or an ImageData. */
interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export class FakeImageData implements Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c ?? 1;
    }
  }
}

/** Snapshot of a canvas, as `createImageBitmap` hands back. */
export class FakeImageBitmap implements Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  closed = false;
  constructor(source: Pixels) {
    this.width = source.width;
    this.height = source.height;
    this.data = source.data.slice();
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * A Blob stand-in carrying decodable pixels, so `createImageBitmap(blob)` can
 * work in tests. The real WebP/APNG bitstreams can't be decoded in Node, so
 * tests that care about pixels build their patches with this instead.
 */
export class FakePixelBlob implements Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  size: number;
  constructor(width: number, height: number, data: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.data = data;
    this.size = data.length;
  }
}

const CSS_RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

/** Parse the `rgb()`/`rgba()` strings the decoders build, to RGBA 0-255. */
function parseColor(css: string): [number, number, number, number] {
  const m = CSS_RGB.exec(css.trim());
  if (!m) throw new Error(`fakeCanvas: unsupported colour ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4] ?? 1) * 255)];
}

/** Composite one non-premultiplied RGBA pixel over another, in place. */
function blendPixel(
  dst: Uint8ClampedArray,
  o: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
): void {
  if (sa === 255) {
    dst[o] = sr;
    dst[o + 1] = sg;
    dst[o + 2] = sb;
    dst[o + 3] = 255;
    return;
  }
  if (sa === 0) return;
  const as = sa / 255;
  const ad = dst[o + 3]! / 255;
  const ao = as + ad * (1 - as);
  if (ao === 0) {
    dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
    return;
  }
  dst[o] = Math.round((sr * as + dst[o]! * ad * (1 - as)) / ao);
  dst[o + 1] = Math.round((sg * as + dst[o + 1]! * ad * (1 - as)) / ao);
  dst[o + 2] = Math.round((sb * as + dst[o + 2]! * ad * (1 - as)) / ao);
  dst[o + 3] = Math.round(ao * 255);
}

class FakeCtx {
  fillStyle = "#000";
  constructor(private canvas: FakeOffscreenCanvas) {}

  private forEachIn(
    x: number,
    y: number,
    w: number,
    h: number,
    fn: (offset: number, sx: number, sy: number) => void,
  ): void {
    const { width, height } = this.canvas;
    const x0 = Math.max(0, Math.trunc(x));
    const y0 = Math.max(0, Math.trunc(y));
    const x1 = Math.min(width, Math.trunc(x + w));
    const y1 = Math.min(height, Math.trunc(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        fn((py * width + px) * 4, px - Math.trunc(x), py - Math.trunc(y));
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const data = this.canvas.data;
    this.forEachIn(x, y, w, h, (o) => {
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
    });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = parseColor(this.fillStyle);
    const data = this.canvas.data;
    this.forEachIn(x, y, w, h, (o) => blendPixel(data, o, r, g, b, a));
  }

  /** Source-over draw of `source` with its top-left at (x, y). No scaling. */
  drawImage(source: Pixels, x: number, y: number): void {
    const data = this.canvas.data;
    const src = source.data;
    this.forEachIn(x, y, source.width, source.height, (o, sx, sy) => {
      const s = (sy * source.width + sx) * 4;
      blendPixel(data, o, src[s]!, src[s + 1]!, src[s + 2]!, src[s + 3]!);
    });
  }

  createImageData(w: number, h: number): FakeImageData {
    return new FakeImageData(w, h);
  }

  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const out = new FakeImageData(w, h);
    const data = this.canvas.data;
    this.forEachIn(x, y, w, h, (o, sx, sy) => {
      const d = (sy * w + sx) * 4;
      out.data[d] = data[o]!;
      out.data[d + 1] = data[o + 1]!;
      out.data[d + 2] = data[o + 2]!;
      out.data[d + 3] = data[o + 3]!;
    });
    return out;
  }

  /** Replaces pixels outright (no blending), as the real putImageData does. */
  putImageData(image: FakeImageData, x: number, y: number): void {
    const data = this.canvas.data;
    this.forEachIn(x, y, image.width, image.height, (o, sx, sy) => {
      const s = (sy * image.width + sx) * 4;
      data[o] = image.data[s]!;
      data[o + 1] = image.data[s + 1]!;
      data[o + 2] = image.data[s + 2]!;
      data[o + 3] = image.data[s + 3]!;
    });
  }
}

export class FakeOffscreenCanvas implements Pixels {
  data: Uint8ClampedArray;
  private w: number;
  private h: number;
  private ctx: FakeCtx | null = null;

  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  get width(): number {
    return this.w;
  }
  // Assigning either dimension resets the drawing buffer, per the canvas spec —
  // frameSource relies on that to clear its patch staging canvas.
  set width(value: number) {
    this.w = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height(): number {
    return this.h;
  }
  set height(value: number) {
    this.h = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }

  getContext(): FakeCtx {
    this.ctx ??= new FakeCtx(this);
    return this.ctx;
  }
}

/**
 * Install the software canvas as globals. Call before importing any module that
 * touches canvas APIs (they're all read lazily inside function bodies, so a
 * static import of the module under test is still fine).
 */
export function installFakeCanvas(): void {
  const g = globalThis as Record<string, unknown>;
  g.ImageData = FakeImageData;
  g.OffscreenCanvas = FakeOffscreenCanvas;
  // A source with no pixel buffer is a structural stand-in (e.g. a Blob whose
  // real bitstream can't be decoded in Node); hand back an empty bitmap so
  // bookkeeping-only tests still run.
  g.createImageBitmap = async (source: Partial<Pixels>) =>
    new FakeImageBitmap(
      source.data ? (source as Pixels) : { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    );
}

/** Read one pixel as `[r, g, b, a]`. */
export function pixelAt(p: Pixels, x: number, y: number): [number, number, number, number] {
  const o = (y * p.width + x) * 4;
  return [p.data[o]!, p.data[o + 1]!, p.data[o + 2]!, p.data[o + 3]!];
}
