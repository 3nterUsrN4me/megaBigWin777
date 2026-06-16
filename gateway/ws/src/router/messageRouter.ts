import { parseMessage } from "../parser/messageParser.js";
import { sendError } from "../errors/errorHandler.js";
import { handlePing } from "../handlers/pingHandler.js";
import { handleJoinGame } from "../handlers/joinGameHandler.js";
import { handlePlayerAction } from "../handlers/playerActionHandler.js";
import { handleLeaveGame } from "../handlers/leaveGameHandler.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Central message dispatcher.
 *
 * Parses the raw WebSocket message, validates the protocol version and schema,
 * then routes to the appropriate handler.
 *
 * All handlers receive a shared `WsHandlerContext` so they can access the session,
 * game service, and the full sessions map without coupling to the server internals.
 */
export function routeMessage(rawData: unknown, ctx: WsHandlerContext): void {
  const parsed = parseMessage(rawData);

  if (parsed.type === "PARSE_ERROR") {
    sendError(ctx.session.ws, parsed.code, parsed.message);
    return;
  }

  switch (parsed.type) {
    case "PING":
      handlePing(parsed.data, ctx);
      break;

    case "JOIN_GAME":
      handleJoinGame(parsed.data, ctx);
      break;

    case "PLAYER_ACTION":
      handlePlayerAction(parsed.data, ctx);
      break;

    case "LEAVE_GAME":
      handleLeaveGame(parsed.data, ctx);
      break;

    default: {
      // TypeScript exhaustiveness guard — this branch is unreachable at runtime.
      const _exhaustive: never = parsed;
      sendError(ctx.session.ws, "INVALID_MESSAGE", "Unhandled message type");
    }
  }
}
