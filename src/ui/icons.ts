// Inlined player-control SVG glyphs. We borrow simple inline icons rather than
// pulling in an icon package — the content script injects into
// every matching page, so bundle size matters. Built with Preact's `h` (no JSX)
// so this stays a plain `.ts` module per the project structure.
//
// Icons are decorative: `aria-hidden` + `focusable="false"`, leaving the
// accessible name to the enclosing <button>.
import { h } from "preact";
import type { ComponentChildren, VNode } from "preact";

export interface IconProps {
  size?: number;
}

const glyph = (size: number, children: ComponentChildren): VNode =>
  h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      focusable: "false",
    },
    children,
  );

export const PlayIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h("path", { d: "M8 5v14l11-7z" }));

export const PauseIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, [
    h("rect", { x: 6, y: 5, width: 4, height: 14 }),
    h("rect", { x: 14, y: 5, width: 4, height: 14 }),
  ]);

export const StepBackIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, [
    h("rect", { x: 6, y: 6, width: 2, height: 12 }),
    h("path", { d: "M20 6 9 12l11 6z" }),
  ]);

export const StepForwardIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, [
    h("rect", { x: 16, y: 6, width: 2, height: 12 }),
    h("path", { d: "M4 6l11 6L4 18z" }),
  ]);

export const CloseIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(
    size,
    h("path", {
      d: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    }),
  );

// Six-dot "grip" affordance for the drag handle. Two
// columns of three dots — the conventional cue that an element can be dragged.
export const GripIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(
    size,
    [
      [9, 6],
      [9, 12],
      [9, 18],
      [15, 6],
      [15, 12],
      [15, 18],
    ].map(([cx, cy]) => h("circle", { cx, cy, r: 1.5 })),
  );

// Gear/cog for the settings button.
export const CogIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(
    size,
    h("path", {
      d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
    }),
  );

// Right-pointing chevron: cue that a main-menu row opens a sub-panel.
export const ChevronRightIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h("path", { d: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" }));

// Left-pointing chevron for the sub-panel back header.
export const BackIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h("path", { d: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" }));

// Checkmark on the active option in a sub-panel.
export const CheckIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h("path", { d: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }));

// Two offset sheets: "copy this to the clipboard".
export const CopyIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(
    size,
    h("path", {
      d: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
    }),
  );

// Arrow into a tray: "save this to a file".
export const DownloadIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h("path", { d: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" }));
