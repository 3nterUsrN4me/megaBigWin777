import {
  GameService,
  cardsToHand,
  type GameStateView,
  type ServiceError,
  type SeatBet,
} from "@megabigwin777/game-service";
import type {
  Card,
  GameResult,
  PlayerActionType,
  RoomState,
  RoomStatus,
} from "../../../../contracts/domain.js";
import { buildRoomStateFromMeta, type RoomMeta } from "../wsPayloads.js";

const TABLE_MIN_BET = 10;
const TABLE_MAX_BET = 500;
const TABLE_MAX_PLAYERS = 5;
export const RECONNECT_GRACE_MS = 30_000;

export type { ServiceError };

export type DisconnectResult =
  | { gracePeriod: true; tableId: string; expiresAt: number }
  | { gracePeriod: false; tableId: null };

export type JoinRoomOk = {
  ok: true;
  roomState: RoomState;
  seatIndex: number;
  minBet: number;
  maxBet: number;
};

export type PlaceBetOk = {
  ok: true;
  roundStarted: boolean;
  game: GameStateView | null;
  slotIndex: number;
  playerChips: number;
  roomState: RoomState;
  minBet: number;
  maxBet: number;
};

export type ApplyActionOk = {
  ok: true;
  game: GameStateView;
  playerChips: number;
  wasIdempotent: boolean;
  roomState: RoomState;
  revealDealer: boolean;
};

export type ReconnectOk = {
  ok: true;
  roomState: RoomState;
  game: GameStateView | null;
  playerChips: number;
  minBet: number;
  maxBet: number;
};

interface PlayerState {
  seatIndex: number;
  playerId: string;
  username: string;
  chips: number;
  bet: number | null;
  gameId: string | null;
  isOnline: boolean;
  offlineSince: number | null;
}

interface SlotEntry {
  socketId: string | null;
  playerState: PlayerState;
}

interface DbRoom {
  tableId: string;
  roomStatus: RoomStatus;
  dealerHand: Card[];
  slots: Map<number, SlotEntry>;
  turnOrder: string[];
  activeTurnIndex: number;
}

export type OccupiedSlot = PlayerState & { socketId: string | null; game: GameStateView | null };

export class DbGameService {
  private readonly rooms = new Map<string, DbRoom>();
  private readonly gameViews = new Map<string, GameStateView>();

  constructor(private readonly gameService: GameService = new GameService()) {}

  async getPlayerChips(playerId: string): Promise<number> {
    const chips = await this.gameService.getPlayerChips(playerId);
    return chips ?? 1000;
  }

  getRoom(tableId: string): DbRoom | null {
    return this.rooms.get(tableId) ?? null;
  }

  async joinRoom(params: {
    tableId: string;
    playerId: string;
    username: string;
    socketId: string;
  }): Promise<JoinRoomOk | ServiceError> {
    const { tableId, playerId, username, socketId } = params;

    try {
      await this.gameService.ensureTable(tableId);
      await this.gameService.ensurePlayer(playerId, username);
    } catch {
      return { ok: false, code: "INTERNAL_ERROR", message: "Failed to initialize player session" };
    }

    let room = this.rooms.get(tableId);
    if (!room) room = this._createRoom(tableId);

    if (room.roomStatus === "PLAYING") {
      return { ok: false, code: "INVALID_ACTION", message: "Round in progress — use RECONNECT." };
    }
    if (room.roomStatus === "ROUND_OVER") this._resetRoom(room);

    const existingBySocket = this._findSeatBySocket(room, socketId);
    if (existingBySocket !== null) {
      return this._joinOk(room, existingBySocket);
    }
    if (room.slots.size >= TABLE_MAX_PLAYERS) {
      return { ok: false, code: "TABLE_FULL", message: `Table is full (max ${TABLE_MAX_PLAYERS} seats)` };
    }

    const seatIndex = this._nextAvailableSeat(room);
    const chips = await this.getPlayerChips(playerId);
    room.slots.set(seatIndex, {
      socketId,
      playerState: {
        seatIndex, playerId, username, chips,
        bet: null, gameId: null, isOnline: true, offlineSince: null,
      },
    });
    if (room.roomStatus === "WAITING_FOR_PLAYERS") room.roomStatus = "BETTING";
    return this._joinOk(room, seatIndex);
  }

  async joinSlot(params: {
    tableId: string;
    playerId: string;
    username: string;
    seatIndex: number;
    socketId: string;
  }): Promise<JoinRoomOk | ServiceError> {
    const { tableId, playerId, username, seatIndex, socketId } = params;

    try {
      await this.gameService.ensureTable(tableId);
      await this.gameService.ensurePlayer(playerId, username);
    } catch {
      return { ok: false, code: "INTERNAL_ERROR", message: "Failed to initialize player session" };
    }

    if (seatIndex < 0 || seatIndex >= TABLE_MAX_PLAYERS) {
      return { ok: false, code: "INVALID_ACTION", message: `Invalid seat index ${seatIndex}` };
    }

    let room = this.rooms.get(tableId);
    if (!room) room = this._createRoom(tableId);
    if (room.roomStatus === "PLAYING") {
      return { ok: false, code: "INVALID_ACTION", message: "Cannot join mid-round — use RECONNECT." };
    }
    if (room.roomStatus === "ROUND_OVER") this._resetRoom(room);

    if (room.slots.has(seatIndex)) {
      const occupant = room.slots.get(seatIndex)!;
      if (occupant.socketId === socketId) return this._joinOk(room, seatIndex);
      return { ok: false, code: "INVALID_ACTION", message: `Slot ${seatIndex} is already occupied` };
    }
    if (room.slots.size >= TABLE_MAX_PLAYERS) {
      return { ok: false, code: "TABLE_FULL", message: `Table is full (max ${TABLE_MAX_PLAYERS} seats)` };
    }

    const chips = await this.getPlayerChips(playerId);
    room.slots.set(seatIndex, {
      socketId,
      playerState: {
        seatIndex, playerId, username, chips,
        bet: null, gameId: null, isOnline: true, offlineSince: null,
      },
    });
    if (room.roomStatus === "WAITING_FOR_PLAYERS") room.roomStatus = "BETTING";
    return this._joinOk(room, seatIndex);
  }

  async placeBet(params: {
    tableId: string;
    playerId: string;
    betAmount: number;
    slotIndex?: number;
  }): Promise<PlaceBetOk | ServiceError> {
    const { tableId, playerId, betAmount } = params;
    const room = this.rooms.get(tableId);
    if (!room) {
      return { ok: false, code: "INVALID_ACTION", message: "Room not found — send JOIN_ROOM first" };
    }
    if (room.roomStatus !== "BETTING") {
      return { ok: false, code: "INVALID_ACTION", message: `Cannot place bet — room is "${room.roomStatus}"` };
    }

    let ps: PlayerState | undefined;
    let resolvedSlotIndex = 0;

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
      if (ps.bet !== betAmount) {
        return { ok: false, code: "INVALID_ACTION", message: `Bet already placed (${ps.bet}). Cannot change.` };
      }
      // Idempotent retry — all bets may already be in but a prior deal attempt failed.
      const roundResult = await this._tryStartRoundIfReady(
        room, tableId, playerId, resolvedSlotIndex,
      );
      if (roundResult !== null) return roundResult;
      return this._placeBetPendingOk(room, playerId, resolvedSlotIndex);
    }

    const reserved = await this.gameService.reserveBet(
      playerId, betAmount, TABLE_MIN_BET, TABLE_MAX_BET,
    );
    if (!reserved.ok) return reserved;

    ps.bet = betAmount;
    ps.chips = reserved.chips;
    for (const [, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) entry.playerState.chips = reserved.chips;
    }

    if (!this._allBetsIn(room)) {
      return this._placeBetPendingOk(room, playerId, resolvedSlotIndex, reserved.chips);
    }

    const roundResult = await this._tryStartRoundIfReady(
      room, tableId, playerId, resolvedSlotIndex,
    );
    if (roundResult === null) {
      return this._placeBetPendingOk(room, playerId, resolvedSlotIndex, reserved.chips);
    }
    if (!roundResult.ok) {
      await this.gameService.refundBet(playerId, betAmount);
      ps.bet = null;
      return roundResult;
    }
    return roundResult;
  }

  async reconnect(params: {
    tableId: string;
    playerId: string;
    username: string;
    socketId: string;
  }): Promise<ReconnectOk | ServiceError> {
    const { tableId, playerId, username, socketId } = params;
    const room = this.rooms.get(tableId);
    if (!room) {
      return { ok: false, code: "GAME_NOT_FOUND", message: "No active room at this table — send JOIN_ROOM" };
    }
    if (room.roomStatus === "ROUND_OVER") this._resetRoom(room);

    const ownedSeats = this._findAllSlotsByPlayer(room, playerId);
    if (ownedSeats.length === 0) {
      return { ok: false, code: "GAME_NOT_FOUND", message: "You are not seated — send JOIN_ROOM" };
    }

    const playerChips = await this.getPlayerChips(playerId);
    for (const slot of ownedSeats) {
      slot.username = username;
      slot.chips = playerChips;
      slot.isOnline = true;
      slot.offlineSince = null;
      if (slot.gameId) {
        const view = await this.gameService.getGameState(slot.gameId, playerId);
        if (view) this.gameViews.set(view.gameId, view);
      }
    }
    for (const [, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) entry.socketId = socketId;
    }

    const primary = ownedSeats[0];
    let primaryGame: GameStateView | null = null;
    if (primary?.gameId) {
      primaryGame = this.gameViews.get(primary.gameId) ??
        (await this.gameService.getGameState(primary.gameId, playerId));
    }

    return {
      ok: true,
      roomState: await this.buildRoomState(room),
      game: primaryGame,
      playerChips,
      minBet: TABLE_MIN_BET,
      maxBet: TABLE_MAX_BET,
    };
  }

  notifyDisconnect(socketId: string): DisconnectResult {
    for (const room of this.rooms.values()) {
      for (const [, entry] of room.slots) {
        if (entry.socketId === socketId) {
          entry.playerState.isOnline = false;
          entry.playerState.offlineSince = Date.now();
          return {
            gracePeriod: true,
            tableId: room.tableId,
            expiresAt: entry.playerState.offlineSince + RECONNECT_GRACE_MS,
          };
        }
      }
    }
    return { gracePeriod: false, tableId: null };
  }

  async expireDisconnectedSeats(tableId: string): Promise<number[]> {
    const room = this.rooms.get(tableId);
    if (!room) return [];

    const now = Date.now();
    const removed: number[] = [];
    for (const [slotIdx, entry] of room.slots) {
      const ps = entry.playerState;
      if (!ps.isOnline && ps.offlineSince !== null && now - ps.offlineSince >= RECONNECT_GRACE_MS) {
        if (room.roomStatus === "BETTING" && ps.bet !== null) {
          await this.gameService.refundBet(ps.playerId, ps.bet);
        }
        room.slots.delete(slotIdx);
        removed.push(slotIdx);
      }
    }

    if (room.slots.size === 0) {
      this.rooms.delete(tableId);
    } else if (room.roomStatus === "BETTING") {
      await this._maybeStartRoundAfterSeatChange(room);
    }
    return removed;
  }

  async getPlayerSeats(tableId: string, playerId: string): Promise<OccupiedSlot[]> {
    const room = this.rooms.get(tableId);
    if (!room) return [];
    const seats = this._findAllSlotsByPlayer(room, playerId);
    const result: OccupiedSlot[] = [];
    for (const seat of seats) {
      const entry = room.slots.get(seat.seatIndex);
      let game: GameStateView | null = null;
      if (seat.gameId) {
        game = this.gameViews.get(seat.gameId) ??
          (await this.gameService.getGameState(seat.gameId, playerId));
      }
      result.push({ ...seat, socketId: entry?.socketId ?? null, game });
    }
    return result;
  }

  async leaveRoom(params: { tableId: string; playerId: string }): Promise<{ roomState: RoomState | null }> {
    const { tableId, playerId } = params;
    const room = this.rooms.get(tableId);
    if (!room) return { roomState: null };

    for (const [slotIdx, entry] of room.slots) {
      const ps = entry.playerState;
      if (ps.playerId !== playerId) continue;
      if (room.roomStatus === "BETTING" && ps.bet !== null) {
        await this.gameService.refundBet(playerId, ps.bet);
      }
      room.slots.delete(slotIdx);
    }

    if (room.slots.size === 0) {
      this.rooms.delete(tableId);
      return { roomState: null };
    }

    if (room.roomStatus === "BETTING") {
      await this._maybeStartRoundAfterSeatChange(room);
    }
    return { roomState: await this.buildRoomState(room) };
  }

  async applyAction(params: {
    gameId: string;
    playerId: string;
    action: PlayerActionType;
    idempotencyKey: string;
    slotIndex: number;
  }): Promise<ApplyActionOk | ServiceError> {
    const { gameId, playerId, action, idempotencyKey, slotIndex } = params;

    let room: DbRoom | undefined;
    for (const r of this.rooms.values()) {
      const entry = r.slots.get(slotIndex);
      if (entry?.playerState.playerId === playerId && entry.playerState.gameId === gameId) {
        room = r;
        break;
      }
    }
    if (!room) {
      return { ok: false, code: "GAME_NOT_FOUND", message: "Game not found or does not belong to you" };
    }
    if (room.roomStatus !== "PLAYING") {
      return { ok: false, code: "INVALID_ACTION", message: `Room is not PLAYING (current: "${room.roomStatus}")` };
    }

    const currentSeatKey = room.turnOrder[room.activeTurnIndex];
    if (currentSeatKey !== String(slotIndex)) {
      return { ok: false, code: "INVALID_ACTION", message: "It is not your turn" };
    }

    let result;
    try {
      result = await this.gameService.applyMultiplayerAction(gameId, playerId, {
        type: action,
        idempotencyKey,
      });
    } catch {
      return { ok: false, code: "INTERNAL_ERROR", message: "Failed to process action" };
    }

    if (!result.ok) return result;

    const { gameState, wasIdempotent } = result;
    this.gameViews.set(gameState.gameId, gameState);

    const entry = room.slots.get(slotIndex)!;
    entry.playerState.chips = gameState.playerChips;
    for (const [, e] of room.slots) {
      if (e.playerState.playerId === playerId) e.playerState.chips = gameState.playerChips;
    }

    if (!wasIdempotent && gameState.status === "FINISHED") {
      this._advanceTurn(room);
    }

    let revealDealer = false;
    if (this._allOccupiedSlotsDone(room)) {
      await this._runDealerPhase(room);
      revealDealer = true;
      const refreshed = await this.gameService.getGameState(gameId, playerId);
      if (refreshed) this.gameViews.set(gameId, refreshed);
    }

    const latest = this.gameViews.get(gameId) ?? gameState;
    return {
      ok: true,
      game: latest,
      playerChips: latest.playerChips,
      wasIdempotent,
      roomState: await this.buildRoomState(room, revealDealer),
      revealDealer,
    };
  }

  /** Legacy JOIN_GAME — single transaction createGame path */
  async createGame(params: {
    tableId: string;
    playerId: string;
    betAmount: number;
  }): Promise<
    | { ok: true; gameState: GameStateView; minBet: number; maxBet: number }
    | ServiceError
  > {
    try {
      const result = await this.gameService.createGame(params);
      if (!result.ok) return result;
      this.gameViews.set(result.gameState.gameId, result.gameState);
      return {
        ok: true,
        gameState: result.gameState,
        minBet: TABLE_MIN_BET,
        maxBet: TABLE_MAX_BET,
      };
    } catch {
      return { ok: false, code: "INTERNAL_ERROR", message: "Failed to create game" };
    }
  }

  async buildRoomState(room: DbRoom, revealDealer = false): Promise<RoomState> {
    const seats: RoomMeta["seats"] = [];
    for (const [seatIndex, entry] of room.slots) {
      const ps = entry.playerState;
      let view = ps.gameId ? this.gameViews.get(ps.gameId) : undefined;
      if (!view && ps.gameId) {
        view = (await this.gameService.getGameState(ps.gameId, ps.playerId)) ?? undefined;
        if (view) this.gameViews.set(view.gameId, view);
      }
      seats.push({
        seatIndex,
        playerId: ps.playerId,
        username: ps.username,
        chips: ps.chips,
        bet: ps.bet,
        gameId: ps.gameId,
        gameStatus: view?.status ?? null,
        playerHand: view?.playerHand ?? null,
        result: (view?.result ?? null) as GameResult,
        isOnline: ps.isOnline,
      });
    }

    const dealerHand = room.dealerHand.length > 0
      ? cardsToHand(room.dealerHand)
      : null;

    return buildRoomStateFromMeta({
      tableId: room.tableId,
      roomStatus: room.roomStatus,
      turnOrder: room.turnOrder,
      activeTurnIndex: room.activeTurnIndex,
      minBet: TABLE_MIN_BET,
      maxBet: TABLE_MAX_BET,
      seats,
      dealerHand,
    });
  }

  private _createRoom(tableId: string): DbRoom {
    const room: DbRoom = {
      tableId,
      roomStatus: "WAITING_FOR_PLAYERS",
      dealerHand: [],
      slots: new Map(),
      turnOrder: [],
      activeTurnIndex: 0,
    };
    this.rooms.set(tableId, room);
    return room;
  }

  private _resetRoom(room: DbRoom): void {
    room.roomStatus = "BETTING";
    room.dealerHand = [];
    room.turnOrder = [];
    room.activeTurnIndex = 0;
    for (const [, entry] of room.slots) {
      const ps = entry.playerState;
      ps.bet = null;
      ps.gameId = null;
    }
    if (room.slots.size === 0) room.roomStatus = "WAITING_FOR_PLAYERS";
  }

  private async _joinOk(room: DbRoom, seatIndex: number): Promise<JoinRoomOk> {
    return {
      ok: true,
      roomState: await this.buildRoomState(room),
      seatIndex,
      minBet: TABLE_MIN_BET,
      maxBet: TABLE_MAX_BET,
    };
  }

  private _allOccupiedSlotsDone(room: DbRoom): boolean {
    for (const [, entry] of room.slots) {
      const gameId = entry.playerState.gameId;
      if (!gameId) return false;
      const view = this.gameViews.get(gameId);
      if (!view || view.status !== "FINISHED") return false;
    }
    return room.slots.size > 0;
  }

  private _advanceTurn(room: DbRoom): void {
    room.activeTurnIndex++;
    while (room.activeTurnIndex < room.turnOrder.length) {
      const seatKey = room.turnOrder[room.activeTurnIndex]!;
      const slotIdx = parseInt(seatKey, 10);
      const entry = room.slots.get(slotIdx);
      const view = entry?.playerState.gameId
        ? this.gameViews.get(entry.playerState.gameId)
        : undefined;
      if (view?.status === "FINISHED") {
        room.activeTurnIndex++;
      } else {
        break;
      }
    }
  }

  private async _runDealerPhase(room: DbRoom): Promise<void> {
    const resolved = await this.gameService.resolveTableDealerPhase(room.tableId);
    if (!resolved.ok) return;

    room.dealerHand = resolved.dealerHand;
    room.roomStatus = "ROUND_OVER";
    room.turnOrder = [];
    room.activeTurnIndex = 0;

    for (const view of resolved.games) {
      this.gameViews.set(view.gameId, view);
      for (const [, entry] of room.slots) {
        if (entry.playerState.gameId === view.gameId) {
          entry.playerState.chips = view.playerChips;
        }
      }
    }
  }

  private _findSeatBySocket(room: DbRoom, socketId: string): number | null {
    for (const [idx, entry] of room.slots) {
      if (entry.socketId === socketId) return idx;
    }
    return null;
  }

  private _findAllSlotsByPlayer(room: DbRoom, playerId: string): PlayerState[] {
    const result: PlayerState[] = [];
    for (const [, entry] of room.slots) {
      if (entry.playerState.playerId === playerId) result.push(entry.playerState);
    }
    return result;
  }

  private _nextAvailableSeat(room: DbRoom): number {
    for (let i = 0; i < TABLE_MAX_PLAYERS; i++) {
      if (!room.slots.has(i)) return i;
    }
    return room.slots.size;
  }

  /**
   * True when every online seated player has placed a bet.
   * Offline seats without a bet do not block the deal (they expire via grace period).
   */
  private _allBetsIn(room: DbRoom): boolean {
    const seated = Array.from(room.slots.values());
    if (seated.length === 0) return false;
    const online = seated.filter((e) => e.playerState.isOnline);
    if (online.length === 0) return false;
    return online.every((e) => e.playerState.bet !== null);
  }

  private async _placeBetPendingOk(
    room: DbRoom,
    playerId: string,
    slotIndex: number,
    chipsOverride?: number,
  ): Promise<PlaceBetOk> {
    const playerChips = chipsOverride ?? await this.getPlayerChips(playerId);
    return {
      ok: true,
      roundStarted: false,
      game: null,
      slotIndex,
      playerChips,
      roomState: await this.buildRoomState(room),
      minBet: TABLE_MIN_BET,
      maxBet: TABLE_MAX_BET,
    };
  }

  /**
   * When all online players have bet, deal cards via game-service and transition
   * the in-memory room to PLAYING (or ROUND_OVER if every hand is blackjack).
   */
  private async _tryStartRoundIfReady(
    room: DbRoom,
    tableId: string,
    actorPlayerId: string,
    actorSlotIndex: number,
  ): Promise<PlaceBetOk | ServiceError | null> {
    if (room.roomStatus !== "BETTING" || !this._allBetsIn(room)) return null;

    const seatBets: SeatBet[] = Array.from(room.slots.entries())
      .filter(([, entry]) => entry.playerState.bet !== null)
      .map(([seatIndex, entry]) => ({
        seatIndex,
        playerId: entry.playerState.playerId,
        betAmount: entry.playerState.bet!,
      }));

    if (seatBets.length === 0) return null;

    // Guarantee every seated player exists in DB before dealing.
    const seen = new Set<string>();
    for (const [, entry] of room.slots) {
      const { playerId, username } = entry.playerState;
      if (seen.has(playerId)) continue;
      seen.add(playerId);
      try {
        await this.gameService.ensurePlayer(playerId, username);
      } catch {
        return { ok: false, code: "INTERNAL_ERROR", message: "Failed to initialize player for deal" };
      }
    }

    let dealResult;
    try {
      dealResult = await this.gameService.startMultiplayerRound(tableId, seatBets);
    } catch {
      return { ok: false, code: "INTERNAL_ERROR", message: "Failed to start round" };
    }

    if (!dealResult.ok) return dealResult;

    room.dealerHand = dealResult.dealerHand;
    room.turnOrder = dealResult.turnOrder.map(String);
    room.activeTurnIndex = 0;
    room.roomStatus = "PLAYING";

    let actorGame: GameStateView | null = null;
    for (const [seatIndex, view] of dealResult.games) {
      const entry = room.slots.get(seatIndex);
      if (entry) {
        entry.playerState.gameId = view.gameId;
        this.gameViews.set(view.gameId, view);
        if (seatIndex === actorSlotIndex && entry.playerState.playerId === actorPlayerId) {
          actorGame = view;
        }
      }
    }

    if (dealResult.turnOrder.length === 0) {
      await this._runDealerPhase(room);
    }

    const playerChips = await this.getPlayerChips(actorPlayerId);
    return {
      ok: true,
      roundStarted: true,
      game: actorGame,
      slotIndex: actorSlotIndex,
      playerChips,
      roomState: await this.buildRoomState(room, true),
      minBet: TABLE_MIN_BET,
      maxBet: TABLE_MAX_BET,
    };
  }

  /** After a seat is removed, attempt to deal if remaining online players all bet. */
  private async _maybeStartRoundAfterSeatChange(room: DbRoom): Promise<void> {
    if (!this._allBetsIn(room)) return;
    const first = Array.from(room.slots.entries())[0];
    if (!first) return;
    const [seatIndex, entry] = first;
    await this._tryStartRoundIfReady(
      room, room.tableId, entry.playerState.playerId, seatIndex,
    );
  }
}
