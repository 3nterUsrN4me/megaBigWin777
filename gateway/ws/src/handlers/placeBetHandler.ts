import { sendError, sendJson } from "../errors/errorHandler.js";
import { gameStateViewToPayload, buildDealPayload, cardsToHand, revealDealerHand } from "../wsPayloads.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { PlaceBetMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export async function handlePlaceBet(
  msg: PlaceBetMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId } = session;

  let result;
  try {
    result = await gameService.placeBet({
      tableId: msg.tableId,
      playerId,
      betAmount: msg.betAmount,
      slotIndex: msg.seatIndex,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to place bet");
    return;
  }

  if (!result.ok) {
    sendError(ws, result.code, result.message);
    return;
  }

  if (!session.tableId) {
    session.tableId = msg.tableId;
  }

  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);

  if (result.roundStarted) {
    await _sendDealtCardsToRoom(msg.tableId, roomSessions, sessions, gameService);

    const room = gameService.getRoom(msg.tableId);
    if (room) {
      const playingRoomState = await gameService.buildRoomState(room, true);
      broadcastRoomState(msg.tableId, playingRoomState, roomSessions, sessions);
    }
  }
}

async function _sendDealtCardsToRoom(
  tableId: string,
  roomSessions: Map<string, Set<string>>,
  sessions: Map<string, import("../types.js").ClientSession>,
  gameService: WsHandlerContext["gameService"],
): Promise<void> {
  const sids = roomSessions.get(tableId);
  if (!sids) return;

  const room = gameService.getRoom(tableId);
  if (!room) return;

  for (const sid of sids) {
    const sess = sessions.get(sid);
    if (!sess || sess.ws.readyState !== 1) continue;

    const { playerId } = sess;
    const playerSeats = await gameService.getPlayerSeats(tableId, playerId);
    if (playerSeats.length === 0) continue;

    const primarySeat = playerSeats.find((s) => s.game !== null);
    if (primarySeat?.game) sess.gameId = primarySeat.game.gameId;

    for (const slot of playerSeats) {
      const game = slot.game;
      if (!game) continue;

      sendJson(sess.ws, buildDealPayload(game, slot.seatIndex));
      sendJson(sess.ws, gameStateViewToPayload(game, slot.seatIndex));

      if (game.status === "FINISHED") {
        sendJson(sess.ws, {
          event:            "GAME_STATE",
          v:                "1",
          gameId:           game.gameId,
          seatIndex:        slot.seatIndex,
          status:           "FINISHED",
          playerHand:       game.playerHand,
          dealerHand:       cardsToHand(revealDealerHand(game.dealerHand.cards)),
          betAmount:        game.betAmount,
          result:           game.result,
          availableActions: [],
          playerChips:      game.playerChips,
        });
      }
    }
  }
}
