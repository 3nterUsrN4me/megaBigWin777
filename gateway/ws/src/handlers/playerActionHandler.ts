import { sendError, sendJson } from "../errors/errorHandler.js";
import { buildGameStatePayload } from "../gameService/InMemoryGameService.js";
import type { PlayerActionMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles PLAYER_ACTION (HIT | STAND | DOUBLE_DOWN).
 *
 * Idempotency per ARCHITECTURE.md §7:
 *  - If the idempotencyKey matches the last stored key → return the cached GAME_STATE.
 *  - Otherwise → process the action, update game state, cache the new GAME_STATE.
 *
 * After applying the action, broadcasts the updated GAME_STATE to the client.
 * (v1 is single-player per table, so "broadcast" == send to the one connected player.)
 */
export function handlePlayerAction(
  msg: PlayerActionMessage,
  ctx: WsHandlerContext
): void {
  const { session, gameService } = ctx;
  const { ws, playerId } = session;

  const actionResult = gameService.applyAction({
    gameId: msg.gameId,
    playerId,
    action: msg.action,
    idempotencyKey: msg.idempotencyKey,
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

  const { game, playerChips, wasIdempotent } = actionResult;

  if (wasIdempotent && game.cachedStatePayload !== null) {
    // Return the cached response without re-processing
    sendJson(ws, game.cachedStatePayload);
    return;
  }

  // Build and cache the GAME_STATE payload
  const statePayload = buildGameStatePayload(game, playerChips);
  gameService.cacheStatePayload(game.gameId, statePayload);

  sendJson(ws, statePayload);
}
