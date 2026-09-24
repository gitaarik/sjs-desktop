#!/usr/bin/env bash
set -euo pipefail

npm ci
( cd src/ui && npm ci )

# TS type-check across src/main (and any other TS in the workspace).
npm run typecheck

# Tauri's build.rs validates that the externalBin sidecar binary exists at
# src-tauri/binaries/<triple>. For PR-time CI we only care that the Rust
# code compiles — the real sidecar is built per-platform by release.yml.
# Stub the file so clippy's build passes; the contents are irrelevant.
TRIPLE=$(rustc -vV | awk '/^host:/ {print $2}')
SIDECAR=src-tauri/binaries/sjs-sidecar-$TRIPLE
mkdir -p src-tauri/binaries
[ -f "$SIDECAR" ] || { touch "$SIDECAR" && chmod +x "$SIDECAR"; }

# The Tauri backend: formatting first, as it needs no build, then clippy.
# Clippy compiles everything `cargo check` did, so it catches the same type
# errors and broken cargo deps, and lints on top. Both were at zero when this
# started, so any warning fails; there is no baseline. Still not the full
# release build, which is matrixed in release.yml.
( cd src-tauri && cargo fmt --check )
( cd src-tauri && cargo clippy --all-targets -- -D warnings )
