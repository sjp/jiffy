<div align="center">

<img src="public/icons/icon.svg" width="88" height="88" alt="Jiffy logo" />

# Jiffy

**Pause, scrub, and frame-step any animated image — like a video player for GIFs.**

Jiffy adds a little video
player to any animated **GIF, WebP, APNG, or AVIF** on the web.

Works in **Firefox** (142+) and **Chrome** (120+).

</div>

## Install

- **Firefox**: https://addons.mozilla.org/en-US/firefox/addon/jiffy/
- **Chrome**: _coming soon..._

Prefer to build it yourself? See [Building from source](#building-from-source).

## Demo

<div align="center">

<video src="https://github.com/user-attachments/assets/61902889-da8f-418c-a083-5dd1d66df0e9" width="720" controls muted playsinline></video>

</div>

> ▶️ If the video above doesn't play, [watch the demo](https://github.com/user-attachments/assets/61902889-da8f-418c-a083-5dd1d66df0e9) directly.

## Usage

1. **Click the Jiffy button** in your browser toolbar. Your cursor turns into a
   crosshair.
2. **Click the animated image** you want to control. A small player bar appears
   attached to it.
3. **Play with it** — pause, step through frames, scrub, change speed, and more
   (see the controls below).
4. **Click the ✕** (or click the image again) when you're done.

> 💡 **On a standalone image page** — like when you open a `.gif` link directly —
> just click the toolbar button and the controls appear instantly. No need to pick.

### Controls

| Control            | What it does                               |
| ------------------ | ------------------------------------------ |
| ▶ / ⏸ Play / Pause | Start or stop playback                     |
| ◀ / ▶ Step         | Jump one frame back or forward (pauses)    |
| Scrubber           | Click or drag to seek to any frame         |
| Speed              | Slow down or speed up playback             |
| Direction          | Forward, reverse, or ping-pong (bounce)    |
| Grip handle        | Drag to move the player bar out of the way |
| Double-click grip  | Snap the bar back to its default spot      |
| ✕ Close            | Remove the controls                        |

### Keyboard shortcuts

Click the player bar (or Tab to it) to focus it, then:

| Key       | Action                        |
| --------- | ----------------------------- |
| `Space`   | Play / Pause                  |
| `←` / `→` | Step one frame back / forward |
| `Home`    | Jump to the first frame       |
| `End`     | Jump to the last frame        |

Shortcuts only affect the player bar you've focused — they won't disturb other
GIFs on the page or get in the way when you're typing in a text box.

## Privacy

Jiffy does its work entirely on your own device. It doesn't collect data, send
anything to a server, or track you.

## Building from source

<details>
<summary>For developers — click to expand</summary>

### Prerequisites

- **Node.js** 18+ (the devcontainer uses Node 24)
- **npm** (included with Node)

### Setup

```sh
npm install
```

### Build

```sh
npm run build           # both browsers
npm run build:firefox   # → dist-firefox/
npm run build:chrome    # → dist-chrome/
```

### Watch mode (rebuilds on change)

```sh
npm run dev:firefox
npm run dev:chrome
```

### Quality checks

```sh
npm run typecheck       # TypeScript (no emit)
npm run test            # Unit tests
npm run lint            # web-ext lint on dist-firefox/
npm run lint:js         # ESLint
npm run format          # Prettier (write)
npm run format:check    # Prettier (check only)
```

### Load your local build

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
→ pick `dist-firefox/manifest.json`. Re-run the build and click **Reload** to pick
up changes. (Or run `web-ext run -s dist-firefox/` on your host machine for
auto-reload.)

**Chrome** — `chrome://extensions/` → enable **Developer mode** → **Load unpacked**
→ select `dist-chrome/`. Click the refresh icon on the card after each rebuild.

### Packaging

```sh
npm run pack            # → jiffy-firefox.zip and jiffy-chrome.zip
```

### Devcontainer

The repo includes a VS Code devcontainer (`.devcontainer/`) based on the official
`typescript-node:24-trixie` image with dependencies pre-installed. Open the repo
in VS Code and choose **Reopen in Container**. Note: `web-ext run` launches a
browser and must run on your host machine, not inside the container.

</details>

## License

[MIT](LICENSE)
</content>
