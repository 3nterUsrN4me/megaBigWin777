import { randomUUID } from "node:crypto";
import {
  createDeck,
  dealInitialCards,
  applyHit,
  applyStand,
  applyDoubleDown,
  calculateHandValue,
  determineResult,
  calculateChipsDelta,
} from "@megabigwin777/game-core";
import type { Card, Hand, GameResult, GameStatus, PlayerActionType } from "../../../../contracts/domain.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CHIPS = 1000;
const TABLE_MIN_BET = 10;
const TABLE_MAX_BET = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

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

export type ServiceError =
  | { ok: false; code: "INSUFFICIENT_CHIPS" | "INVALID_ACTION" | "GAME_NOT_FOUND" | "INTERNAL_ERROR"; message: string };

export type CreateGameOk = {
  ok: true;
  game: InMemoryGame;
  playerChips: number;
  minBet: number;
  maxBet: number;
};

export type ApplyActionOk = {
  ok: true;
  game: InMemoryGame;
  playerChips: number;
  wasIdempotent: boolean;
};

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Converts a raw Card[] to the Hand shape expected by the WS protocol.
 * Hidden cards are included (their value contribution is excluded by calculateHandValue).
 */
export function cardsToHand(cards: Card[]): Hand {
  const stats = calculateHandValue(cards);
  return {
    cards,
    value: stats.value,
    isSoft: stats.isSoft,
    isBust: stats.isBust,
    isBlackjack: stats.isBlackjack,
  };
}

/**
 * Returns a copy of dealerHand with all hidden cards revealed.
 */
export function revealDealerHand(cards: Card[]): Card[] {
  return cards.map((c) => ({ ...c, hidden: false }));
}

/**
 * Builds the GAME_STATE WS payload from an in-memory game snapshot.
 * During PLAYER_TURN the dealer's hole card remains hidden; after that all cards are revealed.
 */
export function buildGameStatePayload(
  game: InMemoryGame,
  playerChips: number
): Record<string, unknown> {
  const isPlayerTurn = game.status === "PLAYER_TURN";

  const playerHand = cardsToHand(game.playerHand);
  const dealerHand = isPlayerTurn
    ? cardsToHand(game.dealerHand)           // hole card stays hidden
    : cardsToHand(revealDealerHand(game.dealerHand));  // game over — reveal all

  // DOUBLE_DOWN only allowed on the initial two-card hand
  const availableActions: PlayerActionType[] =
    isPlayerTurn
      ? game.playerHand.length === 2
        ? ["HIT", "STAND", "DOUBLE_DOWN"]
        : ["HIT", "STAND"]
      : [];

  return {
    event: "GAME_STATE",
    v: "1",
    gameId: game.gameId,
    status: game.status,
    playerHand,
    dealerHand,
    betAmount: game.betAmount,
    result: game.result,
    availableActions,
    playerChips,
  };
}

// ─── InMemoryGameService ──────────────────────────────────────────────────────

/**
 * In-memory implementation of the game service.
 *
 * Responsibilities:
 *  - Manages game lifecycle (create, apply action, query)
 *  - Integrates with `game-core` pure functions
 *  - Tracks player chip balances (in-memory; replaced by DB in game-service module)
 *  - Enforces idempotency keys per ARCHITECTURE.md §7
 */
export class InMemoryGameService {
  private readonly games = new Map<string, InMemoryGame>();
  private readonly playerChips = new Map<string, number>();

  // ── Chips ────────────────────────────────────────────────────────────────

  getPlayerChips(playerId: string): number {
    return this.playerChips.get(playerId) ?? DEFAULT_CHIPS;
  }

  private setPlayerChips(playerId: string, chips: number): void {
    this.playerChips.set(playerId, Math.max(0, chips));
  }

  // ── Create game ──────────────────────────────────────────────────────────

  createGame(params: {
    tableId: string;
    playerId: string;
    betAmount: number;
  }): CreateGameOk | ServiceError {
    const { tableId, playerId, betAmount } = params;

    if (betAmount < TABLE_MIN_BET || betAmount > TABLE_MAX_BET) {
      return {
        ok: false,
        code: "INVALID_ACTION",
        message: `Bet must be between ${TABLE_MIN_BET} and ${TABLE_MAX_BET}`,
      };
    }

    const chips = this.getPlayerChips(playerId);
    if (betAmount > chips) {
      return {
        ok: false,
        code: "INSUFFICIENT_CHIPS",
        message: `Not enough chips. Have: ${chips}, need: ${betAmount}`,
      };
    }

    // Deduct bet upfront (settled when game ends)
    this.setPlayerChips(playerId, chips - betAmount);

    const deckSeed = randomUUID();
    const deck = createDeck(deckSeed);
    const { playerHand, dealerHand, remainingDeck } = dealInitialCards(deck);
    const gameId = randomUUID();
    const now = new Date().toISOString();

    const playerStats = calculateHandValue(playerHand);

    // Immediate blackjack → skip PLAYER_TURN entirely
    const status: GameStatus = playerStats.isBlackjack ? "FINISHED" : "PLAYER_TURN";
    const result: GameResult = playerStats.isBlackjack ? "BLACKJACK" : null;

    const game: InMemoryGame = {
      gameId,
      tableId,
      playerId,
      status,
      playerHand,
      dealerHand,
      deckState: remainingDeck,
      betAmount,
      result,
      deckSeed,
      lastIdempotencyKey: null,
      cachedStatePayload: null,
      updatedAt: now,
    };

    if (playerStats.isBlackjack) {
      this._settleChips(game);
    }

    this.games.set(gameId, game);

    return {
      ok: true,
      game,
      playerChips: this.getPlayerChips(playerId),
      minBet: TABLE_MIN_BET,
      maxBet: TABLE_MAX_BET,
    };
  }

  // ── Query ────────────────────────────────────────────────────────────────

  getGame(gameId: string, playerId: string): InMemoryGame | null {
    const game = this.games.get(gameId);
    if (!game || game.playerId !== playerId) return null;
    return game;
  }

  // ── Apply player action ──────────────────────────────────────────────────

  applyAction(params: {
    gameId: string;
    playerId: string;
    action: PlayerActionType;
    idempotencyKey: string;
  }): ApplyActionOk | ServiceError {
    const { gameId, playerId, action, idempotencyKey } = params;

    const game = this.games.get(gameId);
    if (!game || game.playerId !== playerId) {
      return { ok: false, code: "GAME_NOT_FOUND", message: "Game not found or does not belong to this player" };
    }

    // ── Idempotency check ────────────────────────────────────────────────
    // Per ARCHITECTURE.md §7: same key → return cached state, no reprocessing.
    if (game.lastIdempotencyKey === idempotencyKey && game.cachedStatePayload !== null) {
      return {
        ok: true,
        game,
        playerChips: this.getPlayerChips(playerId),
        wasIdempotent: true,
      };
    }

    if (game.status !== "PLAYER_TURN") {
      return {
        ok: false,
        code: "INVALID_ACTION",
        message: `Cannot ${action} when game status is "${game.status}"`,
      };
    }

    game.updatedAt = new Date().toISOString();

    // ── Apply the action ─────────────────────────────────────────────────
    switch (action) {
      case "HIT": {
        const hitResult = applyHit(game.deckState, game.playerHand);
        if (!hitResult.ok) {
          return { ok: false, code: "INTERNAL_ERROR", message: hitResult.error.message };
        }
        game.playerHand = hitResult.value.playerHand;
        game.deckState = hitResult.value.remainingDeck;

        const handStats = calculateHandValue(game.playerHand);
        if (handStats.isBust) {
          game.status = "FINISHED";
          game.result = "LOSS";
          this._settleChips(game);
        }
        // Otherwise status stays PLAYER_TURN
        break;
      }

      case "STAND": {
        const standResult = applyStand(game.deckState, game.dealerHand);
        if (!standResult.ok) {
          return { ok: false, code: "INTERNAL_ERROR", message: standResult.error.message };
        }
        game.dealerHand = standResult.value.dealerHand;
        game.deckState = standResult.value.remainingDeck;
        game.result = determineResult(game.playerHand, game.dealerHand);
        game.status = "FINISHED";
        this._settleChips(game);
        break;
      }

      case "DOUBLE_DOWN": {
        const chipsNow = this.getPlayerChips(playerId);
        if (chipsNow < game.betAmount) {
          return {
            ok: false,
            code: "INSUFFICIENT_CHIPS",
            message: `Need ${game.betAmount} more chips to double down. Have: ${chipsNow}`,
          };
        }

        const ddResult = applyDoubleDown(game.deckState, game.playerHand);
        if (!ddResult.ok) {
          return { ok: false, code: "INVALID_ACTION", message: ddResult.error.message };
        }

        // Deduct the additional bet
        this.setPlayerChips(playerId, chipsNow - game.betAmount);
        game.betAmount *= 2;
        game.playerHand = ddResult.value.playerHand;
        game.deckState = ddResult.value.remainingDeck;

        const playerStats = calculateHandValue(game.playerHand);
        if (playerStats.isBust) {
          game.status = "FINISHED";
          game.result = "LOSS";
          this._settleChips(game);
        } else {
          // Dealer plays immediately (DOUBLE_DOWN → DEALER_TURN → FINISHED in one step)
          const standResult = applyStand(game.deckState, game.dealerHand);
          if (!standResult.ok) {
            return { ok: false, code: "INTERNAL_ERROR", message: standResult.error.message };
          }
          game.dealerHand = standResult.value.dealerHand;
          game.deckState = standResult.value.remainingDeck;
          game.result = determineResult(game.playerHand, game.dealerHand);
          game.status = "FINISHED";
          this._settleChips(game);
        }
        break;
      }
    }

    // Record idempotency key (payload will be cached by the caller after serialisation)
    game.lastIdempotencyKey = idempotencyKey;
    game.cachedStatePayload = null; // caller sets this after building the payload

    return {
      ok: true,
      game,
      playerChips: this.getPlayerChips(playerId),
      wasIdempotent: false,
    };
  }

  /**
   * Stores the serialised GAME_STATE payload for idempotency caching.
   * Must be called immediately after `applyAction` succeeds.
   */
  cacheStatePayload(gameId: string, payload: Record<string, unknown>): void {
    const game = this.games.get(gameId);
    if (game) game.cachedStatePayload = payload;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Settles the player's chip balance after the game ends.
   *
   * Bet was deducted upfront at createGame (and again for DOUBLE_DOWN).
   * Settlement formula: chips_current + betAmount + delta
   *   WIN      → +betAmount (return) + betAmount (profit) = +2× = net +betAmount delta ✓
   *   BLACKJACK → +betAmount + floor(betAmount×1.5)
   *   LOSS     → +betAmount + (−betAmount) = 0 change (bet already spent)
   *   PUSH     → +betAmount + 0 = bet returned
   */
  private _settleChips(game: InMemoryGame): void {
    if (game.result === null) return;
    const delta = calculateChipsDelta(game.result, game.betAmount);
    const current = this.getPlayerChips(game.playerId);
    // Return the bet plus the net winnings/loss
    this.setPlayerChips(game.playerId, current + game.betAmount + delta);
  }
}
