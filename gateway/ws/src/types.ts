import type { WebSocket } from "ws";
import type { Card, GameResult, GameStatus, PlayerActionType } from "../../../contracts/domain.js";

// ─── Client session ──────────────────────────────────────────────────────────

/**
 * Per-connection session. Populated at WS handshake and mutated by handlers.
 *
 * `tableId` tracks which room the player is sitting at (null = in lobby).
 * `gameId`  tracks the active game within that round (null = no round started).
 */
export interface ClientSession {
  sessionId: string;
  playerId:  string;
  username:  string;
  ws:        WebSocket;
  /** Set by JOIN_ROOM / RECONNECT; cleared by LEAVE_GAME or disconnect */
  tableId:   string | null;
  /** Set when cards are dealt (PLACE_BET transitions room to PLAYING) */
  gameId:    string | null;
  lastPingAt: number;
}

// ─── WS outbound message helpers ─────────────────────────────────────────────

export type ErrorCode =
  | "INVALID_ACTION"
  | "INSUFFICIENT_CHIPS"
  | "TABLE_FULL"
  | "GAME_NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_MESSAGE"
  | "PROTOCOL_VERSION_MISMATCH"
  | "INTERNAL_ERROR";

/**
 * Handler context — everything a handler needs, injected at dispatch time.
 *
 * `roomSessions` maps tableId → Set<sessionId> and is the source of truth
 * for per-room ROOM_STATE broadcasts.
 */
export interface WsHandlerContext {
  session:      ClientSession;
  gameService:  import("./gameService/InMemoryGameService.js").InMemoryGameService;
  sessions:     Map<string, ClientSession>;
  roomSessions: Map<string, Set<string>>;
}

export { Card, GameResult, GameStatus, PlayerActionType };
