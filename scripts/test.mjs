// Test runner for Jiffy.
//
// Node's type stripping only ERASES types; it can't transform JSX, and it has no
// loader for a `.css` import. Our UI tests render Preact components (TSX) and the
// controls mount imports controls.css as a string, so plain `node --test` can't
// run this suite — it refuses a `.tsx` entry outright (ERR_UNKNOWN_FILE_EXTENSION).
// So we bundle each test with esbuild first (same JSX settings as the app build),
// then run the output with node. `packages: 'external'` keeps node_modules
// (preact, jsdom, gifuct-js) as real runtime imports — only our own source
// (incl. JSX) is transformed.
//
// Each file is an independent process, so they run concurrently. Their output is
// captured and printed a file at a time, in a stable order, rather than being
// interleaved into nonsense; failures are repeated at the end so the last thing
// on screen (and the last thing in a CI log) is the list of what broke.
//
//   node scripts/test.mjs            # quiet: expected console.debug is silenced
//   JIFFY_TEST_VERBOSE=1 node scripts/test.mjs

import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

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
  // Runs before anything else in every test bundle; see src/test/quiet.ts.
  inject: [path.join(srcDir, "test/quiet.ts")],
  logLevel: "warning",
});

/** Run one bundled test, capturing its output instead of inheriting the tty. */
function runTest(test) {
  const rel = path.relative(srcDir, test).replace(/\.tsx?$/, ".js");
  const child = spawn(process.execPath, [path.join(outdir, rel)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => chunks.push(c));
  return new Promise((resolve) => {
    child.on("error", (err) => resolve({ test, ok: false, output: `${err.stack ?? err}\n` }));
    child.on("close", (status) =>
      resolve({ test, ok: status === 0, output: Buffer.concat(chunks).toString() }),
    );
  });
}

// A worker pool over the file list: `limit` processes in flight, each taking the
// next file as it finishes. Bounded because every jsdom test builds a DOM, and
// oversubscribing the box makes the suite slower, not faster.
const limit = Math.max(1, Math.min(tests.length, availableParallelism()));
const queue = tests.slice();
const results = new Map();
await Promise.all(
  Array.from({ length: limit }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.set(next, await runTest(next));
    }
  }),
);

// Report in file order, not completion order, so a run reads the same every time.
const failed = [];
for (const test of tests) {
  const { ok, output } = results.get(test);
  const rel = path.relative(root, test);
  if (!ok) failed.push(rel);
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${rel}\n`);
  // A pass has already said so on that line; its own chatter is only interesting
  // when something is being debugged.
  if (!ok || process.env["JIFFY_TEST_VERBOSE"]) {
    process.stdout.write(output.replace(/^/gm, "      "));
  }
}

if (failed.length > 0) {
  console.error(`\n[jiffy] ${failed.length} of ${tests.length} test file(s) failed:`);
  for (const rel of failed) console.error(`  ${rel}`);
  process.exit(1);
}
console.log(`\n[jiffy] all ${tests.length} test file(s) passed`);
