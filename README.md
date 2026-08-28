<div align="center">

<img src="public/icons/icon.svg" width="88" height="88" alt="Jiffy logo" />

# Jiffy

**Pause, scrub, and frame-step any animated image — like a video player for GIFs.**

Jiffy adds a little video
player to any animated **GIF, WebP, APNG, or AVIF** on the web.

Works in **Firefox** (142+) and **Chrome** (137+).

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
2. **Click the animated image** you want to control. The one under your cursor
   is outlined as you move, so you can see which image you'll get before you
   commit — handy in a gallery, or where a link or caption sits over the image.
   A small player bar appears attached to it.
3. **Play with it** — pause, step through frames, scrub, change speed, and more
   (see the controls below).
4. **Click the ✕** (or click the image again) when you're done.

> 💡 **On a standalone image page** — like when you open a `.gif` link directly —
> just click the toolbar button and the controls appear instantly. No need to pick.

> 🔒 **Images in embedded frames** — a GIF inside an embed from another site (an
> ad slot, a comment widget, an embedded post) is out of reach until you tick
> **Allow on all sites** in the popup. See [Permissions](#permissions).

> ⚠️ **Very large animations** — if decoding an image would need more memory than
> the machine can spare, Jiffy declines it and tells you the size it would have
> taken, rather than risking the tab.

### Controls

| Control            | What it does                               |
| ------------------ | ------------------------------------------ |
| ▶ / ⏸ Play / Pause | Start or stop playback                     |
| ◀ / ▶ Step         | Jump one frame back or forward (pauses)    |
| Scrubber           | Click or drag to seek to any frame         |
| Speed              | Slow down or speed up playback             |
| Direction          | Forward, reverse, or ping-pong (bounce)    |
| Copy frame         | Put the frame on screen on the clipboard   |
| Save frame…        | Download the frame on screen as a PNG      |
| Grip handle        | Drag to move the player bar out of the way |
| Double-click grip  | Snap the bar back to its default spot      |
| ✕ Close            | Remove the controls                        |

> 💾 **Getting a frame out** — speed, direction, loop and the two frame-export
> actions live behind the ⚙ button, which keeps the bar small enough to sit on
> top of the image. Step to the moment you want, then **Copy frame** to paste it
> straight into an editor or chat, or **Save frame…** to write a PNG named after
> the image and the frame number (`cat-f012.png`).

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

## Permissions

Jiffy installs with **no access to any site** — none of the "read and change all
your data on all websites" that browsers warn about. Clicking the toolbar button
is what lets it into the page you're on, and the picker is injected only then;
navigate away and that access lapses.

Copying a frame to the clipboard uses the `clipboardWrite` permission. It grants
no access to any page and browsers don't prompt for it; saving a frame needs
nothing at all.

Two things need more reach than a single page, so the popup carries an optional
**Allow on all sites** checkbox. It's off by default, and you can turn it back
off there or in your browser's extension settings at any time:

- **Images inside an embedded frame from another site** — Jiffy can't offer them
  for picking without it.
- **Images a site won't hand over** — some servers refuse to let another page
  read their images. Jiffy then can't get the bytes to decode and says
  "Couldn't load this image"; with all-sites access it fetches them itself.

## Privacy

Jiffy does its work entirely on your own device. It doesn't collect data, send
anything to a server, or track you. The Firefox build states that in its
manifest, through the `data_collection_permissions` declaration AMO expects —
which is also what sets the Firefox 142 floor, since earlier releases don't
accept that key.

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
npm run lint:js         # oxlint
npm run format          # oxfmt (write)
npm run format:check    # oxfmt (check only)
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
