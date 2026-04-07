/**
 * App configuration persistence.
 *
 * Stores settings in a JSON file in the user's app data directory.
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface AppConfig {
  /** Server preset (production, preview, dev, custom) */
  server: string;
  /** Server tunnel WebSocket URL (e.g., wss://smartjobseeker.com/tunnel) */
  serverUrl: string;
  /** API token for authentication */
  apiToken: string;
  /** Optional custom Chrome path */
  chromePath?: string;
  /** Whether to auto-connect on startup */
  autoConnect: boolean;
  /** Show Chrome window (headed mode) */
  headed: boolean;
  /** Auto-reconnect on unexpected disconnect */
  autoReconnect: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  server: "production",
  serverUrl: "",
  apiToken: "",
  autoConnect: false,
  headed: true,
  autoReconnect: true,
};

function getConfigPath(): string {
  const appName = "sjs-desktop";
  const platform = os.platform();

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName, "config.json");
  } else if (platform === "win32") {
    return path.join(process.env["APPDATA"] || os.homedir(), appName, "config.json");
  } else {
    return path.join(os.homedir(), ".config", appName, "config.json");
  }
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();

  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    }
  } catch (err) {
    console.warn(`[Config] Failed to load config: ${err}`);
  }

  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[Config] Saved to ${configPath}`);
  } catch (err) {
    console.error(`[Config] Failed to save: ${err}`);
  }
}
