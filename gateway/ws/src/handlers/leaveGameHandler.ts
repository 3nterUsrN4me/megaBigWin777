import { sendJson } from "../errors/errorHandler.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { LeaveGameMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles LEAVE_GAME — player explicitly leaves the table.
 *
 * Actions:
 *  1. Remove the player's seat from the room (via gameService.leaveRoom).
 *     - If room was BETTING and player had bet → bet is refunded.
 *  2. Clear session's tableId and gameId.
 *  3. Remove session from room broadcast map.
 *  4. Send a blank GAME_STATE to the departing player so the client resets.
 *  5. Broadcast updated ROOM_STATE to remaining players.
 */
export function handleLeaveGame(
  msg: LeaveGameMessage,
  ctx: WsHandlerContext,
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const tableId = msg.tableId;

  // Only process if this player is actually at that table
  if (session.tableId !== tableId) {
    return;
  }

  const chips = gameService.getPlayerChips(session.playerId);

  // Remove player from room (may trigger bet refund)
  const { roomState } = gameService.leaveRoom({
    tableId,
    playerId: session.playerId,
  });

  // Clear session state
  const oldGameId  = session.gameId;
  session.gameId   = null;
  session.tableId  = null;

  // Remove from broadcast map
  const sids = roomSessions.get(tableId);
  if (sids) {
    sids.delete(session.sessionId);
    if (sids.size === 0) roomSessions.delete(tableId);
  }

  // Acknowledge to departing player — send a reset GAME_STATE
  sendJson(session.ws, {
    event:            "GAME_STATE",
    v:                "1",
    gameId:           oldGameId ?? "00000000-0000-0000-0000-000000000000",
    status:           "FINISHED",
    playerHand:       { cards: [], value: 0, isSoft: false, isBust: false, isBlackjack: false },
    dealerHand:       { cards: [], value: 0, isSoft: false, isBust: false, isBlackjack: false },
    betAmount:        0,
    result:           null,
    availableActions: [],
    playerChips:      chips,
  });

  // Broadcast to remaining players
  if (roomState) {
    broadcastRoomState(tableId, roomState, roomSessions, sessions);
  }
}
