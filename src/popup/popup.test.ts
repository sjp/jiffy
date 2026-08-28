// Headless tests for the toolbar popup: the on-demand injection that replaces a
// declared content script, and the optional all-sites permission toggle. The
// extension APIs are faked, so this pins down the ORDER of the injection and the
// message (arming a script that isn't there yet would silently do nothing) and
// that a refused permission never leaves the checkbox looking granted.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { bindPopup } from "./popup.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- fake extension APIs ---------------------------------------------------
/** Everything the popup asked the browser to do, in order. */
let calls: string[] = [];
let injectFails = false;
let granted = false;
/** What the browser's permission prompt answers. */
let grantRequest = true;
let closed = 0;

(globalThis as Record<string, unknown>).browser = {
  runtime: {},
  tabs: {
    query: async () => [{ id: 7 }],
    sendMessage: async (tabId: number, message: { type: string }) => {
      calls.push(`send:${tabId}:${message.type}`);
    },
  },
  scripting: {
    executeScript: async (injection: {
      target: { tabId: number; allFrames?: boolean };
      files: string[];
    }) => {
      // What a privileged page (about:, chrome:, the add-ons gallery) throws.
      if (injectFails) throw new Error("Cannot access contents of the page");
      const { tabId, allFrames } = injection.target;
      calls.push(`inject:${tabId}:${allFrames}:${injection.files.join(",")}`);
      return [];
    },
  },
  permissions: {
    contains: async () => granted,
    request: async () => (granted = grantRequest),
    remove: async () => {
      granted = false;
      return true;
    },
  },
};
window.close = () => closed++;

/** A freshly bound popup, so each case starts with its own listeners. */
function popup(): Document {
  const doc = document.implementation.createHTMLDocument("popup");
  doc.body.innerHTML =
    '<button id="pick" type="button"></button>' +
    '<p id="status" role="status" hidden></p>' +
    '<label><input id="all-sites" type="checkbox" /></label>';
  bindPopup(doc);
  return doc;
}
const el = <T extends HTMLElement>(doc: Document, id: string) => doc.getElementById(id) as T;

// ---- picking ---------------------------------------------------------------
{
  const doc = popup();
  el(doc, "pick").click();
  await flush();
  assert.deepEqual(
    calls,
    ["inject:7:true:content.js", "send:7:PICK_GIF"],
    "the content script is injected into every frame BEFORE it's told to arm",
  );
  assert.equal(closed, 1, "an armed pick closes the popup");
  assert.equal(el(doc, "status").hidden, true, "a successful pick says nothing");
}

// A page no extension may touch: stay open and explain, rather than closing on a
// button press that did nothing.
{
  calls = [];
  injectFails = true;
  const doc = popup();
  el(doc, "pick").click();
  await flush();
  assert.deepEqual(calls, [], "a failed injection never sends the arming message");
  assert.equal(closed, 1, "the popup stays open on a page Jiffy can't run on");
  assert.equal(el(doc, "status").hidden, false);
  assert.match(el(doc, "status").textContent ?? "", /can't run on this page/);
  injectFails = false;
}

// ---- the optional all-sites permission -------------------------------------
{
  granted = true;
  const doc = popup();
  await flush();
  assert.equal(
    el<HTMLInputElement>(doc, "all-sites").checked,
    true,
    "the checkbox reflects access the user has already granted",
  );
}

{
  granted = false;
  const doc = popup();
  const box = el<HTMLInputElement>(doc, "all-sites");
  await flush();
  assert.equal(box.checked, false, "access is off by default");

  box.checked = true;
  box.dispatchEvent(new window.Event("change"));
  await flush();
  assert.equal(granted, true, "ticking the box requests the permission");
  assert.equal(box.checked, true);

  box.checked = false;
  box.dispatchEvent(new window.Event("change"));
  await flush();
  assert.equal(granted, false, "unticking it hands the permission back");
  assert.equal(box.checked, false);
}

// A dismissed permission prompt must snap the checkbox back — a ticked box the
// browser never honoured would be a lie about what Jiffy can reach.
{
  granted = false;
  grantRequest = false;
  const doc = popup();
  const box = el<HTMLInputElement>(doc, "all-sites");
  box.checked = true;
  box.dispatchEvent(new window.Event("change"));
  await flush();
  assert.equal(box.checked, false, "a refused request leaves the box unticked");
  assert.equal(el(doc, "status").hidden, false);
  assert.match(el(doc, "status").textContent ?? "", /wasn't granted/);
  grantRequest = true;
}

console.log("popup.test: OK");
