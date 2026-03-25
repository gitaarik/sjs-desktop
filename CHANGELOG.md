# Changelog

All notable changes to the Smart Job Seeker desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.0-beta.1] - 2026-03-25

### Added

- **App version display** -- version number shown in the header next to the app title
- **Check for updates button** -- manual update check from the footer, with status feedback
- **Beta update channel** -- users can switch between stable and beta channels to receive early updates; preference persisted in localStorage
- **Channel-aware updater** -- custom Rust commands route update checks to the correct GitHub release endpoint per channel

### Changed

- **Release workflow** -- auto-detects prerelease tags (`-beta`, `-alpha`, `-rc`) and marks GitHub Releases as prereleases accordingly; new CI job maintains a pinned `beta-latest` release for the beta updater endpoint

### Improved

- **Logging across tunnel client, CDP bridge, and Chrome manager** -- replaced silent catch blocks with error logging for CDP parse errors, screenshot failures, click/scroll handler errors, and invalid server messages; added CDP retry progress logging and better preferences write error reporting

## [0.3.1] - 2026-03-22

### Added

- **Keyboard modifier support in clickElement** -- Ctrl+click delegation for opening jobs in new tabs, with full CDP Input.dispatchKeyEvent support for Control, Shift, Alt, Meta modifiers
- **scrollRevealLazyContent delegation** -- run entire scroll-and-detect loop locally via direct CDP connection, eliminating dozens of tunnel roundtrips per search page

## [0.3.0] - 2026-03-20

### Added

- **clickElement tunnel message** -- delegate Playwright click operations to the desktop app via direct CDP, avoiding tunnel latency for each click

### Changed

- Publish GitHub releases automatically instead of as drafts

## [0.2.0] and earlier

Initial desktop app release with CDP tunnel infrastructure, Chrome session management, bidirectional CDP relay, screenshot support, and keepMinimized mode.
