import type { WebSocket } from "ws";
import type { Card, GameResult, GameStatus, PlayerActionType } from "../../../contracts/domain.js";
import type { DbGameService } from "./gameService/DbGameService.js";

export interface ClientSession {
  sessionId: string;
  playerId:  string;
  username:  string;
  ws:        WebSocket;
  tableId:   string | null;
  gameId:    string | null;
  lastPingAt: number;
}

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
  session:      ClientSession;
  gameService:  DbGameService;
  sessions:     Map<string, ClientSession>;
  roomSessions: Map<string, Set<string>>;
}

export { Card, GameResult, GameStatus, PlayerActionType };
