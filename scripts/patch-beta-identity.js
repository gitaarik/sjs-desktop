#!/usr/bin/env node
/**
 * Patch tauri.conf.json for beta builds.
 *
 * Changes the app identifier, product name, window title, and updater
 * endpoint so the beta app installs alongside stable (different identity
 * = different install path on all platforms).
 *
 * Usage: node scripts/patch-beta-identity.js        (apply beta patch)
 *        node scripts/patch-beta-identity.js --undo  (restore stable identity)
 *
 * Called by the CI workflow before building beta releases.
 */

const fs = require("fs");
const path = require("path");

const CONF_PATH = path.join(__dirname, "..", "src-tauri", "tauri.conf.json");

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

const conf = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));

conf.identifier = target.identifier;
conf.productName = target.productName;
conf.app.windows[0].title = target.windowTitle;
conf.plugins.updater.endpoints = [target.updaterEndpoint];

fs.writeFileSync(CONF_PATH, JSON.stringify(conf, null, 2) + "\n");

console.log(`Patched tauri.conf.json for ${undo ? "stable" : "beta"}:`);
console.log(`  identifier: ${target.identifier}`);
console.log(`  productName: ${target.productName}`);
console.log(`  updater: ${target.updaterEndpoint}`);
