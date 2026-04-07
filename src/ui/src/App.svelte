<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";

  // Server options
  const SERVERS = [
    { id: "preview", label: "Preview", url: "wss://dev.smartjobseeker.com/tunnel" },
    { id: "dev", label: "Dev", url: "wss://dev2.smartjobseeker.com/tunnel" },
    { id: "custom", label: "Custom", url: "" },
  ] as const;

  // State
  let server = "";
  let serverUrl = "";
  let apiToken = "";
  let apiTokens: Record<string, string> = {};
  let showToken = false;
  let headed = true;
  let autoConnect = false;
  let autoReconnect = true;
  let status = "disconnected";
  let chromeVersion: string | null = null;
  let chromeDownloadPercent = 0;
  let chromeDownloadStatus = "";
  let logs: { time: string; message: string }[] = [];
  let intervention: string | null = null;
  let configLoaded = false;
  let activeTab = "connection";
  let urlError = "";
  let tokenError = "";
  let connectionError = "";
  let userInitiatedConnect = false;
  let stopped = false;
  let debugChromeOpen = false;
  let updateAvailable: string | null = null;
  let updateBody: string | null = null;
  let updating = false;
  let appVersion: string | null = null;
  let checkingForUpdates = false;
  let updateCheckResult: string | null = null;
  let updateChannel: "stable" | "beta" = "stable";

  // Max log entries to keep
  const MAX_LOGS = 100;

  function addLog(message: string) {
    const time = new Date().toLocaleTimeString();
    logs = [...logs.slice(-(MAX_LOGS - 1)), { time, message }];
  }

  // Sidecar communication via Tauri shell plugin
  let sidecarProcess: any = null;

  async function sendCommand(cmd: Record<string, unknown>) {
    if (sidecarProcess) {
      await sidecarProcess.write(JSON.stringify(cmd) + "\n");
    }
  }

  function handleSidecarMessage(line: string) {
    try {
      const msg = JSON.parse(line);
      switch (msg.type) {
        case "status":
          if (stopped && msg.status !== "disconnected") break;
          status = msg.status;
          if (status === "connected" || status === "scraping") connectionError = "";
          break;
        case "log":
          addLog(msg.message);
          break;
        case "error":
          addLog(`ERROR: ${msg.message}`);
          if (userInitiatedConnect) connectionError = msg.message;
          break;
        case "config":
          server = server || msg.server || "";
          serverUrl = serverUrl || msg.serverUrl || "";
          apiTokens = msg.apiTokens ?? {};
          apiToken = apiToken || msg.apiToken || "";
          autoConnect = msg.autoConnect ?? false;
          headed = msg.headed ?? true;
          autoReconnect = msg.autoReconnect ?? true;
          chromeVersion = msg.chromeVersion;
          // Migrate: detect server preset from known URLs
          if (serverUrl && !server) {
            const match = SERVERS.find((s) => s.url === serverUrl);
            server = match ? match.id : "custom";
          }
          // Migrate: production was removed, treat as custom
          if (server === "production") {
            server = "custom";
            if (!serverUrl) serverUrl = "wss://smartjobseeker.com/tunnel";
          }
          // Default to preview if nothing is set
          if (!server) server = "preview";
          // Ensure active token is in the map so server-switch reactive works
          if (apiToken && server && !apiTokens[server]) {
            apiTokens[server] = apiToken;
          }
          prevServer = server;
          configLoaded = true;
          if (!chromeVersion) activeTab = "chrome";
          break;
        case "configured":
          addLog("Configuration saved");
          break;
        case "chromeDownloadProgress":
          chromeDownloadPercent = msg.percent;
          chromeDownloadStatus = msg.status;
          break;
        case "chromeReady":
          chromeDownloadPercent = 0;
          chromeDownloadStatus = "";
          chromeVersion = msg.version || "installed";
          addLog("Chrome for Testing ready");
          break;
        case "intervention":
          intervention = msg.interventionType;
          addLog(`INTERVENTION NEEDED: ${msg.interventionType}`);
          break;
        case "chromeDebug":
          debugChromeOpen = msg.open;
          break;
      }
    } catch {
      // Not JSON, ignore
    }
  }

  onMount(async () => {
    try {
      // Import Tauri shell plugin
      const { Command } = await import("@tauri-apps/plugin-shell");
      const command = Command.sidecar("binaries/sjs-sidecar");

      let stdoutBuffer = "";
      command.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop()!; // keep incomplete last line in buffer
        for (const line of lines) {
          if (line.trim()) handleSidecarMessage(line);
        }
      });

      command.stderr.on("data", (line: string) => {
        addLog(`[stderr] ${line}`);
      });

      command.on("close", () => {
        status = "disconnected";
        addLog("Sidecar process exited");
        sidecarProcess = null;
      });

      sidecarProcess = await command.spawn();
      addLog("Sidecar started");
    } catch (err) {
      addLog(`Failed to start sidecar: ${err}`);
      // Fallback: load saved config from localStorage for demo
      configLoaded = true;
    }
  });

  onDestroy(() => {
    if (sidecarProcess) {
      sendCommand({ type: "stop" });
    }
  });

  // Listen for tray events
  onMount(async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      listen("tray-start", () => handleConnect());
      listen("tray-stop", () => handleDisconnect());
      listen("tray-open-chrome", () => sendCommand({ type: "openChrome" }));
      listen("tray-close-chrome", () => sendCommand({ type: "closeChrome" }));
    } catch {
      // Not running in Tauri
    }
  });

  // Check for app updates via custom Rust command
  async function checkForUpdates() {
    checkingForUpdates = true;
    updateCheckResult = null;
    updateAvailable = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result: { version: string; body: string | null } | null =
        await invoke("check_for_update", { channel: updateChannel });
      if (result) {
        updateAvailable = result.version;
        updateBody = result.body ?? null;
        addLog(`Update available: v${result.version} (${updateChannel} channel)`);
      } else {
        updateCheckResult = "You're on the latest version";
        addLog(`No updates available (${updateChannel} channel)`);
      }
    } catch (err) {
      updateCheckResult = "Failed to check for updates";
      addLog(`Update check failed: ${err}`);
    } finally {
      checkingForUpdates = false;
    }
  }

  // Get app version, load channel preference, then check for updates
  onMount(async () => {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      appVersion = await getVersion();
    } catch {
      // Not running in Tauri
    }
    // Load saved channel preference, defaulting to beta if running a prerelease build
    const saved = localStorage.getItem("sjs-update-channel");
    if (saved) {
      updateChannel = saved === "beta" ? "beta" : "stable";
    } else if (appVersion && /-(beta|alpha|rc)/.test(appVersion)) {
      updateChannel = "beta";
    }
    checkForUpdates();
  });

  async function handleUpdate() {
    if (updating) return;
    updating = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      addLog("Downloading update...");
      await invoke("download_and_install_update", { channel: updateChannel });
      addLog("Update installed, restarting...");
      await relaunch();
    } catch (err) {
      addLog(`Update failed: ${err}`);
      updating = false;
    }
  }

  function toggleChannel() {
    updateChannel = updateChannel === "stable" ? "beta" : "stable";
    localStorage.setItem("sjs-update-channel", updateChannel);
    updateAvailable = null;
    updateCheckResult = null;
    checkForUpdates();
  }

  // Derive serverUrl from server selection
  $: {
    const entry = SERVERS.find((s) => s.id === server);
    if (entry && entry.id !== "custom") {
      serverUrl = entry.url;
    }
  }

  // Swap apiToken when server changes (per-server tokens)
  let prevServer = "";
  $: if (server && server !== prevServer) {
    // Save current token for previous server
    if (prevServer && apiToken) {
      apiTokens[prevServer] = apiToken;
    }
    // Load token for new server
    apiToken = apiTokens[server] || "";
    tokenError = "";
    prevServer = server;
  }

  // Actions
  async function handleSaveConfig() {
    // Keep apiTokens map in sync before saving
    if (server) apiTokens[server] = apiToken;
    await sendCommand({
      type: "configure",
      server,
      serverUrl,
      apiToken,
      apiTokens,
      autoConnect,
      headed,
      autoReconnect,
    });
  }

  function validateForm(): boolean {
    urlError = "";
    tokenError = "";
    connectionError = "";
    if (server === "custom") {
      if (!serverUrl.trim()) {
        urlError = "Server URL is required";
      } else {
        try {
          const u = new URL(serverUrl);
          if (u.protocol !== "wss:" && u.protocol !== "ws:") {
            urlError = "Must be a WebSocket URL (wss://...)";
          }
        } catch {
          urlError = "Invalid URL format";
        }
      }
    }
    if (!apiToken.trim()) {
      tokenError = "API token is required";
    }
    return !urlError && !tokenError;
  }

  async function handleConnect() {
    if (!validateForm()) return;
    userInitiatedConnect = true;
    stopped = false;
    // Stop first in case sidecar is still connected from a previous session
    await sendCommand({ type: "stop" });
    await handleSaveConfig();
    await sendCommand({ type: "start" });
  }

  async function handleDisconnect() {
    status = "disconnected";
    userInitiatedConnect = false;
    stopped = true;
    connectionError = "";
    await sendCommand({ type: "stop" });
  }

  async function handleEnsureChrome() {
    await sendCommand({ type: "ensureChrome" });
  }

  // Status display
  $: statusColor = {
    connected: "#22c55e",
    scraping: "#3b82f6",
    connecting: "#f59e0b",
    authenticating: "#f59e0b",
    reconnecting: "#f59e0b",
    disconnected: "#6b7280",
  }[status] || "#6b7280";

  $: statusLabel = {
    connected: "Connected",
    scraping: "Scraping",
    connecting: "Connecting...",
    authenticating: "Authenticating...",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
  }[status] || status;

  $: isConnected = status === "connected" || status === "scraping";
  $: isConnecting = status === "connecting" || status === "authenticating";
  $: isReconnecting = status === "reconnecting";

  // Keep tray menu in sync with connection state
  $: hasConfig = !!(serverUrl.trim() && apiToken.trim());
  $: hasChrome = !!chromeVersion;
  $: if (configLoaded) updateTrayState(status, hasConfig, hasChrome, debugChromeOpen);

  async function updateTrayState(currentStatus: string, currentHasConfig: boolean, currentHasChrome: boolean, currentDebugChromeOpen: boolean) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_tray_state", { status: currentStatus, hasConfig: currentHasConfig, hasChrome: currentHasChrome, debugChromeOpen: currentDebugChromeOpen });
    } catch {
      // Not running in Tauri
    }
  }
</script>

<main>
  <header>
    <div class="header-left">
      <h1>Smart Job Seeker</h1>
      {#if appVersion}<span class="app-version">v{appVersion}{#if updateChannel === "beta"} (beta){/if}</span>{/if}
    </div>
    <div class="status-badge" style="background: {statusColor}">
      {statusLabel}
    </div>
  </header>

  <!-- Update Banner -->
  {#if updateAvailable}
    <section class="update-banner">
      <span>Version {updateAvailable} is available.</span>
      <button class="btn-primary btn-sm" on:click={handleUpdate} disabled={updating}>
        {updating ? "Updating..." : "Update now"}
      </button>
    </section>
  {/if}

  <!-- Intervention Alert -->
  {#if intervention}
    <section class="intervention">
      <p>Manual action needed: <strong>{intervention}</strong></p>
      <p>Switch to the Chrome window to resolve.</p>
      <button class="btn-secondary" on:click={() => (intervention = null)}>Dismiss</button>
    </section>
  {/if}

  <!-- Tabs -->
  <nav class="tabs">
    <button class="tab" class:active={activeTab === "connection"} on:click={() => (activeTab = "connection")}>Connection</button>
    <button class="tab" class:active={activeTab === "chrome"} on:click={() => (activeTab = "chrome")}>Chrome</button>
    <button class="tab" class:active={activeTab === "log"} on:click={() => (activeTab = "log")}>Activity Log</button>
  </nav>

  {#if activeTab === "connection"}
    <section class="settings">
      {#if connectionError}
        <div class="form-error-banner">{connectionError}</div>
      {/if}

      <div class="field">
        <span class="field-label">Server</span>
        <div class="server-picker">
          {#each SERVERS as s}
            <button
              class="server-option"
              class:active={server === s.id}
              disabled={isConnected || isConnecting || isReconnecting}
              on:click={() => { server = s.id; urlError = ""; }}
            >
              {s.label}
            </button>
          {/each}
        </div>
      </div>

      {#if server === "custom"}
        <label>
          Server URL
          <input
            type="text"
            bind:value={serverUrl}
            placeholder="wss://example.com/tunnel"
            disabled={isConnected || isConnecting || isReconnecting}
            class:input-error={urlError}
            on:input={() => (urlError = "")}
          />
          {#if urlError}<span class="field-error">{urlError}</span>{/if}
        </label>
      {/if}

      <label>
        API Token
        <div class="token-input-wrap">
          <input
            type={showToken ? "text" : "password"}
            bind:value={apiToken}
            placeholder="sjs_..."
            disabled={isConnected || isConnecting || isReconnecting}
            class:input-error={tokenError}
            on:input={() => (tokenError = "")}
          />
          <button
            type="button"
            class="token-toggle"
            on:click={() => (showToken = !showToken)}
            tabindex="-1"
          >
            {showToken ? "Hide" : "Show"}
          </button>
        </div>
        {#if tokenError}<span class="field-error">{tokenError}</span>{/if}
      </label>

      <label class="checkbox">
        <input type="checkbox" bind:checked={autoConnect} disabled={!isConnected && !autoConnect} on:change={async () => { await tick(); handleSaveConfig(); }} />
        Connect automatically on startup
      </label>

      <label class="checkbox">
        <input type="checkbox" bind:checked={headed} disabled={isConnected || isConnecting || isReconnecting} on:change={async () => { await tick(); handleSaveConfig(); }} />
        Show browser window (recommended for CAPTCHA solving)
      </label>

      <label class="checkbox">
        <input type="checkbox" bind:checked={autoReconnect} on:change={async () => { await tick(); handleSaveConfig(); }} />
        Auto-reconnect on unexpected disconnect
      </label>

      <div class="actions">
        {#if isConnected}
          <button class="btn-danger" on:click={handleDisconnect}>Disconnect</button>
        {:else if isConnecting}
          <button class="btn-danger" on:click={handleDisconnect}>Cancel</button>
        {:else if isReconnecting}
          <button class="btn-danger" on:click={handleDisconnect}>Cancel</button>
        {:else}
          <button class="btn-primary" on:click={handleConnect}>Connect</button>
        {/if}
      </div>
    </section>
  {:else if activeTab === "chrome"}
    <section class="chrome-section">
      {#if chromeVersion}
        <p class="chrome-status">Installed: v{chromeVersion}</p>
      {:else}
        <p class="chrome-status">Not installed</p>
      {/if}

      {#if chromeDownloadStatus}
        <div class="progress">
          <div class="progress-bar" style="width: {chromeDownloadPercent}%"></div>
          <span class="progress-text">{chromeDownloadStatus}</span>
        </div>
      {:else}
        <div class="chrome-actions">
          <button class="btn-secondary" on:click={handleEnsureChrome}>
            {chromeVersion ? "Check for Updates" : "Download Chrome"}
          </button>
          <button
            class="btn-secondary"
            disabled={!chromeVersion || isConnected || isConnecting || isReconnecting}
            on:click={() => sendCommand({ type: debugChromeOpen ? "closeChrome" : "openChrome" })}
          >
            {debugChromeOpen ? "Close Browser" : "Open Browser"}
          </button>
        </div>
      {/if}
    </section>
  {:else if activeTab === "log"}
    <section class="log-section">
      <div class="log">
        {#each logs as entry}
          <div class="log-entry">
            <span class="log-time">{entry.time}</span>
            <span class="log-msg">{entry.message}</span>
          </div>
        {/each}
        {#if logs.length === 0}
          <div class="log-empty">No activity yet</div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Footer -->
  <footer>
    <div class="footer-left">
      {#if updateCheckResult}
        <span class="update-check-result">{updateCheckResult}</span>
      {/if}
    </div>
    <div class="footer-right">
      <button class="btn-link" on:click={toggleChannel} disabled={checkingForUpdates || updating}>
        {updateChannel === "stable" ? "Switch to beta" : "Switch to stable"}
      </button>
      <span class="footer-sep">|</span>
      <button class="btn-link" on:click={checkForUpdates} disabled={checkingForUpdates || updating}>
        {checkingForUpdates ? "Checking..." : "Check for updates"}
      </button>
    </div>
  </footer>
</main>

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }

  .app-version {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 400;
  }

  h2 {
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0 0 12px 0;
  }

  .tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 16px;
    background: var(--bg-surface);
    border-radius: 8px;
    padding: 4px;
  }

  .tab {
    flex: 1;
    padding: 8px 12px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .tab:hover {
    color: var(--text-secondary);
    opacity: 1;
  }

  .tab.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .status-badge {
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    color: white;
  }

  section {
    background: var(--bg-surface);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }

  label {
    display: block;
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  label.checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  input[type="text"],
  input[type="password"] {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 8px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 14px;
    box-sizing: border-box;
  }

  input[type="text"]:focus,
  input[type="password"]:focus {
    outline: none;
    border-color: var(--focus);
  }

  input:disabled {
    opacity: 0.5;
  }

  .field {
    margin-bottom: 12px;
  }

  .field-label {
    display: block;
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .server-picker {
    display: flex;
    background: var(--bg-base);
    border-radius: 6px;
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .server-option {
    flex: 1;
    padding: 7px 12px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .server-option:not(:first-child) {
    border-left: 1px solid var(--border);
  }

  .server-option:hover:not(:disabled):not(.active) {
    color: var(--text-secondary);
    background: var(--bg-surface);
  }

  .server-option.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .server-option:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .token-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .token-input-wrap input {
    padding-right: 52px;
  }

  .token-toggle {
    position: absolute;
    right: 8px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .token-toggle:hover {
    color: var(--text-secondary);
  }

  .input-error {
    border-color: var(--error-input) !important;
  }

  .field-error {
    display: block;
    color: var(--error-field);
    font-size: 12px;
    margin-top: 4px;
  }

  .form-error-banner {
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: var(--error-text);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
    margin-bottom: 12px;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  button {
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  button:hover {
    opacity: 0.9;
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--btn-primary-bg);
    color: var(--btn-primary-text);
  }

  .btn-secondary {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-text);
  }

  .btn-danger {
    background: var(--btn-danger-bg);
    color: var(--btn-danger-text);
  }

  .chrome-actions {
    display: flex;
    gap: 8px;
  }

  .chrome-section .chrome-status {
    margin: 0 0 12px 0;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .progress {
    position: relative;
    height: 24px;
    background: var(--progress-bg);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: var(--progress-fill);
    transition: width 0.3s ease;
  }

  .progress-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 500;
  }

  .intervention {
    background: var(--intervention-bg);
    border: 1px solid var(--intervention-border);
  }

  .intervention p {
    margin: 0 0 8px 0;
  }

  .log {
    padding: 8px;
    max-height: 300px;
    overflow-y: auto;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 12px;
  }

  .log-entry {
    padding: 2px 4px;
    display: flex;
    gap: 8px;
  }

  .log-time {
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .log-msg {
    color: var(--text-secondary);
    word-break: break-word;
  }

  .log-empty {
    color: var(--text-faint);
    text-align: center;
    padding: 16px;
  }

  .update-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-elevated);
    border: 1px solid var(--focus);
    font-size: 13px;
  }

  .btn-sm {
    padding: 4px 12px;
    font-size: 12px;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0 0;
    margin-top: 8px;
    border-top: 1px solid var(--border);
  }

  .footer-left {
    font-size: 12px;
    color: var(--text-muted);
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .footer-sep {
    color: var(--text-faint);
    font-size: 12px;
  }

  .update-check-result {
    font-size: 12px;
    color: var(--text-muted);
  }

  .btn-link {
    background: none;
    color: var(--focus);
    padding: 4px 0;
    font-size: 12px;
    font-weight: 400;
    border: none;
    cursor: pointer;
  }

  .btn-link:hover {
    opacity: 0.8;
  }

  .btn-link:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
