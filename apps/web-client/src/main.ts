import { store } from "./gameStore.js";
import { WsClient } from "./wsClient.js";
import { renderUI, appendLog } from "./renderer.js";
import type { ServerMessage } from "./types.js";

// ─── Dev JWT helper ───────────────────────────────────────────────────────────

const DEV_SECRET = import.meta.env["VITE_JWT_SECRET"] ?? "dev-secret-for-testing-CHANGE-IN-PROD!!";

async function signDevJwt(playerId: string): Promise<string> {
  const header  = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: playerId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(DEV_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig     = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigB64  = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${signingInput}.${sigB64}`;
}

// ─── Globals ──────────────────────────────────────────────────────────────────

let wsClient: WsClient | null = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const btnJoin      = $<HTMLButtonElement>("btn-join");
const btnHit       = $<HTMLButtonElement>("btn-hit");
const btnStand     = $<HTMLButtonElement>("btn-stand");
const btnDouble    = $<HTMLButtonElement>("btn-double");
const btnLeave     = $<HTMLButtonElement>("btn-leave");
const btnLeaveAfter = $<HTMLButtonElement>("btn-leave-after");
const btnNewGame   = $<HTMLButtonElement>("btn-new-game");
const btnPlaceBet  = $<HTMLButtonElement>("btn-place-bet");
const inputTable   = $<HTMLInputElement>("input-table-id");
const inputBet     = $<HTMLInputElement>("input-bet");
const inputPlayer  = $<HTMLInputElement>("input-player-id");

// ─── Store → render ───────────────────────────────────────────────────────────

store.subscribe((s) => renderUI(s));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Connect (or reuse connection) and emit onConnected callback once open. */
async function ensureConnected(playerId: string, onConnected: () => void): Promise<void> {
  if (wsClient?.isConnected()) {
    onConnected();
    return;
  }

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
      onConnected();
    },
    onMessage(msg: ServerMessage) {
      const detail = msg.event === "GAME_STATE"
        ? ` [${(msg as { status?: string }).status ?? ""}]`
        : "";
      appendLog(`← ${msg.event}${detail}`, "info");
      store.handleServerMessage(msg);

      if (msg.event === "ERROR") {
        appendLog(`  ⚠ [${msg.code}] ${msg.message}`, "error");
      }
      if (msg.event === "GAME_STATE" && msg.result) {
        appendLog(`  → Wynik: ${msg.result} | Chips: ${msg.playerChips}`, "info");
      }
      if (msg.event === "RECONNECT_FAILED") {
        // Server says we were never seated — fall through to lobby
        appendLog("Rekoneks nieudany — wróć do lobby", "warn");
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

  wireWsClientResolvers(wsClient);
  wsClient.connect();
}

function wireWsClientResolvers(client: WsClient): void {
  client.setSlotResolvers({
    getActiveSeatIndex:    () => store.getActiveSeatIndex(),
    getGameIdForSeat:      (seatIndex) => store.getGameIdForSeat(seatIndex),
    getSelectedBetSeatIndex: () => store.getSelectedBetSeatIndex(),
  });
}

/** Returns current tableId from input or store */
function currentTableId(): string {
  return inputTable?.value.trim() || store.getState().game.tableId || "table-dev-001";
}

/** Returns current playerId from input or sessionStorage */
function currentPlayerId(): string {
  return inputPlayer?.value.trim() || "player-dev-001";
}

/** Returns currently entered bet amount */
function currentBetAmount(): number {
  return parseInt(inputBet?.value ?? "50", 10) || 50;
}

// ─── Button: JOIN ROOM ────────────────────────────────────────────────────────

btnJoin?.addEventListener("click", async () => {
  const tableId  = currentTableId();
  const playerId = currentPlayerId();

  await ensureConnected(playerId, () => {
    // First try RECONNECT in case the player was already seated (page refresh)
    const existingTableId = store.getState().game.tableId;
    if (existingTableId) {
      wsClient!.sendReconnect(existingTableId);
      appendLog(`→ RECONNECT (table: ${existingTableId})`, "info");
    } else {
      wsClient!.sendJoinRoom(tableId);
      appendLog(`→ JOIN_ROOM (table: ${tableId})`, "info");
    }
  });
});

// ─── Button: PLACE BET ────────────────────────────────────────────────────────

btnPlaceBet?.addEventListener("click", () => {
  const { game } = store.getState();
  const tableId   = game.tableId ?? currentTableId();
  const betAmount = currentBetAmount();

  if (!wsClient?.isConnected()) {
    appendLog("Brak połączenia — najpierw JOIN ROOM", "warn");
    return;
  }

  const seatIndex = store.getSelectedBetSeatIndex();
  if (seatIndex === null) {
    appendLog("Wybierz slot bez zakładu (kliknij miejsce przy stole)", "warn");
    return;
  }

  wsClient.sendPlaceBet(tableId, betAmount, seatIndex);
  appendLog(`→ PLACE_BET (table: ${tableId}, seat: ${seatIndex}, bet: ${betAmount})`, "info");
});

// ─── Chip quick-select buttons ────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>(".btn-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const amount = btn.dataset["chip"];
    if (!amount || !inputBet) return;
    inputBet.value = amount;
    // Update confirm label
    const confirmEl = document.getElementById("bet-confirm-amount");
    if (confirmEl) confirmEl.textContent = `(${amount})`;
  });
});

// Update confirm label when input changes manually
inputBet?.addEventListener("input", () => {
  const confirmEl = document.getElementById("bet-confirm-amount");
  if (confirmEl && inputBet) confirmEl.textContent = inputBet.value ? `(${inputBet.value})` : "";
});

// ─── Button: "Zajmij miejsce" (Multi-Hand / specific slot) ───────────────────
//
// The table-slots container fires "slot-join" CustomEvent when a user clicks
// any "btn-take-seat" button inside an empty-joinable slot.
// We send JOIN_SLOT with the specific seatIndex so the server places the player
// exactly in that position (Multi-Hand support).

document.getElementById("table-slots")?.addEventListener("slot-select-bet", (e) => {
  const ev = e as CustomEvent<{ slotIndex: number }>;
  const { slotIndex } = ev.detail;
  const slot = store.getState().game.slots[slotIndex];
  if (!slot?.isSelf || slot.hasBet) return;
  store.setSelectedBetSlot(slotIndex);
  appendLog(`Wybrany slot #${slotIndex} do zakładu`, "info");
});

document.getElementById("table-slots")?.addEventListener("slot-join", async (e) => {
  const ev = e as CustomEvent<{ slotIndex: number }>;
  const { slotIndex } = ev.detail;
  appendLog(`Klikasz wolny slot #${slotIndex} — JOIN_SLOT`, "info");

  const tableId  = currentTableId();
  const playerId = currentPlayerId();

  await ensureConnected(playerId, () => {
    wsClient!.sendJoinSlot(tableId, slotIndex);
    appendLog(`→ JOIN_SLOT (table: ${tableId}, seat: ${slotIndex})`, "info");
  });
});

// ─── Button: HIT / STAND / DOUBLE ─────────────────────────────────────────────

function sendPlayerAction(action: "HIT" | "STAND" | "DOUBLE_DOWN"): void {
  if (!wsClient) return;
  if (action === "HIT") wsClient.sendHit();
  else if (action === "STAND") wsClient.sendStand();
  else wsClient.sendDoubleDown();
}

btnHit?.addEventListener("click",    () => sendPlayerAction("HIT"));
btnStand?.addEventListener("click",  () => sendPlayerAction("STAND"));
btnDouble?.addEventListener("click", () => sendPlayerAction("DOUBLE_DOWN"));

// ─── Button: LEAVE ────────────────────────────────────────────────────────────

function doLeave(): void {
  const { tableId } = store.getState().game;
  if (!tableId || !wsClient) return;
  wsClient.sendLeave(tableId);
  appendLog("→ LEAVE_GAME", "info");
  store.resetGame();
}

btnLeave?.addEventListener("click", doLeave);
btnLeaveAfter?.addEventListener("click", doLeave);

// ─── Button: NEW ROUND ────────────────────────────────────────────────────────

btnNewGame?.addEventListener("click", () => {
  const tableId  = currentTableId();

  if (!wsClient?.isConnected()) {
    appendLog("Brak połączenia — kliknij JOIN ROOM", "warn");
    return;
  }

  // After ROUND_OVER the server resets the room to BETTING when a player re-joins.
  wsClient.sendJoinRoom(tableId);
  appendLog(`→ JOIN_ROOM (nowa runda, table: ${tableId})`, "info");
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

// Stable player ID per browser tab (fresh UUID per new tab, persists on refresh)
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

// On page load: if we have a stored tableId in sessionStorage, attempt RECONNECT
// (handles the "player refreshes page mid-round" case from the task requirements)
const storedTable = sessionStorage.getItem("megabigwin_table_id");
if (storedTable && inputTable) {
  inputTable.value = storedTable;
}

// Persist tableId whenever store receives a room
store.subscribe((s) => {
  const tid = s.game.tableId;
  if (tid) sessionStorage.setItem("megabigwin_table_id", tid);
});

appendLog("MegaBigWin777 Blackjack v2 gotowy.", "info");
appendLog("Skróty: [H] HIT  [S] STAND  [D] DOUBLE", "info");
