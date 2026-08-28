# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `release/<version>` tag (e.g. `release/1.0.0`),
which stamps `<version>` into the built manifests and publishes a GitHub Release
with the packaged Firefox and Chrome `.zip`s. See `scripts/release.sh`.

## [Unreleased]

### Added

- Video-like playback controls (play/pause, frame-step, seek) for animated
  GIF, WebP, APNG, and AVIF images.
- Pick mode: click the toolbar button, then click an image to attach controls —
  including images embedded in an iframe; standalone image pages toggle controls
  directly. The image is resolved by hit-testing the click point, so images
  covered by a link overlay, a caption gradient or a lightbox trigger still pick.
  While picking, the image under the cursor is outlined — with a reminder that
  Esc cancels — so on a dense page the pick is never a guess.
- Copy or save the frame on screen, from the ⚙ menu: **Copy frame** puts a PNG
  on the clipboard, **Save frame…** downloads one named after the image and the
  frame number (`cat-f012.png`). Both come from the same composited pixels the
  overlay is showing, so what you get is exactly the frame you stepped to.
- Keyboard shortcuts scoped to the focused control bar (Space, ←/→, Home, End).
- Draggable, repositionable control bar with snap-back-to-default.
- Nothing is asked for at install: no content script is declared and no host
  permission is required, so there's no "read and change all your data on all
  websites" warning. Clicking the toolbar button grants access to that tab alone
  and injects the picker on the spot. Access to every site is an optional
  checkbox in the popup, off by default, needed only for images inside
  cross-origin frames and images whose server won't let another page read them.
- On-demand player bundle: what gets injected when you click the toolbar button
  is a ~13 KB loader, and the decoders, engine and UI (~115 KB) are imported only
  when you actually pick an image.
- Decoding runs in a Worker, so picking a large image no longer freezes the
  page: scrolling, the page's own animations and the "Loading…" toast all keep
  going while the frames are built. Cancelling with the toast's ✕ terminates the
  worker, stopping the work rather than discarding its result. Where a worker
  can't be spawned the decode falls back to the page's thread as before.
- Bounded decode memory: only every 16th frame is held as a full-canvas bitmap.
  The frames in between are recomposited on demand from their (much smaller)
  source patches, and animated AVIF is re-decoded by index from a live decoder,
  so a long animation costs roughly an order of magnitude less than holding a
  bitmap per frame.
- Decode memory ceiling sized to the machine: on Chromium it is a share of
  `navigator.deviceMemory`, elsewhere a fixed ~1.2 GB. An image whose decode
  would go over it is refused before any pixels are allocated, and the toast
  names the size it would have needed, so an outsized image can no longer take
  the tab down with it.
- Two-tier image fetch: the content script fetches the bytes itself first, so it
  reuses the browser's cache, carries the page's cookies and Referer (images that
  a cookie-less background fetch 403s), and can read `blob:` sources. The
  background's privileged fetch remains the fallback for cross-origin images that
  send no CORS headers.
- The playback overlay honours the page's own CSS: an image the page has
  rotated, scaled or skewed — by its own `transform`, or one on a container above
  it (a shadow host included) — plays back at that same angle and size instead of
  upright inside its bounding box, and the image's `border-radius` and
  `clip-path` come across too, so rounded avatars and clipped images keep their
  shape. 3D transforms, which no 2D matrix can stand in for, fall back to
  covering the bounding box.
- Firefox (142+) and Chrome (137+) builds.
