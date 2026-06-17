import { randomUUID } from "node:crypto";
import {
  applyDoubleDown,
  applyHit,
  applyStand,
  calculateChipsDelta,
  calculateHandValue,
  createDeck,
  dealInitialCards,
  determineResult,
} from "@megabigwin777/game-core";
import type {
  GameResult,
  GameState,
  PlayerAction,
} from "../../../contracts/domain.js";
import type { Database, Transaction } from "./db/client.js";
import { db as defaultDb } from "./db/client.js";
import type { GameRow } from "./db/schema.js";
import {
  availableActionsForGame,
  revealDealerHand,
  toGameStateView,
  type GameStateView,
} from "./mappers/gameStateMapper.js";
import { GameRepository } from "./repositories/GameRepository.js";
import { PlayerRepository } from "./repositories/PlayerRepository.js";

export type ServiceErrorCode =
  | "INSUFFICIENT_CHIPS"
  | "INVALID_ACTION"
  | "GAME_NOT_FOUND"
  | "TABLE_FULL"
  | "INTERNAL_ERROR";

export type ServiceError = {
  ok: false;
  code: ServiceErrorCode;
  message: string;
};

export type CreateGameParams = {
  tableId: string;
  playerId: string;
  betAmount: number;
  deckSeed?: string;
};

export type CreateGameOk = {
  ok: true;
  gameState: GameStateView;
};

export type ApplyPlayerActionOk = {
  ok: true;
  gameState: GameStateView;
  wasIdempotent: boolean;
};

export type ApplyPlayerActionResult = ApplyPlayerActionOk | ServiceError;
export type CreateGameResult = CreateGameOk | ServiceError;

export class GameService {
  private readonly gameRepo: GameRepository;
  private readonly playerRepo: PlayerRepository;

  constructor(
    private readonly db: Database = defaultDb,
    deps?: {
      gameRepo?: GameRepository;
      playerRepo?: PlayerRepository;
    },
  ) {
    this.gameRepo = deps?.gameRepo ?? new GameRepository();
    this.playerRepo = deps?.playerRepo ?? new PlayerRepository();
  }

  async getGameState(
    gameId: string,
    playerId: string,
  ): Promise<GameStateView | null> {
    return this.db.transaction(async (tx) => {
      const game = await this.gameRepo.findById(tx, gameId);
      if (!game || game.playerId !== playerId) return null;

      const player = await this.playerRepo.findById(tx, playerId);
      if (!player) return null;

      return toGameStateView(game, player.chips);
    });
  }

  async createGame(params: CreateGameParams): Promise<CreateGameResult> {
    const { tableId, playerId, betAmount } = params;
    const deckSeed = params.deckSeed ?? randomUUID();

    return this.db.transaction(async (tx) => {
      const table = await this.gameRepo.findTable(tx, tableId);
      if (!table) {
        return {
          ok: false,
          code: "GAME_NOT_FOUND",
          message: "Table not found",
        };
      }

      if (betAmount < table.minBet || betAmount > table.maxBet) {
        return {
          ok: false,
          code: "INVALID_ACTION",
          message: `Bet must be between ${table.minBet} and ${table.maxBet}`,
        };
      }

      const existingActive = await this.gameRepo.findActiveByTable(tx, tableId);
      if (existingActive) {
        return {
          ok: false,
          code: "TABLE_FULL",
          message: "Table already has an active game",
        };
      }

      const player = await this.playerRepo.findByIdForUpdate(tx, playerId);
      if (!player) {
        return {
          ok: false,
          code: "GAME_NOT_FOUND",
          message: "Player not found",
        };
      }

      if (player.chips < betAmount) {
        return {
          ok: false,
          code: "INSUFFICIENT_CHIPS",
          message: `Need ${betAmount}, have ${player.chips}`,
        };
      }

      await this.playerRepo.deductChips(tx, playerId, betAmount);

      const deck = createDeck(deckSeed);
      const dealt = dealInitialCards(deck);
      const playerStats = calculateHandValue(dealt.playerHand);

      let status: GameState["status"] = "PLAYER_TURN";
      let result: GameResult = null;

      if (playerStats.isBlackjack) {
        status = "FINISHED";
        result = determineResult(dealt.playerHand, revealDealerHand(dealt.dealerHand));
      }

      const game = await this.gameRepo.create(tx, {
        tableId,
        playerId,
        deckSeed,
        deckState: dealt.remainingDeck,
        playerHand: dealt.playerHand,
        dealerHand: dealt.dealerHand,
        betAmount,
        status,
        result,
      });

      await this.gameRepo.setTableStatus(tx, tableId, "ACTIVE");

      let persistedGame = game;
      let playerChips = player.chips - betAmount;

      if (status === "FINISHED" && result !== null) {
        const settled = await this.finalizeFinishedGame(tx, game, result);
        playerChips = settled.chips;
        persistedGame = (await this.gameRepo.findById(tx, game.id))!;
      }

      return {
        ok: true,
        gameState: toGameStateView(persistedGame, playerChips),
      };
    });
  }

  /**
   * Processes HIT | STAND | DOUBLE_DOWN inside a single DB transaction.
   *
   * Idempotency (ARCHITECTURE.md §7): if `games.idempotency_key` already
   * matches the incoming key, the action is skipped and the current state is
   * returned without mutating chips or re-running game-core.
   */
  async applyPlayerAction(
    gameId: string,
    playerId: string,
    action: PlayerAction,
  ): Promise<ApplyPlayerActionResult> {
    return this.db.transaction(async (tx) => {
      const game = await this.gameRepo.findByIdForUpdate(tx, gameId, playerId);
      if (!game) {
        return {
          ok: false,
          code: "GAME_NOT_FOUND",
          message: "Game not found or does not belong to you",
        };
      }

      const player = await this.playerRepo.findByIdForUpdate(tx, playerId);
      if (!player) {
        return {
          ok: false,
          code: "GAME_NOT_FOUND",
          message: "Player not found",
        };
      }

      if (game.idempotencyKey === action.idempotencyKey) {
        return {
          ok: true,
          gameState: toGameStateView(game, player.chips),
          wasIdempotent: true,
        };
      }

      if (game.status !== "PLAYER_TURN") {
        return {
          ok: false,
          code: "INVALID_ACTION",
          message: `Cannot ${action.type} — status is "${game.status}"`,
        };
      }

      const allowed = availableActionsForGame(
        game.status as GameState["status"],
        game.playerHand,
      );
      if (!allowed.includes(action.type)) {
        return {
          ok: false,
          code: "INVALID_ACTION",
          message: `Action ${action.type} is not allowed in the current state`,
        };
      }

      let nextGame: GameRow;
      let nextPlayerChips = player.chips;

      switch (action.type) {
        case "HIT":
          nextGame = this.processHit(game);
          break;
        case "STAND":
          nextGame = this.runDealerAndResolve(game);
          break;
        case "DOUBLE_DOWN": {
          const ddOutcome = await this.processDoubleDown(tx, game, player);
          if (!ddOutcome.ok) return ddOutcome;
          nextGame = ddOutcome.game;
          nextPlayerChips = ddOutcome.player.chips;
          break;
        }
      }

      const updatedGame = await this.gameRepo.update(tx, game.id, {
        status: nextGame.status,
        deckState: nextGame.deckState,
        playerHand: nextGame.playerHand,
        dealerHand: nextGame.dealerHand,
        betAmount: nextGame.betAmount,
        result: nextGame.result,
        idempotencyKey: action.idempotencyKey,
      });

      if (updatedGame.status === "FINISHED" && updatedGame.result) {
        const settled = await this.finalizeFinishedGame(
          tx,
          updatedGame,
          updatedGame.result as GameResult,
        );
        nextPlayerChips = settled.chips;
        await this.gameRepo.setTableStatus(tx, updatedGame.tableId, "FINISHED");
      }

      return {
        ok: true,
        gameState: toGameStateView(updatedGame, nextPlayerChips),
        wasIdempotent: false,
      };
    });
  }

  private processHit(game: GameRow): GameRow {
    const hitResult = applyHit(game.deckState, game.playerHand);
    if (!hitResult.ok) {
      throw new Error(hitResult.error.message);
    }

    const playerHand = hitResult.value.playerHand;
    const deckState = hitResult.value.remainingDeck;
    const bust = calculateHandValue(playerHand).isBust;

    return {
      ...game,
      playerHand,
      deckState,
      status: bust ? "FINISHED" : "PLAYER_TURN",
      result: bust ? "LOSS" : game.result,
    };
  }

  private async processDoubleDown(
    tx: Transaction,
    game: GameRow,
    player: { id: string; chips: number },
  ): Promise<{ ok: true; game: GameRow; player: { chips: number } } | ServiceError> {
    if (player.chips < game.betAmount) {
      return {
        ok: false,
        code: "INSUFFICIENT_CHIPS",
        message: `Need ${game.betAmount}, have ${player.chips}`,
      };
    }

    const ddResult = applyDoubleDown(game.deckState, game.playerHand);
    if (!ddResult.ok) {
      return {
        ok: false,
        code: "INVALID_ACTION",
        message: ddResult.error.message,
      };
    }

    const updatedPlayer = await this.playerRepo.deductChips(tx, player.id, game.betAmount);
    const playerHand = ddResult.value.playerHand;
    const deckState = ddResult.value.remainingDeck;
    const betAmount = game.betAmount * 2;
    const bust = calculateHandValue(playerHand).isBust;

    const nextGame = bust
      ? {
          ...game,
          playerHand,
          deckState,
          betAmount,
          status: "FINISHED" as const,
          result: "LOSS" as const,
        }
      : this.runDealerAndResolve({
          ...game,
          playerHand,
          deckState,
          betAmount,
        });

    return { ok: true, game: nextGame, player: updatedPlayer };
  }

  private runDealerAndResolve(game: GameRow): GameRow {
    const standResult = applyStand(game.deckState, game.dealerHand);
    if (!standResult.ok) {
      throw new Error(standResult.error.message);
    }

    const dealerHand = revealDealerHand(standResult.value.dealerHand);
    const deckState = standResult.value.remainingDeck;
    const result = determineResult(game.playerHand, dealerHand);

    return {
      ...game,
      dealerHand,
      deckState,
      status: "FINISHED",
      result,
    };
  }

  private async finalizeFinishedGame(
    tx: Transaction,
    game: GameRow,
    result: GameResult,
  ) {
    if (result === null) {
      throw new Error("Cannot finalize game without a result");
    }

    const chipsDelta = calculateChipsDelta(result, game.betAmount);
    const updatedPlayer = await this.playerRepo.settleRound(
      tx,
      game.playerId,
      game.betAmount,
      chipsDelta,
    );

    await this.gameRepo.insertRound(tx, {
      gameId: game.id,
      playerId: game.playerId,
      tableId: game.tableId,
      playerHand: game.playerHand,
      dealerHand: revealDealerHand(game.dealerHand),
      betAmount: game.betAmount,
      result,
      chipsDelta,
    });

    return updatedPlayer;
  }
}
