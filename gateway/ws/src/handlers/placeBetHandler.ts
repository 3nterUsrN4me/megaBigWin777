import { sendError, sendJson } from "../errors/errorHandler.js";
import {
  buildGameStatePayload,
  buildRoomStatePayload,
  cardsToHand,
  revealDealerHand,
} from "../gameService/InMemoryGameService.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { PlaceBetMessage } from "../parser/schemas.js";
import type { ClientSession, WsHandlerContext } from "../types.js";
import type { Card } from "../../../contracts/domain.js";

/**
 * Handles PLACE_BET — Phase 2 of the room state machine.
 *
 * Flow:
 *  1. Record the bet for this player.
 *  2. Broadcast ROOM_STATE so all clients can see who has bet.
 *  3. If all seated players have now bet → cards are dealt automatically:
 *       - Each player receives their personal DEAL + GAME_STATE.
 *       - Everyone receives ROOM_STATE (now in PLAYING status).
 *
 * Guards (enforced in GameService):
 *  - Room must be in BETTING state.
 *  - Player must be seated (JOIN_ROOM sent first).
 *  - betAmount ∈ [TABLE_MIN_BET, TABLE_MAX_BET].
 *  - Player must have enough chips.
 *  - Duplicate bet for same round is idempotent (same amount) or rejected (different amount).
 */
export function handlePlaceBet(
  msg: PlaceBetMessage,
  ctx: WsHandlerContext,
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId } = session;

  const result = gameService.placeBet({
    tableId:   msg.tableId,
    playerId,
    betAmount: msg.betAmount,
    slotIndex: msg.seatIndex,
  });

  if (!result.ok) {
    sendError(
      ws,
      result.code as "INVALID_ACTION" | "INSUFFICIENT_CHIPS" | "INTERNAL_ERROR",
      result.message,
    );
    return;
  }

  // Ensure session is associated with this table
  if (!session.tableId) {
    session.tableId = msg.tableId;
  }

  // Broadcast updated ROOM_STATE (bets visible to everyone)
  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);

  // If the round just started (all bets placed → cards dealt), push personal hands
  // then send the final PLAYING ROOM_STATE so every client transitions phase.
  if (result.roundStarted) {
    _sendDealtCardsToRoom(msg.tableId, roomSessions, sessions, gameService);

    // Re-fetch room state now that it is PLAYING (cards dealt, dealer set)
    const room = gameService.getRoom(msg.tableId);
    if (room) {
      const playingRoomState = buildRoomStatePayload(room);
      // Direct broadcast to all — ensures no client gets stuck in BETTING phase
      broadcastRoomState(msg.tableId, playingRoomState, roomSessions, sessions);
    }
  }
}

// ─── Deal broadcast ───────────────────────────────────────────────────────────

/**
 * After cards are dealt, send each player their personal DEAL + GAME_STATE.
 * Called only when placeBet() transitioned the room to PLAYING.
 */
function _sendDealtCardsToRoom(
  tableId:      string,
  roomSessions: Map<string, Set<string>>,
  sessions:     Map<string, ClientSession>,
  gameService:  WsHandlerContext["gameService"],
): void {
  const sids = roomSessions.get(tableId);
  if (!sids) return;

  const room = gameService.getRoom(tableId);
  if (!room) return;

  for (const sid of sids) {
    const sess = sessions.get(sid);
    if (!sess || sess.ws.readyState !== 1) continue;

    const { playerId } = sess;
    const playerChips = gameService.getPlayerChips(playerId);

    // Find ALL seats belonging to this player (Multi-Hand support)
    const playerSeats = gameService.getPlayerSeats(tableId, playerId);
    if (playerSeats.length === 0) continue;

    const primarySeat = playerSeats.find((s) => s.game !== null);
    if (primarySeat?.game) sess.gameId = primarySeat.game.gameId;

    for (const slot of playerSeats) {
      const game = slot.game;
      if (!game) continue;

      const dealerCardsForDeal: Card[] = game.dealerHand.map((c) =>
        c.hidden ? { suit: "SPADES", rank: "2", hidden: true } : c
      );

      sendJson(sess.ws, {
        event:      "DEAL",
        v:          "1",
        gameId:     game.gameId,
        seatIndex:  slot.seatIndex,
        playerHand: cardsToHand(game.playerHand),
        dealerHand: cardsToHand(dealerCardsForDeal),
      });

      const statePayload = buildGameStatePayload(game, playerChips, slot.seatIndex);
      gameService.cacheStatePayload(game.gameId, statePayload);
      sendJson(sess.ws, statePayload);

      if (game.status === "FINISHED") {
        sendJson(sess.ws, {
          event:            "GAME_STATE",
          v:                "1",
          gameId:           game.gameId,
          seatIndex:        slot.seatIndex,
          status:           "FINISHED",
          playerHand:       cardsToHand(game.playerHand),
          dealerHand:       cardsToHand(revealDealerHand(game.dealerHand)),
          betAmount:        game.betAmount,
          result:           game.result,
          availableActions: [],
          playerChips,
        });
      }
    }
  }
}
