import { sendError, sendJson } from "../errors/errorHandler.js";
import { buildGameStatePayload, buildRoomStatePayload } from "../gameService/InMemoryGameService.js";
import type { JoinRoomMessage } from "../parser/schemas.js";
import type { ClientSession, WsHandlerContext } from "../types.js";

/**
 * Handles JOIN_ROOM — Phase 1 of the room state machine.
 *
 * Happy path:
 *   1. joinRoom() seats the player; WAITING_FOR_PLAYERS → BETTING (first player)
 *      or BETTING → BETTING (subsequent players) or idempotent re-seat.
 *   2. Register sessionId in roomSessions map for future broadcasts.
 *   3. Send ROOM_ACK + ROOM_STATE directly to the joining player (no "void" window).
 *   4. Broadcast ROOM_STATE to all other existing players so they see the new seat.
 *
 * Auto-reconnect path (room is in PLAYING / ROUND_OVER):
 *   Instead of rejecting with an error we transparently call reconnect() so a
 *   refreshed browser window is never left in a blank state ("bricked").
 *
 * Security note: playerId comes from the verified JWT — never from the message body.
 */
export function handleJoinRoom(
  msg: JoinRoomMessage,
  ctx: WsHandlerContext,
): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  // ── Check if room is in a state that needs reconnect instead ──────────────
  const existingRoom = gameService.getRoom(msg.tableId);
  if (existingRoom && (existingRoom.roomStatus === "PLAYING" || existingRoom.roomStatus === "ROUND_OVER")) {
    // Transparent auto-reconnect: player refreshed browser during active round
    _handleAutoReconnect(msg.tableId, ctx);
    return;
  }

  // ── Normal join ───────────────────────────────────────────────────────────
  const result = gameService.joinRoom({
    tableId:  msg.tableId,
    playerId,
    username: session.username,
    socketId: sessionId,
  });

  if (!result.ok) {
    sendError(ws, result.code as "INVALID_ACTION" | "TABLE_FULL", result.message);
    return;
  }

  // Attach session to this table
  session.tableId = msg.tableId;

  // Register in room broadcast map BEFORE sending anything, so the joining
  // player is included in all subsequent broadcasts.
  let sids = roomSessions.get(msg.tableId);
  if (!sids) { sids = new Set(); roomSessions.set(msg.tableId, sids); }
  sids.add(sessionId);

  // 1. Personal ROOM_ACK — minimal confirmation
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

  // 2. Send ROOM_STATE directly to the joining player first.
  //    This guarantees they immediately see the full table snapshot even if the
  //    subsequent broadcast is slightly delayed (e.g. other sessions processing).
  sendJson(ws, result.roomState);

  // 3. Broadcast updated ROOM_STATE to everyone else at the table (they need
  //    to see the new seat appear). Because sessionId is already in sids, the
  //    joining player will receive a second ROOM_STATE — the client store is
  //    idempotent so this is harmless and ensures consistency.
  broadcastRoomState(msg.tableId, result.roomState, roomSessions, sessions);
}

// ─── Auto-reconnect for players joining a room mid-round ─────────────────────

/**
 * Called when a JOIN_ROOM arrives for a table that is already PLAYING/ROUND_OVER.
 * Delegates to gameService.reconnect() which does not change room state.
 * Sends RECONNECT_ACK + ROOM_STATE + optional GAME_STATE to the joining client,
 * then broadcasts ROOM_STATE to others so they see the returning player.
 */
function _handleAutoReconnect(tableId: string, ctx: WsHandlerContext): void {
  const { session, gameService, sessions, roomSessions } = ctx;
  const { ws, playerId, sessionId } = session;

  const result = gameService.reconnect({
    tableId,
    playerId,
    username: session.username,
    socketId: sessionId,
  });

  // Re-seat the session regardless of reconnect result
  session.tableId = tableId;
  let sids = roomSessions.get(tableId);
  if (!sids) { sids = new Set(); roomSessions.set(tableId, sids); }
  sids.add(sessionId);

  if (!result.ok) {
    // Room exists but player wasn't seated — send current ROOM_STATE as a spectator view
    // This prevents a blank screen even in the edge case.
    const room = gameService.getRoom(tableId);
    if (room) {
      const roomState = buildRoomStatePayload(room, room.roomStatus === "ROUND_OVER");
      sendJson(ws, {
        event:       "RECONNECT_ACK",
        v:           "1",
        tableId,
        playerId,
        roomStatus:  roomState.roomStatus,
        minBet:      roomState.minBet,
        maxBet:      roomState.maxBet,
        playerChips: gameService.getPlayerChips(playerId),
      });
      sendJson(ws, roomState);
    } else {
      sendError(ws, "GAME_NOT_FOUND", result.message);
    }
    return;
  }

  // Update gameId on session if a game exists
  if (result.game) session.gameId = result.game.gameId;

  // RECONNECT_ACK + full snapshot
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

  // Personal GAME_STATE if in active round
  if (result.game) {
    const statePayload = buildGameStatePayload(result.game, result.playerChips);
    sendJson(ws, statePayload);
  }

  // Notify other players
  broadcastRoomState(tableId, result.roomState, roomSessions, sessions);
}

// ─── Broadcast helper (shared across handlers) ────────────────────────────────

/**
 * Sends `roomState` to every open WebSocket in `roomSessions[tableId]`.
 * Prunes stale entries (disconnected sessions without cleanup).
 */
export function broadcastRoomState(
  tableId:      string,
  roomState:    object,
  roomSessions: Map<string, Set<string>>,
  sessions:     Map<string, ClientSession>,
): void {
  const sids = roomSessions.get(tableId);
  if (!sids) return;

  for (const sid of sids) {
    const sess = sessions.get(sid);
    if (!sess) { sids.delete(sid); continue; }
    if (sess.ws.readyState === 1 /* WebSocket.OPEN */) {
      sendJson(sess.ws, roomState);
    }
  }
}

