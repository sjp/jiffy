// Headless checks on the two shipped manifests.
//
// Everything here is a pairing the code depends on but cannot see: the built
// bundle names the content script reaches for, the origins allowed to load them,
// and Chrome's `use_dynamic_url`. Bundled by scripts/test.mjs, so the JSON is
// inlined at build time rather than read off disk.

import assert from "node:assert/strict";

import chrome from "../manifest.chrome.json";
import firefox from "../manifest.firefox.json";

/** The web-accessible bundles, keyed by manifest, with the one entry unwrapped. */
const war = {
  chrome: chrome.web_accessible_resources[0],
  firefox: firefox.web_accessible_resources[0],
};

// ---- the resources are the two bundles the player path loads --------------
// player.js is `import()`ed by src/content/index.ts, decode-worker.js is spawned
// (or fetched, then spawned from a blob) by src/content/decodeInWorker.ts. Both
// names come out of scripts/build.mjs.
for (const [browser, entry] of Object.entries(war)) {
  assert.deepEqual(entry?.resources, ["player.js", "decode-worker.js"], `${browser} resources`);
}

// ---- only the schemes the extension can be injected into ------------------
// `<all_urls>` would additionally expose the bundles to `file:` and `ftp:` pages,
// which Jiffy neither runs on nor fetches from (see src/fetchLimits.ts). These
// stay identical to `optional_host_permissions`, which is what popup.ts requests.
const SCHEMES = ["http://*/*", "https://*/*"];
for (const [browser, entry] of Object.entries(war)) {
  assert.deepEqual(entry?.matches, SCHEMES, `${browser} matches`);
}
assert.deepEqual(chrome.optional_host_permissions, SCHEMES, "chrome optional_host_permissions");
assert.deepEqual(firefox.optional_host_permissions, SCHEMES, "firefox optional_host_permissions");

// ---- Chrome serves them from a per-session origin -------------------------
// Chrome's extension ID is stable, so without this any page could probe
// `chrome-extension://<id>/player.js` and learn Jiffy is installed. Firefox
// already gives each profile a random `moz-extension://` UUID and has no such
// key — adding one there would only trip `web-ext lint`.
assert.equal(war.chrome?.use_dynamic_url, true, "chrome use_dynamic_url");
assert.equal("use_dynamic_url" in (war.firefox ?? {}), false, "firefox has no use_dynamic_url");

console.log("manifests.test: OK");
