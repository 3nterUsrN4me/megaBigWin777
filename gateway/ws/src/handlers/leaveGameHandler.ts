import { sendJson } from "../errors/errorHandler.js";
import type { LeaveGameMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles LEAVE_GAME.
 *
 * Disassociates the game from the session.
 * The game record is kept in memory for potential state recovery (F-08).
 * In production, the game-service would archive the round to the DB.
 */
export function handleLeaveGame(
  msg: LeaveGameMessage,
  ctx: WsHandlerContext
): void {
  const { session } = ctx;

  if (session.gameId !== msg.gameId) {
    // Player is not in this game — silently ignore to avoid information leakage
    return;
  }

  session.gameId = null;

  // Acknowledge the leave so the client can clean up its state
  sendJson(session.ws, {
    event: "GAME_STATE",
    v: "1",
    gameId: msg.gameId,
    status: "FINISHED",
    playerHand: { cards: [], value: 0, isSoft: false, isBust: false, isBlackjack: false },
    dealerHand: { cards: [], value: 0, isSoft: false, isBust: false, isBlackjack: false },
    betAmount: 0,
    result: null,
    availableActions: [],
    playerChips: ctx.gameService.getPlayerChips(session.playerId),
  });
}
