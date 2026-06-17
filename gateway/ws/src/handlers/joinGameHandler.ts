import { sendError, sendJson } from "../errors/errorHandler.js";
import { handlePlaceBet } from "./placeBetHandler.js";
import { handleJoinRoom as _handleJoinRoom, broadcastRoomState } from "./joinRoomHandler.js";
import type { JoinGameMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export { broadcastRoomState };

export async function handleJoinGame(
  msg: JoinGameMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  let joinResult;
  try {
    joinResult = await gameService.joinRoom({
      tableId: msg.tableId,
      playerId,
      username: session.username,
      socketId: sessionId,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to join game");
    return;
  }

  if (!joinResult.ok) {
    sendError(ws, joinResult.code, joinResult.message);
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
    roomStatus: joinResult.roomState.roomStatus,
    minBet:     joinResult.minBet,
    maxBet:     joinResult.maxBet,
  });

  broadcastRoomState(msg.tableId, joinResult.roomState, roomSessions, sessions);

  await handlePlaceBet(
    { event: "PLACE_BET", v: "1", tableId: msg.tableId, betAmount: msg.betAmount },
    ctx,
  );
}
