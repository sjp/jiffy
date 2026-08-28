// Where to put the overlay canvas when the <img> is transformed.
//
// `getBoundingClientRect()` returns the *axis-aligned* box: for an image that a
// page has rotated, skewed or scaled with CSS `transform` — its own, or one on a
// gallery container above it — that rect is the shadow the image casts, not the
// image. Sizing the canvas from it draws playback upright and too big inside a
// rotated frame.
//
// So we reproduce the transform on the canvas instead. Two pieces are needed:
// the accumulated matrix (this element's transform and every ancestor's,
// multiplied), and where the *untransformed* box sits. We take only the linear
// (2x2) part of each matrix and recover the translation from the measured rect —
// see `originUnderTransform`. That keeps the walk cheap and, more importantly,
// leaves layout out of it: element offsets, scroll positions, `transform-origin`
// and positioned ancestors all move a box without rotating it, and the browser
// has already accounted for every one of them in the rect it handed us.
//
// This is pure geometry over DOM measurements, kept out of ./overlay so it can
// be exercised with stubbed rects and styles (jsdom has no layout).

/**
 * The linear part of a 2D affine transform, named as in CSS `matrix(a, b, c, d,
 * e, f)`: (a, b) is where the x unit vector lands and (c, d) the y one. The
 * translation (e, f) is dropped on purpose.
 */
export interface Linear2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

export const IDENTITY: Linear2D = { a: 1, b: 0, c: 0, d: 1 };

// Sub-pixel slack for the identity test: a transform chain that cancels out
// (scale(2) inside scale(0.5)) can leave rounding dust, and treating that as a
// transform would cost us the exact fractional rect of the untransformed path.
const EPSILON = 1e-6;

/** Computed `transform` values are always resolved to one of these two forms. */
const MATRIX_RE = /^matrix\(([^)]*)\)$/;

/**
 * The linear part of a computed `transform` value, or `null` if it isn't a 2D
 * matrix — `matrix3d(...)` from a 3D rotation or a `perspective()`, which no
 * 2x2 matrix can stand in for. Callers fall back to the bounding box there.
 */
export function parseLinear(value: string): Linear2D | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none") return IDENTITY;
  const [, body] = MATRIX_RE.exec(trimmed) ?? [];
  if (body === undefined) return null;
  const parts = body.split(",").map((part) => Number.parseFloat(part));
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null;
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return { a, b, c, d };
}

/** `outer` applied after `inner`, i.e. the matrix product outer x inner. */
export function multiply(outer: Linear2D, inner: Linear2D): Linear2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
  };
}

export function isIdentity(m: Linear2D): boolean {
  return (
    Math.abs(m.a - 1) < EPSILON &&
    Math.abs(m.b) < EPSILON &&
    Math.abs(m.c) < EPSILON &&
    Math.abs(m.d - 1) < EPSILON
  );
}

/** As a CSS `transform` value, for a box whose `transform-origin` is `0 0`. */
export function toCssMatrix(m: Linear2D): string {
  return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, 0, 0)`;
}

/** A viewport-relative box — the part of a DOMRect this module reads. */
export interface MeasuredRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the top-left of an untransformed `width` x `height` box has to sit, in
 * viewport coordinates, for `m` to map it onto `rect`.
 *
 * `rect` is the bounding box of the four transformed corners, so its top-left is
 * the *minimum* corner under `m` — not the image of (0, 0). Subtracting that
 * minimum recovers the translation the walk threw away, exactly, whatever mix of
 * layout offsets and transform origins produced it.
 */
export function originUnderTransform(
  m: Linear2D,
  width: number,
  height: number,
  rect: MeasuredRect,
): { x: number; y: number } {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ];
  let minX = Infinity;
  let minY = Infinity;
  for (const { x, y } of corners) {
    minX = Math.min(minX, m.a * x + m.c * y);
    minY = Math.min(minY, m.b * x + m.d * y);
  }
  return { x: rect.left - minX, y: rect.top - minY };
}

/**
 * Next element up, stepping out of a shadow tree to its host: an image inside a
 * web component still inherits transforms from the elements around the host.
 */
function parentElementOrHost(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const parent = node.parentNode as (ShadowRoot & { host?: Element }) | null;
  return parent?.host ?? null;
}

/**
 * Every CSS transform between `el`'s own box and the viewport, multiplied into
 * one matrix (outermost applied last). `null` means the chain contains something
 * a 2D matrix can't express: a 3D transform, or an ancestor `perspective`, which
 * warps a descendant's rendering without appearing in its own `transform`.
 */
export function accumulatedTransform(el: Element): Linear2D | null {
  let matrix = IDENTITY;
  let node: Element | null = el;
  while (node) {
    const style = getComputedStyle(node);
    // Only an ancestor's perspective distorts `el`; its own applies to children.
    if (node !== el && style.perspective !== "" && style.perspective !== "none") return null;
    const local = parseLinear(style.transform);
    if (!local) return null;
    if (!isIdentity(local)) matrix = multiply(local, matrix);
    node = parentElementOrHost(node);
  }
  return matrix;
}

/** A `getComputedStyle` length, or 0 for the ones jsdom/UA leave blank. */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The element's border-box size *before* any transform, at sub-pixel precision.
 *
 * The resolved `width`/`height` are used values of the content box, so the
 * padding and borders go back on. `offsetWidth`/`offsetHeight` are the same
 * measurement rounded to whole pixels — good enough as a fallback for an element
 * whose computed size doesn't resolve to a length.
 */
export function untransformedSize(el: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(el);
  const contentWidth = Number.parseFloat(style.width);
  const contentHeight = Number.parseFloat(style.height);
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)) {
    return { width: el.offsetWidth, height: el.offsetHeight };
  }
  return {
    width:
      contentWidth +
      px(style.paddingLeft) +
      px(style.paddingRight) +
      px(style.borderLeftWidth) +
      px(style.borderRightWidth),
    height:
      contentHeight +
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth),
  };
}

/** Page-coordinate box plus the CSS `transform` that lays it over an element. */
export interface OverlayBox {
  /** Page coordinates (scroll included) of the untransformed box's top-left. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** For an element whose `transform-origin` is `0 0`; `"none"` when upright. */
  readonly transform: string;
}

/**
 * The box an absolutely-positioned element needs to cover `el` exactly,
 * transforms and all.
 *
 * Untransformed images take the plain bounding-rect path, which is both cheaper
 * and exact — no size is inferred, and no rounding is introduced.
 */
export function overlayBox(el: HTMLElement): OverlayBox {
  const rect = el.getBoundingClientRect();
  const matrix = accumulatedTransform(el);
  if (!matrix || isIdentity(matrix)) {
    return {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      transform: "none",
    };
  }
  const { width, height } = untransformedSize(el);
  const origin = originUnderTransform(matrix, width, height, rect);
  return {
    left: origin.x + window.scrollX,
    top: origin.y + window.scrollY,
    width,
    height,
    transform: toCssMatrix(matrix),
  };
}
