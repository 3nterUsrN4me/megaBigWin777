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

export async function routeMessage(rawData: unknown, ctx: WsHandlerContext): Promise<void> {
  const parsed = parseMessage(rawData);

  if (parsed.type === "PARSE_ERROR") {
    sendError(ctx.session.ws, parsed.code, parsed.message);
    return;
  }

  switch (parsed.type) {
    case "JOIN_ROOM":
      await handleJoinRoom(parsed.data, ctx);
      break;

    case "JOIN_SLOT":
      await handleJoinSlot(parsed.data, ctx);
      break;

    case "PLACE_BET":
      await handlePlaceBet(parsed.data, ctx);
      break;

    case "RECONNECT":
      await handleReconnect(parsed.data, ctx);
      break;

    case "JOIN_GAME":
      await handleJoinGame(parsed.data, ctx);
      break;

    case "PLAYER_ACTION":
      await handlePlayerAction(parsed.data, ctx);
      break;

    case "LEAVE_GAME":
      await handleLeaveGame(parsed.data, ctx);
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
