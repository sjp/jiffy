// Headless tests for the worker-backed decode client.
//
// There is no real Worker here (or in jsdom), so this drives a fake one: the
// client's whole job is the handoff — post the bytes, hydrate what comes back,
// rebuild the typed errors the wire flattened, and decode on this thread
// whenever the worker can't or won't. All of that is testable without ever
// running the worker itself, which is just `decode()` (covered by decode.test).
//
// The blocks run in order and share one module: the way a worker is spawned only
// ever demotes (extension URL → blob URL → not at all), so the direct-path cases
// come first, then the construction failure that moves to blob URLs, and the
// give-up case last.
//
// Run: `npm test`.

import assert from "node:assert/strict";

import { installFakeCanvas, pixelAt, type FakeImageBitmap } from "../test/fakeCanvas.ts";
import { gifBytes } from "../test/gifFixture.ts";

installFakeCanvas();

// ---- fakes, installed before the module under test is imported ------------

interface Posted {
  bytes: ArrayBuffer;
}

class FakeWorker {
  static spawned: FakeWorker[] = [];
  /** URL prefix the "browser" refuses to build a worker from, as Chrome does. */
  static refuse: string | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: Posted[] = [];
  terminated = false;

  constructor(readonly url: string) {
    if (FakeWorker.refuse && url.startsWith(FakeWorker.refuse)) {
      throw new Error(`SecurityError: refused to construct a worker from ${url}`);
    }
    FakeWorker.spawned.push(this);
  }

  postMessage(message: Posted): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Announce itself the way the real worker does on startup. */
  ready(): void {
    this.onmessage?.({ data: { ready: true } });
  }

  /** Deliver the worker's decode reply. */
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Fail the way a worker that can't load or throws at the top level does. */
  fail(message: string): void {
    this.onerror?.({ message });
  }

  /** Answer with something structured clone refuses to carry across. */
  unclonable(): void {
    this.onmessageerror?.();
  }
}

/** Fetches of the worker bundle, so the blob path can be seen to happen once. */
const fetched: string[] = [];

const globals = globalThis as Record<string, unknown>;
globals.Worker = FakeWorker;
globals.browser = { runtime: { getURL: (name: string) => `test-extension://${name}` } };
globals.fetch = (url: string) => {
  fetched.push(url);
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("/* bundle */") });
};
let blobUrls = 0;
URL.createObjectURL = (() => `blob:test-page/${++blobUrls}`) as typeof URL.createObjectURL;

const { buildFrameSource } = await import("../engine/frameSource.ts");
const { NotAnimatedError } = await import("../engine/decode.ts");
const { DecodeBudgetError } = await import("../engine/types.ts");
const { decodeInWorker } = await import("./decodeInWorker.ts");

/** The last worker the client spawned. */
const latest = (): FakeWorker => FakeWorker.spawned[FakeWorker.spawned.length - 1]!;

/**
 * Let the client get as far as posting to the worker it just spawned. Spawning
 * awaits (the blob path fetches the bundle), so the handlers this drives aren't
 * attached in the same turn as the call. Microtasks only — one block replaces
 * `setTimeout` to fire the startup deadline on demand.
 */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// A 2×1 animation the "worker" claims to have decoded: frame 0 black/white,
// frame 1 the same rect repainted white/black — the shape the real GIF fixture
// produces, built here directly so the reply doesn't depend on a decode.
const palette = new Uint8Array([0, 0, 0, 255, 255, 255]); // black, white
const step = (pixels: number[]) => ({
  patch: {
    kind: "indexed" as const,
    pixels: new Uint8Array(pixels),
    palette,
    transparentIndex: -1,
  },
  x: 0,
  y: 0,
  width: 2,
  height: 1,
  clear: false,
  dispose: 0 as const,
});
const decodedSource = await buildFrameSource({
  width: 2,
  height: 1,
  steps: [step([0, 1]), step([1, 0])],
});
const decodedReply = {
  ok: true,
  frames: [
    { time: 100, delay: 100 },
    { time: 200, delay: 100 },
  ],
  duration: 200,
  loops: false,
  source: decodedSource,
};

const black: [number, number, number, number] = [0, 0, 0, 255];
const white: [number, number, number, number] = [255, 255, 255, 255];

// ---- a finished decode comes back and hydrates ----------------------------

{
  const promise = decodeInWorker(gifBytes());
  await settled();
  const worker = latest();
  assert.equal(worker.url, "test-extension://decode-worker.js", "spawned from the extension URL");
  assert.equal(worker.posted.length, 1, "the bytes were posted once");
  assert.equal(worker.posted[0]!.bytes.byteLength, gifBytes().byteLength, "bytes arrive intact");

  worker.ready();
  worker.reply(decodedReply);
  const result = await promise;

  assert.equal(result.frames.length, 2, "frames come through");
  assert.equal(result.duration, 200, "duration comes through");
  assert.equal(result.loops, false, "loop flag comes through");
  assert.equal(result.source.frameCount, 2, "the source is hydrated from the keyframes");
  assert.equal(worker.terminated, true, "the worker is terminated once it has answered");

  // Frame 0 is a keyframe (it arrived as a bitmap); frame 1 has to be replayed
  // on this thread from that keyframe plus the step — the point of the split.
  const frame0 = (await result.source.getBitmap(0)) as unknown as FakeImageBitmap;
  assert.deepEqual(pixelAt(frame0, 0, 0), black, "keyframe survived the handoff");
  assert.deepEqual(pixelAt(frame0, 1, 0), white, "keyframe survived the handoff");
  const frame1 = (await result.source.getBitmap(1)) as unknown as FakeImageBitmap;
  assert.deepEqual(pixelAt(frame1, 0, 0), white, "replayed frame is correct");
  assert.deepEqual(pixelAt(frame1, 1, 0), black, "replayed frame is correct");
  result.source.close();
}

// ---- failures keep their type across the wire -----------------------------

{
  const promise = decodeInWorker(gifBytes());
  await settled();
  latest().reply({ ok: false, failure: { kind: "not-animated", message: "not animated" } });
  await assert.rejects(
    () => promise,
    (err: unknown) => err instanceof NotAnimatedError,
    "a not-animated reply rethrows as NotAnimatedError",
  );
}

{
  const promise = decodeInWorker(gifBytes());
  await settled();
  latest().reply({
    ok: false,
    failure: { kind: "too-large", message: "too large", bytes: 1_800_000_000 },
  });
  await assert.rejects(
    () => promise,
    (err: unknown) => err instanceof DecodeBudgetError && err.bytes === 1_800_000_000,
    "a too-large reply rethrows as DecodeBudgetError, size intact",
  );
}

// ---- a format the worker can't hand back is decoded on this thread --------

{
  const promise = decodeInWorker(gifBytes());
  await settled();
  const worker = latest();
  worker.reply({ ok: false, failure: { kind: "unsupported" } });
  const result = await promise;
  assert.equal(result.frames.length, 2, "the client decoded the GIF itself");
  assert.equal(worker.terminated, true, "the worker is still torn down");
  result.source.close();
}

// ---- cancelling terminates the worker -------------------------------------

{
  const ac = new AbortController();
  const promise = decodeInWorker(gifBytes(), ac.signal);
  await settled();
  const worker = latest();
  ac.abort();
  await assert.rejects(
    () => promise,
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    "aborting rejects with AbortError",
  );
  assert.equal(worker.terminated, true, "aborting terminates the worker mid-decode");
}

// ---- a reply that can't be cloned across settles, rather than hanging -----

{
  const promise = decodeInWorker(gifBytes());
  await settled();
  const worker = latest();
  worker.ready();
  worker.unclonable();
  const result = await promise;
  assert.equal(result.frames.length, 2, "an untransferable reply falls back to decoding here");
  assert.equal(worker.terminated, true, "the worker is terminated rather than left waiting");
  result.source.close();
}

// ---- a worker that dies mid-decode falls back, and is still trusted --------

{
  const promise = decodeInWorker(gifBytes());
  await settled();
  const worker = latest();
  worker.ready();
  worker.fail("uncaught error in decode-worker.js");
  const result = await promise;
  assert.equal(result.frames.length, 2, "a dead worker falls back to decoding here");
  assert.equal(worker.terminated, true, "the dead worker is terminated");
  result.source.close();
}

{
  // One worker crashing says nothing about whether workers run here, so the
  // next decode gets one again.
  const before = FakeWorker.spawned.length;
  const promise = decodeInWorker(gifBytes());
  await settled();
  assert.equal(FakeWorker.spawned.length, before + 1, "a worker is still spawned after a crash");
  latest().ready();
  latest().reply({ ok: false, failure: { kind: "not-animated", message: "not animated" } });
  await assert.rejects(() => promise);
}

// ---- an extension URL the browser refuses falls through to a blob URL -----
// Chrome's case: `new Worker("chrome-extension://…")` throws because a content
// script counts as the page for same-origin. The bundle is web-accessible, so
// it can still be fetched and run from a `blob:` URL of the page's own origin —
// in the same decode, since the refusal costs nothing to discover.

{
  FakeWorker.refuse = "test-extension://";
  const before = FakeWorker.spawned.length;
  const promise = decodeInWorker(gifBytes());
  await settled();
  assert.equal(FakeWorker.spawned.length, before + 1, "exactly one worker got built");
  const worker = latest();
  assert.equal(worker.url, "blob:test-page/1", "spawned from a blob URL of the bundle");
  assert.deepEqual(fetched, ["test-extension://decode-worker.js"], "the bundle was fetched once");
  assert.equal(worker.posted.length, 1, "and the bytes went to it");

  worker.ready();
  worker.reply(decodedReply);
  const result = await promise;
  assert.equal(result.frames.length, 2, "the decode came back over the blob worker");
  result.source.close();
}

{
  // The blob URL outlives the worker built from it, so the next decode reuses
  // it rather than fetching and wrapping the bundle all over again.
  const promise = decodeInWorker(gifBytes());
  await settled();
  assert.equal(latest().url, "blob:test-page/1", "the same blob URL is reused");
  assert.equal(fetched.length, 1, "the bundle is not fetched again");
  latest().reply({ ok: false, failure: { kind: "not-animated", message: "not animated" } });
  await assert.rejects(() => promise);
}

// ---- a worker that never announces itself is given up on -------------------
// The startup deadline is the only guard against a context where a worker is
// constructed but silently never runs, so it's driven here rather than waited
// out: `setTimeout` is stubbed so the deadline can be fired on demand.
// With the blob URL already the last resort, this is the sticky failure that
// ends worker use altogether, so it goes last (see decodeInWorker).

{
  const realSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  globalThis.setTimeout = ((fn: () => void) => {
    expire = fn;
    return 0;
  }) as unknown as typeof setTimeout;

  let result;
  try {
    const promise = decodeInWorker(gifBytes());
    await settled();
    const worker = latest();
    assert.ok(expire, "a startup deadline was armed");
    expire(); // never said `ready`
    result = await promise;
    assert.equal(worker.terminated, true, "the silent worker is terminated");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(result.frames.length, 2, "a worker that never starts falls back to this thread");
  result.source.close();
}

{
  const before = FakeWorker.spawned.length;
  const result = await decodeInWorker(gifBytes());
  await settled();
  assert.equal(FakeWorker.spawned.length, before, "no further workers are spawned");
  assert.equal(result.frames.length, 2, "and the decode still happens");
  result.source.close();
}

console.log("decodeInWorker.test: OK");
