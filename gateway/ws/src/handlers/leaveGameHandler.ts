import { sendJson } from "../errors/errorHandler.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { LeaveGameMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export async function handleLeaveGame(
  msg: LeaveGameMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const tableId = msg.tableId;

  if (session.tableId !== tableId) {
    return;
  }

  const chips = await gameService.getPlayerChips(session.playerId);

  const { roomState } = await gameService.leaveRoom({
    tableId,
    playerId: session.playerId,
  });

  const oldGameId = session.gameId;
  session.gameId = null;
  session.tableId = null;

  const sids = roomSessions.get(tableId);
  if (sids) {
    sids.delete(session.sessionId);
    if (sids.size === 0) roomSessions.delete(tableId);
  }

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

  if (roomState) {
    broadcastRoomState(tableId, roomState, roomSessions, sessions);
  }
}
