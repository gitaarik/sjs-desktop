#!/bin/bash
# Create a new tagged release for the desktop app.
#
# Usage: npm run release [-- patch|minor|major|prerelease] [-- -y|--yes]
#   Default: prerelease (bumps the pre-release number, e.g. beta.2 → beta.3)
#
#   e.g. npm run release                    → v0.4.0-beta.2 → v0.4.0-beta.3
#        npm run release -- patch           → v0.4.0-beta.3 → v0.4.1
#        npm run release -- minor           → v0.4.0-beta.3 → v0.5.0
#        npm run release -- major           → v0.4.0-beta.3 → v1.0.0
#        npm run release -- prerelease --yes → skip confirmation prompt
#
# What this does:
#   1. Determines the next version from src-tauri/tauri.conf.json
#   2. Checks for uncommitted changes
#   3. Bumps version in tauri.conf.json and package.json
#   4. Commits, tags (vX.Y.Z), and pushes with tags
#   5. GitHub Actions builds the release binaries automatically
#
# Pre-release tags (containing -beta, -alpha, -rc) are marked as
# pre-releases on GitHub automatically by the workflow.

set -euo pipefail

BUMP="prerelease"
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    -y|--yes) SKIP_CONFIRM=true ;;
    patch|minor|major|prerelease) BUMP="$arg" ;;
  esac
done

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
META_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
TAURI_CONF="$DESKTOP_DIR/src-tauri/tauri.conf.json"

# --- Validate ---

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" && "$BUMP" != "prerelease" ]]; then
  echo "Error: Invalid bump type '$BUMP'. Use patch, minor, major, or prerelease."
  exit 1
fi

# --- Get current version from tauri.conf.json ---

CURRENT_VERSION=$(node -e "console.log(require('$TAURI_CONF').version)")

if [ -z "$CURRENT_VERSION" ]; then
  echo "Error: Could not read version from tauri.conf.json"
  exit 1
fi

# --- Compute next version ---

compute_next_version() {
  local version="$1"
  local bump="$2"

  # Split off pre-release suffix (e.g. "0.4.0-beta.3" → base="0.4.0", pre="beta.3")
  local base="${version%%-*}"
  local pre=""
  if [[ "$version" == *-* ]]; then
    pre="${version#*-}"
  fi

  IFS='.' read -r major minor patch <<< "$base"

  case "$bump" in
    major)
      echo "$((major + 1)).0.0"
      ;;
    minor)
      echo "$major.$((minor + 1)).0"
      ;;
    patch)
      if [ -n "$pre" ]; then
        # If current is a pre-release, "patch" promotes to the base version
        # e.g. 0.4.0-beta.3 → 0.4.0
        echo "$base"
      else
        echo "$major.$minor.$((patch + 1))"
      fi
      ;;
    prerelease)
      if [ -n "$pre" ]; then
        # Bump the pre-release number: beta.2 → beta.3
        local pre_label="${pre%%.*}"
        local pre_num="${pre##*.}"
        if [[ "$pre_num" =~ ^[0-9]+$ ]]; then
          echo "$base-$pre_label.$((pre_num + 1))"
        else
          echo "$base-$pre.1"
        fi
      else
        # No pre-release suffix — bump patch and add beta.1
        echo "$major.$minor.$((patch + 1))-beta.1"
      fi
      ;;
  esac
}

NEW_VERSION=$(compute_next_version "$CURRENT_VERSION" "$BUMP")
NEW_TAG="v$NEW_VERSION"

echo "Release: v$CURRENT_VERSION → $NEW_TAG ($BUMP bump)"
echo ""

# --- Check for uncommitted changes ---

cd "$DESKTOP_DIR"
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: There are uncommitted changes. Commit or stash them first."
  git status --short
  exit 1
fi

# --- Confirm ---

echo "This will:"
echo "  1. Bump version to $NEW_VERSION in tauri.conf.json and package.json"
echo "  2. Commit, tag ($NEW_TAG), and push"
echo "  3. GitHub Actions will build release binaries"
echo ""
if [ "$SKIP_CONFIRM" = true ]; then
  echo "  (--yes flag: skipping confirmation)"
else
  read -r -p "Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo ""

# --- Bump version in tauri.conf.json ---

echo "==> Bumping version in tauri.conf.json..."
node -e "
  const fs = require('fs');
  const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf-8'));
  conf.version = '$NEW_VERSION';
  fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
"

# --- Bump version in package.json ---

echo "==> Bumping version in package.json..."
cd "$DESKTOP_DIR"
npm version "$NEW_VERSION" --no-git-tag-version > /dev/null

# --- Commit, tag, push ---

echo "==> Committing and tagging..."
cd "$DESKTOP_DIR"
git add src-tauri/tauri.conf.json package.json package-lock.json 2>/dev/null || git add src-tauri/tauri.conf.json package.json
git commit -m "Bump version to $NEW_VERSION"
git tag "$NEW_TAG"
git push origin main --tags

echo "    Pushed $NEW_TAG"

# --- Update meta-repo ---

echo "==> Updating meta-repo submodule..."
cd "$META_DIR"
git add desktop
git commit -m "Update submodule: desktop $NEW_TAG"
git tag "desktop-$NEW_TAG"
git push origin master --tags

echo "    Meta-repo updated"

# --- Done ---

echo ""
echo "Released $NEW_TAG"
echo "GitHub Actions will build the binaries: https://github.com/gitaarik/sjs-desktop/actions"
