// Headless smoke test for the decode + precompute module (issue 03).
//
// Run: `npm test` (→ node --experimental-strip-types src/engine/decode.test.ts).
//
// Node has no canvas APIs (OffscreenCanvas / createImageBitmap / ImageData), so
// we shim a minimal, non-rendering canvas surface. That means this test verifies
// the *bookkeeping* — frame count, monotonic cumulative-time array, duration,
// delay clamping, and the disposal control flow — on a real GIF decoded by
// gifuct-js, but not actual pixel output (which needs a real canvas). Pixel
// correctness is best verified manually in the browser (issue 05 onward).

import assert from 'node:assert/strict';

// ---- minimal canvas shim -------------------------------------------------

class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === 'number') {
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

class FakeCtx {
  constructor(private w: number, private h: number) {}
  clearRect() {}
  drawImage() {}
  putImageData() {}
  getImageData() {
    return new FakeImageData(this.w, this.h);
  }
}

class FakeOffscreenCanvas {
  constructor(public width: number, public height: number) {}
  getContext() {
    return new FakeCtx(this.width, this.height);
  }
}

// Install shims before invoking decode (decode only touches these inside its
// function body, so setting them now — after the static import — is fine).
const g = globalThis as Record<string, unknown>;
g.ImageData = FakeImageData;
g.OffscreenCanvas = FakeOffscreenCanvas;
g.createImageBitmap = async () => ({ close() {} });

const { decode } = await import('./decode.ts');

// ---- a real, hand-built 2-frame GIF --------------------------------------
// 2×1, 2-colour (black/white). Frame 0 = [black, white], frame 1 = [white,
// black]. Each frame's GCE delay is 10 centiseconds (gifuct normalises → 100ms).
// prettier-ignore
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,       // LSD: 2×1, global colour table (2)
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // GCT: black, white
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 0: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 0
  0x02, 0x02, 0x44, 0x05, 0x00,                   // LZW: pixels [0,1]
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE frame 1: delay=10cs
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image desc 1
  0x02, 0x02, 0x0c, 0x05, 0x00,                   // LZW: pixels [1,0]
  0x3b,                                           // trailer
]);

// ---- assertions ----------------------------------------------------------

const { frames, duration } = await decode(
  GIF.buffer.slice(GIF.byteOffset, GIF.byteOffset + GIF.byteLength),
);

assert.equal(frames.length, 2, 'frame count');

// gifuct normalises delay (10cs → 100ms); clamp leaves it ≥ 20ms.
assert.equal(frames[0]!.delay, 100, 'frame 0 delay (ms)');
assert.equal(frames[1]!.delay, 100, 'frame 1 delay (ms)');

// End-of-frame cumulative convention: monotonically increasing.
assert.equal(frames[0]!.time, 100, 'frame 0 cumulative time');
assert.equal(frames[1]!.time, 200, 'frame 1 cumulative time');
assert.ok(frames[1]!.time > frames[0]!.time, 'time array is monotonic');

// duration == final cumulative time.
assert.equal(duration, 200, 'duration');

// Every frame carries a (shimmed) full-canvas bitmap.
for (const f of frames) assert.ok(f.bitmap, 'frame has a bitmap');

console.log('decode.test: OK — %d frames, duration %dms', frames.length, duration);
