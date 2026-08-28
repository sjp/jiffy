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
  directly.
- Keyboard shortcuts scoped to the focused control bar (Space, ←/→, Home, End).
- Draggable, repositionable control bar with snap-back-to-default.
- On-demand player bundle: the script injected into every page is a ~7 KB
  loader, and the decoders, engine and UI (~90 KB) are imported only when
  you actually pick an image.
- Firefox (130+) and Chrome (120+) builds.
