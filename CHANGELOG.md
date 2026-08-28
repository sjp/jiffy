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
- Keyboard shortcuts scoped to the focused control bar (Space, ←/→, Home, End).
- Draggable, repositionable control bar with snap-back-to-default.
- On-demand player bundle: the script injected into every page is a ~9 KB
  loader, and the decoders, engine and UI (~97 KB) are imported only when
  you actually pick an image.
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
- Firefox (142+) and Chrome (137+) builds.
