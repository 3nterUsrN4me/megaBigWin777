import type { WebSocket } from "ws";
import type { ErrorCode } from "../types.js";

export type { ErrorCode };

/**
 * Sends a structured ERROR event to the WebSocket client.
 * Never throws — if the socket is closed, the send is silently skipped.
 */
export function sendError(
  ws: WebSocket,
  code: ErrorCode,
  message: string,
  gameId?: string
): void {
  if (ws.readyState !== ws.OPEN) return;

  const payload: Record<string, unknown> = {
    event: "ERROR",
    v: "1",
    code,
    message,
  };
  if (gameId !== undefined) payload["gameId"] = gameId;

  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Socket may have closed between the readyState check and send
  }
}

/**
 * Sends a JSON payload to a WebSocket client.
 * Never throws.
 */
export function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Swallow — caller doesn't need to know if the client has disconnected
  }
}
