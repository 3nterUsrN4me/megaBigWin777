import pino from "pino";

/**
 * Shared structured logger (Pino).
 *
 * Usage: import { logger } from '../middleware/requestLogger.js'
 * Then: logger.info({ sessionId, event, durationMs }, 'message processed')
 */
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "ws-gateway" },
});

/**
 * Creates a child logger scoped to a specific WebSocket session.
 * All log entries will include `sessionId` and `playerId` automatically.
 */
export function createSessionLogger(sessionId: string, playerId: string) {
  return logger.child({ sessionId, playerId });
}

export type SessionLogger = ReturnType<typeof createSessionLogger>;
