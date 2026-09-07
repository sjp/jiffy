// Headless tests for the content-script loader: the pick-mode state machine, the
// standalone-image shortcut, cross-frame pick coordination, and the lazy import
// of the player bundle. The player itself is stubbed — its pipeline is covered
// by controller.test.ts — so these tests also pin down that the bundle is never
// fetched until the user actually asks for it.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import {
  enhanceStandaloneImage,
  enterPickMode,
  exitPickMode,
  init,
  setPlayerLoader,
} from "./index.ts";

const imgWith = (src: string) => {
  const img = document.createElement("img");
  img.src = src;
  return img;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Let a rAF-throttled update (the hover highlight) run, then settle its microtasks. */
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
/**
 * Is pick mode armed here? The crosshair is one blanket `!important` rule
 * injected into <head> for the duration (a `cursor` on <html> would lose to
 * every link and lightbox thumbnail on the page).
 */
const isPicking = () =>
  [...document.head.querySelectorAll("style")].some((el) =>
    (el.textContent ?? "").includes("crosshair"),
  );

/** Text of every toast currently on the page (each lives in its own shadow root). */
const toastText = () =>
  [...document.body.querySelectorAll("div")]
    .map((el) => el.shadowRoot?.textContent ?? "")
    .join(" ");

/** The ✕ of whatever toast is on screen, if it still carries one. */
const toastCancel = () =>
  [...document.body.querySelectorAll("div")]
    .map((el) => el.shadowRoot?.querySelector(".cancel") ?? null)
    .find(Boolean) ?? null;

/** The hover highlight's host, if one is mounted (it's the shadow root with a .box). */
const highlightHost = () =>
  ([...document.body.children] as HTMLElement[]).find((el) =>
    el.shadowRoot?.querySelector(".box"),
  ) ?? null;

// ---- stub player -----------------------------------------------------------
// Stands in for the lazily-imported ./player module. `imports` counts how many
// times the loader actually reached for the bundle.
const instances = new Map<HTMLImageElement, object>();
let picked: HTMLImageElement | null = null;
let tornDown: HTMLImageElement | null = null;
let lastStatus: ((status: string) => void) | undefined;
let toreDownAll = 0;
let imports = 0;

const stubPlayer = {
  instances,
  processImage: async (img: HTMLImageElement, onStatus?: (status: string) => void) => {
    picked = img;
    lastStatus = onStatus;
    instances.set(img, {});
  },
  teardown: (img: HTMLImageElement) => {
    tornDown = img;
    instances.delete(img);
  },
  teardownAll: () => {
    toreDownAll++;
    instances.clear();
  },
} as never;

/** Install a player loader; by default one that hands over the stub immediately. */
const usePlayer = (load = async () => ({ controller: stubPlayer })) =>
  setPlayerLoader(async () => {
    imports++;
    return load();
  });

const reset = () => {
  instances.clear();
  picked = null;
  tornDown = null;
  lastStatus = undefined;
  document.body.innerHTML = "";
};

// ---- the bundle is not touched until the user asks for it ------------------
usePlayer();
assert.equal(imports, 0, "an idle page never reaches for the player bundle");

// Entering pick mode warms it: the user has declared intent, so the bundle is
// usually there by the time they click, and the pick lands with no "Loading…".
enterPickMode();
await flush();
assert.equal(imports, 1, "entering pick mode warms the player bundle");
exitPickMode();

enterPickMode();
await flush();
assert.equal(imports, 1, "a second pick reuses the loaded bundle");
exitPickMode();

// ---- pick-mode state machine -----------------------------------------------
enterPickMode();
assert.equal(isPicking(), true, "pick mode sets crosshair cursor");

// Escape cancels.
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assert.equal(isPicking(), false, "Escape exits pick mode");

// Clicking something that isn't an image cancels too — and the click is left
// alone (not swallowed) so a link still navigates.
enterPickMode();
assert.equal(isPicking(), true);
const notAnImage = document.createElement("div");
document.body.appendChild(notAnImage);
const plainClick = new window.MouseEvent("click", { bubbles: true, cancelable: true });
notAnImage.dispatchEvent(plainClick);
assert.equal(isPicking(), false, "clicking a non-image exits pick mode");
assert.equal(plainClick.defaultPrevented, false, "a cancelling click isn't swallowed");

exitPickMode(); // no-op if already exited
reset();

// ---- pick mode accepts any <img>, whatever its URL --------------------------
// There is no extension pre-filter: opaque CDN paths, signed URLs and
// blob:/data: sources are all valid picks — decode() decides if they animate.

/** Enter pick mode against the stub player and click `img`. */
const pickClick = (img: HTMLImageElement) => {
  document.body.appendChild(img);
  enterPickMode();
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  img.dispatchEvent(event);
  return event;
};

for (const url of [
  "http://cdn.example/media/abc123", // extension-less CDN path
  "http://cdn.example/image?id=7&format=gif", // extension only in the query
  "http://cdn.example/p/9f3a?sig=deadbeef", // opaque signed URL
  "blob:http://x/2f8c-4f2a", // lazy-loading library
  "data:image/gif;base64,R0lGOD", // inline bytes
  "http://x/photo.jpg", // a static-looking extension is still a pick
]) {
  reset();
  const img = imgWith(url);
  const event = pickClick(img);
  await flush();
  assert.equal(picked, img, `picked image with opaque URL: ${url}`);
  assert.equal(event.defaultPrevented, true, "the picking click is swallowed");
  assert.equal(isPicking(), false, "a pick exits pick mode");
}

// Clicking an already-enhanced image toggles it back off.
reset();
const enhanced = imgWith("http://cdn.example/media/toggle");
instances.set(enhanced, {});
pickClick(enhanced);
await flush();
assert.equal(tornDown, enhanced, "clicking an enhanced image tears it down");

// A static image surfaces the "Not an animated image" toast at the click point.
reset();
const staticImg = imgWith("http://cdn.example/media/static");
pickClick(staticImg);
await flush();
assert.equal(picked, staticImg, "the static image was still processed");
assert.ok(lastStatus, "a status reporter is handed to processImage");
lastStatus!("not-animated");
assert.match(toastText(), /Not an animated image/, "not-animated surfaces a toast");

// A format this browser has no decoder for names itself, so the message reads
// as a limit of the browser rather than as Jiffy failing on a good image.
lastStatus!("unsupported", "Animated AVIF");
assert.match(
  toastText(),
  /Animated AVIF isn't supported in this browser/,
  "unsupported surfaces a toast naming the format",
);
reset();

// ---- an image under an overlay is still picked ------------------------------
// Card layouts stack a stretched link (or a caption gradient, or our own canvas
// once the image is enhanced) over the image, so the click target is that
// overlay and closest("img") sees nothing. The click POINT is hit-tested
// instead — see ./pick. jsdom has no elementsFromPoint, so stand one in.
{
  const stackAt = new Map<string, Element[]>();
  const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
  doc.elementsFromPoint = (x, y) => stackAt.get(`${x},${y}`) ?? [];
  const at = (x: number, y: number, stack: Element[]) => stackAt.set(`${x},${y}`, stack);
  // jsdom measures everything as 0×0; pick mode skips zero-size images.
  const withBox = <T extends Element>(el: T): T => {
    el.getBoundingClientRect = () => ({ width: 200, height: 100, top: 0, left: 0 }) as DOMRect;
    return el;
  };

  reset();
  const covered = withBox(imgWith("http://x/covered.gif"));
  const link = document.createElement("a");
  link.href = "http://x/elsewhere";
  document.body.append(covered, link);
  at(40, 60, [link, covered, document.body]);

  enterPickMode();
  const overlayClick = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
  });
  link.dispatchEvent(overlayClick);
  await flush();
  assert.equal(picked, covered, "an image beneath an overlay is picked");
  // The overlay's own click must not also fire, or the page navigates away the
  // moment the pick lands.
  assert.equal(overlayClick.defaultPrevented, true, "the overlay's click is swallowed");
  assert.equal(isPicking(), false, "the pick exits pick mode");

  // Nothing under the point: the click cancels as before and is left alone.
  reset();
  const bare = document.createElement("div");
  document.body.appendChild(bare);
  enterPickMode();
  const missClick = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: 5,
    clientY: 5,
  });
  bare.dispatchEvent(missClick);
  await flush();
  assert.equal(picked, null, "a point with no image picks nothing");
  assert.equal(missClick.defaultPrevented, false, "a cancelling click still isn't swallowed");

  // A direct hit on an image the hit test can't see (a hit stack that came back
  // empty) still resolves through the click target.
  reset();
  const direct = imgWith("http://x/direct.gif");
  document.body.appendChild(direct);
  enterPickMode();
  direct.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 9, clientY: 9 }),
  );
  await flush();
  assert.equal(picked, direct, "the click target remains the fallback");

  delete doc.elementsFromPoint;
  reset();
}

// ---- hovering in pick mode outlines the image that would be picked ---------
// The crosshair says Jiffy is armed but not what it's aimed at, which on a dense
// page (or an image under an overlay) is exactly the ambiguity. The box is
// resolved with the same hit test the click uses, so what it outlines is what
// the click delivers.
{
  const stackAt = new Map<string, Element[]>();
  const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
  doc.elementsFromPoint = (x, y) => stackAt.get(`${x},${y}`) ?? [];
  const at = (x: number, y: number, stack: Element[]) => stackAt.set(`${x},${y}`, stack);
  const move = (x: number, y: number) =>
    document.dispatchEvent(
      new window.MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }),
    );

  reset();
  usePlayer();
  const target = imgWith("http://x/hover.gif");
  target.getBoundingClientRect = () => ({ top: 30, left: 60, width: 240, height: 120 }) as DOMRect;
  document.body.appendChild(target);
  at(80, 90, [target, document.body]);

  enterPickMode();
  assert.equal(highlightHost(), null, "an untouched pick mode adds nothing to the page");

  move(80, 90);
  await nextFrame();
  const boxHost = highlightHost();
  assert.ok(boxHost, "hovering an image mounts the highlight");
  assert.equal(boxHost!.style.left, "60px", "the box is placed over the image's box");
  assert.equal(boxHost!.style.top, "30px");
  assert.equal(boxHost!.style.width, "240px");
  assert.equal(boxHost!.style.height, "120px");
  assert.equal(boxHost!.style.display, "block", "the box is visible");

  // Moving off the image hides the box (the same host is kept for the next one).
  move(400, 400);
  await nextFrame();
  assert.equal(highlightHost(), boxHost, "the host is reused rather than rebuilt");
  assert.equal(boxHost!.style.display, "none", "no candidate under the pointer → no box");

  // Scrolling moves the page under a stationary cursor, so the candidate is
  // re-resolved from the last pointer position rather than left stale.
  at(400, 400, [target, document.body]);
  window.dispatchEvent(new window.Event("scroll"));
  await nextFrame();
  assert.equal(boxHost!.style.display, "block", "a scroll re-resolves the candidate");

  // Clicking picks the image the box was pointing at.
  move(80, 90);
  await nextFrame();
  target.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 80, clientY: 90 }),
  );
  await flush();
  assert.equal(picked, target, "the click picks the highlighted image");
  assert.equal(highlightHost(), null, "resolving the pick removes the highlight");

  // Nothing is left listening once pick mode is over.
  move(80, 90);
  await nextFrame();
  assert.equal(highlightHost(), null, "pointer moves after the pick draw nothing");

  // Leaving pick mode without picking clears the box too.
  reset();
  document.body.appendChild(target);
  enterPickMode();
  move(80, 90);
  await nextFrame();
  assert.ok(highlightHost(), "the box is back for the next pick");
  exitPickMode();
  assert.equal(highlightHost(), null, "exiting pick mode removes the highlight");

  delete doc.elementsFromPoint;
  reset();
}

// ---- the press is taken too, not just the click ----------------------------
// Pages open lightboxes, start drags and move focus on pointerdown/mousedown, so
// intercepting `click` alone let the page act first and the pick land on a page
// that had already changed under it. Over an image the press is swallowed;
// anywhere else it stays the page's, since the click is about to cancel anyway.
{
  const stackAt = new Map<string, Element[]>();
  const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
  doc.elementsFromPoint = (x, y) => stackAt.get(`${x},${y}`) ?? [];
  const withBox = <T extends Element>(el: T): T => {
    el.getBoundingClientRect = () => ({ width: 200, height: 100, top: 0, left: 0 }) as DOMRect;
    return el;
  };

  reset();
  usePlayer();
  const target = withBox(imgWith("http://x/press.gif"));
  const elsewhere = document.createElement("div");
  document.body.append(target, elsewhere);
  stackAt.set("40,60", [target, document.body]);

  /**
   * Dispatch a press on `el` and report whether a page listener ON THE TARGET
   * ever saw it — the capture listener sits on `document`, so stopping there is
   * exactly what keeps the page's own handlers out.
   */
  const press = (type: string, el: Element, x: number, y: number) => {
    let reached = false;
    const spy = () => (reached = true);
    el.addEventListener(type, spy);
    const event: Event =
      type === "touchstart"
        ? Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), {
            touches: [{ clientX: x, clientY: y }],
          })
        : new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    el.dispatchEvent(event);
    el.removeEventListener(type, spy);
    return { reached, prevented: event.defaultPrevented };
  };

  enterPickMode();
  for (const type of ["pointerdown", "mousedown"]) {
    const onImage = press(type, target, 40, 60);
    assert.equal(onImage.reached, false, `a ${type} over an image never reaches the page`);
    assert.equal(onImage.prevented, true, `a ${type} over an image is prevented`);

    const onNothing = press(type, elsewhere, 5, 5);
    assert.equal(onNothing.reached, true, `a ${type} elsewhere is left to the page`);
    assert.equal(onNothing.prevented, false, `a ${type} elsewhere keeps its default`);
  }

  // Touch: propagation only. Preventing a touchstart's default is what cancels
  // the compatibility click, and that click is what resolves the pick.
  const touch = press("touchstart", target, 40, 60);
  assert.equal(touch.reached, false, "a touch on an image never reaches the page");
  assert.equal(touch.prevented, false, "the touch keeps its default, so the click still comes");
  assert.equal(press("touchstart", elsewhere, 5, 5).reached, true, "a touch elsewhere passes");

  // The click that follows still resolves the pick.
  target.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
  );
  await flush();
  assert.equal(picked, target, "the press is swallowed but the click still picks");

  // And once the pick is over the page gets its presses back.
  assert.equal(press("pointerdown", target, 40, 60).reached, true, "presses resume after the pick");

  delete doc.elementsFromPoint;
  reset();
}

// ---- a first pick before the bundle arrives shows "Loading…" ---------------
// The warm-up in enterPickMode usually wins the race, but on a cold, slow load
// the click must not look like it did nothing.
{
  let release: (module: { controller: never }) => void = () => {};
  usePlayer(() => new Promise((resolve) => (release = resolve)));

  const slow = imgWith("http://x/slow.gif");
  document.body.appendChild(slow);
  enterPickMode();
  slow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await flush();
  assert.match(toastText(), /Loading…/, "the bundle load shows a loading toast");
  assert.equal(picked, null, "nothing is processed until the bundle arrives");

  release({ controller: stubPlayer });
  await flush();
  assert.equal(picked, slow, "the pick resumes once the bundle has loaded");
  reset();
}

// ---- a failed bundle load reports an error and stays retryable -------------
{
  usePlayer(() => Promise.reject(new Error("blocked")));
  const failing = imgWith("http://x/fail.gif");
  document.body.appendChild(failing);
  enterPickMode();
  failing.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(picked, null, "a failed load processes nothing");
  assert.match(toastText(), /Couldn't load this image/, "a failed load surfaces an error toast");

  // The memo is cleared on failure, so a later pick tries again rather than
  // leaving the extension permanently dead on this page.
  reset();
  usePlayer();
  const before = imports;
  const retry = imgWith("http://x/retry.gif");
  pickClick(retry);
  await flush();
  assert.ok(imports > before, "a later pick retries the import");
  assert.equal(picked, retry, "the retry succeeds");
  reset();
}

// ---- an outcome takes the toast's ✕ away -----------------------------------
// The "Loading…" toast is cancellable and the same toast is then reused for the
// outcome, so without this the ✕ would sit beside "Couldn't load this image" for
// the whole auto-dismiss with nothing left to cancel.
{
  let release: (module: { controller: never }) => void = () => {};
  usePlayer(() => new Promise((resolve) => (release = resolve)));
  reset();
  const slow = imgWith("http://x/outcome.gif");
  document.body.appendChild(slow);
  enterPickMode();
  slow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await flush();
  assert.ok(toastCancel(), "the loading toast can be cancelled");

  release({ controller: stubPlayer });
  await flush();
  assert.ok(lastStatus, "the pick resumed and reports status");
  lastStatus!("error");
  assert.match(toastText(), /Couldn't load this image/, "the same toast carries the outcome");
  assert.equal(toastCancel(), null, "the outcome drops the ✕");
  reset();
  usePlayer();
}

// ---- standalone image: toolbar toggles directly (ImageDocument) ------------
// Firefox renders a directly-opened .gif/.webp as an ImageDocument: contentType
// 'image/gif' or 'image/webp', body is a single <img>. A toolbar click toggles
// that image via enhanceStandaloneImage() instead of entering pick mode.
// Returns true on such a document (caller skips pick mode), false otherwise.
const setContentType = (value: string) =>
  Object.defineProperty(document, "contentType", { value, configurable: true });

// Normal page (not an ImageDocument): returns false → caller uses pick mode.
setContentType("text/html");
reset();
document.body.appendChild(imgWith("http://x/page.gif"));
assert.equal(enhanceStandaloneImage(), false, "normal page → not handled");
assert.equal(picked, null, "normal page is not auto-enhanced");

// Standalone GIF document: first click enhances the single <img>.
setContentType("image/gif");
reset();
const standaloneGif = imgWith("http://x/standalone.gif");
document.body.appendChild(standaloneGif);
assert.equal(enhanceStandaloneImage(), true, "standalone GIF → handled");
await flush();
assert.equal(picked, standaloneGif, "first toolbar click enhances the GIF");

// Second click toggles it back off (tears down).
assert.equal(enhanceStandaloneImage(), true, "still handled");
await flush();
assert.equal(tornDown, standaloneGif, "second toolbar click tears it down");

// Standalone WebP document.
setContentType("image/webp");
reset();
const standaloneWebP = imgWith("http://x/standalone.webp");
document.body.appendChild(standaloneWebP);
assert.equal(enhanceStandaloneImage(), true, "standalone WebP → handled");
await flush();
assert.equal(picked, standaloneWebP, "standalone WebP enhanced");

// Standalone APNG document.
setContentType("image/apng");
reset();
const standaloneApng = imgWith("http://x/standalone.apng");
document.body.appendChild(standaloneApng);
assert.equal(enhanceStandaloneImage(), true, "standalone APNG → handled");
await flush();
assert.equal(picked, standaloneApng, "standalone APNG enhanced");

// The content type is the only gate: an image document's <img> is enhanced
// whatever its URL looks like (Firefox serves these from opaque paths too).
setContentType("image/gif");
reset();
const standaloneOpaque = imgWith("http://cdn.example/media/xyz");
document.body.appendChild(standaloneOpaque);
assert.equal(enhanceStandaloneImage(), true, "image doc → handled");
await flush();
assert.equal(picked, standaloneOpaque, "opaque URL in an image document is enhanced");

setContentType("text/html");
reset();

// ---- cross-frame pick coordination -----------------------------------------
// The content script runs in every frame, so PICK_GIF arms all of them. The
// frame that resolves the pick announces it (PICK_ENDED → background) and the
// background fans EXIT_PICK back out so no other frame is left armed. The
// self-disarming safety nets must stay LOCAL: broadcasting from them would
// cancel a sibling frame right before it handles the click it was armed for.
{
  const sent: unknown[] = [];
  let listener: ((message: unknown) => unknown) | null = null;
  // init() ran at import time with no `browser` global (a no-op); install a fake
  // runtime and call it again to capture the message listener it registers.
  (globalThis as Record<string, unknown>).browser = {
    runtime: {
      onMessage: {
        addListener: (fn: (message: unknown) => unknown) => {
          listener = fn;
        },
        removeListener: () => {
          listener = null;
        },
      },
      sendMessage: async (message: unknown) => {
        sent.push(message);
      },
    },
  };
  const teardownInit = init();
  const deliver = (message: unknown) => listener?.(message);
  assert.ok(listener, "init registers a runtime message listener");

  // Escape resolves the pick: local exit + an announcement for the other frames.
  deliver({ type: "PICK_GIF" });
  assert.equal(isPicking(), true, "PICK_GIF arms this frame");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(isPicking(), false, "Escape leaves pick mode");
  assert.deepEqual(sent, [{ type: "PICK_ENDED" }], "Escape announces the end of the pick");

  // So does a click that cancels (and so does one that picks — same code path).
  sent.length = 0;
  deliver({ type: "PICK_GIF" });
  const elsewhere = document.createElement("div");
  document.body.appendChild(elsewhere);
  elsewhere.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(sent, [{ type: "PICK_ENDED" }], "a click announces the end of the pick");
  elsewhere.remove();

  // EXIT_PICK (another frame got there first) disarms without re-announcing,
  // otherwise the frames would bounce the message around the tab forever.
  sent.length = 0;
  deliver({ type: "PICK_GIF" });
  assert.equal(isPicking(), true);
  deliver({ type: "EXIT_PICK" });
  assert.equal(isPicking(), false, "EXIT_PICK disarms this frame");
  assert.deepEqual(sent, [], "disarming for another frame doesn't re-broadcast");

  // Losing focus abandons the pick here only — this is what a click into a
  // sibling frame looks like, so it must not cancel that sibling.
  deliver({ type: "PICK_GIF" });
  window.dispatchEvent(new window.Event("blur"));
  assert.equal(isPicking(), false, "losing focus abandons the pick");
  assert.deepEqual(sent, [], "an abandoned pick is not announced");

  // Hiding the tab likewise — every frame shares the document's visibility, so
  // each disarms itself without needing the relay.
  const setHidden = (value: boolean) =>
    Object.defineProperty(document, "hidden", { value, configurable: true });
  deliver({ type: "PICK_GIF" });
  setHidden(true);
  document.dispatchEvent(new window.Event("visibilitychange"));
  assert.equal(isPicking(), false, "hiding the tab abandons the pick");
  assert.deepEqual(sent, [], "a hidden tab's abandoned pick is not announced");
  setHidden(false);

  // A still-visible tab firing visibilitychange keeps the pick armed.
  deliver({ type: "PICK_GIF" });
  document.dispatchEvent(new window.Event("visibilitychange"));
  assert.equal(isPicking(), true, "a visible tab stays armed");
  exitPickMode();

  // Unloading tears down whatever the loaded player is still holding.
  await flush();
  const teardownsBefore = toreDownAll;
  teardownInit();
  assert.equal(toreDownAll, teardownsBefore + 1, "teardown drains the loaded player");
  delete (globalThis as Record<string, unknown>).browser;
}

// ---- standalone handling is top-frame-only ---------------------------------
// An <iframe> pointed at a .gif is an image document too, and a page can hold
// many; sub-frames fall through to pick mode instead of all toggling at once.
{
  setContentType("image/gif");
  reset();
  document.body.appendChild(imgWith("http://x/framed.gif"));
  // jsdom can't nest realms and its `window.top` is non-configurable, so stand in
  // a minimal window whose `top` is some other object — all the frame check reads.
  const realWindow = globalThis.window;
  (globalThis as Record<string, unknown>).window = { top: realWindow };
  assert.equal(enhanceStandaloneImage(), false, "a sub-frame image document is not auto-toggled");
  (globalThis as Record<string, unknown>).window = realWindow;

  reset();
  const framed = imgWith("http://x/top.gif");
  document.body.appendChild(framed);
  assert.equal(enhanceStandaloneImage(), true, "the top frame still handles it");
  await flush();
  assert.equal(picked, framed, "the top frame's image document is enhanced");
  setContentType("text/html");
  reset();
}

console.log("content-loader.test: OK");
