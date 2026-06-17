import { store } from "./gameStore.js";
import { WsClient } from "./wsClient.js";
import { renderUI, appendLog } from "./renderer.js";
import type { ServerMessage } from "./types.js";

// ─── Dev JWT helper ───────────────────────────────────────────────────────────
// Generates a HS256 JWT client-side using the dev secret.
// NOTE: This is ONLY for local development — real auth must use the auth-lobby service.

const DEV_SECRET = import.meta.env["VITE_JWT_SECRET"] ?? "dev-secret-for-testing-CHANGE-IN-PROD!!";

async function signDevJwt(playerId: string): Promise<string> {
  const header  = { alg: "HS256", typ: "JWT" };
  const payload = { sub: playerId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };

  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(DEV_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${signingInput}.${sigB64}`;
}

// ─── Globals ──────────────────────────────────────────────────────────────────

let wsClient: WsClient | null = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const btnJoin     = $<HTMLButtonElement>("btn-join");
const btnHit      = $<HTMLButtonElement>("btn-hit");
const btnStand    = $<HTMLButtonElement>("btn-stand");
const btnDouble   = $<HTMLButtonElement>("btn-double");
const btnLeave    = $<HTMLButtonElement>("btn-leave");
const btnNewGame  = $<HTMLButtonElement>("btn-new-game");
const inputTable  = $<HTMLInputElement>("input-table-id");
const inputBet    = $<HTMLInputElement>("input-bet");
const inputPlayer = $<HTMLInputElement>("input-player-id");

// ─── Store subscription → render ─────────────────────────────────────────────

store.subscribe((s) => renderUI(s));

// ─── Button handlers ──────────────────────────────────────────────────────────

btnJoin?.addEventListener("click", async () => {
  const tableId  = inputTable?.value.trim()  || "table-dev-001";
  const betAmount = parseInt(inputBet?.value ?? "50", 10) || 50;
  const playerId = inputPlayer?.value.trim() || "player-dev-001";

  if (!wsClient || !wsClient.isConnected()) {
    store.setConnection("connecting");
    appendLog(`Generuję token JWT dla gracza "${playerId}"…`);

    let token: string;
    try {
      token = await signDevJwt(playerId);
      appendLog("Token JWT wygenerowany ✓");
    } catch (e) {
      appendLog(`Błąd generowania JWT: ${String(e)}`, "error");
      store.setConnection("error");
      return;
    }

    wsClient = new WsClient(token, {
      onOpen() {
        store.setConnection("connected");
        appendLog("Połączono z serwerem ✓", "info");
        // After connection, join the game
        wsClient!.sendJoin({ tableId, betAmount });
        appendLog(`→ JOIN_GAME (table: ${tableId}, bet: ${betAmount})`, "info");
      },
      onMessage(msg: ServerMessage) {
        appendLog(`← ${msg.event}${msg.event === "GAME_STATE" ? ` [${(msg as { status?: string }).status ?? ""}]` : ""}`, "info");
        store.handleServerMessage(msg);

        if (msg.event === "ERROR") {
          appendLog(`  ⚠ [${msg.code}] ${msg.message}`, "error");
        }
        if (msg.event === "GAME_STATE" && msg.result) {
          appendLog(`  → Wynik: ${msg.result} | Chips: ${msg.playerChips}`, "info");
        }
      },
      onClose(code, reason) {
        store.setConnection("disconnected");
        appendLog(`Rozłączono [${code}] ${reason}`, "warn");
        wsClient = null;
      },
      onError() {
        store.setConnection("error");
        appendLog("Błąd połączenia WebSocket", "error");
      },
      onLog(text, level = "info") {
        appendLog(text, level);
      },
    });

    wsClient.connect();
  } else {
    // Already connected — just send JOIN_GAME
    wsClient.sendJoin({ tableId, betAmount });
    appendLog(`→ JOIN_GAME (table: ${tableId}, bet: ${betAmount})`, "info");
  }
});

btnHit?.addEventListener("click", () => {
  const { gameId } = store.getState().game;
  if (!gameId || !wsClient) return;

  const idempotencyKey = crypto.randomUUID();
  wsClient.sendAction({ gameId, action: "HIT", idempotencyKey });
  appendLog(`→ PLAYER_ACTION HIT`, "info");
});

btnStand?.addEventListener("click", () => {
  const { gameId } = store.getState().game;
  if (!gameId || !wsClient) return;

  const idempotencyKey = crypto.randomUUID();
  wsClient.sendAction({ gameId, action: "STAND", idempotencyKey });
  appendLog(`→ PLAYER_ACTION STAND`, "info");
});

btnDouble?.addEventListener("click", () => {
  const { gameId } = store.getState().game;
  if (!gameId || !wsClient) return;

  const idempotencyKey = crypto.randomUUID();
  wsClient.sendAction({ gameId, action: "DOUBLE_DOWN", idempotencyKey });
  appendLog(`→ PLAYER_ACTION DOUBLE_DOWN`, "info");
});

btnLeave?.addEventListener("click", () => {
  const { gameId } = store.getState().game;
  if (!gameId || !wsClient) return;

  wsClient.sendLeave(gameId);
  appendLog(`→ LEAVE_GAME`, "info");
  store.resetGame();
});

btnNewGame?.addEventListener("click", () => {
  const state  = store.getState();
  const tableId = inputTable?.value.trim() || state.game.tableId || "table-dev-001";
  const betAmount = parseInt(inputBet?.value ?? "50", 10) || 50;

  store.resetGame();

  if (wsClient?.isConnected()) {
    wsClient.sendJoin({ tableId, betAmount });
    appendLog(`→ JOIN_GAME (table: ${tableId}, bet: ${betAmount})`, "info");
  } else {
    appendLog("Brak połączenia — kliknij JOIN ROOM, aby się połączyć.", "warn");
  }
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;

  switch (e.key.toLowerCase()) {
    case "h": btnHit?.click();    break;
    case "s": btnStand?.click();  break;
    case "d": btnDouble?.click(); break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Auto-fill Player ID with a stable UUID stored in sessionStorage
// so the same player persists across page refreshes but is fresh per tab.
if (inputPlayer) {
  const stored = sessionStorage.getItem("megabigwin_player_id");
  if (stored) {
    inputPlayer.value = stored;
  } else {
    const newId = crypto.randomUUID();
    inputPlayer.value = newId;
    sessionStorage.setItem("megabigwin_player_id", newId);
  }
}

appendLog("MegaBigWin777 Blackjack Client v1.0 gotowy.", "info");
appendLog("Skróty: [H] HIT  [S] STAND  [D] DOUBLE DOWN", "info");
