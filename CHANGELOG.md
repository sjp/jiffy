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
- Bounded decode memory: only every 16th frame is held as a full-canvas bitmap.
  The frames in between are recomposited on demand from their (much smaller)
  source patches, and animated AVIF is re-decoded by index from a live decoder,
  so a long animation costs roughly an order of magnitude less than holding a
  bitmap per frame.
- Firefox (142+) and Chrome (137+) builds.
