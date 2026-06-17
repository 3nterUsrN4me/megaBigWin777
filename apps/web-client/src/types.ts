// ─── Domain types (mirrors contracts/domain.ts) ──────────────────────────────

export type Suit = "HEARTS" | "DIAMONDS" | "CLUBS" | "SPADES";
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";

export interface Card {
  suit: Suit;
  rank: Rank;
  hidden?: boolean;
}

export interface Hand {
  cards: Card[];
  value: number;
  isSoft: boolean;
  isBust: boolean;
  isBlackjack: boolean;
}

export type GameStatus =
  | "BETTING"
  | "DEALING"
  | "PLAYER_TURN"
  | "DEALER_TURN"
  | "FINISHED";

export type GameResult = "WIN" | "LOSS" | "PUSH" | "BLACKJACK" | null;

export type PlayerActionType = "HIT" | "STAND" | "DOUBLE_DOWN";

// ─── WebSocket protocol messages (v:"1") ─────────────────────────────────────

// Client → Server
export interface JoinGameMsg {
  event: "JOIN_GAME";
  v: "1";
  tableId: string;
  betAmount: number;
}

export interface PlayerActionMsg {
  event: "PLAYER_ACTION";
  v: "1";
  gameId: string;
  action: PlayerActionType;
  idempotencyKey: string;
}

export interface LeaveGameMsg {
  event: "LEAVE_GAME";
  v: "1";
  gameId: string;
}

export interface PingMsg {
  event: "PING";
  v: "1";
  timestamp: number;
}

// Server → Client
export interface JoinAckMsg {
  event: "JOIN_ACK";
  v: "1";
  gameId: string;
  tableId: string;
  playerId: string;
  sessionId: string;
  minBet: number;
  maxBet: number;
}

export interface DealMsg {
  event: "DEAL";
  v: "1";
  gameId: string;
  playerHand: Hand;
  dealerHand: Hand;
}

export interface GameStateMsg {
  event: "GAME_STATE";
  v: "1";
  gameId: string;
  status: GameStatus;
  playerHand: Hand;
  dealerHand: Hand;
  betAmount: number;
  result: GameResult;
  availableActions: PlayerActionType[];
  playerChips: number;
}

export interface ErrorMsg {
  event: "ERROR";
  v: "1";
  code: string;
  message: string;
  gameId?: string;
}

export interface HeartbeatMsg {
  event: "HEARTBEAT";
  v: "1";
  serverTime: number;
  gameId?: string;
  status?: GameStatus;
}

export interface PongMsg {
  event: "PONG";
  v: "1";
  timestamp: number;
}

export type ServerMessage =
  | JoinAckMsg
  | DealMsg
  | GameStateMsg
  | ErrorMsg
  | HeartbeatMsg
  | PongMsg;

// ─── Internal client state ────────────────────────────────────────────────────

export interface GameState {
  gameId: string | null;
  tableId: string | null;
  status: GameStatus | null;
  playerHand: Hand | null;
  dealerHand: Hand | null;
  betAmount: number;
  result: GameResult;
  availableActions: PlayerActionType[];
  playerChips: number;
  minBet: number;
  maxBet: number;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
