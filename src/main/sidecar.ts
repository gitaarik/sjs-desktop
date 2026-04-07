/**
 * SJS Sidecar — Entry point for Tauri sidecar mode
 *
 * Communicates with the Tauri shell via stdin/stdout JSON messages.
 * Each line on stdout is a JSON object with a `type` field.
 * Each line on stdin is a JSON command from the Tauri shell.
 */

import { loadConfig, saveConfig, type AppConfig } from "./config";
import { connect, disconnect, getStatus } from "./tunnel-client";
import { ensureChromeForTesting, getInstalledVersion } from "./chrome-for-testing";
import { launchChrome, type ChromeSession } from "./chrome-manager";
import readline from "readline";

// ============================================================================
// Sidecar → Tauri (stdout JSON lines)
// ============================================================================

function emit(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function emitStatus(status: string): void {
  emit({ type: "status", status });
}

function emitLog(message: string): void {
  emit({ type: "log", message });
}

function emitError(message: string): void {
  emit({ type: "error", message });
}

// ============================================================================
// Tauri → Sidecar (stdin JSON commands)
// ============================================================================

interface ConfigureCommand {
  type: "configure";
  server?: string;
  serverUrl: string;
  apiToken: string;
  apiTokens?: Record<string, string>;
  autoConnect?: boolean;
  headed?: boolean;
  autoReconnect?: boolean;
}

interface StartCommand {
  type: "start";
}

interface StopCommand {
  type: "stop";
}

interface GetStatusCommand {
  type: "getStatus";
}

interface GetConfigCommand {
  type: "getConfig";
}

interface EnsureChromeCommand {
  type: "ensureChrome";
}

interface OpenChromeCommand {
  type: "openChrome";
}

interface CloseChromeCommand {
  type: "closeChrome";
}

type SidecarCommand =
  | ConfigureCommand
  | StartCommand
  | StopCommand
  | GetStatusCommand
  | GetConfigCommand
  | EnsureChromeCommand
  | OpenChromeCommand
  | CloseChromeCommand;

// ============================================================================
// Command handlers
// ============================================================================

let config: AppConfig;
let debugChrome: ChromeSession | null = null;

function handleConfigure(cmd: ConfigureCommand): void {
  if (cmd.server !== undefined) {
    config.server = cmd.server;
  }
  config.serverUrl = cmd.serverUrl;
  config.apiToken = cmd.apiToken;
  if (cmd.apiTokens !== undefined) {
    config.apiTokens = cmd.apiTokens;
  }
  if (cmd.autoConnect !== undefined) {
    config.autoConnect = cmd.autoConnect;
  }
  if (cmd.headed !== undefined) {
    config.headed = cmd.headed;
  }
  if (cmd.autoReconnect !== undefined) {
    config.autoReconnect = cmd.autoReconnect;
  }
  saveConfig(config);
  emitLog(`Configuration saved (autoConnect=${config.autoConnect}, headed=${config.headed}, autoReconnect=${config.autoReconnect}, server=${config.server}, serverUrl=${config.serverUrl ? "set" : "empty"}, apiToken=${config.apiToken ? "set" : "empty"})`);
  emit({ type: "configured", config: { serverUrl: config.serverUrl, headed: config.headed } });
}

async function handleOpenChrome(): Promise<void> {
  const tunnelStatus = getStatus();
  if (tunnelStatus !== "disconnected") {
    emitError("Cannot open debug browser while scraper is connected");
    return;
  }
  if (debugChrome) {
    emitError("Debug browser is already open");
    return;
  }

  try {
    emitLog("Opening debug browser...");
    debugChrome = await launchChrome({ headed: true });
    emit({ type: "chromeDebug", open: true });
    emitLog("Debug browser opened");

    // Auto-clear when the user closes Chrome manually
    debugChrome.process.on("exit", () => {
      debugChrome = null;
      emit({ type: "chromeDebug", open: false });
      emitLog("Debug browser closed");
    });
  } catch (err) {
    debugChrome = null;
    emitError(`Failed to open debug browser: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleCloseChrome(): Promise<void> {
  if (!debugChrome) return;
  try {
    await debugChrome.kill();
  } catch { /* already dead */ }
  debugChrome = null;
  emit({ type: "chromeDebug", open: false });
  emitLog("Debug browser closed");
}

function handleStart(): void {
  if (!config.serverUrl || !config.apiToken) {
    emitError("Server URL and API token required. Send 'configure' first.");
    return;
  }

  // Close debug browser before connecting — can't share the profile
  if (debugChrome) {
    handleCloseChrome();
  }

  emitLog(`Connecting to ${config.serverUrl}...`);
  connect(config, {
    onStatusChange: (status) => {
      emitStatus(status);
    },
    onError: (error) => {
      emitError(error);
    },
    onLog: (message) => {
      emitLog(message);
    },
  });
  // Always report current status so the UI stays in sync
  emitStatus(getStatus());
}

function handleStop(): void {
  disconnect();
  emitStatus("disconnected");
  emitLog("Disconnected");
}

function handleGetStatus(): void {
  const status = getStatus();
  emitStatus(status);
}

function handleGetConfig(): void {
  emit({
    type: "config",
    server: config.server || "",
    serverUrl: config.serverUrl,
    apiToken: config.apiToken || "",
    apiTokens: config.apiTokens || {},
    autoConnect: config.autoConnect,
    headed: config.headed,
    autoReconnect: config.autoReconnect,
    chromeVersion: getInstalledVersion(),
  });
}

async function handleEnsureChrome(): Promise<void> {
  try {
    emitLog("Checking Chrome for Testing...");
    const chromePath = await ensureChromeForTesting((percent, status) => {
      emit({ type: "chromeDownloadProgress", percent, status });
    });
    emit({ type: "chromeReady", path: chromePath, version: getInstalledVersion() });
    emitLog(`Chrome for Testing ready: ${chromePath}`);
  } catch (err) {
    emitError(`Chrome for Testing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  config = loadConfig();

  emitLog("SJS Sidecar v0.1.0 started");
  emitStatus("disconnected");

  // Report config state
  handleGetConfig();

  // Auto-connect if configured
  if (config.autoConnect && config.serverUrl && config.apiToken) {
    emitLog("Auto-connecting...");
    handleStart();
  }

  // Listen for commands on stdin
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    let cmd: SidecarCommand;
    try {
      cmd = JSON.parse(line.trim());
    } catch {
      emitError(`Invalid command: ${line}`);
      return;
    }

    switch (cmd.type) {
      case "configure":
        handleConfigure(cmd);
        break;
      case "start":
        handleStart();
        break;
      case "stop":
        handleStop();
        break;
      case "getStatus":
        handleGetStatus();
        break;
      case "getConfig":
        handleGetConfig();
        break;
      case "ensureChrome":
        await handleEnsureChrome();
        break;
      case "openChrome":
        await handleOpenChrome();
        break;
      case "closeChrome":
        await handleCloseChrome();
        break;
      default:
        emitError(`Unknown command type: ${(cmd as { type: string }).type}`);
    }
  });

  rl.on("close", () => {
    // stdin closed — Tauri shell is shutting down
    disconnect();
    if (debugChrome) debugChrome.kill();
    process.exit(0);
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    disconnect();
    if (debugChrome) debugChrome.kill();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    disconnect();
    if (debugChrome) debugChrome.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  emitError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
