import {
  calculateHandValue,
} from "@megabigwin777/game-core";
import type {
  Card,
  GameResult,
  GameState,
  GameStatus,
  Hand,
  PlayerActionType,
} from "../../../../contracts/domain";
import type { GameRow } from "../db/schema.js";

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

export function revealDealerHand(cards: Card[]): Card[] {
  return cards.map((c) => ({ ...c, hidden: false }));
}

export function rowToGameState(row: GameRow): GameState {
  const hideDealerHole = row.status === "PLAYER_TURN";
  const dealerCards = hideDealerHole
    ? row.dealerHand
    : revealDealerHand(row.dealerHand);

  return {
    gameId: row.id,
    tableId: row.tableId,
    playerId: row.playerId,
    status: row.status as GameStatus,
    playerHand: cardsToHand(row.playerHand),
    dealerHand: cardsToHand(dealerCards),
    betAmount: row.betAmount,
    result: (row.result as GameResult) ?? null,
    deckSeed: row.deckSeed,
    deckRemaining: row.deckState.length,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const ALLOWED_ACTIONS: Record<GameStatus, PlayerActionType[]> = {
  BETTING: [],
  DEALING: [],
  PLAYER_TURN: ["HIT", "STAND", "DOUBLE_DOWN"],
  DEALER_TURN: [],
  FINISHED: [],
};

export function availableActionsForGame(
  status: GameStatus,
  playerHand: Card[],
): PlayerActionType[] {
  if (status !== "PLAYER_TURN") return [];
  return playerHand.length === 2
    ? ["HIT", "STAND", "DOUBLE_DOWN"]
    : ["HIT", "STAND"];
}

export interface GameStateView extends GameState {
  availableActions: PlayerActionType[];
  playerChips: number;
}

export function toGameStateView(
  row: GameRow,
  playerChips: number,
): GameStateView {
  const state = rowToGameState(row);
  return {
    ...state,
    availableActions: availableActionsForGame(
      state.status,
      row.playerHand,
    ),
    playerChips,
  };
}
