import type {
  GameState,
  ConnectionStatus,
  ServerMessage,
  JoinAckMsg,
  DealMsg,
  GameStateMsg,
  Hand,
  GameStatus,
  PlayerActionType,
} from "./types.js";

// ─── Store shape ──────────────────────────────────────────────────────────────

export interface Store {
  connection: ConnectionStatus;
  game: GameState;
}

type Listener = (store: Store) => void;

// ─── Initial state ────────────────────────────────────────────────────────────

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
  };
}

// ─── Store (observable, no external deps) ────────────────────────────────────

class GameStore {
  private state: Store = {
    connection: "disconnected",
    game: initialGame(),
  };

  private listeners = new Set<Listener>();

  // ── Subscriptions ────────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state); // emit current state immediately
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
      case "JOIN_ACK":
        this.applyJoinAck(msg);
        break;
      case "DEAL":
        this.applyDeal(msg);
        break;
      case "GAME_STATE":
        this.applyGameState(msg);
        break;
      case "ERROR":
        // Errors are surfaced via the log; no state mutation here
        break;
      case "HEARTBEAT":
        // Server heartbeat — could update lastServerTime if needed
        break;
      case "PONG":
        // Already handled in WsClient
        break;
    }
  }

  resetGame(): void {
    this.patch({ game: initialGame() });
  }

  setChips(chips: number): void {
    this.patch({ game: { ...this.state.game, playerChips: chips } });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private applyJoinAck(msg: JoinAckMsg): void {
    this.patch({
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

  private applyDeal(msg: DealMsg): void {
    // After DEAL the game moves to PLAYER_TURN (unless it's an immediate blackjack,
    // in which case the server will immediately follow up with GAME_STATE FINISHED).
    // Derive availableActions locally so buttons are active right away without
    // waiting for a GAME_STATE message that the server may not send after DEAL.
    const availableActions = deriveAvailableActions(msg.playerHand, "PLAYER_TURN");

    this.patch({
      game: {
        ...this.state.game,
        gameId:     msg.gameId,
        status:     "PLAYER_TURN",
        playerHand: msg.playerHand,
        dealerHand: msg.dealerHand,
        result:     null,
        availableActions,
      },
    });
  }

  private applyGameState(msg: GameStateMsg): void {
    // Trust server's availableActions when present and non-empty.
    // If the server sends an empty array but status is still PLAYER_TURN,
    // derive actions locally as a fallback (guards against protocol gaps).
    const available =
      msg.availableActions.length > 0
        ? msg.availableActions
        : deriveAvailableActions(msg.playerHand, msg.status);

    this.patch({
      game: {
        ...this.state.game,
        gameId:           msg.gameId,
        status:           msg.status,
        playerHand:       msg.playerHand,
        dealerHand:       msg.dealerHand,
        betAmount:        msg.betAmount,
        result:           msg.result,
        availableActions: available,
        playerChips:      msg.playerChips,
      },
    });
  }

  private patch(partial: Partial<Store>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derives the allowed player actions from the current hand and game status.
 * Used as a client-side fallback when the server omits `availableActions`
 * (e.g. after DEAL, where the server only sends DEAL but not GAME_STATE).
 */
function deriveAvailableActions(hand: Hand | null, status: GameStatus | null): PlayerActionType[] {
  if (status !== "PLAYER_TURN" || !hand || hand.isBust || hand.isBlackjack) return [];
  // DOUBLE_DOWN is only legal on the initial two-card hand
  return hand.cards.length === 2
    ? ["HIT", "STAND", "DOUBLE_DOWN"]
    : ["HIT", "STAND"];
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const store = new GameStore();
