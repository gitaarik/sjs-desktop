#!/usr/bin/env bash
set -euo pipefail

npm ci
( cd src/ui && npm ci )

# TS type-check across src/main (and any other TS in the workspace).
npm run typecheck

# Tauri's build.rs validates that the externalBin sidecar binary exists at
# src-tauri/binaries/<triple>. For PR-time CI we only care that the Rust
# code compiles — the real sidecar is built per-platform by release.yml.
# Stub the file so cargo check passes; the contents are irrelevant.
TRIPLE=$(rustc -vV | awk '/^host:/ {print $2}')
SIDECAR=src-tauri/binaries/sjs-sidecar-$TRIPLE
mkdir -p src-tauri/binaries
[ -f "$SIDECAR" ] || { touch "$SIDECAR" && chmod +x "$SIDECAR"; }

# Rust check for the Tauri backend — catches type errors / broken cargo deps
# without doing the full release build (which is matrixed in release.yml).
( cd src-tauri && cargo check --all-targets )
