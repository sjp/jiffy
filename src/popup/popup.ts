// Toolbar popup — Jiffy's only entry point, and the reason it can ask for
// nothing at install time.
//
// No content script is declared and no host permission is required: opening this
// popup grants `activeTab` for the current tab, which is exactly what lets the
// button below inject the content script and then talk to it. A page the user
// never points Jiffy at gets nothing injected into it at all.
//
// `activeTab` covers the tab's own origin, though, so two things stay out of
// reach: images inside a CROSS-ORIGIN frame (no injection there, so no pick), and
// images whose server sends no CORS headers (the content script's own fetch is
// refused, and the background's fallback fetch has no host access to retry with).
// The "all sites" checkbox grants that access on demand. `permissions.request`
// only runs from a user gesture on an extension page, so the popup is the one
// place that offer can live.
import type { PickGifRequest } from "../messages";

/** Built name of the content-script bundle (see scripts/build.mjs). */
const CONTENT_SCRIPT = "content.js";

/**
 * The optional host access, covering the schemes the fetch tiers allow (`data:`
 * URLs need no permission). Must stay identical to `optional_host_permissions` in
 * both manifests — requesting anything not declared there is rejected outright.
 */
const ALL_SITES: browser.permissions.Permissions = {
  origins: ["http://*/*", "https://*/*"],
};

/**
 * Put the active tab into pick mode: inject the content script, then tell it to
 * arm. Injecting `allFrames` covers images inside embeds; frames the extension
 * has no access to are skipped rather than failing the call, and a frame that
 * already ran the script ignores the second injection (see content/index.ts).
 *
 * Throws when the page is one no extension may touch (`about:`/`chrome:`, the
 * add-ons gallery, the built-in PDF viewer) — there is nothing to control there.
 */
export async function pickInActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error("no active tab");
  await browser.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: [CONTENT_SCRIPT],
  });
  const message: PickGifRequest = { type: "PICK_GIF" };
  // Nothing answers PICK_GIF, and Chrome reports an unanswered message as a
  // rejection. The injection above is what proves the page is reachable, so this
  // rejection means nothing — but still await delivery before the caller closes
  // the popup out from under it.
  await browser.tabs.sendMessage(tab.id, message).catch(() => {});
}

/** Is all-sites access currently granted? */
export function hasAllSites(): Promise<boolean> {
  return browser.permissions.contains(ALL_SITES);
}

/**
 * Turn all-sites access on or off. Resolves to the state that actually took
 * effect, which is not what was asked for when the user dismisses the browser's
 * permission prompt.
 *
 * `request` has to be reached from the click that asked for it with nothing
 * awaited in between — both browsers refuse a request made outside a user
 * gesture — so this stays synchronous up to that call.
 */
export async function setAllSites(enabled: boolean): Promise<boolean> {
  if (enabled) return browser.permissions.request(ALL_SITES);
  return !(await browser.permissions.remove(ALL_SITES));
}

/** Wire the popup's markup (see public/popup.html) to the two actions above. */
export function bindPopup(doc: Document): void {
  const button = doc.getElementById("pick");
  const status = doc.getElementById("status");
  const allSites = doc.getElementById("all-sites") as HTMLInputElement | null;

  const say = (text: string) => {
    if (!status) return;
    status.textContent = text;
    status.hidden = text === "";
  };

  button?.addEventListener("click", async () => {
    try {
      await pickInActiveTab();
      window.close(); // pick mode is armed; get out of the user's way
    } catch {
      // Privileged page, or the tab went away mid-click. Stay open and say so —
      // closing silently would look like the button did nothing.
      say("Jiffy can't run on this page.");
    }
  });

  if (allSites) {
    // Reflect the current grant before the user can flip it. The box starts
    // unchecked, so a slow answer here can only under-report, never over-report.
    void hasAllSites()
      .then((granted) => (allSites.checked = granted))
      .catch(() => {});
    allSites.addEventListener("change", async () => {
      const wanted = allSites.checked;
      try {
        allSites.checked = await setAllSites(wanted);
      } catch {
        allSites.checked = !wanted; // e.g. the request was refused outright
      }
      if (allSites.checked !== wanted && wanted) say("Access wasn't granted.");
      else say("");
    });
  }
}

// Guarded so importing this module headlessly (tests) never touches `browser`.
if (typeof browser !== "undefined" && browser.runtime) bindPopup(document);
