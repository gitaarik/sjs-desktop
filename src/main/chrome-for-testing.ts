/**
 * Chrome for Testing — Download & Version Management
 *
 * Downloads and manages a bundled Chrome for Testing binary so users
 * don't need Chrome installed. The binary is identical to regular Chrome
 * (same UA, codecs, TLS fingerprint) but doesn't auto-update.
 */

import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { execSync } from "child_process";

const VERSION_API =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

interface CfTMetadata {
  version: string;
  platform: string;
  downloadedAt: string;
  chromePath: string;
}

/**
 * Get the platform key for Chrome for Testing downloads.
 */
function getPlatform(): string {
  const arch = os.arch();
  const platform = os.platform();

  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  } else if (platform === "win32") {
    return arch === "x64" ? "win64" : "win32";
  } else {
    return "linux64";
  }
}

/**
 * Get the install directory for Chrome for Testing.
 */
export function getCfTInstallDir(): string {
  const appName = "sjs-desktop";
  const platform = os.platform();

  let baseDir: string;
  if (platform === "darwin") {
    baseDir = path.join(os.homedir(), "Library", "Application Support", appName);
  } else if (platform === "win32") {
    baseDir = path.join(process.env["LOCALAPPDATA"] || os.homedir(), appName);
  } else {
    baseDir = path.join(os.homedir(), ".local", "share", appName);
  }

  return path.join(baseDir, "chrome-for-testing");
}

/**
 * Get the Chrome binary path within the CfT install directory.
 */
function getChromeBinaryPath(installDir: string): string {
  const platform = os.platform();

  // Chrome for Testing extracts to a chrome-<platform>/ subdirectory
  const platformDir = getPlatform();
  const chromeDir = path.join(installDir, `chrome-${platformDir}`);

  if (platform === "darwin") {
    return path.join(
      chromeDir,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
  } else if (platform === "win32") {
    return path.join(chromeDir, "chrome.exe");
  } else {
    return path.join(chromeDir, "chrome");
  }
}

/**
 * Read the metadata file for the installed CfT version.
 */
function readMetadata(installDir: string): CfTMetadata | null {
  const metaPath = path.join(installDir, "metadata.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write the metadata file.
 */
function writeMetadata(installDir: string, meta: CfTMetadata): void {
  fs.writeFileSync(
    path.join(installDir, "metadata.json"),
    JSON.stringify(meta, null, 2),
  );
}

/**
 * Check if Chrome for Testing is installed and return its path.
 */
export function getInstalledChromePath(): string | null {
  const installDir = getCfTInstallDir();
  const meta = readMetadata(installDir);
  if (!meta) return null;

  const chromePath = getChromeBinaryPath(installDir);
  if (fs.existsSync(chromePath)) {
    return chromePath;
  }

  return null;
}

/**
 * Get the installed CfT version, or null if not installed.
 */
export function getInstalledVersion(): string | null {
  const meta = readMetadata(getCfTInstallDir());
  return meta?.version || null;
}

/**
 * Fetch the latest stable Chrome for Testing version info.
 */
export async function fetchLatestVersion(): Promise<{
  version: string;
  downloadUrl: string;
}> {
  return new Promise((resolve, reject) => {
    https
      .get(VERSION_API, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const stable = json.channels.Stable;
            const platform = getPlatform();
            const download = stable.downloads.chrome.find(
              (d: { platform: string; url: string }) => d.platform === platform,
            );
            if (!download) {
              reject(new Error(`No Chrome for Testing download for ${platform}`));
              return;
            }
            resolve({
              version: stable.version,
              downloadUrl: download.url,
            });
          } catch (err) {
            reject(new Error(`Failed to parse CfT version API: ${err}`));
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Download and extract Chrome for Testing.
 * Calls onProgress with percentage (0-100) during download.
 */
export async function downloadChromeForTesting(
  onProgress?: (percent: number, status: string) => void,
): Promise<string> {
  const { version, downloadUrl } = await fetchLatestVersion();
  const installDir = getCfTInstallDir();

  onProgress?.(0, `Downloading Chrome for Testing ${version}...`);

  // Create install directory
  fs.mkdirSync(installDir, { recursive: true });

  // Download the ZIP
  const zipPath = path.join(installDir, "chrome.zip");
  await downloadFile(downloadUrl, zipPath, (percent) => {
    onProgress?.(Math.round(percent * 0.8), `Downloading... ${Math.round(percent)}%`);
  });

  // Extract
  onProgress?.(80, "Extracting...");
  await extractZip(zipPath, installDir);

  // Clean up ZIP
  try {
    fs.unlinkSync(zipPath);
  } catch { /* ignore */ }

  // Make binary executable (Linux/macOS)
  const chromePath = getChromeBinaryPath(installDir);
  if (os.platform() !== "win32" && fs.existsSync(chromePath)) {
    fs.chmodSync(chromePath, 0o755);
  }

  // Write metadata
  writeMetadata(installDir, {
    version,
    platform: getPlatform(),
    downloadedAt: new Date().toISOString(),
    chromePath,
  });

  onProgress?.(100, `Chrome for Testing ${version} ready`);
  return chromePath;
}

/**
 * Ensure Chrome for Testing is available. Downloads if needed.
 * Returns the path to the Chrome binary.
 */
export async function ensureChromeForTesting(
  onProgress?: (percent: number, status: string) => void,
): Promise<string> {
  const existing = getInstalledChromePath();
  if (existing) {
    const version = getInstalledVersion();
    onProgress?.(100, `Chrome for Testing ${version} ready`);
    return existing;
  }

  return downloadChromeForTesting(onProgress);
}

// ============================================================================
// Helpers
// ============================================================================

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string) => {
      https
        .get(requestUrl, (res) => {
          // Follow redirects
          if (res.statusCode === 301 || res.statusCode === 302) {
            const location = res.headers.location;
            if (location) {
              doRequest(location);
              return;
            }
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
          let downloadedBytes = 0;

          const file = fs.createWriteStream(destPath);
          res.pipe(file);

          res.on("data", (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
              onProgress?.((downloadedBytes / totalBytes) * 100);
            }
          });

          file.on("finish", () => {
            file.close();
            resolve();
          });

          file.on("error", (err) => {
            fs.unlinkSync(destPath);
            reject(err);
          });
        })
        .on("error", reject);
    };

    doRequest(url);
  });
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const platform = os.platform();

      if (platform === "win32") {
        // Use PowerShell on Windows
        execSync(
          `powershell -command "Expand-Archive -Force '${zipPath}' '${destDir}'"`,
          { stdio: "pipe" },
        );
      } else {
        // Use unzip on Linux/macOS
        execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, {
          stdio: "pipe",
        });
      }

      resolve();
    } catch (err) {
      reject(new Error(`Failed to extract ZIP: ${err}`));
    }
  });
}
