import { parseMessage } from "../parser/messageParser.js";
import { sendError } from "../errors/errorHandler.js";
import { handlePing } from "../handlers/pingHandler.js";
import { handleJoinRoom } from "../handlers/joinRoomHandler.js";
import { handleJoinSlot } from "../handlers/joinSlotHandler.js";
import { handlePlaceBet } from "../handlers/placeBetHandler.js";
import { handleReconnect } from "../handlers/reconnectHandler.js";
import { handleJoinGame } from "../handlers/joinGameHandler.js";
import { handlePlayerAction } from "../handlers/playerActionHandler.js";
import { handleLeaveGame } from "../handlers/leaveGameHandler.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Central message dispatcher.
 *
 * Room state machine event routing:
 *
 *   JOIN_ROOM     → Phase 1: seat the player (WAITING_FOR_PLAYERS → BETTING)
 *   PLACE_BET     → Phase 2: record bet (BETTING → PLAYING when all bets in)
 *   RECONNECT     → Reattach after refresh; restores ROOM_STATE + GAME_STATE
 *   PLAYER_ACTION → Phase 3: HIT / STAND / DOUBLE_DOWN (PLAYING → ROUND_OVER)
 *   LEAVE_GAME    → Remove seat; refund bet if in BETTING
 *   JOIN_GAME     → Legacy alias: JOIN_ROOM + PLACE_BET in one message
 *   PING          → Heartbeat keepalive
 */
export function routeMessage(rawData: unknown, ctx: WsHandlerContext): void {
  const parsed = parseMessage(rawData);

  if (parsed.type === "PARSE_ERROR") {
    sendError(ctx.session.ws, parsed.code, parsed.message);
    return;
  }

  switch (parsed.type) {
    case "JOIN_ROOM":
      handleJoinRoom(parsed.data, ctx);
      break;

    case "JOIN_SLOT":
      handleJoinSlot(parsed.data, ctx);
      break;

    case "PLACE_BET":
      handlePlaceBet(parsed.data, ctx);
      break;

    case "RECONNECT":
      handleReconnect(parsed.data, ctx);
      break;

    case "JOIN_GAME":
      // Legacy: seat + bet in one message
      handleJoinGame(parsed.data, ctx);
      break;

    case "PLAYER_ACTION":
      handlePlayerAction(parsed.data, ctx);
      break;

    case "LEAVE_GAME":
      handleLeaveGame(parsed.data, ctx);
      break;

    case "PING":
      handlePing(parsed.data, ctx);
      break;

    default: {
      const _exhaustive: never = parsed;
      sendError(ctx.session.ws, "INVALID_MESSAGE", "Unhandled message type");
    }
  }
}
