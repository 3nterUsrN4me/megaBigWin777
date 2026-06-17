import { sendError, sendJson } from "../errors/errorHandler.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { JoinSlotMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles JOIN_SLOT — player occupies a specific seat by index (0–4).
 *
 * Multi-Hand: the same player can own multiple seats at the same table.
 * Each seat gets its own game / hand during the round.
 *
 * Rules (enforced in gameService.joinSlot):
 *  - Only allowed when room is WAITING_FOR_PLAYERS or BETTING.
 *  - Slot must be empty (or already owned by the same player — idempotent).
 *  - PLAYING → reject (round already started).
 *  - ROUND_OVER → auto-reset to BETTING, then seat.
 *
 * Response:
 *  → ROOM_ACK (personal) + ROOM_STATE broadcast to all.
 */
export function handleJoinSlot(
  msg: JoinSlotMessage,
  ctx: WsHandlerContext,
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  const result = gameService.joinSlot({
    tableId:   msg.tableId,
    playerId,
    username:  session.username,
    seatIndex: msg.seatIndex,
    socketId:  sessionId,
  });

  if (!result.ok) {
    sendError(ws, result.code as "INVALID_ACTION" | "TABLE_FULL", result.message);
    return;
  }

  // Ensure session is tracked for this room
  session.tableId = msg.tableId;
  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(sessionId);

  // Personal ACK with the claimed seat index
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

  // Send full snapshot directly to this player (no "brickable" window)
  sendJson(ws, result.roomState);

  // Broadcast to everyone else
  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);
}
