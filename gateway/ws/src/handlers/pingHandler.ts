import { sendJson } from "../errors/errorHandler.js";
import type { PingMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles a client PING message.
 *
 * - Refreshes the heartbeat timestamp so the connection isn't pruned.
 * - Responds immediately with a PONG containing the same timestamp.
 */
export function handlePing(
  msg: PingMessage,
  ctx: WsHandlerContext
): void {
  const { session } = ctx;

  // Refresh heartbeat
  session.lastPingAt = Date.now();

  sendJson(session.ws, {
    event: "PONG",
    v: "1",
    timestamp: msg.timestamp,
  });
}
