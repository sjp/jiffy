// Inlined player-control SVG glyphs (issue 07 / PRD §6). We borrow simple inline
// icons rather than pulling in an icon package — the content script injects into
// every matching page, so bundle size matters. Built with Preact's `h` (no JSX)
// so this stays a plain `.ts` module per the project structure.
//
// Icons are decorative: `aria-hidden` + `focusable="false"`, leaving the
// accessible name to the enclosing <button> (issue 08).
import { h } from 'preact';
import type { ComponentChildren, VNode } from 'preact';

export interface IconProps {
  size?: number;
}

const glyph = (size: number, children: ComponentChildren): VNode =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children,
  );

export const PlayIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h('path', { d: 'M8 5v14l11-7z' }));

export const PauseIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, [
    h('rect', { x: 6, y: 5, width: 4, height: 14 }),
    h('rect', { x: 14, y: 5, width: 4, height: 14 }),
  ]);

export const StepBackIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, [
    h('rect', { x: 6, y: 6, width: 2, height: 12 }),
    h('path', { d: 'M20 6 9 12l11 6z' }),
  ]);

export const StepForwardIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, [
    h('rect', { x: 16, y: 6, width: 2, height: 12 }),
    h('path', { d: 'M4 6l11 6L4 18z' }),
  ]);

export const CloseIcon = ({ size = 16 }: IconProps): VNode =>
  glyph(size, h('path', { d: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' }));

// Six-dot "grip" affordance for the drag handle (issue: movable controls). Two
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
    ].map(([cx, cy]) => h('circle', { cx, cy, r: 1.5 })),
  );
