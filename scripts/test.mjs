// Test runner for Jiffy.
//
// Node's --experimental-strip-types only ERASES types; it can't transform JSX.
// Our UI tests render Preact components (TSX), so we bundle each test with
// esbuild first (same JSX settings as the app build), then run the output with
// node. `packages: 'external'` keeps node_modules (preact, jsdom, gifuct-js)
// as real runtime imports — only our own source (incl. JSX) is transformed.
//
//   node scripts/test.mjs

import * as esbuild from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outdir = path.join(root, "node_modules/.cache/jiffy-tests");

/** Recursively collect every *.test.ts / *.test.tsx under src/. */
function findTests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(full));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const tests = findTests(srcDir).sort();
if (tests.length === 0) {
  console.log("[jiffy] no test files found");
  process.exit(0);
}

rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: tests,
  outdir,
  outbase: srcDir,
  bundle: true,
  packages: "external", // resolve preact/jsdom/gifuct-js from node_modules at runtime
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "text" },
  logLevel: "warning",
});

let failures = 0;
for (const test of tests) {
  const rel = path.relative(srcDir, test).replace(/\.tsx?$/, ".js");
  const bundled = path.join(outdir, rel);
  const result = spawnSync(process.execPath, [bundled], { stdio: "inherit" });
  if (result.status !== 0) {
    failures++;
    console.error(`[jiffy] FAILED: ${path.relative(root, test)}`);
  }
}

if (failures > 0) {
  console.error(`[jiffy] ${failures} test file(s) failed`);
  process.exit(1);
}
console.log(`[jiffy] all ${tests.length} test file(s) passed`);
