import { sendError, sendJson } from "../errors/errorHandler.js";
import { buildGameStatePayload, cardsToHand, revealDealerHand } from "../gameService/InMemoryGameService.js";
import type { JoinGameMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

/**
 * Handles JOIN_GAME.
 *
 * Flow per ARCHITECTURE.md §3:
 *  1. Create game (bet deducted, deck shuffled, initial cards dealt)
 *  2. Send JOIN_ACK with game metadata
 *  3. Send DEAL with the initial hands
 *  4. If immediate blackjack → send GAME_STATE (FINISHED) right away
 */
export function handleJoinGame(
  msg: JoinGameMessage,
  ctx: WsHandlerContext
): void {
  const { session, gameService } = ctx;
  const { ws, playerId, sessionId } = session;

  const createResult = gameService.createGame({
    tableId: msg.tableId,
    playerId,
    betAmount: msg.betAmount,
  });

  if (!createResult.ok) {
    sendError(ws, createResult.code as "INSUFFICIENT_CHIPS" | "INVALID_ACTION", createResult.message);
    return;
  }

  const { game, playerChips, minBet, maxBet } = createResult;

  // Associate the game with this session so future messages can locate it
  session.gameId = game.gameId;

  // 1. JOIN_ACK
  sendJson(ws, {
    event: "JOIN_ACK",
    v: "1",
    gameId: game.gameId,
    tableId: game.tableId,
    playerId: game.playerId,
    sessionId,
    minBet,
    maxBet,
  });

  // 2. DEAL — initial hands (dealer hole card stays hidden)
  const playerHandForDeal = cardsToHand(game.playerHand);
  const dealerHandForDeal = cardsToHand(game.dealerHand);  // hole card is already marked hidden

  sendJson(ws, {
    event: "DEAL",
    v: "1",
    gameId: game.gameId,
    playerHand: playerHandForDeal,
    dealerHand: dealerHandForDeal,
  });

  // 3. If immediate blackjack, reveal dealer hand and send final GAME_STATE
  if (game.status === "FINISHED") {
    const finalDealerHand = cardsToHand(revealDealerHand(game.dealerHand));
    sendJson(ws, {
      event: "GAME_STATE",
      v: "1",
      gameId: game.gameId,
      status: "FINISHED",
      playerHand: playerHandForDeal,
      dealerHand: finalDealerHand,
      betAmount: game.betAmount,
      result: game.result,
      availableActions: [],
      playerChips,
    });
  }
}
