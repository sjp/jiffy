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
