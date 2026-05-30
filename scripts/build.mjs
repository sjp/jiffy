// esbuild build for the Jiffy Firefox extension.
//
// Produces SEPARATE bundles for the entry points that run in different contexts
// (background service worker vs. injected content script — they cannot share one
// IIFE), compiles TypeScript + Preact TSX via the automatic JSX runtime, and
// copies the manifest + static assets into dist/.
//
//   node scripts/build.mjs            one-off production build
//   node scripts/build.mjs --watch    rebuild on change (dev)

import * as esbuild from 'esbuild';
import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Copy manifest.json (issue 02) + everything under public/ into dist/. Tolerant
// of missing sources so the build works before those assets exist.
async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  const manifest = path.join(root, 'manifest.json');
  if (await exists(manifest)) {
    await cp(manifest, path.join(outdir, 'manifest.json'));
  }
  const publicDir = path.join(root, 'public');
  if (await exists(publicDir)) {
    await cp(publicDir, outdir, { recursive: true });
  }
}

// Re-copy static assets after every (re)build, including in watch mode — esbuild
// only watches the JS/TS import graph, not the manifest or public/ files.
const copyStaticPlugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(() => copyStatic());
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    content: path.join(root, 'src/content/index.ts'),
    popup: path.join(root, 'src/popup/popup.ts'),
  },
  outdir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['firefox115', 'chrome120'],
  sourcemap: true,
  logLevel: 'info',
  // Preact JSX — keep in sync with tsconfig (jsx/jsxImportSource).
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // controls.css is consumed as a string for an adopted stylesheet (PRD §7),
  // not injected as a stylesheet — load it as text.
  loader: { '.css': 'text' },
  plugins: [copyStaticPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[jiffy] watching for changes…');
} else {
  await rm(outdir, { recursive: true, force: true });
  await esbuild.build(options);
  console.log('[jiffy] build complete → dist/');
}
