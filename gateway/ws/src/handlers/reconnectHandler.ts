import { sendError, sendJson } from "../errors/errorHandler.js";
import { buildGameStatePayload } from "../gameService/InMemoryGameService.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { ReconnectMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles RECONNECT — player returns after page refresh or network drop.
 *
 * Ghost-state fix:
 *   If the room was in ROUND_OVER when the player reconnects, the service
 *   automatically resets it to BETTING (clears all game data, keeps seats).
 *   The player therefore sees a clean BETTING panel instead of a frozen result.
 *
 * Response sequence:
 *   1. RECONNECT_ACK  — confirms reconnection + current room phase
 *   2. ROOM_STATE     — full table snapshot
 *   3. GAME_STATE     — personal hand for each active seat (only if PLAYING)
 *
 * Broadcast: ROOM_STATE sent to all other players so they see the seat is back.
 */
export function handleReconnect(
  msg: ReconnectMessage,
  ctx: WsHandlerContext,
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  const result = gameService.reconnect({
    tableId:  msg.tableId,
    playerId,
    username: session.username,
    socketId: sessionId,
  });

  if (!result.ok) {
    sendError(ws, result.code as "GAME_NOT_FOUND", result.message);
    sendJson(ws, {
      event:   "RECONNECT_FAILED",
      v:       "1",
      tableId: msg.tableId,
      reason:  result.message,
    });
    return;
  }

  // Re-attach session
  session.tableId = msg.tableId;

  // Register in broadcast map
  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(sessionId);

  // 1. RECONNECT_ACK
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

  // 2. Full ROOM_STATE
  sendJson(ws, result.roomState);

  // 3. GAME_STATE for each active seat (Multi-Hand: player may own several)
  // Only send during PLAYING — after ghost-state fix, ROUND_OVER → BETTING,
  // so result.game is null and no stale GAME_STATE is sent.
  const allSeats = gameService.getPlayerSeats(msg.tableId, playerId);
  for (const slot of allSeats) {
    if (slot.game && slot.game.status !== "FINISHED") {
      session.gameId = slot.game.gameId;
      const statePayload = buildGameStatePayload(slot.game, result.playerChips, slot.seatIndex);
      sendJson(ws, statePayload);
    }
  }

  // 4. Let others know this player is back
  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);
}
