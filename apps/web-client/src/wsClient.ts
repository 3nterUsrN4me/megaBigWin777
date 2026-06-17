import type { ServerMessage, PingMsg, JoinGameMsg, PlayerActionMsg, LeaveGameMsg } from "./types.js";

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

// ─── WsClient ─────────────────────────────────────────────────────────────────

export class WsClient {
  private ws: WebSocket | null = null;
  private token: string;
  private callbacks: WsClientCallbacks;

  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutId:  ReturnType<typeof setTimeout>  | null = null;
  private reconnectAttempts = 0;
  private intentionalClose  = false;

  constructor(token: string, callbacks: WsClientCallbacks) {
    this.token     = token;
    this.callbacks = callbacks;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    this.intentionalClose = false;
    this.log(`Łączę z ${WS_URL}…`);

    // Native WebSocket doesn't support custom headers — we pass the JWT
    // as a subprotocol token trick OR via query param for local dev.
    // The gateway reads Authorization header during HTTP Upgrade;
    // Vite's dev server proxy can inject it, but for direct connection
    // we use a query parameter that the gateway also accepts.
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

  sendJoin(msg: Omit<JoinGameMsg, "event" | "v">): void {
    this.send({ event: "JOIN_GAME", v: "1", ...msg });
  }

  sendAction(msg: Omit<PlayerActionMsg, "event" | "v">): void {
    this.send({ event: "PLAYER_ACTION", v: "1", ...msg });
  }

  sendLeave(gameId: string): void {
    this.send({ event: "LEAVE_GAME", v: "1", gameId } satisfies LeaveGameMsg);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  updateToken(newToken: string): void {
    this.token = newToken;
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

    // Reset pong timeout on any server message — server is alive
    this.resetPongTimeout();

    // Handle PONG specifically for heartbeat tracking
    if (parsed.event === "PONG") {
      this.log(`← PONG (${Date.now() - parsed.timestamp} ms)`, "info");
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

  // ── Heartbeat ────────────────────────────────────────────────────────────────

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
      this.ws?.close(1001, "Heartbeat timeout");
    }, PONG_TIMEOUT_MS);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Type guard ───────────────────────────────────────────────────────────────

function isServerMessage(v: unknown): v is ServerMessage {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj["event"] === "string" && obj["v"] === "1";
}
