import { sendError, sendJson } from "../errors/errorHandler.js";
import { handlePlaceBet } from "./placeBetHandler.js";
import { handleJoinRoom as _handleJoinRoom, broadcastRoomState } from "./joinRoomHandler.js";
import type { JoinGameMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export { broadcastRoomState };

/**
 * Legacy JOIN_GAME handler.
 *
 * Translates the old single-message join+bet into the new two-step flow:
 *   JOIN_ROOM (seat player) → PLACE_BET (record bet immediately)
 *
 * Kept so old clients and existing tests continue to work without changes.
 * New clients should send JOIN_ROOM then PLACE_BET separately.
 */
export function handleJoinGame(
  msg: JoinGameMessage,
  ctx: WsHandlerContext,
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId } = session;

  // Phase 1 — seat the player
  const joinResult = gameService.joinRoom({
    tableId:  msg.tableId,
    playerId,
    username: session.username,
    socketId: session.sessionId,
  });

  if (!joinResult.ok) {
    sendError(ws, joinResult.code as "INVALID_ACTION" | "TABLE_FULL", joinResult.message);
    return;
  }

  session.tableId = msg.tableId;

  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(session.sessionId);

  // Personal acknowledgement
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

  // Phase 2 — immediately place the bet (legacy clients bundle this into JOIN_GAME)
  handlePlaceBet(
    { event: "PLACE_BET", v: "1", tableId: msg.tableId, betAmount: msg.betAmount },
    ctx,
  );
}
