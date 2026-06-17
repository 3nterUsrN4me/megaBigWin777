import type {
  ServerMessage,
  PingMsg,
  JoinRoomMsg,
  JoinSlotMsg,
  PlaceBetMsg,
  ReconnectMsg,
  JoinGameMsg,
  PlayerActionMsg,
  LeaveGameMsg,
  PlayerActionType,
} from "./types.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const WS_URL = import.meta.env["VITE_WS_URL"] ?? "ws://localhost:3001/ws";
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS  = 60_000;
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;

// ─── Event callbacks ──────────────────────────────────────────────────────────

export interface WsClientCallbacks {
  onMessage:    (msg: ServerMessage) => void;
  onOpen:       () => void;
  onClose:      (code: number, reason: string) => void;
  onError:      (err: Event) => void;
  onLog:        (text: string, level?: "info" | "warn" | "error") => void;
}

/**
 * Resolvers read live UI state so every outbound message targets the correct slot.
 * Wired from main.ts against the game store.
 */
export interface WsClientSlotResolvers {
  /** Slot whose turn is active (highlighted) — used for HIT / STAND / DOUBLE */
  getActiveSeatIndex: () => number | null;
  /** gameId stored on that slot after DEAL */
  getGameIdForSeat: (seatIndex: number) => string | null;
  /** Slot selected for the next PLACE_BET (one bet per click) */
  getSelectedBetSeatIndex: () => number | null;
}

// ─── WsClient ─────────────────────────────────────────────────────────────────

export class WsClient {
  private ws: WebSocket | null = null;
  private token: string;
  private callbacks: WsClientCallbacks;
  private slotResolvers: WsClientSlotResolvers | null = null;

  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutId:  ReturnType<typeof setTimeout>  | null = null;
  private reconnectAttempts = 0;
  private intentionalClose  = false;

  constructor(token: string, callbacks: WsClientCallbacks) {
    this.token     = token;
    this.callbacks = callbacks;
  }

  /** Connect store resolvers — call once after construction */
  setSlotResolvers(resolvers: WsClientSlotResolvers): void {
    this.slotResolvers = resolvers;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    this.intentionalClose = false;
    this.log(`Łączę z ${WS_URL}…`);

    const url = `${WS_URL}?token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.log(`Błąd tworzenia WebSocket: ${String(e)}`, "error");
      return;
    }

    this.ws.addEventListener("open",    this.handleOpen);
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close",   this.handleClose);
    this.ws.addEventListener("error",   this.handleError);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
  }

  sendJoinRoom(tableId: string): void {
    this.send({ event: "JOIN_ROOM", v: "1", tableId } satisfies JoinRoomMsg);
  }

  sendJoinSlot(tableId: string, seatIndex: number): void {
    this.send({ event: "JOIN_SLOT", v: "1", tableId, seatIndex } satisfies JoinSlotMsg);
  }

  /**
   * Place a bet on exactly one slot.
   * Uses explicit seatIndex or the store's selected bet slot.
   */
  sendPlaceBet(tableId: string, betAmount: number, seatIndex?: number): void {
    const resolved =
      seatIndex ??
      this.slotResolvers?.getSelectedBetSeatIndex() ??
      null;

    if (resolved === null) {
      this.log("PLACE_BET — wybierz slot (kliknij miejsce przy stole)", "warn");
      return;
    }

    this.send({
      event: "PLACE_BET",
      v: "1",
      tableId,
      betAmount,
      seatIndex: resolved,
    } satisfies PlaceBetMsg);
  }

  sendReconnect(tableId: string): void {
    this.send({ event: "RECONNECT", v: "1", tableId } satisfies ReconnectMsg);
  }

  sendJoin(msg: Omit<JoinGameMsg, "event" | "v">): void {
    this.send({ event: "JOIN_GAME", v: "1", ...msg } satisfies JoinGameMsg);
  }

  /** HIT on the currently active (highlighted) slot */
  sendHit(): void {
    this._sendPlayerAction("HIT");
  }

  /** STAND on the currently active (highlighted) slot */
  sendStand(): void {
    this._sendPlayerAction("STAND");
  }

  sendDoubleDown(): void {
    this._sendPlayerAction("DOUBLE_DOWN");
  }

  sendAction(msg: Omit<PlayerActionMsg, "event" | "v"> & { seatIndex: number }): void {
    this.send({ event: "PLAYER_ACTION", v: "1", ...msg });
  }

  sendLeave(tableId: string): void {
    this.send({ event: "LEAVE_GAME", v: "1", tableId } satisfies LeaveGameMsg);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  updateToken(newToken: string): void {
    this.token = newToken;
  }

  // ── Player action (always uses active highlighted slot) ───────────────────

  private _sendPlayerAction(action: PlayerActionType): void {
    const seatIndex = this.slotResolvers?.getActiveSeatIndex() ?? null;
    if (seatIndex === null) {
      this.log(`${action} — brak aktywnego slotu (to nie Twoja tura?)`, "warn");
      return;
    }

    const gameId = this.slotResolvers?.getGameIdForSeat(seatIndex) ?? null;
    if (!gameId) {
      this.log(`${action} — brak gameId dla slotu ${seatIndex}`, "warn");
      return;
    }

    this.sendAction({
      gameId,
      action,
      idempotencyKey: crypto.randomUUID(),
      seatIndex,
    });
    this.log(`→ PLAYER_ACTION ${action} (seat ${seatIndex})`, "info");
  }

  // ── Private handlers ────────────────────────────────────────────────────────

  private handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.log("Połączono ✓", "info");
    this.startHeartbeat();
    this.callbacks.onOpen();
  };

  private handleMessage = (event: MessageEvent): void => {
    const raw = event.data as string;
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log(`Nieczytelna wiadomość: ${raw.slice(0, 100)}`, "warn");
      return;
    }

    if (!isServerMessage(parsed)) {
      this.log(`Nieznany typ wiadomości: ${JSON.stringify(parsed).slice(0, 80)}`, "warn");
      return;
    }

    if (parsed.event === "PONG") {
      this.resetPongTimeout();
      this.log(`← PONG (${Date.now() - (parsed.timestamp ?? Date.now())} ms)`, "info");
      return;
    }

    this.callbacks.onMessage(parsed);
  };

  private handleClose = (event: CloseEvent): void => {
    this.stopHeartbeat();
    const reason = event.reason || "(no reason)";
    this.log(`WebSocket zamknięty [${event.code}] ${reason}`, "warn");
    this.callbacks.onClose(event.code, reason);

    if (!this.intentionalClose && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
      this.log(`Próba reconnect ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} za ${delay / 1000}s…`, "warn");
      setTimeout(() => this.connect(), delay);
    }
  };

  private handleError = (event: Event): void => {
    this.log("Błąd WebSocket", "error");
    this.callbacks.onError(event);
  };

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingIntervalId = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    this.resetPongTimeout();
  }

  private stopHeartbeat(): void {
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  private sendPing(): void {
    const msg: PingMsg = { event: "PING", v: "1", timestamp: Date.now() };
    this.send(msg);
    this.log(`→ PING`, "info");
  }

  private resetPongTimeout(): void {
    if (this.pongTimeoutId !== null) clearTimeout(this.pongTimeoutId);
    this.pongTimeoutId = setTimeout(() => {
      this.log("Heartbeat timeout — brak odpowiedzi serwera. Zamykam.", "error");
      this.ws?.close(1000, "Heartbeat timeout");
    }, PONG_TIMEOUT_MS);
  }

  private send(data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("Nie można wysłać — brak połączenia", "warn");
      return;
    }
    this.ws.send(JSON.stringify(data));
  }

  private log(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.callbacks.onLog(text, level);
  }
}

function isServerMessage(v: unknown): v is ServerMessage {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj["event"] === "string" && obj["v"] === "1";
}
