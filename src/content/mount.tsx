// Shadow root + Preact render of the controls UI (issue 09).
import { render } from 'preact';
import type { Engine } from '../engine/types';
import { Controls } from '../ui/Controls';
import controlsCss from '../ui/controls.css';

/**
 * Attach a shadow root to `host`, install the adopted stylesheet, and render the
 * controls bound to `engine`. Returns a teardown function.
 */
export function mountControls(host: HTMLElement, engine: Engine): () => void {
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(controlsCss);
  shadow.adoptedStyleSheets = [sheet];

  render(<Controls engine={engine} />, shadow);
  return () => render(null, shadow);
}
