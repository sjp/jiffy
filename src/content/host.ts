// Mounting Jiffy's own chrome into someone else's page.
//
// Everything Jiffy adds to a page — the overlay canvas, the control bar, the
// pick highlight, the toast — is the same shape: a host <div> carrying the
// position and the stacking order, a shadow root holding the actual content
// behind a style and event boundary, and one teardown. Two details of that are
// easy to get wrong, which is why they live here rather than in four copies.
//
// **Where an absolutely positioned host is attached.** `left`/`top` resolve
// against the host's *containing block*, which is the initial containing block
// (i.e. page coordinates) only while no ancestor establishes one. `position:
// relative` on <body> is extremely common in site CSS, and `transform`,
// `filter`, `perspective`, `contain: paint/layout` and `will-change` on it do
// the same — at which point body's own margin (8px by UA default) and offset
// silently shift everything Jiffy draws. Attaching to <html> instead takes body
// out of the picture entirely, and `place()` corrects for the far rarer case of
// a positioned <html>. A containing block with a *transform* on it is the one
// case still not handled: the coordinate space is scaled or rotated, not just
// moved, and correcting an origin can't undo that.
//
// **Whether the page can reach inside.** A closed shadow root is not decoration
// for the overlay: its canvas holds decoded pixels that the page's own script is
// not allowed to read (Jiffy's background tier fetches cross-origin images the
// same-origin policy would deny the page). `element.shadowRoot` is null for a
// closed root, so page script has no way in; the content script keeps the only
// reference. Content-script realms in both browsers use their own
// `attachShadow`, so a page-side prototype patch cannot intercept the call.

// `contain` values that make an element a containing block, and the
// `will-change` values that promise one of the properties that would.
const CONTAINING_CONTAIN = new Set(["paint", "layout", "strict", "content"]);
const CONTAINING_WILL_CHANGE = new Set([
  "transform",
  "translate",
  "rotate",
  "scale",
  "filter",
  "perspective",
  "contain",
]);

/** The keywords in a space- or comma-separated computed value. */
function keywords(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}

/** A `getComputedStyle` length, or 0 for the ones jsdom/UA leave blank. */
function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether `style` makes its element the containing block for absolutely
 * positioned descendants. Anything that promotes an element to a containing
 * block for *fixed* descendants does so for absolute ones too, hence the
 * transform/filter/contain family alongside the position check.
 *
 * jsdom resolves most of these to `""` rather than `"none"`; both count as
 * absent, so this reads the same headless as it does in a browser.
 */
function establishesContainingBlock(style: CSSStyleDeclaration): boolean {
  if (style.position !== "" && style.position !== "static") return true;
  for (const value of [
    style.transform,
    style.translate,
    style.rotate,
    style.scale,
    style.filter,
    style.backdropFilter,
    style.perspective,
  ]) {
    if (value !== undefined && value !== "" && value !== "none") return true;
  }
  // Matched as whole keywords: `will-change: transform-origin` promises nothing
  // that moves a containing block, and a substring test would say it does.
  if (keywords(style.contain).some((word) => CONTAINING_CONTAIN.has(word))) return true;
  if (keywords(style.willChange).some((word) => CONTAINING_WILL_CHANGE.has(word))) return true;
  return false;
}

/**
 * Page coordinates of the origin an absolutely positioned `host`'s `left`/`top`
 * are measured from: the *padding box* of the nearest ancestor that establishes
 * a containing block, or (0, 0) when none does and the initial containing block
 * applies.
 *
 * Exported for its own tests — this is arithmetic over computed styles and
 * rects, so it can be exercised with stubs where the placement it feeds cannot
 * (jsdom has no layout).
 */
export function containingBlockOrigin(host: Element): { x: number; y: number } {
  for (let node = host.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!establishesContainingBlock(style)) continue;
    const rect = node.getBoundingClientRect();
    return {
      x: rect.left + window.scrollX + px(style.borderLeftWidth),
      y: rect.top + window.scrollY + px(style.borderTopWidth),
    };
  }
  return { x: 0, y: 0 };
}

export interface MountedHost {
  /** The host element in the page. Size, transform and display live here. */
  readonly host: HTMLDivElement;
  /** The shadow root to put content in. */
  readonly shadow: ShadowRoot;
  /**
   * Move the host's top-left corner to `x`/`y` — page coordinates for an
   * `absolute` host, viewport coordinates for a `fixed` one.
   */
  place(x: number, y: number): void;
  /** Remove the host, and everything in its shadow tree, from the page. */
  remove(): void;
}

export interface HostOptions {
  /**
   * `absolute` sticks to a page position through scroll without waiting on a
   * scroll handler; `fixed` is for chrome anchored to the viewport instead.
   */
  position: "absolute" | "fixed";
  zIndex: string;
  /** `closed` where page script must not reach the content (see above). */
  mode: "open" | "closed";
  /** Stylesheet text for the shadow tree, if the content needs one. */
  css?: string;
  /** Pass `"none"` so the host never intercepts the page's own interaction. */
  pointerEvents?: "none";
}

/**
 * Create a host element with a shadow root, insert it, and return the handles
 * needed to fill it, move it and take it away again.
 */
export function createHost(options: HostOptions): MountedHost {
  const host = document.createElement("div");
  host.style.position = options.position;
  host.style.margin = "0";
  host.style.padding = "0";
  host.style.border = "0";
  host.style.zIndex = options.zIndex;
  if (options.pointerEvents !== undefined) host.style.pointerEvents = options.pointerEvents;

  // An `absolute` host goes on <html> so a positioned <body> can't shift it; a
  // `fixed` one resolves against the viewport wherever it sits, so it stays in
  // <body> where page tooling expects an extension's chrome to be.
  const parent = options.position === "absolute" ? document.documentElement : document.body;
  parent.appendChild(host);

  const shadow = host.attachShadow({ mode: options.mode });
  if (options.css !== undefined) {
    // A <style> node rather than a constructable stylesheet: in a Firefox
    // content script `new CSSStyleSheet()` is a sandbox-realm object and
    // `shadow` is a page-realm Xray node, so `adoptedStyleSheets = [sheet]`
    // throws "Accessing from Xray wrapper is not supported". A <style> node is a
    // plain page-realm element with string content, so it crosses no boundary.
    const style = document.createElement("style");
    style.textContent = options.css;
    shadow.appendChild(style);
  }

  return {
    host,
    shadow,
    place(x, y) {
      if (options.position === "fixed") {
        host.style.left = `${x}px`;
        host.style.top = `${y}px`;
        return;
      }
      // Re-read the origin every time rather than caching it at mount: a page
      // is free to position <html>, or reflow it, while Jiffy is up.
      const origin = containingBlockOrigin(host);
      host.style.left = `${x - origin.x}px`;
      host.style.top = `${y - origin.y}px`;
    },
    remove() {
      host.remove();
    },
  };
}
