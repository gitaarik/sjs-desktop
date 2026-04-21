#!/usr/bin/env node
/**
 * Patch tauri.conf.json and icons for beta builds.
 *
 * Changes the app identifier, product name, window title, updater
 * endpoint, and icons so the beta app installs alongside stable
 * (different identity = different install path on all platforms).
 *
 * Usage: node scripts/patch-beta-identity.js        (apply beta patch)
 *        node scripts/patch-beta-identity.js --undo  (restore stable identity)
 *
 * Called by the CI workflow before building beta releases.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");
const ICONS_DIR = path.join(ROOT, "src-tauri", "icons");
const ICONS_BETA_DIR = path.join(ROOT, "src-tauri", "icons-beta");
const ICONS_STABLE_BACKUP = path.join(ROOT, "src-tauri", "icons-stable-backup");

const STABLE = {
  identifier: "com.smartjobseeker.desktop",
  productName: "Smart Job Seeker",
  windowTitle: "Smart Job Seeker",
  updaterEndpoint: "https://github.com/gitaarik/sjs-desktop/releases/latest/download/latest.json",
};

const BETA = {
  identifier: "com.smartjobseeker.desktop.beta",
  productName: "Smart Job Seeker Beta",
  windowTitle: "Smart Job Seeker Beta",
  updaterEndpoint: "https://github.com/gitaarik/sjs-desktop/releases/download/beta-latest/latest.json",
};

const undo = process.argv.includes("--undo");
const target = undo ? STABLE : BETA;

// Patch tauri.conf.json
const conf = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));
conf.identifier = target.identifier;
conf.productName = target.productName;
conf.app.windows[0].title = target.windowTitle;
conf.plugins.updater.endpoints = [target.updaterEndpoint];
fs.writeFileSync(CONF_PATH, JSON.stringify(conf, null, 2) + "\n");

// Swap icons
if (!undo && fs.existsSync(ICONS_BETA_DIR)) {
  // Back up stable icons, copy beta icons in
  if (!fs.existsSync(ICONS_STABLE_BACKUP)) {
    fs.cpSync(ICONS_DIR, ICONS_STABLE_BACKUP, { recursive: true });
  }
  for (const file of fs.readdirSync(ICONS_BETA_DIR)) {
    fs.copyFileSync(path.join(ICONS_BETA_DIR, file), path.join(ICONS_DIR, file));
  }
  console.log("  icons: swapped to beta");
} else if (undo && fs.existsSync(ICONS_STABLE_BACKUP)) {
  // Restore stable icons
  fs.cpSync(ICONS_STABLE_BACKUP, ICONS_DIR, { recursive: true });
  fs.rmSync(ICONS_STABLE_BACKUP, { recursive: true });
  console.log("  icons: restored to stable");
}

console.log(`Patched tauri.conf.json for ${undo ? "stable" : "beta"}:`);
console.log(`  identifier: ${target.identifier}`);
console.log(`  productName: ${target.productName}`);
console.log(`  updater: ${target.updaterEndpoint}`);
