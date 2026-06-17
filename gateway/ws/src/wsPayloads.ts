import { cardsToHand, revealDealerHand } from "@megabigwin777/game-service";
import type { GameStateView } from "@megabigwin777/game-service";
import type { Card, Hand, RoomState } from "../../../contracts/domain.js";

export { cardsToHand, revealDealerHand };

export function gameStateViewToPayload(
  view: GameStateView,
  seatIndex?: number,
): Record<string, unknown> {
  return {
    event: "GAME_STATE",
    v: "1",
    gameId: view.gameId,
    ...(seatIndex !== undefined ? { seatIndex } : {}),
    status: view.status,
    playerHand: view.playerHand,
    dealerHand: view.dealerHand,
    betAmount: view.betAmount,
    result: view.result,
    availableActions: view.availableActions,
    playerChips: view.playerChips,
  };
}

export function buildDealPayload(
  view: GameStateView,
  seatIndex?: number,
): Record<string, unknown> {
  const dealerCards = view.dealerHand.cards.map((c) =>
    c.hidden ? { suit: "SPADES" as const, rank: "2" as const, hidden: true } : c,
  );

  return {
    event: "DEAL",
    v: "1",
    gameId: view.gameId,
    ...(seatIndex !== undefined ? { seatIndex } : {}),
    playerHand: view.playerHand,
    dealerHand: cardsToHand(dealerCards),
  };
}

export function buildJoinAckPayload(params: {
  gameId: string;
  tableId: string;
  playerId: string;
  sessionId: string;
  minBet: number;
  maxBet: number;
}): Record<string, unknown> {
  return {
    event: "JOIN_ACK",
    v: "1",
    ...params,
  };
}

export function sanitiseDealerHand(hand: Hand, hideHole: boolean): Hand {
  if (!hideHole) return hand;
  const cards: Card[] = hand.cards.map((c) =>
    c.hidden ? { suit: "SPADES", rank: "2", hidden: true } : c,
  );
  return cardsToHand(cards);
}

export type RoomMeta = {
  tableId: string;
  roomStatus: RoomState["roomStatus"];
  turnOrder: string[];
  activeTurnIndex: number;
  minBet: number;
  maxBet: number;
  seats: Array<{
    seatIndex: number;
    playerId: string;
    username: string;
    chips: number;
    bet: number | null;
    gameId: string | null;
    gameStatus: string | null;
    playerHand: Hand | null;
    result: RoomState["players"][string]["result"];
    isOnline: boolean;
  }>;
  dealerHand: Hand | null;
};

export function buildRoomStateFromMeta(meta: RoomMeta): RoomState {
  const isPlaying = meta.roomStatus === "PLAYING";
  const isRoundOver = meta.roomStatus === "ROUND_OVER";
  const activeSeatKey =
    isPlaying && meta.turnOrder.length > 0
      ? (meta.turnOrder[meta.activeTurnIndex] ?? null)
      : null;

  let dealerHand = meta.dealerHand;
  if (dealerHand && isPlaying && !isRoundOver) {
    dealerHand = sanitiseDealerHand(dealerHand, true);
  } else if (dealerHand && isRoundOver) {
    dealerHand = cardsToHand(revealDealerHand(dealerHand.cards));
  }

  const players: RoomState["players"] = {};
  for (const seat of meta.seats) {
    const seatKey = String(seat.seatIndex);
    const hasTurnEnded = seat.gameStatus === "FINISHED";

    players[seatKey] = {
      seatKey,
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      username: seat.username,
      hand: seat.playerHand,
      betAmount: seat.bet ?? 0,
      hasBet: seat.bet !== null,
      result: seat.result,
      chips: seat.chips,
      isActivePlayer: seatKey === activeSeatKey,
      hasTurnEnded,
      isOnline: seat.isOnline,
    };
  }

  return {
    event: "ROOM_STATE",
    v: "1",
    tableId: meta.tableId,
    roomStatus: meta.roomStatus,
    activePlayerId: activeSeatKey,
    dealerHand,
    players,
    turnOrder: meta.turnOrder,
    minBet: meta.minBet,
    maxBet: meta.maxBet,
  };
}
