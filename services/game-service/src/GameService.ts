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
  Card,
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

export type SeatBet = {
  playerId: string;
  betAmount: number;
  seatIndex: number;
};

export type StartMultiplayerRoundResult =
  | { ok: true; games: Map<number, GameStateView>; dealerHand: Card[]; turnOrder: number[] }
  | ServiceError;

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

  async getPlayerChips(playerId: string): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const player = await this.playerRepo.findById(tx, playerId);
      return player?.chips ?? null;
    });
  }

  async reserveBet(
    playerId: string,
    betAmount: number,
    minBet: number,
    maxBet: number,
  ): Promise<{ ok: true; chips: number } | ServiceError> {
    return this.db.transaction(async (tx) => {
      if (betAmount < minBet || betAmount > maxBet) {
        return {
          ok: false,
          code: "INVALID_ACTION",
          message: `Bet must be between ${minBet} and ${maxBet}`,
        };
      }

      const player = await this.playerRepo.findByIdForUpdate(tx, playerId);
      if (!player) {
        return { ok: false, code: "GAME_NOT_FOUND", message: "Player not found" };
      }

      if (player.chips < betAmount) {
        return {
          ok: false,
          code: "INSUFFICIENT_CHIPS",
          message: `Need ${betAmount}, have ${player.chips}`,
        };
      }

      const updated = await this.playerRepo.deductChips(tx, playerId, betAmount);
      return { ok: true, chips: updated.chips };
    });
  }

  async refundBet(playerId: string, betAmount: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.playerRepo.creditChips(tx, playerId, betAmount);
    });
  }

  /**
   * Deals a shared-dealer multiplayer round. Bets must already be reserved via
   * `reserveBet` before calling this method.
   */
  async startMultiplayerRound(
    tableId: string,
    seats: SeatBet[],
  ): Promise<StartMultiplayerRoundResult> {
    const deckSeed = randomUUID();

    return this.db.transaction(async (tx) => {
      const table = await this.gameRepo.findTable(tx, tableId);
      if (!table) {
        return { ok: false, code: "GAME_NOT_FOUND", message: "Table not found" };
      }

      const deck = createDeck(deckSeed);
      const dealerCard1 = deck.shift()!;
      const dealerCard2: Card = { ...deck.shift()!, hidden: true };
      const dealerHand: Card[] = [dealerCard1, dealerCard2];

      const games = new Map<number, GameStateView>();
      const turnOrder: number[] = [];
      const createdGameIds: string[] = [];

      for (const seat of seats.sort((a, b) => a.seatIndex - b.seatIndex)) {
        const card1 = deck.shift()!;
        const card2 = deck.shift()!;
        const playerHand: Card[] = [card1, card2];
        const playerStats = calculateHandValue(playerHand);

        let status: GameState["status"] = "PLAYER_TURN";
        let result: GameResult = null;

        if (playerStats.isBlackjack) {
          status = "FINISHED";
          result = determineResult(playerHand, revealDealerHand(dealerHand));
        } else {
          turnOrder.push(seat.seatIndex);
        }

        const game = await this.gameRepo.create(tx, {
          tableId,
          playerId: seat.playerId,
          deckSeed,
          deckState: [...deck],
          playerHand,
          dealerHand: [...dealerHand],
          betAmount: seat.betAmount,
          status,
          result,
        });
        createdGameIds.push(game.id);

        const player = await this.playerRepo.findById(tx, seat.playerId);
        if (!player) {
          throw new Error(`Player ${seat.playerId} not found`);
        }

        let persistedGame = game;
        let playerChips = player.chips;

        if (status === "FINISHED" && result !== null) {
          const settled = await this.finalizeFinishedGame(tx, game, result);
          playerChips = settled.chips;
          persistedGame = (await this.gameRepo.findById(tx, game.id))!;
        }

        games.set(seat.seatIndex, toGameStateView(persistedGame, playerChips));
      }

      const finalDeck = [...deck];
      for (const gameId of createdGameIds) {
        await this.gameRepo.update(tx, gameId, { deckState: finalDeck, dealerHand: [...dealerHand] });
      }

      await this.gameRepo.setTableStatus(tx, tableId, "ACTIVE");

      return {
        ok: true,
        games,
        dealerHand,
        turnOrder,
      };
    });
  }

  /**
   * Multiplayer-aware action handler. STAND marks the hand finished without
   * running the dealer — call `resolveTableDealerPhase` when all turns end.
   */
  async applyMultiplayerAction(
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
        return { ok: false, code: "GAME_NOT_FOUND", message: "Player not found" };
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
          nextGame = {
            ...game,
            status: "FINISHED",
            result: null,
          };
          break;
        case "DOUBLE_DOWN": {
          const ddOutcome = await this.processDoubleDown(tx, game, player, {
            deferDealer: true,
          });
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
      }

      return {
        ok: true,
        gameState: toGameStateView(updatedGame, nextPlayerChips),
        wasIdempotent: false,
      };
    });
  }

  async resolveTableDealerPhase(tableId: string): Promise<
    | { ok: true; games: GameStateView[]; dealerHand: Card[] }
    | ServiceError
  > {
    return this.db.transaction(async (tx) => {
      const activeGames = await this.gameRepo.findAllActiveByTable(tx, tableId);
      if (activeGames.length === 0) {
        return { ok: false, code: "GAME_NOT_FOUND", message: "No active games at table" };
      }

      const anchor = activeGames[0]!;
      const standResult = applyStand(anchor.deckState, anchor.dealerHand);
      if (!standResult.ok) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message: standResult.error.message,
        };
      }

      const dealerHand = revealDealerHand(standResult.value.dealerHand);
      const deckState = standResult.value.remainingDeck;
      const resolved: GameStateView[] = [];

      for (const game of activeGames) {
        let next = game;
        if (game.result === null) {
          const result = determineResult(game.playerHand, dealerHand);
          next = {
            ...game,
            dealerHand,
            deckState,
            status: "FINISHED",
            result,
          };
          next = await this.gameRepo.update(tx, game.id, {
            status: next.status,
            dealerHand: next.dealerHand,
            deckState: next.deckState,
            result: next.result,
          });

          const settled = await this.finalizeFinishedGame(
            tx,
            next,
            next.result as GameResult,
          );
          resolved.push(toGameStateView(next, settled.chips));
        } else {
          next = await this.gameRepo.update(tx, game.id, {
            dealerHand,
            deckState,
          });
          const player = await this.playerRepo.findById(tx, game.playerId);
          resolved.push(toGameStateView(next, player?.chips ?? 0));
        }
      }

      await this.gameRepo.setTableStatus(tx, tableId, "FINISHED");

      return { ok: true, games: resolved, dealerHand };
    });
  }

  async loadGameViewsByTable(tableId: string): Promise<GameStateView[]> {
    return this.db.transaction(async (tx) => {
      const rows = await this.gameRepo.findAllActiveByTable(tx, tableId);
      const views: GameStateView[] = [];
      for (const row of rows) {
        const player = await this.playerRepo.findById(tx, row.playerId);
        views.push(toGameStateView(row, player?.chips ?? 0));
      }
      return views;
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

      const existingForPlayer = await this.gameRepo.findActiveByTableAndPlayer(
        tx,
        tableId,
        playerId,
      );
      if (existingForPlayer) {
        return {
          ok: false,
          code: "TABLE_FULL",
          message: "You already have an active game at this table",
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
    options?: { deferDealer?: boolean },
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

    let nextGame: GameRow;
    if (bust) {
      nextGame = {
        ...game,
        playerHand,
        deckState,
        betAmount,
        status: "FINISHED",
        result: "LOSS",
      };
    } else if (options?.deferDealer) {
      nextGame = {
        ...game,
        playerHand,
        deckState,
        betAmount,
        status: "FINISHED",
        result: null,
      };
    } else {
      nextGame = this.runDealerAndResolve({
        ...game,
        playerHand,
        deckState,
        betAmount,
      });
    }

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
