import { sendError, sendJson } from "../errors/errorHandler.js";
import { gameStateViewToPayload } from "../wsPayloads.js";
import { broadcastRoomState } from "./joinRoomHandler.js";
import type { PlayerActionMessage } from "../parser/schemas.js";
import type { WsHandlerContext } from "../types.js";

export async function handlePlayerAction(
  msg: PlayerActionMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId } = session;

  if (msg.seatIndex === undefined) {
    sendError(ws, "INVALID_ACTION", "seatIndex is required for PLAYER_ACTION");
    return;
  }

  let actionResult;
  try {
    actionResult = await gameService.applyAction({
      gameId: msg.gameId,
      playerId,
      action: msg.action,
      idempotencyKey: msg.idempotencyKey,
      slotIndex: msg.seatIndex,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to process action", msg.gameId);
    return;
  }

  if (!actionResult.ok) {
    sendError(
      ws,
      actionResult.code,
      actionResult.message,
      msg.gameId,
    );
    return;
  }

  const { game, wasIdempotent, roomState } = actionResult;

  const statePayload = gameStateViewToPayload(game, msg.seatIndex);
  sendJson(ws, statePayload);

  if (session.tableId) {
    const room = gameService.getRoom(session.tableId);
    if (room && room.roomStatus === "PLAYING" && !wasIdempotent) {
      const nextSeatKey = room.turnOrder[room.activeTurnIndex];
      if (nextSeatKey !== undefined) {
        const nextIdx = parseInt(nextSeatKey, 10);
        const entry = room.slots.get(nextIdx);
        if (
          entry &&
          entry.playerState.playerId === playerId &&
          entry.playerState.gameId
        ) {
          const seats = await gameService.getPlayerSeats(session.tableId, playerId);
          const nextSeat = seats.find((s) => s.seatIndex === nextIdx);
          if (nextSeat?.game && nextSeat.game.status === "PLAYER_TURN") {
            sendJson(ws, gameStateViewToPayload(nextSeat.game, nextIdx));
          }
        }
      }
    }

    broadcastRoomState(session.tableId, roomState, roomSessions, sessions);
  }
}
