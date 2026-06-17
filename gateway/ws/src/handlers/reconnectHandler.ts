import { sendError, sendJson } from "../errors/errorHandler.js";
import { gameStateViewToPayload } from "../wsPayloads.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { ReconnectMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export async function handleReconnect(
  msg: ReconnectMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  let result;
  try {
    result = await gameService.reconnect({
      tableId: msg.tableId,
      playerId,
      username: session.username,
      socketId: sessionId,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to reconnect");
    return;
  }

  if (!result.ok) {
    sendError(ws, result.code, result.message);
    sendJson(ws, {
      event:   "RECONNECT_FAILED",
      v:       "1",
      tableId: msg.tableId,
      reason:  result.message,
    });
    return;
  }

  session.tableId = msg.tableId;

  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(sessionId);

  sendJson(ws, {
    event:       "RECONNECT_ACK",
    v:           "1",
    tableId:     msg.tableId,
    playerId,
    roomStatus:  result.roomState.roomStatus,
    minBet:      result.minBet,
    maxBet:      result.maxBet,
    playerChips: result.playerChips,
  });

  sendJson(ws, result.roomState);

  const allSeats = await gameService.getPlayerSeats(msg.tableId, playerId);
  for (const slot of allSeats) {
    if (slot.game && slot.game.status !== "FINISHED") {
      session.gameId = slot.game.gameId;
      sendJson(ws, gameStateViewToPayload(slot.game, slot.seatIndex));
    }
  }

  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);
}
