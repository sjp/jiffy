// esbuild build for the Jiffy browser extension.
//
// Produces SEPARATE bundles for the entry points that run in different contexts
// (background service worker vs. injected content script — they cannot share one
// IIFE), compiles TypeScript + Preact TSX via the automatic JSX runtime, and
// copies the browser-specific manifest + static assets into the output directory.
//
//   node scripts/build.mjs --firefox          one-off Firefox build  → dist-firefox/
//   node scripts/build.mjs --chrome           one-off Chrome build   → dist-chrome/
//   node scripts/build.mjs --firefox --watch  Firefox dev (rebuild on change)
//   node scripts/build.mjs --chrome  --watch  Chrome  dev (rebuild on change)

import * as esbuild from "esbuild";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

// Version stamped into the built manifest. CI passes the release tag via
// JIFFY_VERSION (e.g. "release/1.2.0" or "1.2.0"); local builds fall back to
// package.json. This keeps the committed manifests on a static placeholder so
// they never drift, and makes the release tag the single source of truth.
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = resolveVersion(process.env.JIFFY_VERSION, pkg.version);

function resolveVersion(envVersion, fallback) {
  const raw = (envVersion ?? "").trim().replace(/^release\//, "") || fallback;
  // Chrome requires 1–4 dot-separated integers; Firefox is looser but accepts
  // this shape, so validate against the stricter rule for both.
  if (!/^\d+(\.\d+){0,3}$/.test(raw)) {
    console.error(
      `[jiffy] error: invalid extension version ${JSON.stringify(raw)} ` +
        `(expected 1–4 dot-separated integers, e.g. 1.2.0)`,
    );
    process.exit(1);
  }
  return raw;
}

const isFirefox = process.argv.includes("--firefox");
const isChrome = process.argv.includes("--chrome");

if (!isFirefox && !isChrome) {
  console.error("[jiffy] error: pass --firefox or --chrome");
  process.exit(1);
}
if (isFirefox && isChrome) {
  console.error("[jiffy] error: pass only one of --firefox or --chrome");
  process.exit(1);
}

const browser = isFirefox ? "firefox" : "chrome";
const outdir = path.join(root, `dist-${browser}`);
const manifestSrc = path.join(root, `manifest.${browser}.json`);

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Copy manifest.<browser>.json + everything under public/ into the output dir,
// stamping the resolved version into the manifest as it's written.
// Tolerant of missing sources so the build works before those assets exist.
async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  if (await exists(manifestSrc)) {
    const manifest = JSON.parse(await readFile(manifestSrc, "utf8"));
    manifest.version = version;
    await writeFile(
      path.join(outdir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }
  const publicDir = path.join(root, "public");
  if (await exists(publicDir)) {
    await cp(publicDir, outdir, { recursive: true });
  }
}

// Re-copy static assets after every (re)build, including in watch mode — esbuild
// only watches the JS/TS import graph, not the manifest or public/ files.
const copyStaticPlugin = {
  name: "copy-static",
  setup(build) {
    build.onEnd(() => copyStatic());
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: path.join(root, "src/background.ts"),
    content: path.join(root, "src/content/index.ts"),
    popup: path.join(root, "src/popup/popup.ts"),
  },
  outdir,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox115", "chrome120"],
  sourcemap: true,
  logLevel: "info",
  // Preact JSX — keep in sync with tsconfig (jsx/jsxImportSource).
  jsx: "automatic",
  jsxImportSource: "preact",
  // controls.css is consumed as a string for an adopted stylesheet (PRD §7),
  // not injected as a stylesheet — load it as text.
  loader: { ".css": "text" },
  plugins: [copyStaticPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`[jiffy] watching for changes… (${browser} → ${outdir})`);
} else {
  await rm(outdir, { recursive: true, force: true });
  await esbuild.build(options);
  console.log(`[jiffy] build complete → ${outdir}`);
}
