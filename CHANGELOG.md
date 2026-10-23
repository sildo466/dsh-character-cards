# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-24

First public release.

### Added

- Per-session identity cards with a global default and explicit per-session overrides.
- A card library and visual editor in Settings, with live preview, token estimate, and rule advisories.
- A card picker beside the composer, with "follow the default" and "no card" choices.
- Explicit re-apply for sessions that are already running.
- Import, export, copy, and delete for single `.dshcd` files, preserving unknown fields.
- Automatic id renaming on import and copy conflicts.
- Host routes for cards, preview, apply, session overrides, and the default pointer.

### Fixed

- The client half now declares its `slots` dependency, so both surfaces mount reliably.
- UI primitives wrapped in `forwardRef`/`memo` are no longer treated as missing.
- The composer picker refreshes its card list every time it opens, so newly created cards appear without a page reload.
