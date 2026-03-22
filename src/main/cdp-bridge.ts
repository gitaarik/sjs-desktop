/**
 * CDP bridge between the tunnel WebSocket and Chrome's CDP WebSocket.
 *
 * Relays all CDP traffic bidirectionally:
 * - Server (via tunnel) → Chrome
 * - Chrome → Server (via tunnel)
 */

import WebSocket from "ws";
import type { ClientMessage } from "./protocol";

interface CdpBridgeOptions {
  /** Chrome's CDP WebSocket URL */
  cdpWsUrl: string;
  /** The tunnel WebSocket (to the server) */
  tunnelWs: WebSocket;
  /** Called when the server sends Target.setAutoAttach (Playwright reconnecting) */
  onPlaywrightReconnect?: () => void;
  /** Called when Chrome reports a new target attached (new tab opened) */
  onNewTarget?: () => void;
}

interface CdpBridge {
  /** Close the bridge and CDP connection */
  close: () => void;
}

/**
 * Create a bridge between the tunnel and Chrome's CDP.
 */
export function createCdpBridge(options: CdpBridgeOptions): Promise<CdpBridge> {
  const { cdpWsUrl, tunnelWs, onPlaywrightReconnect, onNewTarget } = options;
  let playwrightReconnectFired = false;

  return new Promise((resolve, reject) => {
    console.log(`[CDP Bridge] Connecting to Chrome: ${cdpWsUrl}`);

    const chromeWs = new WebSocket(cdpWsUrl);

    chromeWs.on("open", () => {
      console.log("[CDP Bridge] Connected to Chrome CDP");

      // CDP traffic stats — logged periodically so you can see data flow
      // without flooding the console with per-message logs
      let serverToChrome = 0;
      let chromeToServer = 0;
      let serverToChromeBytes = 0;
      let chromeToServerBytes = 0;
      const statsInterval = setInterval(() => {
        if (serverToChrome > 0 || chromeToServer > 0) {
          console.log(
            `[CDP Bridge] Traffic: server→chrome ${serverToChrome} msgs (${fmtBytes(serverToChromeBytes)}), ` +
            `chrome→server ${chromeToServer} msgs (${fmtBytes(chromeToServerBytes)})`,
          );
          serverToChrome = 0;
          chromeToServer = 0;
          serverToChromeBytes = 0;
          chromeToServerBytes = 0;
        }
      }, 10_000);

      // Auto-resume targets that the server doesn't handle.
      // Playwright sets Target.setAutoAttach({ waitForDebuggerOnStart: true })
      // which pauses ALL new tabs. During intervention (Playwright disconnected),
      // nobody resumes user-opened tabs, so they hang. We give the server 500ms
      // to handle each new target; if it doesn't, we resume it ourselves.
      const pendingTargets = new Map<string, NodeJS.Timeout>();
      let nextResumeId = 1_000_000; // high IDs to avoid collisions with server

      // Server → Chrome: relay CDP messages from tunnel to Chrome
      const tunnelHandler = (rawData: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(rawData.toString());

          if (msg.type === "cdp" && chromeWs.readyState === WebSocket.OPEN) {
            // Detect server resuming a target — cancel our fallback timer
            // Also detect Playwright reconnecting via Target.setAutoAttach
            let cdpData = msg.data;
            try {
              const cdp = JSON.parse(msg.data);
              if (cdp.method === "Runtime.runIfWaitingForDebugger" && cdp.sessionId) {
                const timer = pendingTargets.get(cdp.sessionId);
                if (timer) {
                  clearTimeout(timer);
                  pendingTargets.delete(cdp.sessionId);
                }
              }
              if (cdp.method === "Target.setAutoAttach" && !playwrightReconnectFired) {
                playwrightReconnectFired = true;
                onPlaywrightReconnect?.();
              }
              // Inject background/focus params into Target.createTarget to prevent
              // Chrome from stealing focus when opening new tabs during scraping.
              // - background: true — open tab in background (supported in stable CDP)
              // - focus: false — don't change window focus state (experimental, newer Chrome)
              // Chrome ignores unknown params, so both are safe to send.
              // Note: these params don't reliably prevent focus stealing on all Linux
              // WM/display setups, so tunnel-client probes at session start and enables
              // a re-minimize fallback if needed (see probeBackgroundTabSupport).
              if (cdp.method === "Target.createTarget") {
                cdp.params = {
                  ...cdp.params,
                  background: true,
                  focus: false,
                };
                cdpData = JSON.stringify(cdp);
              }
            } catch { /* not JSON or no method — relay as-is */ }

            chromeWs.send(cdpData);
            serverToChrome++;
            serverToChromeBytes += msg.data.length;
          } else if (msg.type === "cdpBinary" && chromeWs.readyState === WebSocket.OPEN) {
            const buf = Buffer.from(msg.data, "base64");
            chromeWs.send(buf);
            serverToChrome++;
            serverToChromeBytes += buf.length;
          }
          // Other message types handled by tunnel-client
        } catch (err) {
          console.log(`[CDP Bridge] Tunnel message parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      tunnelWs.on("message", tunnelHandler);

      // Chrome → Server: relay CDP messages from Chrome to tunnel
      chromeWs.on("message", (data, isBinary) => {
        if (tunnelWs.readyState !== WebSocket.OPEN) return;

        const dataLen = isBinary ? (data as Buffer).length : data.toString().length;
        chromeToServer++;
        chromeToServerBytes += dataLen;

        // Detect new auto-attached targets waiting for debugger
        if (!isBinary) {
          try {
            const cdp = JSON.parse(data.toString());
            if (
              cdp.method === "Target.attachedToTarget" &&
              cdp.params?.waitingForDebugger &&
              cdp.params?.sessionId
            ) {
              const sessionId = cdp.params.sessionId as string;
              onNewTarget?.();
              // Give the server 500ms to resume; if it doesn't, we do it
              const timer = setTimeout(() => {
                pendingTargets.delete(sessionId);
                if (chromeWs.readyState === WebSocket.OPEN) {
                  const resumeMsg = JSON.stringify({
                    id: nextResumeId++,
                    method: "Runtime.runIfWaitingForDebugger",
                    sessionId,
                  });
                  chromeWs.send(resumeMsg);
                  console.log(`[CDP Bridge] Auto-resumed unhandled target (session ${sessionId.slice(0, 8)}...)`);
                }
              }, 500);
              pendingTargets.set(sessionId, timer);
            }
          } catch { /* not JSON — just relay */ }
        }

        if (isBinary) {
          const msg: ClientMessage = {
            type: "cdpBinary",
            data: (data as Buffer).toString("base64"),
          };
          tunnelWs.send(JSON.stringify(msg));
        } else {
          const msg: ClientMessage = {
            type: "cdp",
            data: data.toString(),
          };
          tunnelWs.send(JSON.stringify(msg));
        }
      });

      // Cleanup when Chrome disconnects
      chromeWs.on("close", () => {
        console.log("[CDP Bridge] Chrome CDP disconnected");
        clearInterval(statsInterval);
        tunnelWs.removeListener("message", tunnelHandler);
      });

      chromeWs.on("error", (err) => {
        console.error("[CDP Bridge] Chrome CDP error:", err.message);
      });

      resolve({
        close() {
          clearInterval(statsInterval);
          for (const timer of pendingTargets.values()) clearTimeout(timer);
          pendingTargets.clear();
          tunnelWs.removeListener("message", tunnelHandler);
          if (chromeWs.readyState === WebSocket.OPEN) {
            chromeWs.close();
          }
          console.log("[CDP Bridge] Closed");
        },
      });
    });

    chromeWs.on("error", (err) => {
      reject(new Error(`Failed to connect to Chrome CDP: ${err.message}`));
    });
  });
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
