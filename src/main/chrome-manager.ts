/**
 * Chrome lifecycle management.
 *
 * Detects installed Chrome, launches it with CDP enabled,
 * and manages the process lifecycle.
 */

import { spawn, type ChildProcess } from "child_process";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { getInstalledChromePath } from "./chrome-for-testing";

export interface ChromeSession {
  /** Chrome's CDP WebSocket URL */
  cdpWsUrl: string;
  /** Chrome's /json/version response */
  versionInfo: Record<string, unknown>;
  /** The Chrome process */
  process: ChildProcess;
  /** CDP port */
  port: number;
  /** Kill Chrome gracefully */
  kill: () => Promise<void>;
}

/**
 * Find Chrome binary. Checks Chrome for Testing first, then system Chrome.
 */
function findChromePath(): string | null {
  // Prefer Chrome for Testing (downloaded by the app)
  const cftPath = getInstalledChromePath();
  if (cftPath) {
    return cftPath;
  }

  // Fall back to system-installed Chrome
  const platform = os.platform();
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    );
  } else if (platform === "win32") {
    const programFiles = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || "";
    candidates.push(
      path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
    );
  } else {
    // Linux
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Get a free port from the OS.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require("net").createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Fetch Chrome's /json/version endpoint.
 */
function fetchCdpVersion(port: number, maxRetries = 20, retryDelay = 500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const attempt = () => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Invalid JSON from Chrome /json/version: ${data}`));
          }
        });
      });

      req.on("error", () => {
        if (attempts < maxRetries) {
          if (attempts % 5 === 0) console.log(`[Chrome] Waiting for CDP... (attempt ${attempts}/${maxRetries})`);
          setTimeout(attempt, retryDelay);
        } else {
          reject(new Error(`Chrome did not start within ${maxRetries * retryDelay}ms`));
        }
      });

      req.setTimeout(2000, () => {
        req.destroy();
        if (attempts < maxRetries) {
          if (attempts % 5 === 0) console.log(`[Chrome] CDP timeout, retrying... (attempt ${attempts}/${maxRetries})`);
          setTimeout(attempt, retryDelay);
        } else {
          reject(new Error(`Chrome /json/version timeout after ${maxRetries} attempts`));
        }
      });
    };

    attempt();
  });
}

/**
 * Launch Chrome with CDP enabled.
 */
export async function launchChrome(options: {
  chromePath?: string;
  headed?: boolean;
  userDataDir?: string;
}): Promise<ChromeSession> {
  const chromePath = options.chromePath || findChromePath();
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Install Google Chrome or set the Chrome path in settings.",
    );
  }

  const port = await getFreePort();
  // Use a persistent user data dir so Chrome retains cookies, history, and
  // local storage across sessions. A fresh profile each time looks suspicious
  // to anti-bot systems like Cloudflare (zero-history fingerprint).
  const userDataDir = options.userDataDir || path.join(os.homedir(), ".sjs", "chrome-user-data");

  // Ensure the user data dir and Default profile exist
  const defaultProfileDir = path.join(userDataDir, "Default");
  fs.mkdirSync(defaultProfileDir, { recursive: true });

  // Set Chrome preferences to suppress restore prompts and password manager.
  // Merges with existing preferences if present.
  const prefsPath = path.join(defaultProfileDir, "Preferences");
  try {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    } catch { /* no existing prefs */ }
    prefs.credentials_enable_service = false;
    prefs.profile = {
      ...(prefs.profile as Record<string, unknown> || {}),
      password_manager_enabled: false,
      exit_type: "Normal",
      exited_cleanly: true,
    };
    prefs.session = { restore_on_startup: 1 };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (err) {
    console.error(`[Chrome] Failed to write preferences: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }

  // Remove stale lock files left by previous Chrome crashes/kills —
  // without this, Chrome refuses to start with "profile in use" errors
  for (const lockFile of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const lockPath = path.join(userDataDir, lockFile);
    try { fs.unlinkSync(lockPath); } catch { /* doesn't exist */ }
  }

  // Clear session restore data (tabs) but keep cookies/login state.
  // This prevents Chrome from restoring old tabs on startup while
  // preserving authentication cookies across scraping sessions.
  for (const sessionDir of ["Default/Sessions", "Default/Session Storage"]) {
    const dirPath = path.join(userDataDir, sessionDir);
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    // Prevent timer/renderer throttling — without these, background tabs
    // get heavily throttled when CDP is active, stalling their network requests
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-ipc-flooding-protection",
    "--disable-features=CalculateNativeWinOcclusion",
    // Anti-bot stealth flags — AutomationControlled sets browser-level automation
    // signals that Cloudflare and similar services detect
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    // WebRTC leak prevention
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--enforce-webrtc-ip-permission-check",
  ];

  if (options.headed === false) {
    args.push("--headless=new");
  }

  console.log(`[Chrome] Launching: ${chromePath}`);
  console.log(`[Chrome] CDP port: ${port}`);
  console.log(`[Chrome] User data dir: ${userDataDir}`);

  const chromeProcess = spawn(chromePath, args, {
    stdio: "pipe",
    detached: false,
  });

  chromeProcess.on("error", (err) => {
    console.error(`[Chrome] Process error: ${err.message}`);
  });

  chromeProcess.on("exit", (code) => {
    console.log(`[Chrome] Process exited with code ${code}`);
  });

  // Wait for Chrome to start and expose CDP
  console.log("[Chrome] Waiting for CDP endpoint...");
  const versionInfo = await fetchCdpVersion(port);
  const cdpWsUrl = versionInfo.webSocketDebuggerUrl as string;
  console.log(`[Chrome] Ready: ${versionInfo.Browser}`);
  console.log(`[Chrome] CDP WebSocket: ${cdpWsUrl}`);

  return {
    cdpWsUrl,
    versionInfo,
    process: chromeProcess,
    port,
    async kill() {
      console.log("[Chrome] Stopping...");
      if (!chromeProcess.killed) {
        chromeProcess.kill("SIGTERM");
        // Wait up to 5s for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (!chromeProcess.killed) {
              chromeProcess.kill("SIGKILL");
            }
            resolve();
          }, 5000);
          chromeProcess.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      console.log("[Chrome] Stopped");
    },
  };
}
