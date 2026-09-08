// Real-browser smoke test: load the built Chrome extension in the oldest Chrome
// the manifest claims to support, pick an animated GIF on a real page, and check
// the pixels that end up on screen.
//
// Everything in `npm test` runs against jsdom with a faked `browser`, which is
// what makes it fast and what makes it blind to a whole class of bug: the ones
// that only exist in the extension runtime. Three findings from the 2026-09-06
// review were exactly that shape and none of them could have been caught here:
//
//   - the `browser.*` namespace not existing in the Chrome version the manifest
//     names, so the service worker dies before it registers a listener;
//   - the decode worker being refused an extension-URL script and needing the
//     `blob:` fallback, which no headless test exercises;
//   - the overlay being mounted into a containing block it didn't expect, which
//     needs real layout to go wrong.
//
// So the assertions here are deliberately *outcome* assertions — what a user
// would see — rather than unit-level ones, and the fixture page is built to be
// hostile in the ways that broke those three: a scaled, margined <body> that a
// misplaced overlay cannot survive (issue 05), the page scrolled away from the
// origin, and a cross-origin image alongside the same-origin one.
//
//   node scripts/smoke.mjs              # downloads the pinned Chrome if needed
//   JIFFY_SMOKE_CHROME=/usr/bin/chromium node scripts/smoke.mjs
//   JIFFY_SMOKE_HEADFUL=1 node scripts/smoke.mjs   # watch it happen
//
// Which Chrome: the milestone in `dist-chrome/manifest.json`'s
// `minimum_chrome_version`, resolved to a Chrome for Testing build. That is the
// point of the exercise — if the floor is a lie, this fails on the build the
// store would serve to those users. `JIFFY_SMOKE_CHROME` overrides it with a
// local binary, which is how to run this on a platform Chrome for Testing has
// no build for (linux-arm64, notably: `@puppeteer/browsers` hands out the x64
// archive there and it won't execute).
//
// Chrome only, deliberately. Firefox's MV3 background is an event page rather
// than a service worker and is exposed as no target puppeteer can attach to, so
// there is no extension context to arm the pick from without adding a second
// driving mechanism (an extension page opened as a tab) on top of a second
// browser, a second install path and a second set of timing. All three findings
// this exists for are Chrome's; what stays uncovered is the Firefox content
// script's own realm, where the overlay's mounting has to cross an Xray
// boundary. See issues/21-test-suite-gaps.md.
//
// The one thing this can't drive is the permission grant. `activeTab` is given
// out when the user clicks the toolbar button, and `permissions.request` needs a
// user gesture on browser UI — neither exists headlessly. So the copy of the
// build under test has a host permission for the fixture's origins patched into
// its manifest, and the pick is started the way popup.ts starts it
// (`scripting.executeScript` + a PICK_GIF message) rather than by clicking the
// button. Nothing else about the build is touched; `src/popup/popup.test.ts`
// covers the popup's own logic.

import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";
import puppeteer from "puppeteer-core";

import { GIF } from "../src/test/gifFixture.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-chrome");
const cache = path.join(root, "node_modules/.cache");
const extDir = path.join(cache, "jiffy-smoke-ext");
const browsersDir = path.join(cache, "jiffy-browsers");

/** Rendered size of the fixture images. Tall enough that the control bar, which
 *  anchors to the bottom edge, is nowhere near the pixels sampled at 25% down. */
const IMG_W = 320;
const IMG_H = 240;
/** How far the fixture is scrolled before picking, so page ≠ viewport coordinates. */
const SCROLL_Y = 150;
/** Long enough for a cold player bundle + worker spawn on a loaded CI runner. */
const READY_MS = 30_000;

// ---------------------------------------------------------------- the fixture

/**
 * The page under test. Two animated images on a deliberately awkward layout:
 *
 * - a `transform` and a margin on <body>, which is what issue 05 was about.
 *   A transformed <body> is a containing block, so an overlay hosted inside it
 *   is both offset by body's own box and scaled again by the transform — and
 *   subtracting the containing block's origin cannot undo a scale. Hosting on
 *   <html> is what keeps it right; the pixel checks below land on the page's own
 *   grey background if it isn't. (The scale is also mirrored onto the overlay by
 *   ./transformBox, so a correct build draws the frame at 1.25× over an image
 *   the page drew at 1.25× — both halves of that have to be right to pass.)
 * - a spacer that makes the document scrollable, so the pick happens with a
 *   scroll offset applied and a page/viewport mix-up can't pass.
 * - one same-origin image and one served from the other loopback name. A
 *   content-script fetch is subject to the page's CORS, and the server sends no
 *   allow-origin header, so the second image can only be read through the
 *   background's privileged fetch — which puts the whole port-streaming tier on
 *   the same path as the pick.
 *
 * The GIF itself is `src/test/gifFixture.ts`: 2×1, frame 0 = black|white and
 * frame 1 = white|black, which is what makes a screenshot readable as "which
 * frame is on screen" with no image decoding on this side.
 */
function fixtureHtml(crossOriginSrc) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Jiffy smoke fixture</title>
<style>
  body { transform: scale(1.25); transform-origin: 0 0; margin: 40px; background: #808080; font: 14px sans-serif; }
  img { display: block; width: ${IMG_W}px; height: ${IMG_H}px; }
  .spacer { height: 200px; }
  .tail { height: 600px; }
</style>
</head>
<body>
  <div class="spacer">same-origin below, cross-origin under it</div>
  <img id="local" src="/cat.gif" alt="local">
  <div class="spacer"></div>
  <img id="remote" src="${crossOriginSrc}" alt="remote">
  <div class="tail"></div>
</body>
</html>
`;
}

/**
 * Serve the fixture on 127.0.0.1 and the GIF on both loopback names. No CORS
 * header is sent, which is what makes the cross-origin image a real test of the
 * background fetch tier: the content script's own fetch is refused and the
 * bytes have to come back over the runtime port instead.
 */
async function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/cat.gif") {
      res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
      res.end(Buffer.from(GIF));
      return;
    }
    if (url.pathname === "/") {
      const port = server.address().port;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml(`http://localhost:${port}/cat.gif`));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

// ------------------------------------------------------- the build under test

/**
 * Copy `dist-chrome/` somewhere writable and patch a host permission into it.
 * Returns the manifest as built, so the caller can read the version floor off
 * the real one rather than the patched copy.
 */
async function stageExtension(port) {
  const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
  await rm(extDir, { recursive: true, force: true });
  await mkdir(path.dirname(extDir), { recursive: true });
  await cp(dist, extDir, { recursive: true });
  await writeFile(
    path.join(extDir, "manifest.json"),
    JSON.stringify(
      {
        ...manifest,
        host_permissions: [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`],
      },
      null,
      2,
    ),
  );
  return manifest;
}

/** The Chrome to run: the manifest's floor, or whatever JIFFY_SMOKE_CHROME names. */
async function resolveChrome(manifest) {
  const override = process.env.JIFFY_SMOKE_CHROME;
  if (override) return { executablePath: override, described: `${override} (JIFFY_SMOKE_CHROME)` };

  const milestone = manifest.minimum_chrome_version;
  assert.match(milestone ?? "", /^\d+$/, "minimum_chrome_version is a milestone number");
  const platform = detectBrowserPlatform();
  const buildId = await resolveBuildId(Browser.CHROME, platform, milestone);
  const installed = await install({
    browser: Browser.CHROME,
    platform,
    buildId,
    cacheDir: browsersDir,
  });
  return {
    executablePath: installed.executablePath,
    described: `Chrome for Testing ${buildId} (minimum_chrome_version ${milestone})`,
  };
}

// ------------------------------------------------------------- the assertions

/**
 * Colours at 25% and 75% across `selector`, a quarter of the way down it, read
 * off a real screenshot.
 *
 * The overlay's canvas lives in a CLOSED shadow root — page script can't reach
 * it, which is issue 07's fix and not something to work around here — so the
 * only honest way to ask what is on screen is to look at the screen. The
 * screenshot goes back into the page as a data: URL (which taints nothing) and
 * is read with getImageData, so no PNG decoder is needed on this side.
 */
async function sampleImage(page, selector) {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  const shot = await page.screenshot({ encoding: "base64", type: "png" });
  return page.evaluate(
    async (b64, box) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const at = (fx) => {
        const x = Math.round(box.x + box.width * fx);
        const y = Math.round(box.y + box.height * 0.25);
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        return [r, g, b];
      };
      return { left: at(0.25), right: at(0.75) };
    },
    shot,
    rect,
  );
}

const isDark = ([r, g, b]) => Math.max(r, g, b) < 60;
const isLight = ([r, g, b]) => Math.min(r, g, b) > 195;

/**
 * Assert the two halves read as `frame`, and say what was actually there when
 * they don't — a failure here is "the overlay isn't where it should be" or "it
 * drew the wrong frame", and the colours tell those apart (the fixture's own
 * background is mid-grey, so a misplaced overlay reads as neither).
 */
function assertFrame(sample, frame, what) {
  const [dark, light] = frame === 0 ? [sample.left, sample.right] : [sample.right, sample.left];
  const seen = `left=rgb(${sample.left}) right=rgb(${sample.right})`;
  assert.ok(isDark(dark) && isLight(light), `${what}: expected frame ${frame}, saw ${seen}`);
}

/** Arm pick mode in `tab` the way the popup does, then click `selector`. */
async function pick(worker, page, pageUrl, selector) {
  await worker.evaluate(async (url) => {
    const [tab] = await browser.tabs.query({ url });
    if (tab?.id == null) throw new Error(`no tab for ${url}`);
    await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
    // Nothing answers PICK_GIF; the injection above is what proves the page is
    // reachable. Same swallow as popup.ts.
    await browser.tabs.sendMessage(tab.id, { type: "PICK_GIF" }).catch(() => {});
  }, pageUrl);
  await page.click(selector);
  // The overlay hides the <img> it takes over, with !important, and puts it back
  // on teardown — so this is both "a player is up" and a page-visible signal
  // that survives the closed shadow root.
  await page.waitForFunction(
    (sel) => document.querySelector(sel).style.getPropertyValue("visibility") === "hidden",
    { timeout: READY_MS },
    selector,
  );
}

// --------------------------------------------------------------------- driver

const failures = [];
const check = (what, fn) => {
  try {
    fn();
    console.log(`ok    ${what}`);
  } catch (err) {
    failures.push(what);
    console.log(`FAIL  ${what}\n      ${err.message}`);
  }
};

let server;
let browserInstance;
try {
  await readFile(path.join(dist, "manifest.json"), "utf8");
} catch {
  console.error("[jiffy] smoke: dist-chrome/ is missing — run `npm run build:chrome` first");
  process.exit(1);
}

try {
  let port;
  ({ server, port } = await startServer());
  const pageUrl = `http://127.0.0.1:${port}/`;
  const manifest = await stageExtension(port);
  const chrome = await resolveChrome(manifest);
  console.log(`[jiffy] smoke: ${chrome.described}`);

  browserInstance = await puppeteer.launch({
    browser: "chrome",
    executablePath: chrome.executablePath,
    headless: process.env.JIFFY_SMOKE_HEADFUL !== "1",
    enableExtensions: [extDir],
    // `enableExtensions` with a path list needs the pipe transport rather than a
    // websocket; puppeteer refuses the combination otherwise.
    pipe: true,
    defaultViewport: { width: 1000, height: 1050 },
    // Containers and CI runners have no user namespace to sandbox into, and
    // /dev/shm is routinely too small for Chrome's default shared memory use.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // ---- the background service worker came up ------------------------------
  // A `browser is not defined` at registration leaves the worker without its
  // listeners, which is exactly what shipping below the namespace's floor does.
  // `hasListeners()` is the difference between "the worker exists" and "the
  // worker ran background.ts to the end".
  const swTarget = await browserInstance.waitForTarget((t) => t.type() === "service_worker", {
    timeout: READY_MS,
  });
  const worker = await swTarget.worker();
  const background = await worker.evaluate(() => ({
    namespace: typeof browser,
    onMessage: browser.runtime.onMessage.hasListeners(),
    onConnect: browser.runtime.onConnect.hasListeners(),
  }));
  check("the background sees the browser namespace", () =>
    assert.equal(background.namespace, "object"),
  );
  check("the background registered its message listener", () =>
    assert.equal(background.onMessage, true),
  );
  check("the background registered its fetch-port listener", () =>
    assert.equal(background.onConnect, true),
  );

  // ---- the page -----------------------------------------------------------
  const page = await browserInstance.newPage();
  const pageErrors = [];
  const mainThreadNotes = [];
  const backgroundFetches = [];
  const workerUrls = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("workercreated", (w) => workerUrls.push(w.url()));
  page.on("console", (msg) => {
    // decodeInWorker says this, once and loudly, when no way of spawning a
    // worker worked and the decode ran on the page's main thread instead.
    if (/decoding on the main thread|worker bundle could not be loaded/.test(msg.text())) {
      mainThreadNotes.push(msg.text());
    }
    // fetchGif says this when the page's own fetch was refused and the
    // background's host access is being asked to do it instead.
    if (/direct fetch failed, retrying via background/.test(msg.text())) {
      backgroundFetches.push(msg.text());
    }
  });

  await page.goto(pageUrl, { waitUntil: "load" });
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);

  // ---- pick the same-origin image -----------------------------------------
  await pick(worker, page, pageUrl, "#local");

  const frame0 = await sampleImage(page, "#local");
  check("the overlay draws frame 0 over the image", () => assertFrame(frame0, 0, "after the pick"));

  // ---- the decode really ran in a worker ----------------------------------
  // Chrome refuses a dedicated worker whose script is an extension URL, so the
  // bundle is fetched and spawned from a blob: URL instead. A `blob:` worker
  // here is the positive evidence that fallback works; the console note is the
  // negative one, and they should never both be true.
  check("the decode ran in a worker spawned from a blob URL", () =>
    assert.ok(
      workerUrls.some((url) => url.startsWith("blob:")),
      `no blob: worker was created (saw ${JSON.stringify(workerUrls)})`,
    ),
  );
  check("nothing fell back to decoding on the main thread", () =>
    assert.deepEqual(mainThreadNotes, []),
  );

  // ---- the controls are there and drive playback --------------------------
  const stepped = await page.evaluate(() => {
    // The controls' host is the one on <html> whose (open) shadow root has the
    // bar in it; the overlay's is closed and reads as shadowRoot === null.
    const host = [...document.documentElement.children].find((el) =>
      el.shadowRoot?.querySelector('[aria-label="Next frame"]'),
    );
    if (!host) return false;
    host.shadowRoot.querySelector('[aria-label="Next frame"]').click();
    return true;
  });
  check("the control bar is mounted next to the image", () => assert.equal(stepped, true));

  const frame1 = await sampleImage(page, "#local");
  check("stepping forward puts frame 1 on screen", () =>
    assertFrame(frame1, 1, "after Next frame"),
  );

  // ---- pick the cross-origin image ----------------------------------------
  // A second pick on the same page: the frame re-arms, a second player mounts
  // alongside the first, and the bytes come from an origin the page itself
  // could not have read.
  await pick(worker, page, pageUrl, "#remote");
  const remoteFrame0 = await sampleImage(page, "#remote");
  check("a cross-origin image plays too", () => assertFrame(remoteFrame0, 0, "cross-origin pick"));
  // Which tier served those bytes isn't a detail here: the page's own fetch has
  // to have been refused for the background's to run at all, so this is the one
  // check that the port streaming works outside jsdom.
  check("the cross-origin bytes came back over the background port", () =>
    assert.equal(backgroundFetches.length, 1, `saw ${JSON.stringify(backgroundFetches)}`),
  );

  const bothUp = await page.evaluate(
    () =>
      document.querySelector("#local").style.getPropertyValue("visibility") === "hidden" &&
      document.querySelector("#remote").style.getPropertyValue("visibility") === "hidden",
  );
  check("both players are up at once", () => assert.equal(bothUp, true));

  check("the page logged no uncaught errors", () => assert.deepEqual(pageErrors, []));
} finally {
  await browserInstance?.close();
  server?.close();
}

if (failures.length > 0) {
  console.error(`\n[jiffy] smoke: ${failures.length} check(s) failed:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("\n[jiffy] smoke: all checks passed");
