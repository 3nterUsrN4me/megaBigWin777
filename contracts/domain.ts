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

// ─── Multiplayer — maszyna stanów pokoju ─────────────────────────────────────

/**
 * 4-stanowa maszyna stanów pokoju wieloosobowego.
 *
 *  WAITING_FOR_PLAYERS ──► (>=1 gracz dołącza) ──► BETTING
 *  BETTING             ──► (wszyscy postawili zakłady) ──► PLAYING
 *  PLAYING             ──► (wszyscy gracze skończyli tury + dealer) ──► ROUND_OVER
 *  ROUND_OVER          ──► (nowa runda lub reset) ──► WAITING_FOR_PLAYERS
 *
 * Przejścia dozwolone tylko w podanej kolejności; dowolna akcja poza dozwolonym
 * stanem zwraca INVALID_ACTION.
 */
export type RoomStatus =
  | "WAITING_FOR_PLAYERS"  // pokój istnieje, czeka na graczy
  | "BETTING"              // gracze siedzą, powinni postawić zakłady
  | "PLAYING"              // runda w toku — tury graczy i dealera
  | "ROUND_OVER";          // runda zakończona — wyniki znane, oczekiwanie na nową

/**
 * Przejścia dozwolone per zdarzenie (dokumentacja — nie runtime guard tutaj).
 *
 *  JOIN_ROOM  : WAITING_FOR_PLAYERS → BETTING  (gdy >=1 gracza)
 *  PLACE_BET  : BETTING → BETTING (kolejny zakład) | BETTING → PLAYING (ostatni zakład)
 *  PLAYER_ACTION: PLAYING → PLAYING | PLAYING → ROUND_OVER
 *  JOIN_ROOM  : ROUND_OVER → WAITING_FOR_PLAYERS (nowa runda) lub RECONNECT
 */
export type RoomTransition =
  | { from: "WAITING_FOR_PLAYERS"; event: "PLAYER_JOINED";  to: "BETTING"              }
  | { from: "BETTING";             event: "BET_PLACED";     to: "BETTING"              }
  | { from: "BETTING";             event: "ALL_BETS_IN";    to: "PLAYING"              }
  | { from: "PLAYING";             event: "TURN_ADVANCED";  to: "PLAYING"              }
  | { from: "PLAYING";             event: "ROUND_FINISHED"; to: "ROUND_OVER"           }
  | { from: "ROUND_OVER";          event: "NEXT_ROUND";     to: "WAITING_FOR_PLAYERS"  };

/**
 * Stan pojedynczego miejsca przy stole (widoczny dla wszystkich w pokoju).
 *
 * Jeden gracz może zajmować wiele slotów (Multi-Hand).
 * Kluczem w `RoomState.players` jest `seatKey = "${seatIndex}"` (0–4).
 */
export interface RoomPlayerState {
  /** Unikalny klucz miejsca: indeks slotu 0–4 jako string */
  seatKey: string;
  /** Index slotu (0–4) — pozycja na stole od lewej */
  seatIndex: number;
  playerId: string;
  username: string;
  hand: Hand | null;
  betAmount: number;
  /** true = gracz złożył zakład w fazie BETTING */
  hasBet: boolean;
  result: GameResult;
  chips: number;
  isActivePlayer: boolean;
  hasTurnEnded: boolean;
  /** false = gracz rozłączony ale wciąż w grace period (30 s) */
  isOnline: boolean;
}

/**
 * Pełny stan pokoju rozsyłany broadcastem do wszystkich przy stole.
 */
export interface RoomState {
  event: "ROOM_STATE";
  v: "1";
  tableId: string;
  roomStatus: RoomStatus;
  /** seatKey aktywnego gracza (null gdy dealer lub między rundami) */
  activePlayerId: string | null;
  /** Ręka krupiera — hole card ukryta podczas PLAYING; pełna w ROUND_OVER */
  dealerHand: Hand | null;
  /** Klucz: seatKey ("0"–"4"). Jeden playerId może mieć wiele wpisów (Multi-Hand). */
  players: Record<string, RoomPlayerState>;
  turnOrder: string[];
  minBet: number;
  maxBet: number;
}
