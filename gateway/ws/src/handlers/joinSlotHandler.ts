import { sendError, sendJson } from "../errors/errorHandler.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { JoinSlotMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export async function handleJoinSlot(
  msg: JoinSlotMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  let result;
  try {
    result = await gameService.joinSlot({
      tableId: msg.tableId,
      playerId,
      username: session.username,
      seatIndex: msg.seatIndex,
      socketId: sessionId,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to join slot");
    return;
  }

  if (!result.ok) {
    sendError(ws, result.code, result.message);
    return;
  }

  session.tableId = msg.tableId;
  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(sessionId);

  sendJson(ws, {
    event:      "ROOM_ACK",
    v:          "1",
    tableId:    msg.tableId,
    playerId,
    seatIndex:  result.seatIndex,
    roomStatus: result.roomState.roomStatus,
    minBet:     result.minBet,
    maxBet:     result.maxBet,
  });

  sendJson(ws, result.roomState);
  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);
}
