import type { WebSocket } from "ws";
import type { Card, GameResult, GameStatus, PlayerActionType } from "../../../contracts/domain.js";

// ─── In-memory game state ────────────────────────────────────────────────────

export interface InMemoryGame {
  gameId: string;
  tableId: string;
  playerId: string;
  status: GameStatus;
  playerHand: Card[];
  dealerHand: Card[];
  deckState: Card[];
  betAmount: number;
  result: GameResult;
  deckSeed: string;
  lastIdempotencyKey: string | null;
  cachedStatePayload: Record<string, unknown> | null;
  updatedAt: string;
}

// ─── Client session ──────────────────────────────────────────────────────────

export interface ClientSession {
  sessionId: string;
  playerId: string;
  ws: WebSocket;
  gameId: string | null;
  lastPingAt: number;
}

// ─── Application context (shared across the request lifecycle) ────────────────

export interface AppContext {
  sessions: Map<string, ClientSession>;
  games: Map<string, InMemoryGame>;
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

export interface WsHandlerContext {
  session: ClientSession;
  gameService: import("./gameService/InMemoryGameService.js").InMemoryGameService;
  sessions: Map<string, ClientSession>;
}

export { Card, GameResult, GameStatus, PlayerActionType };
