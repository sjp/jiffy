// Pixel-equivalence test for the keyframe frame source.
//
// The whole point of ./frameSource is that a frame recomposited from the nearest
// keyframe is indistinguishable from one that was composited straight through.
// `keyframeInterval: 1` makes every frame a keyframe — i.e. exactly the old
// "one full-canvas bitmap per frame" behaviour — so the two paths can be pinned
// to each other: build the same animation both ways and compare every frame,
// pixel for pixel, across the access patterns playback actually produces
// (forward, reverse, ping-pong, scrub).
//
// Run: `npm test`. Uses the software canvas from ../test/fakeCanvas, so the
// compositing really happens; both paths share it, so what's under test is the
// keyframe/replay logic rather than the canvas.

import assert from "node:assert/strict";

import { FakeImageBitmap, FakePixelBlob, installFakeCanvas, pixelAt } from "../test/fakeCanvas.ts";

installFakeCanvas();

const {
  createFrameSource,
  createBitmapSource,
  keyframeCount,
  patchBytes,
  DISPOSE_BACKGROUND,
  DISPOSE_NONE,
  DISPOSE_PREVIOUS,
} = await import("./frameSource.ts");
type FrameStep = import("./frameSource.ts").FrameStep;

// ---- a synthetic animation ------------------------------------------------
// Deterministic pseudo-random steps (a plain LCG — same sequence every run) that
// exercise every branch of the disposal state machine: partial rects, the three
// disposal ops, overwrite blending, and a transparent palette index.

const WIDTH = 9;
const HEIGHT = 7;
const FRAME_COUNT = 25;

let seed = 0x2f6e2b1;
const rand = (n: number): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed % n;
};

// 4 colours; index 3 is transparent, so patches punch holes as well as paint.
const PALETTE = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
const TRANSPARENT_INDEX = 3;

function randomStep(): FrameStep {
  const x = rand(WIDTH);
  const y = rand(HEIGHT);
  const width = 1 + rand(WIDTH - x);
  const height = 1 + rand(HEIGHT - y);
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = rand(4);
  // Weighted so plain frames dominate (as in real animations) while both
  // restore ops still appear several times over the sequence.
  const roll = rand(10);
  return {
    patch: {
      kind: "indexed",
      pixels,
      palette: PALETTE,
      transparentIndex: TRANSPARENT_INDEX,
    },
    x,
    y,
    width,
    height,
    clear: rand(4) === 0,
    dispose: roll < 6 ? DISPOSE_NONE : roll < 8 ? DISPOSE_BACKGROUND : DISPOSE_PREVIOUS,
  };
}

const steps: FrameStep[] = Array.from({ length: FRAME_COUNT }, randomStep);
// Guard the fixture itself: a run where the weighting produced no restore ops
// would pass without testing the interesting paths.
assert.ok(
  steps.some((s) => s.dispose === DISPOSE_PREVIOUS),
  "fixture exercises restore-to-previous",
);
assert.ok(
  steps.some((s) => s.dispose === DISPOSE_BACKGROUND),
  "fixture exercises restore-to-background",
);
assert.ok(
  steps.some((s) => s.clear),
  "fixture exercises overwrite blending",
);

const build = (keyframeInterval: number) =>
  createFrameSource({
    width: WIDTH,
    height: HEIGHT,
    steps,
    seedFill: "rgb(10,20,30)",
    keyframeInterval,
  });

// ---- reference: every frame a keyframe (the old all-bitmap behaviour) -----

const reference = await build(1);
assert.equal(reference.width, WIDTH, "source reports canvas width");
assert.equal(reference.height, HEIGHT, "source reports canvas height");
assert.equal(reference.frameCount, FRAME_COUNT, "source reports frame count");

const expected: FakeImageBitmap[] = [];
for (let i = 0; i < FRAME_COUNT; i++) {
  const bitmap = await reference.getBitmap(i);
  expected.push(new FakeImageBitmap(bitmap as unknown as FakeImageBitmap));
}

// The reference holds every frame, so nothing is ever recomposited: each request
// is answered synchronously.
assert.ok(
  !(reference.getBitmap(7) instanceof Promise),
  "an all-keyframe source answers synchronously",
);

/** Assert frame `i` of `actual` matches the reference, pixel for pixel. */
function assertFrameMatches(actual: unknown, i: number, label: string): void {
  const got = actual as FakeImageBitmap;
  const want = expected[i]!;
  assert.equal(got.width, want.width, `${label}: frame ${i} width`);
  assert.equal(got.height, want.height, `${label}: frame ${i} height`);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      assert.deepEqual(
        pixelAt(got, x, y),
        pixelAt(want, x, y),
        `${label}: frame ${i} pixel (${x},${y})`,
      );
    }
  }
}

// ---- the keyframe path, over every access pattern playback produces -------

for (const interval of [2, 4, 8, 16, 64]) {
  const source = await build(interval);
  assert.equal(source.frameCount, FRAME_COUNT, `interval ${interval}: frame count`);

  const forward = Array.from({ length: FRAME_COUNT }, (_, i) => i);
  const reverse = [...forward].reverse();
  // Ping-pong turns around at both ends; scrub jumps around at random.
  const pingpong = [...forward, ...reverse, ...forward];
  const scrub = Array.from({ length: 60 }, () => rand(FRAME_COUNT));
  // A frame asked for twice in a row must come back identical (cache hit).
  const repeats = forward.flatMap((i) => [i, i]);

  const orders: Array<[string, number[]]> = [
    ["forward", forward],
    ["reverse", reverse],
    ["pingpong", pingpong],
    ["scrub", scrub],
    ["repeats", repeats],
  ];
  for (const [name, order] of orders) {
    for (const i of order) {
      assertFrameMatches(await source.getBitmap(i), i, `interval ${interval} ${name}`);
    }
  }

  // Out-of-range indices clamp rather than throwing or returning undefined.
  assertFrameMatches(await source.getBitmap(-5), 0, `interval ${interval} clamp-low`);
  assertFrameMatches(
    await source.getBitmap(FRAME_COUNT + 5),
    FRAME_COUNT - 1,
    `interval ${interval} clamp-high`,
  );

  source.close();
}

// ---- keyframes really are the only bitmaps retained ----------------------

const counted = await build(8);
// Every bitmap the source ever produced, so we can check what close() releases.
const produced: FakeImageBitmap[] = [];
for (let i = 0; i < FRAME_COUNT; i++)
  produced.push((await counted.getBitmap(i)) as FakeImageBitmap);

const keyframes = produced.filter((_, i) => i % 8 === 0);
assert.equal(keyframes.length, keyframeCount(FRAME_COUNT, 8), "one keyframe per interval");
assert.ok(
  keyframes.every((b) => !b.closed),
  "keyframes survive playback",
);

counted.close();
assert.ok(
  keyframes.every((b) => b.closed),
  "close() releases every keyframe bitmap",
);
// Recomposited frames are cached, so the most recent ones are still live at
// close() time and must be released too.
assert.ok(produced[FRAME_COUNT - 1]!.closed, "close() releases cached recomposited frames as well");
// A closed source has nothing left to hand out.
await assert.rejects(
  async () => counted.getBitmap(3),
  /closed/,
  "a closed source refuses to recomposite",
);

// ---- blob patches take the same path ------------------------------------
// WebP/APNG retain a compressed sub-image rather than indexed pixels; the
// staging step differs but the disposal state machine must not.

const solid = (r: number, g: number, b: number, a: number, w: number, h: number) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }
  return new FakePixelBlob(w, h, data) as unknown as Blob;
};

const blobSteps: FrameStep[] = [
  {
    patch: { kind: "blob", blob: solid(200, 0, 0, 255, 4, 4) },
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    clear: false,
    dispose: DISPOSE_BACKGROUND,
  },
  {
    patch: { kind: "blob", blob: solid(0, 200, 0, 128, 2, 2) },
    x: 1,
    y: 1,
    width: 2,
    height: 2,
    clear: false,
    dispose: DISPOSE_NONE,
  },
  {
    patch: { kind: "blob", blob: solid(0, 0, 200, 255, 2, 2) },
    x: 2,
    y: 2,
    width: 2,
    height: 2,
    clear: true,
    dispose: DISPOSE_PREVIOUS,
  },
  {
    patch: { kind: "blob", blob: solid(200, 200, 0, 255, 3, 1) },
    x: 0,
    y: 3,
    width: 3,
    height: 1,
    clear: false,
    dispose: DISPOSE_NONE,
  },
];

const blobRef = await createFrameSource({
  width: 4,
  height: 4,
  steps: blobSteps,
  keyframeInterval: 1,
});
const blobKeyed = await createFrameSource({
  width: 4,
  height: 4,
  steps: blobSteps,
  keyframeInterval: 2,
});
for (let i = blobSteps.length - 1; i >= 0; i--) {
  const want = (await blobRef.getBitmap(i)) as FakeImageBitmap;
  const got = (await blobKeyed.getBitmap(i)) as FakeImageBitmap;
  assert.deepEqual([...got.data], [...want.data], `blob patches: frame ${i}`);
}
blobRef.close();
blobKeyed.close();

// ---- an aborted build leaves nothing behind ------------------------------

// The build checks the signal once per frame, so an already-aborted signal bails
// on the first frame — and the keyframes captured so far are closed, not leaked.
const ac = new AbortController();
ac.abort();
await assert.rejects(
  () =>
    createFrameSource({
      width: WIDTH,
      height: HEIGHT,
      steps,
      keyframeInterval: 4,
      signal: ac.signal,
    }),
  (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  "an aborted signal rejects the build with AbortError",
);

// Abort partway: every keyframe captured before the abort must be released.
const midway = new AbortController();
const captured: FakeImageBitmap[] = [];
const realCreateImageBitmap = globalThis.createImageBitmap;
(globalThis as Record<string, unknown>).createImageBitmap = async (source: unknown) => {
  const bitmap = (await realCreateImageBitmap(source as ImageBitmapSource)) as FakeImageBitmap;
  captured.push(bitmap);
  if (captured.length === 2) midway.abort();
  return bitmap as unknown as ImageBitmap;
};
await assert.rejects(
  () =>
    createFrameSource({
      width: WIDTH,
      height: HEIGHT,
      steps,
      keyframeInterval: 4,
      signal: midway.signal,
    }),
  (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  "aborting mid-build rejects",
);
globalThis.createImageBitmap = realCreateImageBitmap;
assert.equal(captured.length, 2, "the build got two keyframes in before aborting");
assert.ok(
  captured.every((b) => b.closed),
  "a cancelled build closes the keyframes it had captured",
);

// ---- patchBytes / keyframeCount ------------------------------------------

assert.equal(
  patchBytes(steps[0]!),
  (steps[0]!.patch as { pixels: Uint8Array }).pixels.byteLength + PALETTE.byteLength,
  "indexed patch bytes = pixels + palette",
);
assert.equal(patchBytes({ ...steps[0]!, patch: null }), 0, "a patchless step costs nothing");
assert.equal(keyframeCount(0), 1, "an empty animation still costs one canvas");
assert.equal(keyframeCount(16), 1, "16 frames at interval 16 → 1 keyframe");
assert.equal(keyframeCount(17), 2, "17 frames at interval 16 → 2 keyframes");

// ---- createBitmapSource --------------------------------------------------

const bitmaps = [expected[0]!, expected[1]!].map(
  (b) => new FakeImageBitmap(b),
) as unknown as ImageBitmap[];
const plain = createBitmapSource(WIDTH, HEIGHT, bitmaps);
assert.equal(plain.frameCount, 2, "bitmap source frame count");
assert.equal(plain.getBitmap(9), bitmaps[1], "bitmap source clamps high");
assert.equal(plain.getBitmap(-1), bitmaps[0], "bitmap source clamps low");
plain.close();
assert.ok(
  (bitmaps as unknown as FakeImageBitmap[]).every((b) => b.closed),
  "bitmap source closes what it holds",
);

reference.close();

console.log("frameSource.test: OK — %d frames verified against the all-bitmap path", FRAME_COUNT);
