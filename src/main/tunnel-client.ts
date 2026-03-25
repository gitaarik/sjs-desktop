/**
 * Tunnel WebSocket client.
 *
 * Connects to the SJS server, authenticates, and handles
 * session commands (start/stop Chrome, relay CDP traffic).
 */

import WebSocket from "ws";
import http from "http";
import { launchChrome } from "./chrome-manager";
import { createCdpBridge } from "./cdp-bridge";
import type { AppConfig } from "./config";
import type { ClientMessage, ServerMessage } from "./protocol";

// Keep in sync with package.json version
const APP_VERSION = "0.4.0-beta.2";

/**
 * Look up a page target ID from Chrome's HTTP /json endpoint.
 */
async function findPageTarget(cdpWsUrl: string): Promise<{ port: string; pageId: string }> {
  const match = cdpWsUrl.match(/:(\d+)\//);
  if (!match) throw new Error("Cannot extract port from CDP URL");
  const port = match[1];

  const targets: { id: string; type: string }[] = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from /json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout fetching targets")); });
  });

  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page targets found");
  return { port, pageId: page.id };
}

/**
 * Send CDP commands on a short-lived browser-level WebSocket connection.
 * Sends messages sequentially (id 1, then id 2 on reply, etc.) and returns
 * the result of the last message.
 */
async function cdpBrowserCall(
  cdpWsUrl: string,
  pageId: string,
  messages: { method: string; params?: Record<string, unknown> }[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cdpWs = new WebSocket(cdpWsUrl);
    const timeout = setTimeout(() => { cdpWs.close(); reject(new Error("Timeout")); }, 3000);
    let step = 0;

    cdpWs.on("open", () => {
      cdpWs.send(JSON.stringify({ id: 1, ...messages[0], params: { targetId: pageId, ...messages[0].params } }));
    });

    cdpWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== step + 1) return;
        if (msg.error) {
          clearTimeout(timeout); cdpWs.close();
          reject(new Error(`${messages[step].method}: ${msg.error.message}`));
          return;
        }
        step++;
        if (step >= messages.length) {
          clearTimeout(timeout); cdpWs.close();
          resolve(msg.result);
        } else {
          // Pass windowId from previous result into next message's params
          const params = { ...messages[step].params };
          if (msg.result?.windowId !== undefined) params.windowId = msg.result.windowId;
          cdpWs.send(JSON.stringify({ id: step + 1, method: messages[step].method, params }));
        }
      } catch (err) {
          log(`cdpBrowserCall: JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
    });

    cdpWs.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

/**
 * Get Chrome's current window state via a short-lived CDP connection.
 */
async function getChromeWindowState(cdpWsUrl: string): Promise<string> {
  const { pageId } = await findPageTarget(cdpWsUrl);
  const result = await cdpBrowserCall(cdpWsUrl, pageId, [
    { method: "Browser.getWindowForTarget" },
  ]);
  return (result as { bounds?: { windowState?: string } })?.bounds?.windowState ?? "unknown";
}

/**
 * Minimize or restore Chrome's window via a short-lived CDP connection.
 */
async function setChromeWindowState(
  cdpWsUrl: string,
  state: "minimized" | "normal",
): Promise<void> {
  const { pageId } = await findPageTarget(cdpWsUrl);
  await cdpBrowserCall(cdpWsUrl, pageId, [
    { method: "Browser.getWindowForTarget" },
    { method: "Browser.setWindowBounds", params: { bounds: { windowState: state } } },
  ]);
}


/**
 * Re-minimize Chrome after a new tab steals focus.
 * Always active — the probe for Target.createTarget doesn't predict
 * whether Ctrl+click-opened tabs (browser UI gesture) will steal focus.
 */
let sessionKeepMinimized = true;

let reMinimizeTimer: NodeJS.Timeout | null = null;
function reMinimize(cdpWsUrl: string): void {
  if (!sessionKeepMinimized) return;
  if (reMinimizeTimer) clearTimeout(reMinimizeTimer);
  reMinimizeTimer = setTimeout(async () => {
    reMinimizeTimer = null;
    try {
      const state = await getChromeWindowState(cdpWsUrl);
      if (state === "minimized") return;
      await setChromeWindowState(cdpWsUrl, "minimized");
      log("Chrome re-minimized after new tab (focus was stolen)");
    } catch (err) {
      log(`Re-minimize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 300);
}



type TunnelStatus = "disconnected" | "connecting" | "authenticating" | "connected" | "scraping" | "reconnecting";

interface TunnelClientEvents {
  onStatusChange?: (status: TunnelStatus) => void;
  onError?: (error: string) => void;
  onLog?: (message: string) => void;
}

let ws: WebSocket | null = null;
let status: TunnelStatus = "disconnected";
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let currentChromeSession: Awaited<ReturnType<typeof launchChrome>> | null = null;
let currentCdpBridge: { close: () => void } | null = null;
let events: TunnelClientEvents = {};
let intentionalDisconnect = false;

const MAX_RECONNECT_DELAY_MS = 30_000;

function log(message: string): void {
  events.onLog?.(`[Tunnel] ${message}`);
}

function setStatus(newStatus: TunnelStatus): void {
  status = newStatus;
  events.onStatusChange?.(newStatus);
  log(`Status: ${newStatus}`);
}

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (msg.type !== "cdp" && msg.type !== "cdpBinary" && msg.type !== "pong") {
      log(` ⬆ Sending: ${msg.type}${msg.type === "sessionError" ? ` (${(msg as { error: string }).error})` : ""}`);
    }
    ws.send(JSON.stringify(msg));
  }
}

async function handleStartSession(config: { startUrl?: string; headed?: boolean; keepMinimized?: boolean }): Promise<void> {
  try {
    setStatus("scraping");
    sessionKeepMinimized = config.keepMinimized ?? true;

    // Stop any existing session
    if (currentChromeSession) {
      log("Stopping existing session before starting new one");
    }
    await stopSession();

    // Launch Chrome
    log("Launching Chrome...");
    currentChromeSession = await launchChrome({
      headed: config.headed ?? true,
    });

    // Create CDP bridge
    log("Creating CDP bridge...");
    const sessionCdpUrl = currentChromeSession.cdpWsUrl;
    currentCdpBridge = await createCdpBridge({
      cdpWsUrl: sessionCdpUrl,
      tunnelWs: ws!,
      onNewTarget: () => reMinimize(sessionCdpUrl),
    });

    // Tell the server Chrome is ready
    send({
      type: "sessionReady",
      cdpVersion: currentChromeSession.versionInfo as {
        Browser: string;
        webSocketDebuggerUrl: string;
      },
    });

    log("Session started, CDP bridge active");

    // Minimize Chrome so it doesn't steal focus during scraping
    if (sessionKeepMinimized) {
      setTimeout(async () => {
        try {
          await setChromeWindowState(sessionCdpUrl, "minimized");
          log("Chrome minimized");
        } catch (err) {
          log(`Failed to minimize Chrome: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, 500);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`ERROR: Failed to start session: ${error}`);
    send({ type: "sessionError", error });
    setStatus("connected");
  }
}

/**
 * Reload all page targets via a short-lived CDP connection.
 * Uses Chrome's HTTP endpoint to discover targets, then sends
 * Page.reload on a temporary WebSocket per page.
 */
async function reloadAllPages(browserCdpWsUrl: string): Promise<void> {
  // Extract port from the browser CDP URL (ws://127.0.0.1:{port}/...)
  const match = browserCdpWsUrl.match(/:(\d+)\//);
  if (!match) return;
  const port = match[1];

  // Get list of targets from Chrome's /json endpoint
  const targets: { id: string; type: string; webSocketDebuggerUrl?: string }[] = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from /json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout")); });
  });

  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  log(` Reloading ${pages.length} page(s) after CDP release`);

  for (const page of pages) {
    try {
      const pageWs = new WebSocket(page.webSocketDebuggerUrl!);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { pageWs.close(); reject(new Error("Timeout")); }, 3000);
        pageWs.on("open", () => {
          pageWs.send(JSON.stringify({ id: 1, method: "Page.reload" }));
          // Give Chrome a moment to process, then close
          setTimeout(() => { clearTimeout(timeout); pageWs.close(); resolve(); }, 200);
        });
        pageWs.on("error", (err) => { clearTimeout(timeout); reject(err); });
      });
    } catch (err) {
      log(` Failed to reload page ${page.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function handleReleaseCdp(): Promise<void> {
  if (!currentCdpBridge || !currentChromeSession || !ws) return;

  log("Releasing CDP bridge (resetting session state)...");
  currentCdpBridge.close();
  currentCdpBridge = null;

  // Restore Chrome so the user can interact during manual intervention

  try {
    await setChromeWindowState(currentChromeSession.cdpWsUrl, "normal");
    log("Chrome restored for intervention");
  } catch (err) {
    log(`Failed to restore Chrome: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Immediately reopen with a fresh CDP session — clears all Playwright
  // state (auto-attach, page sessions, domain enablements) so Chrome
  // behaves like a normal browser during manual intervention.
  try {
    const cdpUrl = currentChromeSession.cdpWsUrl;
    currentCdpBridge = await createCdpBridge({
      cdpWsUrl: cdpUrl,
      tunnelWs: ws,
      onPlaywrightReconnect() {
        if (!sessionKeepMinimized) return;
        // Playwright reconnected — minimize Chrome again after a short delay
        setTimeout(async () => {
          try {
            await setChromeWindowState(cdpUrl, "minimized");
            log("Chrome re-minimized after Playwright reconnect");
          } catch (err) {
            log(`Failed to re-minimize Chrome: ${err instanceof Error ? err.message : String(err)}`);
          }
        }, 500);
      },
      onNewTarget: () => reMinimize(cdpUrl),
    });
    log("CDP bridge reconnected (fresh session)");

    // Reload all pages — existing tabs have stale network/JS state from
    // when Playwright was controlling them and won't work without a reload.
    await reloadAllPages(currentChromeSession.cdpWsUrl);
  } catch (err) {
    log(`ERROR: Failed to reconnect CDP bridge: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Open a direct CDP WebSocket to the active page target and run a callback.
 * Shared by handleTypeText, handleScrollWheel, handleMouseMove.
 */
async function withDirectPageCdp(
  label: string,
  timeoutMs: number,
  fn: (pageWs: WebSocket, nextId: () => number) => Promise<void>,
): Promise<void> {
  if (!currentChromeSession) {
    log(`${label} but no Chrome session`);
    return;
  }

  const cdpWsUrl = currentChromeSession.cdpWsUrl;
  const { port, pageId } = await findPageTarget(cdpWsUrl);

  const targets: { id: string; type: string; webSocketDebuggerUrl?: string }[] = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from /json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout")); });
  });

  const pageTarget = targets.find((t) => t.id === pageId && t.webSocketDebuggerUrl);
  if (!pageTarget?.webSocketDebuggerUrl) {
    log(`${label}: no page WebSocket URL found`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const pageWs = new WebSocket(pageTarget.webSocketDebuggerUrl!);
    const timeout = setTimeout(() => { pageWs.close(); reject(new Error(`${label} timeout`)); }, timeoutMs);
    let msgId = 1;
    const nextId = () => msgId++;

    pageWs.on("open", async () => {
      try {
        await fn(pageWs, nextId);
        clearTimeout(timeout);
        pageWs.close();
        resolve();
      } catch (err) {
        clearTimeout(timeout);
        pageWs.close();
        reject(err);
      }
    });

    pageWs.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

/**
 * Type text locally into Chrome via direct CDP Input.dispatchKeyEvent.
 * Bypasses the tunnel round-trip per keystroke — only one tunnel message
 * for the entire string.
 */
async function handleTypeText(text: string, charDelayMs: number): Promise<void> {
  await withDirectPageCdp("typeText", 30_000, async (pageWs, nextId) => {
    for (const char of text) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", text: char, key: char, code: "" },
      }));
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: char, code: "" },
      }));

      if (charDelayMs > 0) {
        const variance = charDelayMs * 0.4;
        const delay = charDelayMs + (Math.random() * 2 - 1) * variance;
        await new Promise((r) => setTimeout(r, Math.max(8, delay)));
      }
    }
  });
  log(`Typed ${text.length} chars locally (${charDelayMs}ms/char)`);
}

/**
 * Capture a screenshot via a direct browser-level CDP connection.
 * Connects to Chrome's browser WebSocket (separate from Playwright's),
 * finds the most recently created page target, attaches to it, takes
 * a screenshot, and detaches. Since this is a completely separate
 * connection, Playwright never sees the attach/detach events.
 */
async function handleScreenshotRequest(requestId: string, format: string, quality: number): Promise<void> {
  if (!currentChromeSession) {
    send({ type: "screenshotResponse", requestId, data: null });
    return;
  }

  const cdpWsUrl = currentChromeSession.cdpWsUrl;

  // Connect to browser-level CDP to find targets and capture screenshot.
  // This is a separate connection from Playwright's, so it won't interfere.
  await new Promise<void>((resolve) => {
    const browserWs = new WebSocket(cdpWsUrl);
    const timeout = setTimeout(() => {
      send({ type: "screenshotResponse", requestId, data: null });
      browserWs.close();
      resolve();
    }, 5000);
    let msgId = 1;
    let cdpSessionId = "";

    browserWs.on("open", () => {
      // Step 1: Get all targets to find the right page
      browserWs.send(JSON.stringify({
        id: msgId++,
        method: "Target.getTargets",
      }));
    });

    browserWs.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Step 2: Got targets — find best page and attach
        if (msg.id === 1 && msg.result?.targetInfos) {
          const pages = (msg.result.targetInfos as { targetId: string; type: string; url: string }[])
            .filter((t) => t.type === "page" && !t.url.startsWith("chrome://") && t.url !== "about:blank");

          // Pick the last page in the list — that's typically the most recently
          // created/navigated one. If only one page exists, it's the main one.
          const target = pages[pages.length - 1] || pages[0];
          if (!target) {
            clearTimeout(timeout);
            send({ type: "screenshotResponse", requestId, data: null });
            browserWs.close();
            resolve();
            return;
          }

          browserWs.send(JSON.stringify({
            id: msgId++,
            method: "Target.attachToTarget",
            params: { targetId: target.targetId, flatten: true },
          }));
        }

        // Step 3: Got attach response — capture screenshot
        if (msg.id === 2 && msg.result?.sessionId) {
          cdpSessionId = msg.result.sessionId;
          browserWs.send(JSON.stringify({
            id: msgId++,
            method: "Page.captureScreenshot",
            sessionId: cdpSessionId,
            params: { format, quality },
          }));
        }

        // Step 4: Got screenshot — send response, detach, close
        if (msg.id === 3) {
          const data = msg.result?.data || null;
          send({ type: "screenshotResponse", requestId, data });

          if (cdpSessionId) {
            browserWs.send(JSON.stringify({
              id: msgId++,
              method: "Target.detachFromTarget",
              params: { sessionId: cdpSessionId },
            }));
          }

          clearTimeout(timeout);
          browserWs.close();
          resolve();
        }
      } catch (err) {
          log(`Screenshot CDP parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
    });

    browserWs.on("error", () => {
      clearTimeout(timeout);
      send({ type: "screenshotResponse", requestId, data: null });
      resolve();
    });
  });
}

/**
 * Scroll locally via direct CDP Input.dispatchMouseEvent (mouseWheel).
 * Steps are pre-computed by the server (amounts + delays).
 */
async function handleScrollWheel(
  mouseX: number,
  mouseY: number,
  steps: { deltaY: number; delayMs: number }[],
): Promise<void> {
  await withDirectPageCdp("scrollWheel", 30_000, async (pageWs, nextId) => {
    // Move mouse to scroll position
    pageWs.send(JSON.stringify({
      id: nextId(),
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: mouseX, y: mouseY },
    }));

    for (const step of steps) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: mouseX, y: mouseY, deltaX: 0, deltaY: step.deltaY },
      }));
      if (step.delayMs > 0) {
        await new Promise((r) => setTimeout(r, step.delayMs));
      }
    }
  });
  log(`Scrolled ${steps.length} steps locally`);
}

/**
 * Move mouse along a pre-computed path via direct CDP Input.dispatchMouseEvent.
 * Path points (bezier curve + tremor) are computed by the server.
 */
async function handleMouseMove(
  steps: { x: number; y: number; delayMs: number }[],
): Promise<void> {
  await withDirectPageCdp("mouseMove", 30_000, async (pageWs, nextId) => {
    for (const step of steps) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: step.x, y: step.y },
      }));
      if (step.delayMs > 0) {
        await new Promise((r) => setTimeout(r, step.delayMs));
      }
    }
  });
  log(`Moved mouse locally (${steps.length} points)`);
}

/** Convert a CDP content quad [x1,y1,x2,y2,x3,y3,x4,y4] to a bounding box. */
function quadToBox(quad: number[]): { x: number; y: number; width: number; height: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Compute a natural bezier curve path with tremor between two points.
 * Mirrors the logic in stealth-utils.ts naturalMouseMove.
 */
function computeBezierPath(
  fromX: number, fromY: number, toX: number, toY: number,
): { x: number; y: number; delayMs: number }[] {
  const steps = 15 + Math.floor(Math.random() * 15);
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 5) return [{ x: toX, y: toY, delayMs: 0 }];

  const arcAmount = dist * (0.1 + Math.random() * 0.2) * (Math.random() < 0.5 ? 1 : -1);
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const cpX = (fromX + toX) / 2 + perpX * arcAmount;
  const cpY = (fromY + toY) / 2 + perpY * arcAmount;

  const points: { x: number; y: number; delayMs: number }[] = [];
  for (let i = 1; i <= steps; i++) {
    const linear = i / steps;
    const t = linear * linear * (3 - 2 * linear);
    const oneMinusT = 1 - t;
    let x = oneMinusT * oneMinusT * fromX + 2 * oneMinusT * t * cpX + t * t * toX;
    let y = oneMinusT * oneMinusT * fromY + 2 * oneMinusT * t * cpY + t * t * toY;

    if (i < steps) {
      const tremorFade = Math.max(0, 1 - Math.max(0, (linear - 0.8) / 0.2));
      const tremorAmount = 2 * tremorFade;
      x += (Math.random() - 0.5) * tremorAmount;
      y += (Math.random() - 0.5) * tremorAmount;
    }

    const delayMs = i < steps
      ? Math.round((4 + Math.random() * 6) * (1 - 0.6 * Math.sin(linear * Math.PI)))
      : 0;

    points.push({ x, y, delayMs });
  }
  return points;
}

/**
 * Click an element locally via direct CDP.
 * Executes: find element -> scroll into view -> get bounding box ->
 * compute random offset -> move mouse naturally -> click.
 */
/** Map modifier name to CDP key code + modifier bitmask */
const MODIFIER_MAP: Record<string, { key: string; code: string; keyCode: number; bit: number }> = {
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  Shift:   { key: "Shift",   code: "ShiftLeft",   keyCode: 16, bit: 8 },
  Alt:     { key: "Alt",     code: "AltLeft",      keyCode: 18, bit: 1 },
  Meta:    { key: "Meta",    code: "MetaLeft",     keyCode: 91, bit: 4 },
};

async function handleClickElement(
  requestId: string,
  selector: string,
  timeout: number,
  modifiers?: string[],
): Promise<void> {
  // Snapshot page targets before click to detect new tabs
  const cdpWsUrl = currentChromeSession!.cdpWsUrl;
  const portMatch = cdpWsUrl.match(/:(\d+)\//);
  const cdpPort = portMatch?.[1];
  let targetsBefore: string[] = [];
  if (cdpPort) {
    try {
      const targets: { id: string; type: string }[] = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(1000, () => { req.destroy(); resolve([]); });
      });
      targetsBefore = targets.filter(t => t.type === "page").map(t => t.id);
    } catch { /* ignore */ }
  }

  await withDirectPageCdp("clickElement", timeout + 5000, async (pageWs, nextId) => {
    // Helper to send a CDP command and await its response
    const cdpCall = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          pageWs.removeListener("message", onMsg);
          reject(new Error(`${method} timeout`));
        }, timeout);

        const onMsg = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.id === id) {
              clearTimeout(timer);
              pageWs.removeListener("message", onMsg);
              if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
              else resolve((msg.result || {}) as T);
            }
          } catch (err) {
            log(`clickElement cdpCall parse error: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        pageWs.on("message", onMsg);
        pageWs.send(JSON.stringify({ id, method, params }));
      });
    };

    // 1. Find the element
    const { root } = await cdpCall<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdpCall<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`Element not found: ${selector}`);

    // 2. Scroll element into view
    await cdpCall("DOM.scrollIntoViewIfNeeded", { nodeId });
    await new Promise((r) => setTimeout(r, 100));

    // 3. Get bounding box
    const { model } = await cdpCall<{ model: { content: number[] } }>("DOM.getBoxModel", { nodeId });
    if (!model?.content || model.content.length < 8) {
      throw new Error(`Cannot get bounding box for: ${selector}`);
    }
    const box = quadToBox(model.content);

    // 4. Calculate target point with slight randomness (inner 80%)
    const paddingX = box.width * 0.1;
    const paddingY = box.height * 0.1;
    const targetX = box.x + paddingX + Math.random() * (box.width - 2 * paddingX);
    const targetY = box.y + paddingY + Math.random() * (box.height - 2 * paddingY);

    // 5. Move mouse along natural bezier path
    const fromX = 1280 * (0.2 + Math.random() * 0.6);
    const fromY = 800 * (0.2 + Math.random() * 0.6);
    const path = computeBezierPath(fromX, fromY, targetX, targetY);

    for (const point of path) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: point.x, y: point.y },
      }));
      if (point.delayMs > 0) {
        await new Promise((r) => setTimeout(r, point.delayMs));
      }
    }

    // 6. Small pause before clicking
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

    // 7. Press modifier keys (if any)
    const modifierBitmask = (modifiers || []).reduce((mask, mod) => {
      const info = MODIFIER_MAP[mod];
      if (info) {
        pageWs.send(JSON.stringify({
          id: nextId(),
          method: "Input.dispatchKeyEvent",
          params: { type: "rawKeyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: mask | info.bit },
        }));
        return mask | info.bit;
      }
      return mask;
    }, 0);

    // 8. Click (with modifier bitmask on mouse events)
    pageWs.send(JSON.stringify({
      id: nextId(),
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: targetX, y: targetY, button: "left", clickCount: 1, modifiers: modifierBitmask },
    }));
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
    pageWs.send(JSON.stringify({
      id: nextId(),
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: targetX, y: targetY, button: "left", clickCount: 1, modifiers: modifierBitmask },
    }));

    // 9. Release modifier keys (in reverse order)
    for (const mod of (modifiers || []).slice().reverse()) {
      const info = MODIFIER_MAP[mod];
      if (info) {
        pageWs.send(JSON.stringify({
          id: nextId(),
          method: "Input.dispatchKeyEvent",
          params: { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode },
        }));
      }
    }
  });

  // Check if a new tab appeared after the click
  let newTabOpened = false;
  if (cdpPort && targetsBefore.length > 0) {
    // Brief wait for the browser to create the tab target
    await new Promise((r) => setTimeout(r, 300));
    try {
      const targets: { id: string; type: string }[] = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(1000, () => { req.destroy(); resolve([]); });
      });
      const pagesAfter = targets.filter(t => t.type === "page").map(t => t.id);
      newTabOpened = pagesAfter.some(id => !targetsBefore.includes(id));
    } catch { /* ignore */ }
  }

  send({ type: "clickElementResponse", requestId, success: true, newTabOpened });
  log(`Clicked element locally: ${selector}${modifiers?.length ? ` [${modifiers.join("+")}]` : ""}${newTabOpened ? " (new tab opened)" : ""}`);
}

/**
 * Scroll through the page to reveal lazy-loaded content, entirely locally.
 * Uses real mouse wheel CDP events + Runtime.evaluate for height checks.
 * Returns when content stops growing or max rounds reached.
 */
async function handleScrollRevealLazyContent(
  requestId: string,
  viewport: { width: number; height: number },
  maxRounds: number,
  noChangeLimit: number,
): Promise<void> {
  await withDirectPageCdp("scrollRevealLazyContent", 60_000, async (pageWs, nextId) => {
    // Helper to send a CDP command and await its response
    const cdpCall = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          pageWs.removeListener("message", onMsg);
          reject(new Error(`${method} timeout`));
        }, 10_000);

        const onMsg = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.id === id) {
              clearTimeout(timer);
              pageWs.removeListener("message", onMsg);
              if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
              else resolve((msg.result || {}) as T);
            }
          } catch (err) {
            log(`scrollReveal cdpCall parse error: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        pageWs.on("message", onMsg);
        pageWs.send(JSON.stringify({ id, method, params }));
      });
    };

    // Get initial scroll height
    const { result: initialResult } = await cdpCall<{ result: { value: number } }>(
      "Runtime.evaluate",
      { expression: "document.documentElement.scrollHeight", returnByValue: true },
    );
    let previousHeight = initialResult.value;
    let totalScrollSteps = 0;
    let noChangeCount = 0;

    for (let round = 0; round < maxRounds && noChangeCount < noChangeLimit; round++) {
      // Randomize mouse position within viewport
      const mouseX = viewport.width * (0.3 + Math.random() * 0.4);
      const mouseY = viewport.height * (0.3 + Math.random() * 0.3);
      const steps = 2 + Math.floor(Math.random() * 3); // 2-4 steps

      // Move mouse to scroll position
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: mouseX, y: mouseY },
      }));

      // Scroll with real mouse wheel events
      for (let i = 0; i < steps; i++) {
        const deltaY = 500 + (Math.random() - 0.5) * 400; // 300-700
        pageWs.send(JSON.stringify({
          id: nextId(),
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseWheel", x: mouseX, y: mouseY, deltaX: 0, deltaY },
        }));
        const delayMs = 80 + Math.random() * 60; // 80-140ms
        await new Promise((r) => setTimeout(r, delayMs));
      }
      totalScrollSteps += steps;

      // Check if scroll height grew
      const { result: heightResult } = await cdpCall<{ result: { value: number } }>(
        "Runtime.evaluate",
        { expression: "document.documentElement.scrollHeight", returnByValue: true },
      );
      const currentHeight = heightResult.value;

      if (currentHeight > previousHeight) {
        previousHeight = currentHeight;
        noChangeCount = 0;

        // Wait for lazy content to load, then check again
        await new Promise((r) => setTimeout(r, 500));
        const { result: afterResult } = await cdpCall<{ result: { value: number } }>(
          "Runtime.evaluate",
          { expression: "document.documentElement.scrollHeight", returnByValue: true },
        );
        if (afterResult.value > previousHeight) {
          previousHeight = afterResult.value;
        }
      } else {
        noChangeCount++;
      }
    }

    send({
      type: "scrollRevealLazyContentResponse",
      requestId,
      success: true,
      totalScrollSteps,
      finalHeight: previousHeight,
    });
    log(`Scroll-reveal done locally: ${totalScrollSteps} steps, height=${previousHeight}px`);
  });
}

async function handleCdpVersionRequest(): Promise<void> {
  if (!currentChromeSession) {
    log("CDP version request but no Chrome session");
    return;
  }

  log(` ⬆ Sending: cdpVersionResponse (${(currentChromeSession.versionInfo as { Browser?: string }).Browser || "unknown"})`);
  send({
    type: "cdpVersionResponse",
    version: currentChromeSession.versionInfo,
  });
}

async function stopSession(): Promise<void> {
  if (currentCdpBridge) {
    log("Closing CDP bridge...");
    currentCdpBridge.close();
    currentCdpBridge = null;
  }
  if (currentChromeSession) {
    log("Killing Chrome...");
    await currentChromeSession.kill();
    currentChromeSession = null;
  }
}

function handleMessage(rawData: WebSocket.RawData): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(rawData.toString());
  } catch (err) {
    log(`Invalid message from server: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Log all non-CDP messages received from server
  if (msg.type !== "cdp" && msg.type !== "cdpBinary" && msg.type !== "ping") {
    log(` ⬇ Received: ${msg.type}`);
  }

  switch (msg.type) {
    case "authOk":
      setStatus("connected");
      reconnectAttempts = 0;
      log(`   Profile ID: ${msg.profileId}`);
      break;

    case "authFail":
      log(`ERROR:   Auth failed: ${msg.error}`);
      events.onError?.(msg.error);
      // Don't reconnect on auth failure
      ws?.close();
      break;

    case "startSession":
      log(`   Config: headed=${msg.config.headed ?? true}, startUrl=${msg.config.startUrl || "(none)"}`);
      handleStartSession(msg.config);
      break;

    case "stopSession":
      stopSession().then(() => setStatus("connected"));
      break;

    case "releaseCdp":
      handleReleaseCdp();
      break;

    case "cdpVersionRequest":
      handleCdpVersionRequest();
      break;

    case "typeText":
      handleTypeText(msg.text, msg.charDelayMs).catch((err) => {
        log(`ERROR: typeText failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "scrollWheel":
      handleScrollWheel(msg.mouseX, msg.mouseY, msg.steps).catch((err) => {
        log(`ERROR: scrollWheel failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "mouseMove":
      handleMouseMove(msg.steps).catch((err) => {
        log(`ERROR: mouseMove failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "screenshotRequest":
      handleScreenshotRequest(msg.requestId, msg.format || "jpeg", msg.quality ?? 50).catch((err) => {
        log(`ERROR: screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
        send({ type: "screenshotResponse", requestId: msg.requestId, data: null });
      });
      break;

    case "clickElement":
      handleClickElement(msg.requestId, msg.selector, msg.timeout, msg.modifiers).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`ERROR: clickElement failed: ${error}`);
        send({ type: "clickElementResponse", requestId: msg.requestId, success: false, error });
      });
      break;

    case "scrollRevealLazyContent":
      handleScrollRevealLazyContent(msg.requestId, msg.viewport, msg.maxRounds, msg.noChangeLimit).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`ERROR: scrollRevealLazyContent failed: ${error}`);
        send({ type: "scrollRevealLazyContentResponse", requestId: msg.requestId, success: false, totalScrollSteps: 0, finalHeight: 0, error });
      });
      break;

    case "ping":
      send({ type: "pong" });
      break;

    case "cdp":
    case "cdpBinary":
      // These are handled by the CDP bridge listener
      break;

    default:
      log(` ⬇ Unknown message type: ${(msg as { type: string }).type}`);
  }
}

export function connect(config: AppConfig, eventHandlers?: TunnelClientEvents): void {
  events = eventHandlers || {};
  intentionalDisconnect = false;

  if (!config.serverUrl || !config.apiToken) {
    log("ERROR:Server URL and API token are required");
    events.onError?.("Server URL and API token are required");
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log("Already connected/connecting");
    return;
  }

  setStatus("connecting");
  log(` Connecting to ${config.serverUrl}...`);

  ws = new WebSocket(config.serverUrl);

  ws.on("open", () => {
    setStatus("authenticating");
    send({
      type: "auth",
      token: config.apiToken,
      version: APP_VERSION,
    });
  });

  ws.on("message", handleMessage);

  ws.on("close", (code, reason) => {
    const wasConnected = status === "connected" || status === "scraping";
    setStatus("disconnected");

    // Stop any active session
    stopSession().catch(() => {});

    log(` Disconnected (code ${code}: ${reason.toString()})`);

    // Don't reconnect on auth failure, intentional close, or user-initiated disconnect
    if (code === 4004 || intentionalDisconnect) {
      intentionalDisconnect = false;
      return;
    }

    // Don't reconnect if disabled in config
    if (!config.autoReconnect) return;

    // Reconnect with exponential backoff
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    reconnectAttempts++;
    setStatus("reconnecting");
    log(` Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => connect(config, eventHandlers), delay);
  });

  ws.on("error", (err) => {
    log(`ERROR: WebSocket error: ${err.message}`);
  });
}

export function disconnect(): void {
  intentionalDisconnect = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;

  stopSession().catch(() => {});

  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    ws = null;
  }

  setStatus("disconnected");
}

export function getStatus(): TunnelStatus {
  return status;
}
