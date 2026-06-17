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

// ─── Room state machine ───────────────────────────────────────────────────────

/**
 * 4-state room machine (mirrors contracts/domain.ts RoomStatus).
 *
 *  WAITING_FOR_PLAYERS → BETTING → PLAYING → ROUND_OVER
 */
export type RoomStatus =
  | "WAITING_FOR_PLAYERS"
  | "BETTING"
  | "PLAYING"
  | "ROUND_OVER";

/** Per-seat state visible to everyone at the table */
export interface RoomPlayerState {
  /** Seat index as string, e.g. "0"–"4" */
  seatKey:       string;
  seatIndex:     number;
  playerId:      string;
  username:      string;
  hand:          Hand | null;
  betAmount:     number;
  hasBet:        boolean;
  result:        GameResult;
  chips:         number;
  isActivePlayer: boolean;
  hasTurnEnded:  boolean;
  /** false = disconnected but within 30s grace period; seat is held */
  isOnline:      boolean;
}

// ─── WebSocket protocol messages: Client → Server ────────────────────────────

/** Phase 1 — join a table without a bet yet */
export interface JoinRoomMsg {
  event:   "JOIN_ROOM";
  v:       "1";
  tableId: string;
}

/** Phase 1b — occupy a specific slot by index (Multi-Hand) */
export interface JoinSlotMsg {
  event:     "JOIN_SLOT";
  v:         "1";
  tableId:   string;
  seatIndex: number;
}

/** Phase 2 — place bet after sitting down */
export interface PlaceBetMsg {
  event:      "PLACE_BET";
  v:          "1";
  tableId:    string;
  betAmount:  number;
  /**
   * Required for Multi-Hand: targets a specific slot (0–4).
   */
  seatIndex: number;
}

/** Reconnect after page refresh / network drop */
export interface ReconnectMsg {
  event:   "RECONNECT";
  v:       "1";
  tableId: string;
}

/** Legacy single-message join+bet */
export interface JoinGameMsg {
  event:     "JOIN_GAME";
  v:         "1";
  tableId:   string;
  betAmount: number;
}

export interface PlayerActionMsg {
  event:          "PLAYER_ACTION";
  v:              "1";
  gameId:         string;
  action:         PlayerActionType;
  idempotencyKey: string;
  /**
   * Which Multi-Hand slot this action targets (0–4).
   */
  seatIndex:     number;
}

export interface LeaveGameMsg {
  event:   "LEAVE_GAME";
  v:       "1";
  tableId: string;
}

export interface PingMsg {
  event:     "PING";
  v:         "1";
  timestamp: number;
}

// ─── WebSocket protocol messages: Server → Client ────────────────────────────

/** Response to JOIN_ROOM / JOIN_GAME */
export interface RoomAckMsg {
  event:      "ROOM_ACK";
  v:          "1";
  tableId:    string;
  playerId:   string;
  roomStatus: RoomStatus;
  minBet:     number;
  maxBet:     number;
}

/** Response to RECONNECT */
export interface ReconnectAckMsg {
  event:       "RECONNECT_ACK";
  v:           "1";
  tableId:     string;
  playerId:    string;
  roomStatus:  RoomStatus;
  minBet:      number;
  maxBet:      number;
  playerChips: number;
}

/** Sent to all players when reconnect fails — client should JOIN_ROOM instead */
export interface ReconnectFailedMsg {
  event:   "RECONNECT_FAILED";
  v:       "1";
  tableId: string;
  reason:  string;
}

/** Legacy JOIN_ACK — kept for backward compat */
export interface JoinAckMsg {
  event:     "JOIN_ACK";
  v:         "1";
  gameId:    string;
  tableId:   string;
  playerId:  string;
  sessionId: string;
  minBet:    number;
  maxBet:    number;
}

export interface DealMsg {
  event:      "DEAL";
  v:          "1";
  gameId:     string;
  seatIndex?: number;
  playerHand: Hand;
  dealerHand: Hand;
}

export interface GameStateMsg {
  event:            "GAME_STATE";
  v:                "1";
  gameId:           string;
  /** Which slot (0–4) this state belongs to — required for Multi-Hand */
  seatIndex?:       number;
  status:           GameStatus;
  playerHand:       Hand;
  dealerHand:       Hand;
  betAmount:        number;
  result:           GameResult;
  availableActions: PlayerActionType[];
  playerChips:      number;
}

/** Broadcast to all players — full table snapshot */
export interface RoomStateMsg {
  event:         "ROOM_STATE";
  v:             "1";
  tableId:       string;
  roomStatus:    RoomStatus;
  activePlayerId: string | null;
  dealerHand:    Hand | null;
  players:       Record<string, RoomPlayerState>;
  turnOrder:     string[];
  minBet:        number;
  maxBet:        number;
}

export interface ErrorMsg {
  event:    "ERROR";
  v:        "1";
  code:     string;
  message:  string;
  gameId?:  string;
}

export interface HeartbeatMsg {
  event:      "HEARTBEAT";
  v:          "1";
  serverTime: number;
  gameId?:    string;
  status?:    GameStatus;
}

export interface PongMsg {
  event:     "PONG";
  v:         "1";
  timestamp: number;
}

export type ServerMessage =
  | RoomAckMsg
  | ReconnectAckMsg
  | ReconnectFailedMsg
  | JoinAckMsg
  | DealMsg
  | GameStateMsg
  | RoomStateMsg
  | ErrorMsg
  | HeartbeatMsg
  | PongMsg;

// ─── Table slot model ─────────────────────────────────────────────────────────

/** Fixed seat at the table (always exactly TABLE_SLOTS_COUNT of them) */
export interface TableSlot {
  /** 0-based index (0 = leftmost seat) */
  index:      number;
  /** null = empty seat */
  playerId:   string | null;
  username:   string;
  chips:      number;
  betAmount:  number;
  hasBet:     boolean;
  hand:       Hand | null;
  result:     GameResult;
  isActivePlayer: boolean;
  hasTurnEnded:   boolean;
  /** true = this is the local player's own seat */
  isSelf:     boolean;
  /** true = seat is empty AND the room allows joining (WAITING_FOR_PLAYERS or BETTING) */
  isJoinable: boolean;
  /** false = player disconnected but within grace period (seat held for 30s) */
  isOnline:   boolean;
  /** gameId for this slot's hand — used when sending PLAYER_ACTION */
  gameId:     string | null;
}

export const TABLE_SLOTS_COUNT = 5;

// ─── Internal client state ────────────────────────────────────────────────────

/** Betting status of a single self-owned slot — used by PLACE_BET multi-hand flow */
export interface SelfSeatBetState {
  seatIndex: number;
  hasBet:    boolean;
}

export interface GameState {
  gameId:           string | null;
  tableId:          string | null;
  /** Personal game status (PLAYER_TURN, FINISHED etc.) */
  status:           GameStatus | null;
  playerHand:       Hand | null;
  dealerHand:       Hand | null;
  betAmount:        number;
  result:           GameResult;
  availableActions: PlayerActionType[];
  playerChips:      number;
  minBet:           number;
  maxBet:           number;
  /** Other players at the table (excludes self) */
  otherPlayers:     Record<string, RoomPlayerState>;
  activePlayerId:   string | null;
  /** Phase of the room state machine */
  roomStatus:       RoomStatus | null;
  turnOrder:        string[];
  /** Whether ALL of this player's own slots have placed a bet this round */
  hasBet:           boolean;
  /** Fixed 5-slot map of the table — source of truth for table rendering */
  slots:            TableSlot[];
  /**
   * Which of the player's own seats is currently the "active" one whose
   * GAME_STATE we last received. Used to populate `seatIndex` in PLAYER_ACTION
   * so the server knows which Multi-Hand seat to advance.
   */
    activeSeatIndex:  number | null;
  /**
   * Betting state per self-owned slot. Updated on every ROOM_STATE.
   * Used by the PLACE_BET flow to send one message per un-bet slot.
   */
  mySeatsBetting:   SelfSeatBetState[];
  /** Slot targeted by the next PLACE_BET click (0–4) */
  selectedBetSlotIndex: number | null;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
