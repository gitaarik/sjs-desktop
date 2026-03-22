/**
 * Tunnel protocol message types.
 *
 * Shared between the SJS server (worker) and the desktop app.
 * All messages are JSON over WebSocket with a `type` discriminator.
 *
 * This is a standalone copy — keep in sync with
 * cloud/src/server/browser/tunnel/protocol.ts
 */

// ============================================================================
// Desktop App → Server
// ============================================================================

export interface TunnelAuthMessage {
  type: "auth";
  token: string;
  version: string;
}

export interface TunnelSessionReady {
  type: "sessionReady";
  cdpVersion: {
    Browser: string;
    webSocketDebuggerUrl: string;
    [key: string]: unknown;
  };
}

export interface TunnelSessionError {
  type: "sessionError";
  error: string;
}

export interface TunnelCdpVersionResponse {
  type: "cdpVersionResponse";
  version: Record<string, unknown>;
}

export interface TunnelPong {
  type: "pong";
}

// ============================================================================
// Server → Desktop App
// ============================================================================

export interface TunnelAuthOk {
  type: "authOk";
  profileId: number;
}

export interface TunnelAuthFail {
  type: "authFail";
  error: string;
}

export interface TunnelStartSession {
  type: "startSession";
  config: {
    startUrl?: string;
    headed?: boolean;
    keepMinimized?: boolean;
  };
}

export interface TunnelStopSession {
  type: "stopSession";
}

export interface TunnelReleaseCdp {
  type: "releaseCdp";
}

export interface TunnelCdpVersionRequest {
  type: "cdpVersionRequest";
}

export interface TunnelTypeText {
  type: "typeText";
  text: string;
  /** Per-character delay in ms */
  charDelayMs: number;
}

export interface TunnelScrollWheel {
  type: "scrollWheel";
  mouseX: number;
  mouseY: number;
  /** Pre-computed scroll steps (server computes randomization) */
  steps: { deltaY: number; delayMs: number }[];
}

export interface TunnelMouseMove {
  type: "mouseMove";
  /** Pre-computed bezier path with delays (server computes curve + tremor) */
  steps: { x: number; y: number; delayMs: number }[];
}

export interface TunnelScreenshotRequest {
  type: "screenshotRequest";
  requestId: string;
  format?: "jpeg" | "png";
  quality?: number;
}

export interface TunnelClickElement {
  type: "clickElement";
  requestId: string;
  selector: string;
  /** Click timeout in ms (default 5000) */
  timeout: number;
  /** Keyboard modifiers to hold during click (e.g. ["Control"] for Ctrl+click) */
  modifiers?: ("Control" | "Shift" | "Alt" | "Meta")[];
}

export interface TunnelScrollRevealLazyContent {
  type: "scrollRevealLazyContent";
  requestId: string;
  /** Viewport dimensions for mouse positioning */
  viewport: { width: number; height: number };
  /** Max scroll rounds (default: 10) */
  maxRounds: number;
  /** Consecutive no-change rounds before stopping (default: 3) */
  noChangeLimit: number;
}

export interface TunnelPing {
  type: "ping";
}

// ============================================================================
// Desktop App → Server (continued)
// ============================================================================

export interface TunnelScrollRevealLazyContentResponse {
  type: "scrollRevealLazyContentResponse";
  requestId: string;
  success: boolean;
  /** Total scroll steps performed */
  totalScrollSteps: number;
  /** Final scroll height */
  finalHeight: number;
  error?: string;
}

export interface TunnelScreenshotResponse {
  type: "screenshotResponse";
  requestId: string;
  /** base64-encoded image data, or null on failure */
  data: string | null;
}

export interface TunnelClickElementResponse {
  type: "clickElementResponse";
  requestId: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// Bidirectional (CDP relay)
// ============================================================================

export interface TunnelCdpMessage {
  type: "cdp";
  data: string;
}

export interface TunnelCdpBinary {
  type: "cdpBinary";
  data: string; // base64
}

// ============================================================================
// Union types
// ============================================================================

export type ServerMessage =
  | TunnelAuthOk
  | TunnelAuthFail
  | TunnelStartSession
  | TunnelStopSession
  | TunnelReleaseCdp
  | TunnelCdpVersionRequest
  | TunnelTypeText
  | TunnelScrollWheel
  | TunnelMouseMove
  | TunnelScreenshotRequest
  | TunnelClickElement
  | TunnelScrollRevealLazyContent
  | TunnelCdpMessage
  | TunnelCdpBinary
  | TunnelPing;

export type ClientMessage =
  | TunnelAuthMessage
  | TunnelSessionReady
  | TunnelSessionError
  | TunnelCdpVersionResponse
  | TunnelScreenshotResponse
  | TunnelClickElementResponse
  | TunnelScrollRevealLazyContentResponse
  | TunnelCdpMessage
  | TunnelCdpBinary
  | TunnelPong;
