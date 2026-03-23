# Changelog

All notable changes to the Smart Job Seeker desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
