import type {
  GameState,
  ConnectionStatus,
  ServerMessage,
  RoomAckMsg,
  ReconnectAckMsg,
  ReconnectFailedMsg,
  JoinAckMsg,
  DealMsg,
  GameStateMsg,
  RoomStateMsg,
  Hand,
  GameStatus,
  PlayerActionType,
  RoomStatus,
  TableSlot,
  SelfSeatBetState,
} from "./types.js";
import { TABLE_SLOTS_COUNT } from "./types.js";

// ─── Store shape ──────────────────────────────────────────────────────────────

export interface Store {
  connection:  ConnectionStatus;
  game:        GameState;
  /** playerId of the locally authenticated player (set on ROOM_ACK / JOIN_ACK) */
  myPlayerId:  string | null;
}

type Listener = (store: Store) => void;

// ─── Initial state ────────────────────────────────────────────────────────────

function emptySlots(): TableSlot[] {
  return Array.from({ length: TABLE_SLOTS_COUNT }, (_, i) => ({
    index:          i,
    playerId:       null,
    username:       "",
    chips:          0,
    betAmount:      0,
    hasBet:         false,
    hand:           null,
    result:         null,
    isActivePlayer: false,
    hasTurnEnded:   false,
    isSelf:         false,
    isJoinable:     false,
    isOnline:       true,
    gameId:         null,
  }));
}

function initialGame(): GameState {
  return {
    gameId:           null,
    tableId:          null,
    status:           null,
    playerHand:       null,
    dealerHand:       null,
    betAmount:        0,
    result:           null,
    availableActions: [],
    playerChips:      0,
    minBet:           10,
    maxBet:           500,
    otherPlayers:     {},
    activePlayerId:   null,
    roomStatus:       null,
    turnOrder:        [],
    hasBet:           false,
    slots:            emptySlots(),
    activeSeatIndex:  null,
    mySeatsBetting:   [],
    selectedBetSlotIndex: null,
  };
}

/**
 * Rebuild the 5-slot array from a ROOM_STATE message.
 *
 * The server now keys `players` by seatKey ("0"–"4"), so we can place each
 * entry directly at its correct slot index. Empty slots in BETTING/WAITING
 * are marked `isJoinable = true` for the "Take Seat" button.
 */
function buildSlots(
  msg: RoomStateMsg,
  myPlayerId: string | null,
  prevSlots: TableSlot[],
): TableSlot[] {
  const slots = emptySlots();
  const canJoin = msg.roomStatus === "WAITING_FOR_PLAYERS" || msg.roomStatus === "BETTING";

  // Place each occupied seat at its exact index
  for (const [seatKey, ps] of Object.entries(msg.players)) {
    const idx = ps.seatIndex ?? parseInt(seatKey, 10);
    if (idx < 0 || idx >= TABLE_SLOTS_COUNT) continue;

    const isSelf = ps.playerId === myPlayerId;
    slots[idx] = {
      index:          idx,
      playerId:       ps.playerId,
      username:       ps.username,
      chips:          ps.chips,
      betAmount:      ps.betAmount,
      hasBet:         ps.hasBet,
      hand:           ps.hand,
      result:         ps.result,
      isActivePlayer: ps.isActivePlayer,
      hasTurnEnded:   ps.hasTurnEnded,
      isSelf,
      isJoinable:     false,
      isOnline:       ps.isOnline ?? true,
      gameId:         prevSlots[idx]?.gameId ?? null,
    };
  }

  // Mark empty slots as joinable when appropriate
  for (let i = 0; i < TABLE_SLOTS_COUNT; i++) {
    if (!slots[i]!.playerId) {
      slots[i]!.isJoinable = canJoin;
    }
  }

  return slots;
}

// ─── Store ────────────────────────────────────────────────────────────────────

class GameStore {
  private state: Store = {
    connection: "disconnected",
    game:       initialGame(),
    myPlayerId: null,
  };

  private listeners = new Set<Listener>();

  // ── Subscriptions ────────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  getState(): Store {
    return this.state;
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  setConnection(status: ConnectionStatus): void {
    this.patch({ connection: status });
    if (status === "disconnected" || status === "error") {
      this.patch({ game: initialGame() });
    }
  }

  handleServerMessage(msg: ServerMessage): void {
    switch (msg.event) {
      case "ROOM_ACK":
        this.applyRoomAck(msg);
        break;
      case "RECONNECT_ACK":
        this.applyReconnectAck(msg);
        break;
      case "RECONNECT_FAILED":
        this.applyReconnectFailed(msg);
        break;
      case "JOIN_ACK":
        // Legacy server — treat as ROOM_ACK
        this.applyJoinAck(msg);
        break;
      case "DEAL":
        this.applyDeal(msg);
        break;
      case "GAME_STATE":
        this.applyGameState(msg);
        break;
      case "ROOM_STATE":
        this.applyRoomState(msg);
        break;
      case "ERROR":
        break;
      case "HEARTBEAT":
        break;
      case "PONG":
        break;
    }
  }

  resetGame(): void {
    this.patch({ game: initialGame() });
  }

  setChips(chips: number): void {
    this.patch({ game: { ...this.state.game, playerChips: chips } });
  }

  setSelectedBetSlot(seatIndex: number): void {
    this.patch({ game: { ...this.state.game, selectedBetSlotIndex: seatIndex } });
  }

  getActiveSeatIndex(): number | null {
    return resolveActiveSeatIndex(this.state.game);
  }

  getGameIdForSeat(seatIndex: number): string | null {
    return this.state.game.slots.find((s) => s.index === seatIndex)?.gameId ?? null;
  }

  getSelectedBetSeatIndex(): number | null {
    const { selectedBetSlotIndex, slots, roomStatus } = this.state.game;
    if (roomStatus !== "BETTING") return null;

    if (selectedBetSlotIndex !== null) {
      const selected = slots[selectedBetSlotIndex];
      if (selected?.isSelf && !selected.hasBet) return selectedBetSlotIndex;
    }

    const firstUnbet = slots.find((s) => s.isSelf && !s.hasBet);
    return firstUnbet?.index ?? null;
  }

  // ── Private message handlers ─────────────────────────────────────────────

  /**
   * ROOM_ACK — server confirmed the player's seat.
   * Room is now in BETTING phase; player must still send PLACE_BET.
   */
  private applyRoomAck(msg: RoomAckMsg): void {
    this.patch({
      myPlayerId: msg.playerId,
      game: {
        ...this.state.game,
        tableId:              msg.tableId,
        roomStatus:           msg.roomStatus,
        minBet:               msg.minBet,
        maxBet:               msg.maxBet,
        status:               null,
        hasBet:               false,
        mySeatsBetting:       [],
        activeSeatIndex:      null,
        activePlayerId:       null,
        selectedBetSlotIndex: null,
        availableActions:     [],
        gameId:               null,
      },
    });
  }

  /**
   * RECONNECT_ACK — player successfully reattached to an ongoing room.
   * The server will immediately follow up with ROOM_STATE (and GAME_STATE if PLAYING).
   */
  private applyReconnectAck(msg: ReconnectAckMsg): void {
    this.patch({
      myPlayerId: msg.playerId,
      game: {
        ...this.state.game,
        tableId:     msg.tableId,
        roomStatus:  msg.roomStatus,
        minBet:      msg.minBet,
        maxBet:      msg.maxBet,
        playerChips: msg.playerChips,
      },
    });
  }

  /**
   * RECONNECT_FAILED — player was not seated; must send JOIN_ROOM.
   * Trigger auto-join flow in the UI by resetting to lobby state.
   */
  private applyReconnectFailed(_msg: ReconnectFailedMsg): void {
    this.patch({
      game: {
        ...initialGame(),
        tableId: _msg.tableId,
      },
    });
  }

  /** Legacy JOIN_ACK (old server protocol) */
  private applyJoinAck(msg: JoinAckMsg): void {
    this.patch({
      myPlayerId: msg.playerId,
      game: {
        ...this.state.game,
        gameId:  msg.gameId,
        tableId: msg.tableId,
        status:  "DEALING",
        minBet:  msg.minBet,
        maxBet:  msg.maxBet,
        result:  null,
        availableActions: [],
      },
    });
  }

  /**
   * DEAL — cards were distributed (BETTING → PLAYING transition complete).
   * Marks hasBet = true and transitions local status to PLAYER_TURN.
   */
  private applyDeal(msg: DealMsg): void {
    const availableActions = deriveAvailableActions(msg.playerHand, "PLAYER_TURN");
    const seatIndex = msg.seatIndex ?? this.state.game.activeSeatIndex;

    const shouldApply =
      seatIndex === null ||
      seatIndex === this.state.game.activeSeatIndex ||
      this.state.game.activeSeatIndex === null;

    if (!shouldApply) {
      this.patch({
        game: {
          ...this.state.game,
          hasBet: true,
          slots: this._setSlotGameId(this.state.game.slots, seatIndex, msg.gameId),
        },
      });
      return;
    }

    this.patch({
      game: {
        ...this.state.game,
        gameId:           msg.gameId,
        status:           "PLAYER_TURN",
        playerHand:       msg.playerHand,
        dealerHand:       msg.dealerHand,
        result:           null,
        availableActions,
        hasBet:           true,
        activeSeatIndex:  seatIndex,
        slots:            this._setSlotGameId(this.state.game.slots, seatIndex, msg.gameId),
      },
    });
  }

  private applyGameState(msg: GameStateMsg): void {
    const hasBet = msg.betAmount > 0 || this.state.game.hasBet;
    const seatIndex = msg.seatIndex ?? this.state.game.activeSeatIndex;

    if (msg.status === "FINISHED") {
      this.patch({
        game: {
          ...this.state.game,
          playerChips: msg.playerChips,
          hasBet,
          slots: seatIndex !== null
            ? this._setSlotGameId(this.state.game.slots, seatIndex, msg.gameId)
            : this.state.game.slots,
        },
      });
      return;
    }

    const available =
      msg.availableActions.length > 0
        ? msg.availableActions
        : deriveAvailableActions(msg.playerHand, msg.status);

    const shouldApplyPersonal =
      seatIndex !== null &&
      (seatIndex === this.state.game.activeSeatIndex ||
        this.state.game.activeSeatIndex === null);

    this.patch({
      game: {
        ...this.state.game,
        playerChips: msg.playerChips,
        hasBet,
        ...(shouldApplyPersonal ? {
          gameId:           msg.gameId,
          status:           msg.status,
          playerHand:       msg.playerHand,
          dealerHand:       msg.dealerHand,
          betAmount:        msg.betAmount,
          result:           msg.result,
          availableActions: available,
          activeSeatIndex:  seatIndex,
          slots:            this._setSlotGameId(this.state.game.slots, seatIndex, msg.gameId),
        } : {}),
      },
    });
  }

  /**
   * ROOM_STATE — broadcasted table snapshot.
   *
   * This is the authoritative source for table layout, phase, and all player data.
   * In addition to per-player fields it rebuilds the 5-slot `slots` array used by
   * the table renderer.
   */
  private applyRoomState(msg: RoomStateMsg): void {
    const myId = this.state.myPlayerId;
    const otherPlayers: typeof msg.players = {};
    let myChips     = this.state.game.playerChips;
    let myBetAmount = this.state.game.betAmount;
    const mySeatsBetting: SelfSeatBetState[] = [];

    for (const [, ps] of Object.entries(msg.players)) {
      if (ps.playerId === myId) {
        // Chip balance is shared across all self-owned seats.
        myChips = ps.chips;
        if (ps.hasBet) myBetAmount = ps.betAmount;
        mySeatsBetting.push({ seatIndex: ps.seatIndex, hasBet: ps.hasBet });
      } else {
        otherPlayers[ps.seatKey] = ps;
      }
    }

    // Sort by seat index for stable ordering in the UI loop
    mySeatsBetting.sort((a, b) => a.seatIndex - b.seatIndex);

    // hasBet = true only when every own slot has placed its bet — this is the
    // signal to hide the bet panel and show "waiting for others / dealing".
    const myHasBet = mySeatsBetting.length > 0
      ? mySeatsBetting.every((s) => s.hasBet)
      : this.state.game.hasBet;

    const dealerHand  = msg.dealerHand ?? this.state.game.dealerHand;
    const isRoundOver = (msg.roomStatus as RoomStatus) === "ROUND_OVER";
    const slots       = buildSlots(msg, myId, this.state.game.slots);

    // Track which of our own seats is the active one (it's whose turn it is)
    let activeSeatIndex = this.state.game.activeSeatIndex;
    if (msg.activePlayerId !== null) {
      const activeSeatKey = msg.activePlayerId;
      const activePsEntry = msg.players[activeSeatKey];
      if (activePsEntry && activePsEntry.playerId === myId) {
        activeSeatIndex = activePsEntry.seatIndex;
      }
    }

    let availableActions = isRoundOver ? [] : this.state.game.availableActions;
    let gameId = this.state.game.gameId;
    if (!isRoundOver && activeSeatIndex !== null) {
      const activeSelf = slots.find(
        (s) => s.isSelf && s.index === activeSeatIndex && s.isActivePlayer,
      );
      if (activeSelf?.hand && !activeSelf.hasTurnEnded) {
        availableActions = deriveAvailableActions(activeSelf.hand, "PLAYER_TURN");
      } else if (activeSelf?.hasTurnEnded) {
        availableActions = [];
      }
      if (activeSelf?.gameId) gameId = activeSelf.gameId;
    }

    let selectedBetSlotIndex = this.state.game.selectedBetSlotIndex;
    if (msg.roomStatus === "BETTING" && selectedBetSlotIndex !== null) {
      const sel = slots[selectedBetSlotIndex];
      if (!sel?.isSelf || sel.hasBet) selectedBetSlotIndex = null;
    }
    if (msg.roomStatus === "BETTING" && selectedBetSlotIndex === null) {
      const firstUnbet = slots.find((s) => s.isSelf && !s.hasBet);
      if (firstUnbet) selectedBetSlotIndex = firstUnbet.index;
    }

    this.patch({
      game: {
        ...this.state.game,
        tableId:          msg.tableId,
        roomStatus:       msg.roomStatus,
        dealerHand,
        otherPlayers,
        activePlayerId:   msg.activePlayerId,
        turnOrder:        msg.turnOrder,
        minBet:           msg.minBet,
        maxBet:           msg.maxBet,
        hasBet:           isRoundOver ? false : myHasBet,
        playerChips:      myChips,
        betAmount:        isRoundOver ? 0 : myBetAmount,
        gameId:           isRoundOver ? null : gameId,
        availableActions,
        slots: isRoundOver
          ? slots.map((s) => ({ ...s, gameId: null }))
          : slots,
        activeSeatIndex:  isRoundOver ? null : activeSeatIndex,
        mySeatsBetting:   isRoundOver ? [] : mySeatsBetting,
        selectedBetSlotIndex: isRoundOver ? null : selectedBetSlotIndex,
      },
    });
  }

  /** Persist gameId on a slot so PLAYER_ACTION can target the correct hand */
  private _setSlotGameId(slots: TableSlot[], seatIndex: number | null, gameId: string): TableSlot[] {
    if (seatIndex === null) return slots;
    return slots.map((s) =>
      s.index === seatIndex ? { ...s, gameId } : s,
    );
  }

  private patch(partial: Partial<Store>): void {
    this.state = { ...this.state, ...partial } as Store;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Active slot index when it is this client's turn during PLAYING; otherwise null */
export function resolveActiveSeatIndex(game: GameState): number | null {
  const { activeSeatIndex, slots, roomStatus } = game;
  if (roomStatus !== "PLAYING" || activeSeatIndex === null) return null;
  const active = slots.find(
    (s) => s.isSelf && s.index === activeSeatIndex && s.isActivePlayer,
  );
  return active ? activeSeatIndex : null;
}

function deriveAvailableActions(hand: Hand | null, status: GameStatus | null): PlayerActionType[] {
  if (status !== "PLAYER_TURN" || !hand || hand.isBust || hand.isBlackjack) return [];
  return hand.cards.length === 2
    ? ["HIT", "STAND", "DOUBLE_DOWN"]
    : ["HIT", "STAND"];
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const store = new GameStore();
