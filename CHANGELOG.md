# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `release/<version>` tag (e.g. `release/1.0.0`),
which stamps `<version>` into the built manifests and publishes a GitHub Release
with the packaged Firefox and Chrome `.zip`s. See `scripts/release.sh`.

## [Unreleased]

### Added

- Copy or save the frame on screen, from the ⚙ menu: **Copy frame** puts a PNG
  on the clipboard, **Save frame…** downloads one named after the image and the
  frame number (`cat-f012.png`). Both come from the same composited pixels the
  overlay is showing, so what you get is exactly the frame you stepped to.
- Nothing is asked for at install: no content script is declared and no host
  permission is required, so there's no "read and change all your data on all
  websites" warning. Clicking the toolbar button grants access to that tab alone
  and injects the picker on the spot. Access to every site is an optional
  checkbox in the popup, off by default, needed only for images inside
  cross-origin frames and images whose server won't let another page read them.
- Images embedded in an iframe can be picked, given all-sites access.
- While picking, the image under the cursor is outlined — with a reminder that
  Esc cancels — so on a dense page the pick is never a guess.
- The playback overlay honours the page's own CSS: an image the page has
  rotated, scaled or skewed — by its own `transform`, or one on a container above
  it (a shadow host included) — plays back at that same angle and size instead of
  upright inside its bounding box, and the image's `border-radius` and
  `clip-path` come across too, so rounded avatars and clipped images keep their
  shape. 3D transforms, which no 2D matrix can stand in for, fall back to
  covering the bounding box.

### Changed

- The image to control is resolved by hit-testing the click point, so images
  covered by a link overlay, a caption gradient or a lightbox trigger now pick.
- On-demand player bundle: what gets injected when you click the toolbar button
  is a ~13 KB loader, and the decoders, engine and UI (~115 KB) are imported only
  when you actually pick an image.
- Decoding runs in a Worker, so picking a large image no longer freezes the
  page: scrolling, the page's own animations and the "Loading…" toast all keep
  going while the frames are built. Cancelling with the toast's ✕ terminates the
  worker, stopping the work rather than discarding its result. Where a worker
  can't be spawned the decode falls back to the page's thread as before.
- The decode worker now actually starts on Chrome. A worker script has to be
  same-origin with the document that asks for one, and a content script counts
  as the page there — so `chrome-extension://…` was refused every time and every
  decode quietly ran on the page's thread. The bundle is fetched and run from a
  `blob:` URL when the extension URL is refused, which is same-origin with the
  page. A page whose CSP excludes `blob:` workers still falls back to the page's
  thread, and says so once in the console.
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
- Minimum browser versions raised to Firefox 142 and Chrome 148. Chrome only
  exposes the `browser.*` namespace — and promise-returning `runtime.onMessage`
  listeners — from 148, both of which every entry point here relies on.

### Fixed

- The control bar and the playback overlay are no longer offset from the image
  on sites whose CSS positions `<body>` — very common, and enough to drop both
  down and to the right of the picture by the body's own margin and offset.
  Jiffy's chrome now hangs off `<html>` and corrects for whatever containing
  block it lands in.
- Large images fetched with all-sites access no longer fail late with
  "Couldn't load this image". The background handed the whole image back in one
  extension message, which browsers cap at tens of megabytes — so anything above
  that downloaded in full and then died on the way back, while the same image
  loaded fine when the page allowed a direct fetch. The bytes now stream back in
  chunks, so both paths share the same 256 MB ceiling, the background never
  holds a whole image in memory, and cancelling a load stops the download
  instead of leaving it running with nobody listening.
- Jiffy's privileged fetch no longer reaches somewhere the page itself couldn't.
  With all-sites access it would fetch an image on `localhost`, a private
  address (`10.x`, `192.168.x`, …) or an intranet name for any page that asked;
  it now does that only when the page asking is on such a host too. It also
  stops on a `Content-Type` the server says isn't an image, rather than
  downloading an error page or a mislabelled video in full first.
- The page can no longer read the frames Jiffy draws. The overlay canvas sat in
  the page's own DOM, where any script could find it and read the pixels back —
  including for images fetched with the extension's host permissions, which the
  page itself would never have been allowed to read (something on an intranet
  host, or behind another site's cookies). It now lives in a closed shadow root.
- Transparent animated WebP and APNG images no longer gain a solid box behind
  them while controlled. Both formats carry a suggested background colour that
  browsers are told to ignore — and do — but which the encoders most people use
  write as opaque white; it was being painted in, so a transparent sticker went
  from showing the page to sitting in a white rectangle. The saved and copied
  frames were carrying it too.
- An animated image served from a URL with no recognisable file extension is no
  longer skipped before it is looked at.

## [0.3.0] — 2026-06-18

### Added

- Loading a large image can be cancelled from the toast, and the size limits are
  raised now that a long decode is abortable.

## [0.2.1] — 2026-06-09

### Fixed

- Chrome rejected the byte buffer handed back by the background fetch, so images
  that took the privileged path failed to load there.

## [0.2.0] — 2026-06-09

### Added

- A ⚙ settings menu on the control bar.
- Playback speed control.
- Loop detection, with playback looping on or off.
- Reverse and "ping pong" (alternating forward/reverse) playback.

### Changed

- The frame readout keeps a stable width as the digit count changes (1, 10,
  100…), so the bar no longer jitters during playback.
- The mutation observer is bound only while a player is active.

## [0.1.0] — 2026-06-01

### Added

- Video-like playback controls (play/pause, frame-step, seek) for animated
  GIF, WebP, APNG, and AVIF images.
- Pick mode: click the toolbar button, then click an image to attach controls.
  Standalone image pages — a `.gif` opened directly — toggle controls without
  picking.
- Keyboard shortcuts scoped to the focused control bar (Space, ←/→, Home, End).
- Draggable, repositionable control bar with snap-back-to-default, kept within
  the viewport, and a ✕ to put the image back.
- Transparent frames composite over the background the page (or the browser's
  own image document) would have shown, rather than over the image underneath.
- Loading and error states, with limits and timeouts so an oversized or stalled
  image can't leave the page stuck.
- Firefox and Chrome builds.
