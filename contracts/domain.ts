// ─── Karta ────────────────────────────────────────────────────────────────────
export type Suit = "HEARTS" | "DIAMONDS" | "CLUBS" | "SPADES";
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";

export interface Card {
  suit: Suit;
  rank: Rank;
  hidden?: boolean; // true = odwrócona karta dealera
}

// ─── Ręka ─────────────────────────────────────────────────────────────────────
export interface Hand {
  cards: Card[];
  value: number;        // obliczona wartość (ace = 11 lub 1)
  isSoft: boolean;      // true jeśli As liczony jako 11
  isBust: boolean;      // value > 21
  isBlackjack: boolean; // 2 karty, wartość 21
}

// ─── Stan Gry ─────────────────────────────────────────────────────────────────
export type GameStatus =
  | "BETTING"
  | "DEALING"
  | "PLAYER_TURN"
  | "DEALER_TURN"
  | "FINISHED";

export type GameResult = "WIN" | "LOSS" | "PUSH" | "BLACKJACK" | null;

export interface GameState {
  gameId: string;
  tableId: string;
  playerId: string;
  status: GameStatus;
  playerHand: Hand;
  dealerHand: Hand;      // hidden[0] podczas PLAYER_TURN
  betAmount: number;
  result: GameResult;
  deckSeed: string;
  deckRemaining: number; // ile kart zostało w talii
  updatedAt: string;     // ISO 8601
}

// ─── Akcja Gracza ─────────────────────────────────────────────────────────────
export type PlayerActionType = "HIT" | "STAND" | "DOUBLE_DOWN";

export interface PlayerAction {
  type: PlayerActionType;
  idempotencyKey: string; // UUID v4, unikalny per akcja
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
export type TableStatus = "WAITING" | "ACTIVE" | "FINISHED";

export interface TableInfo {
  tableId: string;
  name: string;
  status: TableStatus;
  minBet: number;
  maxBet: number;
  hasPlayer: boolean;
}

// ─── Gracz ────────────────────────────────────────────────────────────────────
export interface PlayerProfile {
  playerId: string;
  username: string;
  chips: number;
}

// ─── Błędy Domenowe ───────────────────────────────────────────────────────────
export interface DomainError {
  code: "BUST" | "INVALID_ACTION" | "GAME_OVER" | "BLACKJACK";
  message: string;
}

export type Result<T, E = DomainError> =
  | { ok: true;  value: T }
  | { ok: false; error: E };
