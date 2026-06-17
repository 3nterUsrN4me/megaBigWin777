import { sendError, sendJson } from "../errors/errorHandler.js";
import { buildGameStatePayload } from "../gameService/InMemoryGameService.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { PlayerActionMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles PLAYER_ACTION (HIT | STAND | DOUBLE_DOWN).
 *
 * Idempotency per ARCHITECTURE.md §7:
 *  - If the idempotencyKey matches the last stored key → return the cached GAME_STATE.
 *  - Otherwise → process the action, update game state, cache the new GAME_STATE.
 *
 * After applying the action:
 *  1. The acting player receives their personal GAME_STATE (with availableActions).
 *  2. All players in the room receive a ROOM_STATE broadcast with the updated table view.
 */
export function handlePlayerAction(
  msg: PlayerActionMessage,
  ctx: WsHandlerContext
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId } = session;

  if (msg.seatIndex === undefined) {
    sendError(ws, "INVALID_ACTION", "seatIndex is required for PLAYER_ACTION");
    return;
  }

  const actionResult = gameService.applyAction({
    gameId:         msg.gameId,
    playerId,
    action:         msg.action,
    idempotencyKey: msg.idempotencyKey,
    slotIndex:      msg.seatIndex,
  });

  if (!actionResult.ok) {
    sendError(
      ws,
      actionResult.code as "GAME_NOT_FOUND" | "INVALID_ACTION" | "INSUFFICIENT_CHIPS" | "INTERNAL_ERROR",
      actionResult.message,
      msg.gameId
    );
    return;
  }

  const { game, playerChips, wasIdempotent, roomState } = actionResult;

  if (wasIdempotent && game.cachedStatePayload !== null) {
    sendJson(ws, game.cachedStatePayload);
    // Still broadcast ROOM_STATE so other players stay in sync
    if (session.tableId) {
      broadcastRoomState(session.tableId, roomState, roomSessions, sessions);
    }
    return;
  }

  // Send GAME_STATE for the hand that just acted
  const statePayload = buildGameStatePayload(game, playerChips, msg.seatIndex);
  gameService.cacheStatePayload(game.gameId, statePayload);
  sendJson(ws, statePayload);

  // If turn moved to another of this player's slots, push its GAME_STATE too
  if (session.tableId) {
    const room = gameService.getRoom(session.tableId);
    if (room && room.roomStatus === "PLAYING") {
      const nextSeatKey = room.turnOrder[room.activeTurnIndex];
      if (nextSeatKey !== undefined) {
        const nextIdx = parseInt(nextSeatKey, 10);
        const entry = room.slots.get(nextIdx);
        const nextGame = entry?.playerState.game;
        if (
          entry &&
          entry.playerState.playerId === playerId &&
          nextGame &&
          nextGame.status === "PLAYER_TURN"
        ) {
          const nextPayload = buildGameStatePayload(nextGame, playerChips, nextIdx);
          gameService.cacheStatePayload(nextGame.gameId, nextPayload);
          sendJson(ws, nextPayload);
        }
      }
    }
  }

  // Broadcast ROOM_STATE to everyone at the table
  if (session.tableId) {
    broadcastRoomState(session.tableId, roomState, roomSessions, sessions);
  }
}
