import { randomUUID } from "node:crypto";
import {
  createDeck,
  applyHit,
  applyStand,
  applyDoubleDown,
  calculateHandValue,
  determineResult,
  calculateChipsDelta,
} from "@megabigwin777/game-core";
import type {
  Card,
  Hand,
  GameResult,
  GameStatus,
  PlayerActionType,
  RoomStatus,
  RoomPlayerState,
  RoomState,
} from "../../../../contracts/domain.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CHIPS   = 1000;
const TABLE_MIN_BET   = 10;
const TABLE_MAX_BET   = 500;
const TABLE_MAX_PLAYERS = 5;
/**
 * Grace period after a WebSocket close before the seat is considered truly
 * abandoned. During this window the player can RECONNECT and resume mid-round.
 * Covers the "Alt-Tab / browser focus loss" disconnect scenario.
 */
const RECONNECT_GRACE_MS = 30_000;

// ─── Internal game types ──────────────────────────────────────────────────────

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

/**
 * Per-slot game state — independent hand, bet, and result (Multi-Hand).
 *
 * `game` is null until cards are dealt (PLAYING phase).
 * `bet`  is null until PLACE_BET is received (BETTING phase).
 */
export interface PlayerState {
  seatIndex: number;   // 0–4 — canonical slot index
  playerId: string;
  username: string;
  chips: number;
  /** Confirmed bet for the current round — null means not bet yet */
  bet: number | null;
  game: InMemoryGame | null;
  /** false = disconnected but within grace period; true = active connection */
  isOnline: boolean;
  /** Date.now() when the socket closed; null if currently online */
  offlineSince: number | null;
}

/** One occupied table slot: socket binding + independent player state */
export interface SlotEntry {
  socketId: string | null;
  playerState: PlayerState;
}

/** Flat view returned to handlers (slot index + socket + state) */
export type OccupiedSlot = PlayerState & { socketId: string | null };

/**
 * Room state machine.
 *
 *  WAITING_FOR_PLAYERS → BETTING    (first player joins any slot)
 *  BETTING             → PLAYING    (every seated slot has placed a bet)
 *  PLAYING             → ROUND_OVER (dealer phase done)
 *  ROUND_OVER          → BETTING    (reset for next round — players keep seats)
 *
 * The deck is allocated once per round at PLAYING transition.
 * Dealer's hand and turnOrder are populated at the same moment.
 */
export interface InMemoryRoom {
  tableId: string;
  roomStatus: RoomStatus;
  /** Shared deck — used during PLAYING */
  deckState: Card[];
  deckSeed: string;
  /** Shared dealer hand */
  dealerHand: Card[];
  /** slotIndex (0–4) → { socketId, playerState }. Each slot has its own hand/result. */
  slots: Map<number, SlotEntry>;
  /**
   * Turn order for the current round.
   * Each entry is a seatKey string ("0"–"4"), matching the map key.
   * Only seats that haven't immediately busted/BJ are included.
   */
  turnOrder: string[];
  activeTurnIndex: number;
}

// ─── Service result types ─────────────────────────────────────────────────────

export type ServiceError = {
  ok: false;
  code: "INSUFFICIENT_CHIPS" | "INVALID_ACTION" | "GAME_NOT_FOUND" | "TABLE_FULL" | "INTERNAL_ERROR";
  message: string;
};

/** Returned from notifyDisconnect() */
export type DisconnectResult =
  | { gracePeriod: true;  tableId: string; expiresAt: number }
  | { gracePeriod: false; tableId: null };

/** Returned from joinRoom() and joinSlot() */
export type JoinRoomOk = {
  ok: true;
  roomState: RoomState;
  /** The seat index this player now occupies */
  seatIndex: number;
  minBet: number;
  maxBet: number;
};

/** Returned from placeBet() */
export type PlaceBetOk = {
  ok: true;
  /** All bets placed → cards dealt; each player's game is now available */
  roundStarted: boolean;
  /** Personal game for this specific seat (null while still BETTING) */
  game: InMemoryGame | null;
  /** Slot index (0–4) this bet was placed for */
  slotIndex: number;
  playerChips: number;
  roomState: RoomState;
  minBet: number;
  maxBet: number;
};

/** Returned from applyAction() */
export type ApplyActionOk = {
  ok: true;
  game: InMemoryGame;
  playerChips: number;
  wasIdempotent: boolean;
  roomState: RoomState;
};

/** Returned from reconnect() */
export type ReconnectOk = {
  ok: true;
  roomState: RoomState;
  /** null when room is in WAITING_FOR_PLAYERS or BETTING and player has no game yet */
  game: InMemoryGame | null;
  playerChips: number;
  minBet: number;
  maxBet: number;
};

// ─── Payload helpers ──────────────────────────────────────────────────────────

export function cardsToHand(cards: Card[]): Hand {
  const stats = calculateHandValue(cards);
  return {
    cards,
    value:       stats.value,
    isSoft:      stats.isSoft,
    isBust:      stats.isBust,
    isBlackjack: stats.isBlackjack,
  };
}

export function revealDealerHand(cards: Card[]): Card[] {
  return cards.map((c) => ({ ...c, hidden: false }));
}

/**
 * Returns the GAME_STATE payload for a specific player.
 * Hides the dealer's hole card if the round is still in progress.
 *
 * Security note: cards marked `hidden:true` are STRIPPED from the payload here —
 * only the placeholder is sent so the client cannot read the rank in DevTools.
 */
export function buildGameStatePayload(
  game: InMemoryGame,
  playerChips: number,
  slotIndex?: number,
): Record<string, unknown> {
  const isPlayerTurn = game.status === "PLAYER_TURN";

  const playerHand = cardsToHand(game.playerHand);

  // Scrub hidden cards before sending — replace with a blank placeholder.
  const sanitisedDealerCards: Card[] = game.dealerHand.map((c) =>
    c.hidden ? { suit: "SPADES", rank: "2", hidden: true } : c
  );
  const dealerHand = isPlayerTurn
    ? cardsToHand(sanitisedDealerCards)
    : cardsToHand(revealDealerHand(game.dealerHand));

  const availableActions: PlayerActionType[] =
    isPlayerTurn
      ? game.playerHand.length === 2
        ? ["HIT", "STAND", "DOUBLE_DOWN"]
        : ["HIT", "STAND"]
      : [];

  return {
    event: "GAME_STATE",
    v: "1",
    gameId:           game.gameId,
    ...(slotIndex !== undefined ? { slotIndex } : {}),
    status:           game.status,
    playerHand,
    dealerHand,
    betAmount:        game.betAmount,
    result:           game.result,
    availableActions,
    playerChips,
  };
}

/**
 * Builds the ROOM_STATE broadcast payload.
 * `revealDealer` = true only after the dealer phase is complete (ROUND_OVER).
 */
export function buildRoomStatePayload(
  room: InMemoryRoom,
  revealDealer = false,
): RoomState {
  const isPlaying    = room.roomStatus === "PLAYING";
  const isRoundOver  = room.roomStatus === "ROUND_OVER";

  // activeSeatKey is a string like "2" that matches a key in players
  const activeSeatKey =
    isPlaying && room.turnOrder.length > 0
      ? (room.turnOrder[room.activeTurnIndex] ?? null)
      : null;

  // Build dealer hand — scrub hole card unless round is over
  let dealerHand: Hand | null = null;
  if (room.dealerHand.length > 0) {
    if (revealDealer || isRoundOver) {
      dealerHand = cardsToHand(revealDealerHand(room.dealerHand));
    } else {
      const sanitised: Card[] = room.dealerHand.map((c) =>
        c.hidden ? { suit: "SPADES", rank: "2", hidden: true } : c
      );
      dealerHand = cardsToHand(sanitised);
    }
  }

  const players: Record<string, RoomPlayerState> = {};
  for (const [slotIndex, entry] of room.slots) {
    const ps         = entry.playerState;
    const seatKey    = String(slotIndex);
    const hand       = ps.game ? cardsToHand(ps.game.playerHand) : null;
    const hasTurnEnded = ps.game ? ps.game.status === "FINISHED" : false;

    players[seatKey] = {
      seatKey,
      seatIndex:      slotIndex,
      playerId:       ps.playerId,
      username:       ps.username,
      hand,
      betAmount:      ps.bet ?? 0,
      hasBet:         ps.bet !== null,
      result:         ps.game?.result ?? null,
      chips:          ps.chips,
      isActivePlayer: seatKey === activeSeatKey,
      hasTurnEnded,
      isOnline:       ps.isOnline,
    };
  }

  return {
    event:          "ROOM_STATE",
    v:              "1",
    tableId:        room.tableId,
    roomStatus:     room.roomStatus,
    activePlayerId: activeSeatKey,
    dealerHand,
    players,
    turnOrder:      room.turnOrder,
    minBet:         TABLE_MIN_BET,
    maxBet:         TABLE_MAX_BET,
  };
}

// ─── InMemoryGameService ──────────────────────────────────────────────────────

/**
 * Room state machine — controls the full lifecycle of a multiplayer Blackjack room.
 *
 * Phase transitions:
 *   joinRoom()   : creates seat; WAITING_FOR_PLAYERS → BETTING (first player)
 *   placeBet()   : records bet; BETTING → PLAYING when ALL players have bet
 *   applyAction(): processes turns; PLAYING → ROUND_OVER after dealer phase
 *   reconnect()  : attaches returning player to existing room; no state change
 *   leaveRoom()  : removes seat; resets to WAITING_FOR_PLAYERS if room empty
 */
export class InMemoryGameService {
  private readonly games       = new Map<string, InMemoryGame>();
  private readonly playerChips = new Map<string, number>();
  private readonly rooms       = new Map<string, InMemoryRoom>();

  // ── Chips ─────────────────────────────────────────────────────────────────

  getPlayerChips(playerId: string): number {
    return this.playerChips.get(playerId) ?? DEFAULT_CHIPS;
  }

  private setPlayerChips(playerId: string, chips: number): void {
    this.playerChips.set(playerId, Math.max(0, chips));
  }

  // ── Room access ───────────────────────────────────────────────────────────

  getRoom(tableId: string): InMemoryRoom | null {
    return this.rooms.get(tableId) ?? null;
  }

  // ── Phase 1a: JOIN_ROOM — seat player in first available slot ────────────

  /**
   * Seat the player in the first available slot.
   *
   * Rules:
   *  - PLAYING → reject (use RECONNECT / joinSlot for explicit reconnect).
   *  - ROUND_OVER → auto-reset room to BETTING, then seat.
   *  - Idempotent per socketId: same socket already occupying a slot → return it.
   *    (A second call from a *different* socket for the same player gets a new seat,
   *    enabling genuine Multi-Hand from separate browser tabs.)
   *  - Table full (all 5 physical seats occupied) → TABLE_FULL error.
   *
   * Transition: WAITING_FOR_PLAYERS → BETTING (first seated player)
   */
  joinRoom(params: {
    tableId: string;
    playerId: string;
    username: string;
    socketId: string;
  }): JoinRoomOk | ServiceError {
    const { tableId, playerId, username, socketId } = params;

    let room = this.rooms.get(tableId);
    if (!room) room = this._createRoom(tableId);

    if (room.roomStatus === "PLAYING") {
      return { ok: false, code: "INVALID_ACTION", message: "Round in progress — use RECONNECT." };
    }

    if (room.roomStatus === "ROUND_OVER") {
      this._resetRoom(room);
    }

    // Idempotent per socket: this specific socket already holds a seat → return it
    const existingBySocket = this._findSeatBySocket(room, socketId);
    if (existingBySocket !== null) {
      return { ok: true, roomState: buildRoomStatePayload(room), seatIndex: existingBySocket, minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
    }

    // Hard cap: all 5 physical seats are occupied
    if (room.slots.size >= TABLE_MAX_PLAYERS) {
      return { ok: false, code: "TABLE_FULL", message: `Table is full (max ${TABLE_MAX_PLAYERS} seats)` };
    }

    const seatIndex = this._nextAvailableSeat(room);
    room.slots.set(seatIndex, {
      socketId,
      playerState: {
        seatIndex, playerId, username,
        chips: this.getPlayerChips(playerId),
        bet: null, game: null,
        isOnline: true, offlineSince: null,
      },
    });

    if (room.roomStatus === "WAITING_FOR_PLAYERS") room.roomStatus = "BETTING";

    return { ok: true, roomState: buildRoomStatePayload(room), seatIndex, minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
  }

  // ── Phase 1b: JOIN_SLOT — take a specific seat (Multi-Hand) ───────────────

  /**
   * Occupy a specific slot by index (0–4).
   *
   * Allows the same player to sit in multiple slots simultaneously (Multi-Hand).
   * The slot must be empty; PLAYING phase is blocked (join before the round).
   *
   * Idempotent per socketId: same socket already sitting in this specific seat
   * returns success without creating a duplicate entry.
   */
  joinSlot(params: {
    tableId: string;
    playerId: string;
    username: string;
    seatIndex: number;
    socketId: string;
  }): JoinRoomOk | ServiceError {
    const { tableId, playerId, username, seatIndex, socketId } = params;

    if (seatIndex < 0 || seatIndex >= TABLE_MAX_PLAYERS) {
      return { ok: false, code: "INVALID_ACTION", message: `Invalid seat index ${seatIndex}. Must be 0–${TABLE_MAX_PLAYERS - 1}` };
    }

    let room = this.rooms.get(tableId);
    if (!room) room = this._createRoom(tableId);

    if (room.roomStatus === "PLAYING") {
      return { ok: false, code: "INVALID_ACTION", message: "Cannot join a specific slot mid-round — use RECONNECT." };
    }

    if (room.roomStatus === "ROUND_OVER") {
      this._resetRoom(room);
    }

    // Slot already occupied?
    if (room.slots.has(seatIndex)) {
      const occupant = room.slots.get(seatIndex)!;
      if (occupant.socketId === socketId) {
        return { ok: true, roomState: buildRoomStatePayload(room), seatIndex, minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
      }
      return { ok: false, code: "INVALID_ACTION", message: `Slot ${seatIndex} is already occupied` };
    }

    if (room.slots.size >= TABLE_MAX_PLAYERS) {
      return { ok: false, code: "TABLE_FULL", message: `Table is full (max ${TABLE_MAX_PLAYERS} seats)` };
    }

    room.slots.set(seatIndex, {
      socketId,
      playerState: {
        seatIndex, playerId, username,
        chips: this.getPlayerChips(playerId),
        bet: null, game: null,
        isOnline: true, offlineSince: null,
      },
    });

    if (room.roomStatus === "WAITING_FOR_PLAYERS") room.roomStatus = "BETTING";

    return { ok: true, roomState: buildRoomStatePayload(room), seatIndex, minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
  }

  // ── Phase 2: PLACE_BET ────────────────────────────────────────────────────

  /**
   * Record a bet for a specific slot owned by playerId.
   *
   * `slotIndex` targets one seat (0–4). When omitted, defaults to the first
   * un-bet slot the player owns. When every seated slot has bet → PLAYING.
   */
  placeBet(params: {
    tableId: string;
    playerId: string;
    betAmount: number;
    slotIndex?: number;
  }): PlaceBetOk | ServiceError {
    const { tableId, playerId, betAmount } = params;

    const room = this.rooms.get(tableId);
    if (!room) return { ok: false, code: "INVALID_ACTION", message: "Room not found — send JOIN_ROOM first" };

    if (room.roomStatus !== "BETTING") {
      return { ok: false, code: "INVALID_ACTION", message: `Cannot place bet — room is "${room.roomStatus}"` };
    }

    let ps: PlayerState | undefined;
    let resolvedSlotIndex: number;

    if (params.slotIndex !== undefined) {
      const entry = room.slots.get(params.slotIndex);
      if (!entry || entry.playerState.playerId !== playerId) {
        return { ok: false, code: "INVALID_ACTION", message: `Slot ${params.slotIndex} does not belong to you` };
      }
      ps = entry.playerState;
      resolvedSlotIndex = params.slotIndex;
    } else {
      for (const [idx, entry] of room.slots) {
        if (entry.playerState.playerId === playerId && entry.playerState.bet === null) {
          ps = entry.playerState;
          resolvedSlotIndex = idx;
          break;
        }
      }
      if (!ps) {
        return { ok: false, code: "INVALID_ACTION", message: "You are not seated or all your bets are already placed" };
      }
    }

    if (ps.bet !== null) {
      if (ps.bet !== betAmount) return { ok: false, code: "INVALID_ACTION", message: `Bet already placed (${ps.bet}). Cannot change.` };
      return { ok: true, roundStarted: false, game: ps.game, slotIndex: resolvedSlotIndex!, playerChips: this.getPlayerChips(playerId), roomState: buildRoomStatePayload(room), minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
    }

    if (betAmount < TABLE_MIN_BET || betAmount > TABLE_MAX_BET) {
      return { ok: false, code: "INVALID_ACTION", message: `Bet must be ${TABLE_MIN_BET}–${TABLE_MAX_BET}` };
    }

    const chips = this.getPlayerChips(playerId);
    if (betAmount > chips) {
      return { ok: false, code: "INSUFFICIENT_CHIPS", message: `Need ${betAmount}, have ${chips}` };
    }

    this.setPlayerChips(playerId, chips - betAmount);
    ps.bet   = betAmount;
    ps.chips = this.getPlayerChips(playerId);

    for (const [, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) entry.playerState.chips = ps.chips;
    }

    const allBetsIn = Array.from(room.slots.values()).every((e) => e.playerState.bet !== null);
    if (!allBetsIn) {
      return { ok: true, roundStarted: false, game: null, slotIndex: resolvedSlotIndex!, playerChips: this.getPlayerChips(playerId), roomState: buildRoomStatePayload(room), minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
    }

    const dealResult = this._dealRound(room);
    if (!dealResult.ok) {
      this.setPlayerChips(playerId, chips);
      ps.bet = null;
      return dealResult;
    }

    return { ok: true, roundStarted: true, game: ps.game, slotIndex: resolvedSlotIndex!, playerChips: this.getPlayerChips(playerId), roomState: buildRoomStatePayload(room), minBet: TABLE_MIN_BET, maxBet: TABLE_MAX_BET };
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  /**
   * Reattach a returning player.
   *
   * Ghost-state fix: if room is ROUND_OVER, auto-reset it to BETTING so the
   * returning player sees a clean table (not a frozen result screen).
   *
   * Returns all seats owned by this player so the handler can send GAME_STATE
   * for each active seat.
   */
  reconnect(params: {
    tableId: string;
    playerId: string;
    username: string;
    socketId: string;
  }): ReconnectOk | ServiceError {
    const { tableId, playerId, username, socketId } = params;

    const room = this.rooms.get(tableId);
    if (!room) {
      return { ok: false, code: "GAME_NOT_FOUND", message: "No active room at this table — send JOIN_ROOM" };
    }

    // ── Ghost state fix ──────────────────────────────────────────────────
    // ROUND_OVER means the round finished but nobody started a new one.
    // A refreshing player should see BETTING, not the frozen result.
    if (room.roomStatus === "ROUND_OVER") {
      this._resetRoom(room);
      // If the player had a seat, they still have it after reset (seats are kept).
      // Return BETTING state — client will show bet panel, not ghost results.
    }

    // Find any seat belonging to this player
    const ownedSeats = this._findAllSlotsByPlayer(room, playerId);

    if (ownedSeats.length === 0) {
      // Player was never seated at this table
      return { ok: false, code: "GAME_NOT_FOUND", message: "You are not seated — send JOIN_ROOM" };
    }

    // Mark all owned seats as back online and refresh username / chips
    for (const slot of ownedSeats) {
      slot.username     = username;
      slot.chips        = this.getPlayerChips(playerId);
      slot.isOnline     = true;
      slot.offlineSince = null;
    }

    for (const [idx, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) {
        entry.socketId = socketId;
      }
    }

    const primaryGame = ownedSeats[0]?.game ?? null;

    return {
      ok: true,
      roomState:   buildRoomStatePayload(room, false),
      game:        primaryGame,
      playerChips: this.getPlayerChips(playerId),
      minBet:      TABLE_MIN_BET,
      maxBet:      TABLE_MAX_BET,
    };
  }

  // ── Disconnect / reconnect grace-period management ───────────────────────

  /**
   * Called by the server when a WebSocket closes.
   *
   * Marks all seats owned by this socketId as `isOnline = false` and records
   * `offlineSince`. The seat is NOT removed. If the player does NOT reconnect
   * within RECONNECT_GRACE_MS the caller is responsible for calling
   * `expireDisconnectedSeats()` (or the sweep timer in the server does it).
   *
   * Returns the tableId (and grace period expiry) if the player had an active
   * seat, or `{ gracePeriod: false }` when no seat existed.
   */
  notifyDisconnect(socketId: string): DisconnectResult {
    for (const room of this.rooms.values()) {
      for (const [, entry] of room.slots) {
        if (entry.socketId === socketId) {
          entry.playerState.isOnline     = false;
          entry.playerState.offlineSince = Date.now();
          return { gracePeriod: true, tableId: room.tableId, expiresAt: entry.playerState.offlineSince + RECONNECT_GRACE_MS };
        }
      }
    }
    return { gracePeriod: false, tableId: null };
  }

  notifyReconnect(tableId: string, playerId: string, socketId: string): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    for (const [, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) {
        entry.playerState.isOnline     = true;
        entry.playerState.offlineSince = null;
        entry.socketId                 = socketId;
      }
    }
  }

  /**
   * Removes seats whose grace period has expired (called by a background timer
   * or lazily before each room operation). Returns removed seatIndexes.
   */
  expireDisconnectedSeats(tableId: string): number[] {
    const room = this.rooms.get(tableId);
    if (!room) return [];

    const now     = Date.now();
    const removed: number[] = [];

    for (const [slotIdx, entry] of room.slots) {
      const ps = entry.playerState;
      if (!ps.isOnline && ps.offlineSince !== null && now - ps.offlineSince >= RECONNECT_GRACE_MS) {
        if (room.roomStatus === "BETTING" && ps.bet !== null) {
          this.setPlayerChips(ps.playerId, this.getPlayerChips(ps.playerId) + ps.bet);
        }
        room.slots.delete(slotIdx);
        removed.push(slotIdx);
      }
    }

    if (room.slots.size === 0) {
      this.rooms.delete(tableId);
    } else if (room.roomStatus === "BETTING") {
      const allBetsIn = Array.from(room.slots.values()).every((e) => e.playerState.bet !== null);
      if (allBetsIn && room.slots.size > 0) this._dealRound(room);
    }

    return removed;
  }

  /**
   * Returns all RoomPlayer seats owned by this playerId across all slots.
   * Used after reconnect to send GAME_STATE for each active seat.
   */
  getPlayerSeats(tableId: string, playerId: string): OccupiedSlot[] {
    const room = this.rooms.get(tableId);
    if (!room) return [];
    return this._findAllSlotsByPlayer(room, playerId);
  }

  // ── Leave room ────────────────────────────────────────────────────────────

  /**
   * Remove ALL seats belonging to this player from the room.
   * Refunds bets for any seat that had bet but round hasn't started.
   */
  leaveRoom(params: { tableId: string; playerId: string }): { roomState: RoomState | null } {
    const { tableId, playerId } = params;
    const room = this.rooms.get(tableId);
    if (!room) return { roomState: null };

    for (const [slotIdx, entry] of room.slots) {
      const ps = entry.playerState;
      if (ps.playerId !== playerId) continue;
      if (room.roomStatus === "BETTING" && ps.bet !== null) {
        this.setPlayerChips(playerId, this.getPlayerChips(playerId) + ps.bet);
      }
      room.slots.delete(slotIdx);
    }

    if (room.slots.size === 0) {
      this.rooms.delete(tableId);
      return { roomState: null };
    }

    if (room.roomStatus === "BETTING") {
      const allBetsIn = Array.from(room.slots.values()).every((e) => e.playerState.bet !== null);
      if (allBetsIn && room.slots.size > 0) this._dealRound(room);
    }

    return { roomState: buildRoomStatePayload(room) };
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  getGame(gameId: string, playerId: string): InMemoryGame | null {
    const game = this.games.get(gameId);
    if (!game || game.playerId !== playerId) return null;
    return game;
  }

  // ── Phase 3: PLAYER_ACTION ────────────────────────────────────────────────

  /**
   * Process a player action (HIT | STAND | DOUBLE_DOWN).
   *
   * Turn order is now based on seatKey ("0"–"4"), not playerId.
   * A player with Multi-Hand seats must play each seat in the natural turn order.
   *
   * `seatIndex` is optional but strongly recommended for Multi-Hand sessions:
   *  - When provided, the server resolves the game from that specific seat.
   *  - When omitted, it falls back to `gameId` lookup (single-hand legacy path).
   *
   * This is the fix for "buttons locked": without `seatIndex` the store holds
   * only the *last* GAME_STATE's gameId. With Multi-Hand the active seat's
   * gameId may differ from the stored one, so actions were silently rejected.
   */
  applyAction(params: {
    gameId: string;
    playerId: string;
    action: PlayerActionType;
    idempotencyKey: string;
    slotIndex: number;
  }): ApplyActionOk | ServiceError {
    const { gameId, playerId, action, idempotencyKey, slotIndex } = params;

    let game: InMemoryGame | undefined;
    let room: InMemoryRoom | undefined;

    for (const r of this.rooms.values()) {
      const entry = r.slots.get(slotIndex);
      if (entry && entry.playerState.playerId === playerId && entry.playerState.game) {
        game = entry.playerState.game;
        room = r;
        break;
      }
    }

    if (!game || game.playerId !== playerId) {
      return { ok: false, code: "GAME_NOT_FOUND", message: "Game not found or does not belong to you" };
    }

    if (!room) return { ok: false, code: "INTERNAL_ERROR", message: "Room not found" };

    if (room.roomStatus !== "PLAYING") {
      return { ok: false, code: "INVALID_ACTION", message: `Room is not PLAYING (current: "${room.roomStatus}")` };
    }

    // Idempotency
    if (game.lastIdempotencyKey === idempotencyKey && game.cachedStatePayload !== null) {
      return { ok: true, game, playerChips: this.getPlayerChips(playerId), wasIdempotent: true, roomState: buildRoomStatePayload(room) };
    }

    if (game.status !== "PLAYER_TURN") {
      return { ok: false, code: "INVALID_ACTION", message: `Cannot ${action} — status is "${game.status}"` };
    }

    const currentSeatKey = room.turnOrder[room.activeTurnIndex];
    if (currentSeatKey !== String(slotIndex)) {
      return { ok: false, code: "INVALID_ACTION", message: "It is not your turn" };
    }

    game.updatedAt = new Date().toISOString();

    switch (action) {
      case "HIT": {
        const hitResult = applyHit(game.deckState, game.playerHand);
        if (!hitResult.ok) return { ok: false, code: "INTERNAL_ERROR", message: hitResult.error.message };
        game.playerHand = hitResult.value.playerHand;
        game.deckState  = hitResult.value.remainingDeck;
        if (calculateHandValue(game.playerHand).isBust) {
          game.status = "FINISHED"; game.result = "LOSS";
          this._settleChips(game); this._advanceTurn(room);
        }
        break;
      }
      case "STAND": {
        game.status = "FINISHED"; game.result = null;
        this._advanceTurn(room);
        break;
      }
      case "DOUBLE_DOWN": {
        const chipsNow = this.getPlayerChips(playerId);
        if (chipsNow < game.betAmount) return { ok: false, code: "INSUFFICIENT_CHIPS", message: `Need ${game.betAmount}, have ${chipsNow}` };
        const ddResult = applyDoubleDown(game.deckState, game.playerHand);
        if (!ddResult.ok) return { ok: false, code: "INVALID_ACTION", message: ddResult.error.message };
        this.setPlayerChips(playerId, chipsNow - game.betAmount);
        game.betAmount  *= 2;
        game.playerHand  = ddResult.value.playerHand;
        game.deckState   = ddResult.value.remainingDeck;
        game.status      = "FINISHED";
        if (calculateHandValue(game.playerHand).isBust) { game.result = "LOSS"; this._settleChips(game); }
        this._advanceTurn(room);
        break;
      }
    }

    game.lastIdempotencyKey = idempotencyKey;
    game.cachedStatePayload = null;

    let revealDealer = false;
    if (this._allOccupiedSlotsDone(room)) {
      this._runDealerPhase(room);
      revealDealer = true;
    }

    return { ok: true, game, playerChips: this.getPlayerChips(playerId), wasIdempotent: false, roomState: buildRoomStatePayload(room, revealDealer) };
  }

  cacheStatePayload(gameId: string, payload: Record<string, unknown>): void {
    const game = this.games.get(gameId);
    if (game) game.cachedStatePayload = payload;
  }

  // ── Internal — room factory & reset ──────────────────────────────────────

  private _createRoom(tableId: string): InMemoryRoom {
    const room: InMemoryRoom = {
      tableId, roomStatus: "WAITING_FOR_PLAYERS",
      deckState: [], deckSeed: "", dealerHand: [],
      slots: new Map(), turnOrder: [], activeTurnIndex: 0,
    };
    this.rooms.set(tableId, room);
    return room;
  }

  /**
   * Reset a room to BETTING for the next round.
   * Ghost-state fix: clears all game data but keeps players in their seats.
   * Stale `InMemoryGame` objects are removed from the global games map.
   */
  private _resetRoom(room: InMemoryRoom): void {
    // Remove stale games
    for (const [gid, g] of this.games) {
      if (g.tableId === room.tableId) this.games.delete(gid);
    }

    room.roomStatus      = "BETTING";
    room.deckState       = [];
    room.deckSeed        = "";
    room.dealerHand      = [];
    room.turnOrder       = [];
    room.activeTurnIndex = 0;

    for (const [, entry] of room.slots) {
      const ps = entry.playerState;
      ps.bet   = null;
      ps.game  = null;
      ps.chips = this.getPlayerChips(ps.playerId);
    }

    if (room.slots.size === 0) room.roomStatus = "WAITING_FOR_PLAYERS";
  }

  // ── Internal — deal round ─────────────────────────────────────────────────

  private _dealRound(room: InMemoryRoom): { ok: true } | ServiceError {
    const deckSeed = randomUUID();
    let deck = createDeck(deckSeed);

    room.deckSeed   = deckSeed;
    room.dealerHand = [];
    room.turnOrder  = [];
    room.activeTurnIndex = 0;

    // Remove stale games
    for (const [gid, g] of this.games) {
      if (g.tableId === room.tableId) this.games.delete(gid);
    }

    const dealerCard1: Card = deck.shift()!;
    const dealerCard2: Card = { ...deck.shift()!, hidden: true };
    room.dealerHand = [dealerCard1, dealerCard2];

    // Deal in seatIndex order (sorted ascending)
    const sortedSlots = Array.from(room.slots.entries()).sort(([a], [b]) => a - b);

    for (const [slotIndex, entry] of sortedSlots) {
      const ps  = entry.playerState;
      const bet = ps.bet ?? TABLE_MIN_BET;

      const card1: Card = deck.shift()!;
      const card2: Card = deck.shift()!;
      const playerHand: Card[] = [card1, card2];

      const playerStats = calculateHandValue(playerHand);
      const status: GameStatus = playerStats.isBlackjack ? "FINISHED" : "PLAYER_TURN";
      const result: GameResult = playerStats.isBlackjack ? "BLACKJACK" : null;

      const game: InMemoryGame = {
        gameId:              randomUUID(),
        tableId:             room.tableId,
        playerId:            ps.playerId,
        status,
        playerHand,
        dealerHand:          room.dealerHand,
        deckState:           [...deck],
        betAmount:           bet,
        result,
        deckSeed,
        lastIdempotencyKey:  null,
        cachedStatePayload:  null,
        updatedAt:           new Date().toISOString(),
      };

      if (playerStats.isBlackjack) {
        this._settleChips(game);
      } else {
        room.turnOrder.push(String(slotIndex));
      }

      this.games.set(game.gameId, game);
      ps.game  = game;
      ps.chips = this.getPlayerChips(ps.playerId);
    }

    room.deckState  = deck;
    room.roomStatus = "PLAYING";

    // Dealer only when every occupied slot is done (all blackjack at deal, or edge case)
    if (this._allOccupiedSlotsDone(room)) this._runDealerPhase(room);

    return { ok: true };
  }

  // ── Internal — turn management ────────────────────────────────────────────

  private _allOccupiedSlotsDone(room: InMemoryRoom): boolean {
    if (room.slots.size === 0) return false;
    for (const [, entry] of room.slots) {
      const game = entry.playerState.game;
      if (!game || game.status !== "FINISHED") return false;
    }
    return true;
  }

  private _advanceTurn(room: InMemoryRoom): void {
    room.activeTurnIndex++;
    // Skip seats whose game already finished (instant blackjack, bust)
    while (room.activeTurnIndex < room.turnOrder.length) {
      const seatKey  = room.turnOrder[room.activeTurnIndex]!;
      const slotIdx  = parseInt(seatKey, 10);
      const entry    = room.slots.get(slotIdx);
      if (entry?.playerState.game?.status === "FINISHED") {
        room.activeTurnIndex++;
      } else {
        break;
      }
    }
  }

  private _runDealerPhase(room: InMemoryRoom): void {
    const standResult = applyStand(room.deckState, room.dealerHand);
    if (standResult.ok) {
      room.dealerHand = standResult.value.dealerHand;
      room.deckState  = standResult.value.remainingDeck;
    }
    const revealedDealer = revealDealerHand(room.dealerHand);

    for (const [, entry] of room.slots) {
      const ps   = entry.playerState;
      const game = ps.game;
      if (!game) continue;
      game.dealerHand = revealedDealer;
      if (game.result === null) {
        game.result = determineResult(game.playerHand, game.dealerHand);
        game.status = "FINISHED";
        this._settleChips(game);
      }
      ps.chips = this.getPlayerChips(ps.playerId);
    }

    room.roomStatus      = "ROUND_OVER";
    room.turnOrder       = [];
    room.activeTurnIndex = 0;
  }

  // ── Internal — seat helpers ───────────────────────────────────────────────

  private _findSeatBySocket(room: InMemoryRoom, socketId: string): number | null {
    for (const [idx, entry] of room.slots) {
      if (entry.socketId === socketId) return idx;
    }
    return null;
  }

  private _findAllSlotsByPlayer(room: InMemoryRoom, playerId: string): OccupiedSlot[] {
    const result: OccupiedSlot[] = [];
    for (const [, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) {
        result.push({ ...entry.playerState, socketId: entry.socketId });
      }
    }
    return result;
  }

  private _nextAvailableSeat(room: InMemoryRoom): number {
    for (let i = 0; i < TABLE_MAX_PLAYERS; i++) {
      if (!room.slots.has(i)) return i;
    }
    return room.slots.size;
  }

  // ── Internal — chip settlement ────────────────────────────────────────────

  private _settleChips(game: InMemoryGame): void {
    if (game.result === null) return;
    const delta   = calculateChipsDelta(game.result, game.betAmount);
    const current = this.getPlayerChips(game.playerId);
    this.setPlayerChips(game.playerId, current + game.betAmount + delta);
  }
}
