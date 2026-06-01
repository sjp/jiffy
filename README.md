# Jiffy

A browser extension that gives animated GIFs, WebP, APNG, and AVIF images video-like playback controls: play, pause, frame-step, and seek.

Works in **Firefox** (142+) and **Chrome** (120+).

## How it works

Click the Jiffy toolbar button to enter pick mode — the cursor changes to a crosshair. Click any animated image on the page to attach a control bar to it. Click a second time (or press the close button) to remove it.

On pages that are a standalone animated image (e.g. navigating directly to a `.gif` URL), the toolbar button toggles controls on that image immediately without needing to pick.

### Controls

| Control            | Action                                    |
| ------------------ | ----------------------------------------- |
| ◀ / ▶ step buttons | Previous / next frame (pauses if playing) |
| Play / Pause       | Toggle playback                           |
| Scrubber           | Click or drag to seek                     |
| Grip handle        | Drag to reposition the control bar        |
| Double-click grip  | Snap bar back to default position         |
| Close (✕)          | Remove controls and free memory           |

### Keyboard shortcuts

Focus the control bar (click it or Tab to it), then:

| Key       | Action                        |
| --------- | ----------------------------- |
| `Space`   | Play / Pause                  |
| `←` / `→` | Step one frame back / forward |
| `Home`    | Jump to first frame           |
| `End`     | Jump to last frame            |

Shortcuts are scoped to the focused control bar — they won't fire on other GIFs on the same page or interfere with text inputs.

## Development

### Prerequisites

- **Node.js** 18+ (the devcontainer uses Node 24)
- **npm** (included with Node)
- **web-ext** (optional, for linting and packaging — installed automatically in the devcontainer)

### Install dependencies

```sh
npm install
```

### Build

```sh
# Build both Firefox and Chrome
npm run build

# Build one browser only
npm run build:firefox   # → dist-firefox/
npm run build:chrome    # → dist-chrome/
```

### Watch mode (rebuilds on file change)

```sh
npm run dev:firefox
npm run dev:chrome
```

### Type checking and tests

```sh
npm run typecheck   # TypeScript type check (no emit)
npm run test        # Unit tests
```

## Loading the extension

### Firefox

**Option A — temporary install (easiest):**

1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick `dist-firefox/manifest.json`

The extension stays loaded until Firefox restarts. Re-run the build and click **Reload** in `about:debugging` to pick up changes.

**Option B — web-ext (auto-reloads on rebuild):**

```sh
# Run on your host machine (not inside the devcontainer)
web-ext run -s dist-firefox/
```

### Chrome

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist-chrome/` folder

Click the refresh icon on the extension card after each rebuild to reload it.

## Packaging

```sh
# Firefox .zip (for AMO submission)
web-ext build -s dist-firefox/ -a web-ext-artifacts/

# Chrome: zip dist-chrome/ manually, or use the Chrome Web Store developer dashboard
```

## Devcontainer

The repo includes a VS Code devcontainer (`.devcontainer/`) based on the official `typescript-node:24` image. It pre-installs dependencies and `web-ext`. To use it, open the repo in VS Code and choose **Reopen in Container**.

Note: `web-ext run` (which launches a browser) must be run on your host machine, not inside the container, since it needs access to a display.

## License

See [LICENSE](LICENSE).
