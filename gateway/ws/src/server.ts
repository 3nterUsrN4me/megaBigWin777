import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { SocketStream } from "@fastify/websocket";

import { verifyJwt, extractBearerToken } from "./auth/jwtVerify.js";
import { routeMessage } from "./router/messageRouter.js";
import { sendError, sendJson } from "./errors/errorHandler.js";
import { DbGameService } from "./gameService/DbGameService.js";
import { HeartbeatManager } from "./heartbeat/heartbeatManager.js";
import { logger, createSessionLogger } from "./middleware/requestLogger.js";
import type { ClientSession } from "./types.js";

// ─── Shared singletons ────────────────────────────────────────────────────────

const gameService = new DbGameService();
const heartbeat = new HeartbeatManager();

/** sessionId → ClientSession */
const sessions = new Map<string, ClientSession>();

/** tableId → Set<sessionId>  — used for per-room ROOM_STATE broadcasts */
const roomSessions = new Map<string, Set<string>>();

// ─── Server factory ───────────────────────────────────────────────────────────

export async function buildServer() {
  const fastify = Fastify({
    logger: false, // we use Pino directly via requestLogger
  });

  await fastify.register(websocketPlugin, {
    options: {
      // ws-level protocol-layer ping/pong every 25 s to detect silent TCP drops.
      // This is independent of the JSON-level PING/PONG heartbeat.
      clientTracking: true,
    },
  });

  // ── WebSocket route ────────────────────────────────────────────────────────
  fastify.register(async (instance) => {
    instance.get(
      "/ws",
      { websocket: true },
      async (connection: SocketStream, req) => {
        // SocketStream wraps the raw ws.WebSocket; use connection.socket for WS ops.
        const socket = connection.socket;

        // ── Authentication ────────────────────────────────────────────────

        const token = extractBearerToken(req);
        if (!token) {
          sendError(socket, "UNAUTHORIZED", "Missing Authorization header");
          socket.close(1008, "Unauthorized");
          return;
        }

        const jwtPayload = await verifyJwt(token);
        if (!jwtPayload) {
          sendError(socket, "UNAUTHORIZED", "Invalid or expired JWT");
          socket.close(1008, "Unauthorized");
          return;
        }

        // ── Session setup ─────────────────────────────────────────────────

        const sessionId = randomUUID();
        const { sub: playerId } = jwtPayload;
        const username = jwtPayload.username ?? playerId;

        const session: ClientSession = {
          sessionId,
          playerId,
          username,
          ws: socket,
          gameId: null,
          tableId: null,
          lastPingAt: Date.now(),
        };

        sessions.set(sessionId, session);
        heartbeat.register(sessionId);

        const sessionLog = createSessionLogger(sessionId, playerId);
        sessionLog.info("WebSocket connection established");

        // ── Message handler ───────────────────────────────────────────────

        socket.on("message", (rawData) => {
          const start = Date.now();

          void routeMessage(rawData, {
            session,
            gameService,
            sessions,
            roomSessions,
          }).catch((err) => {
            sessionLog.error({ err }, "Unhandled error in message handler");
            sendError(socket, "INTERNAL_ERROR", "An internal server error occurred");
          }).finally(() => {
            sessionLog.debug(
              { durationMs: Date.now() - start },
              "Message processed",
            );
          });
        });

        // ── Close handler ─────────────────────────────────────────────────

        socket.on("close", (code, reason) => {
          sessions.delete(sessionId);
          heartbeat.unregister(sessionId);

          // Remove from room broadcast map (stops receiving broadcasts immediately)
          if (session.tableId) {
            const sids = roomSessions.get(session.tableId);
            if (sids) {
              sids.delete(sessionId);
              if (sids.size === 0) roomSessions.delete(session.tableId);
            }
          }

          // Grace period: mark seat offline but keep it for RECONNECT_GRACE_MS.
          // This prevents the "Alt-Tab / focus loss" scenario from instantly
          // booting the player mid-round.
          const disc = gameService.notifyDisconnect(sessionId);
          if (disc.gracePeriod) {
            const { tableId, expiresAt } = disc;
            const delay = expiresAt - Date.now();
            sessionLog.info({ code, tableId, delayMs: delay }, "Grace period started — seat preserved");
            setTimeout(() => {
              void gameService.expireDisconnectedSeats(tableId).then((removed) => {
                if (removed.length > 0) {
                  sessionLog.warn({ tableId, removed }, "Grace period expired — seats removed");
                }
              });
            }, delay);
          }

          sessionLog.info({ code, reason: reason.toString() }, "WebSocket connection closed");
        });

        // ── Error handler ─────────────────────────────────────────────────

        socket.on("error", (err) => {
          sessionLog.error({ err }, "WebSocket socket error");
        });
      }
    );
  });

  // ── Heartbeat sweep ────────────────────────────────────────────────────────
  heartbeat.start((sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    logger.warn({ sessionId }, "Heartbeat timeout — closing stale connection");
    sendJson(session.ws, {
      event: "ERROR",
      v: "1",
      code: "INTERNAL_ERROR",
      message: "Heartbeat timeout",
    });
    session.ws.close(1001, "Heartbeat timeout");
    sessions.delete(sessionId);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  fastify.addHook("onClose", async () => {
    heartbeat.stop();
    for (const session of sessions.values()) {
      session.ws.close(1001, "Server shutting down");
    }
    sessions.clear();
    logger.info("WS Gateway shut down cleanly");
  });

  return fastify;
}
