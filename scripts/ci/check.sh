#!/usr/bin/env bash
set -euo pipefail

npm ci
( cd src/ui && npm ci )

# TS type-check across src/main (and any other TS in the workspace).
npm run typecheck

# Rust check for the Tauri backend — catches type errors / broken cargo deps
# without doing the full release build (which is matrixed in release.yml).
( cd src-tauri && cargo check --all-targets )
