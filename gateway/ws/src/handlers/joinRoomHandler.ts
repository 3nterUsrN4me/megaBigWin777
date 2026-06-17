import { sendError, sendJson } from "../errors/errorHandler.js";
import { gameStateViewToPayload } from "../wsPayloads.js";
import type { JoinRoomMessage } from "../parser/schemas.js";
import type { ClientSession, WsHandlerContext } from "../types.js";

export async function handleJoinRoom(
  msg: JoinRoomMessage,
  ctx: WsHandlerContext,
): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  const existingRoom = gameService.getRoom(msg.tableId);
  if (existingRoom && (existingRoom.roomStatus === "PLAYING" || existingRoom.roomStatus === "ROUND_OVER")) {
    await _handleAutoReconnect(msg.tableId, ctx);
    return;
  }

  let result;
  try {
    result = await gameService.joinRoom({
      tableId: msg.tableId,
      playerId,
      username: session.username,
      socketId: sessionId,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to join room");
    return;
  }

  if (!result.ok) {
    sendError(ws, result.code, result.message);
    return;
  }

  session.tableId = msg.tableId;

  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(sessionId);

  sendJson(ws, {
    event:      "ROOM_ACK",
    v:          "1",
    tableId:    msg.tableId,
    playerId,
    seatIndex:  result.seatIndex,
    roomStatus: result.roomState.roomStatus,
    minBet:     result.minBet,
    maxBet:     result.maxBet,
  });

  sendJson(ws, result.roomState);
  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);
}

async function _handleAutoReconnect(tableId: string, ctx: WsHandlerContext): Promise<void> {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  let result;
  try {
    result = await gameService.reconnect({
      tableId,
      playerId,
      username: session.username,
      socketId: sessionId,
    });
  } catch {
    sendError(ws, "INTERNAL_ERROR", "Failed to reconnect");
    return;
  }

  session.tableId = tableId;
  let sids = roomSessions.get(tableId);
  if (!sids) { sids = new Set(); roomSessions.set(tableId, sids); }
  sids.add(sessionId);

  if (!result.ok) {
    const room = gameService.getRoom(tableId);
    if (room) {
      const roomState = await gameService.buildRoomState(room, room.roomStatus === "ROUND_OVER");
      const playerChips = await gameService.getPlayerChips(playerId);
      sendJson(ws, {
        event:       "RECONNECT_ACK",
        v:           "1",
        tableId,
        playerId,
        roomStatus:  roomState.roomStatus,
        minBet:      roomState.minBet,
        maxBet:      roomState.maxBet,
        playerChips,
      });
      sendJson(ws, roomState);
    } else {
      sendError(ws, "GAME_NOT_FOUND", result.message);
    }
    return;
  }

  if (result.game) session.gameId = result.game.gameId;

  sendJson(ws, {
    event:       "RECONNECT_ACK",
    v:           "1",
    tableId,
    playerId,
    roomStatus:  result.roomState.roomStatus,
    minBet:      result.minBet,
    maxBet:      result.maxBet,
    playerChips: result.playerChips,
  });
  sendJson(ws, result.roomState);

  if (result.game) {
    sendJson(ws, gameStateViewToPayload(result.game));
  }

  broadcastRoomState(tableId, result.roomState, roomSessions, sessions);
}

export function broadcastRoomState(
  tableId: string,
  roomState: object,
  roomSessions: Map<string, Set<string>>,
  sessions: Map<string, ClientSession>,
): void {
  const sids = roomSessions.get(tableId);
  if (!sids) return;

  for (const sid of sids) {
    const sess = sessions.get(sid);
    if (!sess) { sids.delete(sid); continue; }
    if (sess.ws.readyState === 1) {
      sendJson(sess.ws, roomState);
    }
  }
}
