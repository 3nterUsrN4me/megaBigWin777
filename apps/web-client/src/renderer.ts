import type {
  Card, Hand, GameResult, GameStatus, PlayerActionType,
  ConnectionStatus, RoomStatus, TableSlot,
} from "./types.js";
import type { Store } from "./gameStore.js";
import { store as gameStore } from "./gameStore.js";

// ─── Suit helpers ─────────────────────────────────────────────────────────────

const SUIT_SYMBOL: Record<string, string> = {
  HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣", SPADES: "♠",
};
const RED_SUITS = new Set(["HEARTS", "DIAMONDS"]);

// ─── Card HTML ────────────────────────────────────────────────────────────────

function renderCard(card: Card, delay = 0, small = false): string {
  const sizeClass = small ? "slot-card" : "";

  if (card.hidden) {
    return `<div class="card card-back ${sizeClass}" style="animation-delay:${delay}ms" title="Ukryta karta"></div>`;
  }

  const suit     = SUIT_SYMBOL[card.suit] ?? card.suit;
  const isRed    = RED_SUITS.has(card.suit);
  const colorCls = isRed ? "red" : "";
  const style    = delay > 0 ? `style="animation-delay:${delay}ms"` : "";

  return `
    <div class="card card-face ${colorCls} ${sizeClass}" ${style} title="${card.rank}${suit}">
      <div class="card-corner-tl"><div>${card.rank}</div><div>${suit}</div></div>
      <div class="flex flex-col items-center gap-0.5">
        <span class="card-value">${card.rank}</span>
        <span class="card-suit">${suit}</span>
      </div>
      <div class="card-corner-br"><div>${card.rank}</div><div>${suit}</div></div>
    </div>`.trim();
}

function renderHand(hand: Hand | null, placeholder: string, small = false): string {
  if (!hand || hand.cards.length === 0) {
    return `<p class="text-white/25 text-sm italic">${placeholder}</p>`;
  }
  return hand.cards.map((c, i) => renderCard(c, i * 80, small)).join("");
}

// ─── Result banner config ─────────────────────────────────────────────────────

const RESULT_CONFIG: Record<NonNullable<GameResult>, { text: string; cls: string }> = {
  WIN:       { text: "WYGRANA!",   cls: "text-chip-gold  drop-shadow-[0_0_30px_rgba(245,200,66,1)]" },
  LOSS:      { text: "PRZEGRANA",  cls: "text-red-400    drop-shadow-[0_0_30px_rgba(220,38,38,1)]" },
  PUSH:      { text: "REMIS",      cls: "text-blue-300   drop-shadow-[0_0_20px_rgba(147,197,253,1)]" },
  BLACKJACK: { text: "BLACKJACK!", cls: "text-emerald-400 drop-shadow-[0_0_30px_rgba(52,211,153,1)]" },
};

// ─── Status labels ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<GameStatus | "null", string> = {
  BETTING:     "Obstawiam…",
  DEALING:     "Rozdaję karty…",
  PLAYER_TURN: "Twoja tura",
  DEALER_TURN: "Tura krupiera…",
  FINISHED:    "Koniec rundy",
  null:        "Blackjack",
};

const ROOM_PHASE_LABEL: Record<RoomStatus, string> = {
  WAITING_FOR_PLAYERS: "Czekam na graczy",
  BETTING:             "Czas na zakłady",
  PLAYING:             "Runda w toku",
  ROUND_OVER:          "Runda zakończona",
};

// ─── Connection status ────────────────────────────────────────────────────────

const CONN_CONFIG: Record<ConnectionStatus, { dot: string; label: string; text: string }> = {
  disconnected: { dot: "bg-gray-500",                         label: "text-gray-400",    text: "Rozłączony" },
  connecting:   { dot: "bg-yellow-400 animate-pulse",         label: "text-yellow-400",  text: "Łączę…"     },
  connected:    { dot: "bg-emerald-400",                      label: "text-emerald-400", text: "Połączony"  },
  error:        { dot: "bg-red-500",                          label: "text-red-400",     text: "Błąd"       },
};

// ─── Table slot rendering ─────────────────────────────────────────────────────

/**
 * Renders a single table slot as an HTML string.
 *
 * Slot variants:
 *  - Empty / joinable → dashed border + "Zająć miejsce" button
 *  - Empty / not joinable → faded placeholder
 *  - Occupied (other player) → avatar, cards, score, result
 *  - Self → highlighted ring, full personal hand (from game.playerHand for live detail)
 */
function renderSlot(slot: TableSlot, selectedBetSlotIndex: number | null): string {
  // ── Empty slot ──────────────────────────────────────────────────────────────
  if (!slot.playerId) {
    if (slot.isJoinable) {
      return `
        <div class="table-slot slot-empty slot-joinable"
             data-slot-index="${slot.index}"
             title="Zajmij to miejsce">
          <div class="text-white/20 text-lg mb-1">🪑</div>
          <span class="text-white/40 text-xs font-semibold">Wolne</span>
          <button class="btn-take-seat mt-1 text-xs px-3 py-1 rounded-lg bg-white/10 hover:bg-chip-gold/20 border border-white/20 hover:border-chip-gold/40 text-white/60 hover:text-chip-gold transition font-semibold"
                  data-slot-index="${slot.index}">
            + Zajmij
          </button>
        </div>`.trim();
    }
    return `
      <div class="table-slot slot-empty" data-slot-index="${slot.index}">
        <div class="text-white/10 text-lg mb-1">🪑</div>
        <span class="text-white/20 text-xs">–</span>
      </div>`.trim();
  }

  // ── Occupied slot ───────────────────────────────────────────────────────────
  const isSelf    = slot.isSelf;
  const isActive  = slot.isActivePlayer;
  const isOffline = slot.isOnline === false;

  const slotClass = [
    "table-slot",
    isSelf    ? "slot-self"     : "slot-occupied",
    isActive  ? "slot-active"   : "",
    isOffline ? "slot-offline"  : "",
    isSelf && !slot.hasBet && selectedBetSlotIndex === slot.index ? "slot-bet-selected" : "",
  ].filter(Boolean).join(" ");

  // Avatar initial
  const initial = slot.username.charAt(0).toUpperCase() || "?";
  const avatarBg = isSelf
    ? "bg-chip-gold/30 border-chip-gold/60 text-chip-gold"
    : "bg-white/10 border-white/20 text-white/70";

  // Name + turn indicator
  const selfLabel    = isSelf    ? '<span class="text-chip-gold text-[10px] ml-1">(TY)</span>' : "";
  const turnBadge    = isActive  ? '<span class="text-yellow-400 text-[10px] animate-pulse ml-1">▶</span>' : "";
  const offlineBadge = isOffline ? '<span class="text-white/30 text-[10px] ml-1" title="Rozłączony (30s grace)">⏳</span>' : "";

  // Bet display
  const betHTML = slot.hasBet
    ? `<div class="text-chip-gold text-[10px]">💰 ${slot.betAmount}</div>`
    : slot.betAmount === 0 && slot.playerId
      ? `<div class="text-white/25 text-[10px] italic">bez zakładu</div>`
      : "";

  // Hand — each slot uses its own hand from ROOM_STATE (independent Multi-Hand)
  const handToRender = slot.hand;
  const handHTML = handToRender && handToRender.cards.length > 0
    ? `<div class="flex gap-1 justify-center flex-wrap mt-1">
        ${handToRender.cards.map((c) => renderCard(c, 0, true)).join("")}
       </div>`
    : `<div class="text-white/15 text-[10px] italic mt-1">–</div>`;

  const scoreHTML = handToRender
    ? (() => {
        const cls = handToRender.isBust      ? "bg-red-900/70 text-red-300"
                  : handToRender.isBlackjack  ? "bg-emerald-900/70 text-emerald-300"
                  :                         "bg-black/50 text-white/70";
        return `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}">${handToRender.value}</span>`;
      })()
    : "";

  // Result
  const resultHTML = slot.result
    ? (() => {
        const cls = slot.result === "WIN" || slot.result === "BLACKJACK"
                      ? "slot-result-win"
                      : slot.result === "LOSS" ? "slot-result-loss"
                      : "slot-result-push";
        const label = slot.result === "BLACKJACK" ? "BJ!" : slot.result;
        return `<span class="text-[10px] font-bold ${cls} ml-1">${label}</span>`;
      })()
    : "";

  // Done badge
  const doneBadge = (!isActive && slot.hasTurnEnded && !slot.result)
    ? '<span class="text-white/30 text-[10px]">✓</span>'
    : "";

  return `
    <div class="${slotClass}" data-slot-index="${slot.index}" data-player-id="${slot.playerId}">
      <div class="flex items-center gap-1 mb-0.5">
        <div class="w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold flex-shrink-0 ${avatarBg}">
          ${initial}
        </div>
        <div class="flex flex-col min-w-0">
          <div class="flex items-center">
            <span class="text-[11px] font-semibold truncate max-w-[60px] text-white/85" title="${slot.username}">${slot.username}</span>
            ${selfLabel}${turnBadge}${offlineBadge}
          </div>
          <span class="text-[10px] text-white/40">${slot.chips.toLocaleString("pl-PL")} 🪙</span>
        </div>
      </div>
      ${betHTML}
      ${handHTML}
      <div class="flex items-center gap-0.5 mt-0.5">${scoreHTML}${resultHTML}${doneBadge}</div>
    </div>`.trim();
}

/**
 * Re-renders all 5 table slots into `#table-slots`.
 * Attaches delegated click listener for "Take Seat" buttons — fires a custom
 * "slot-join" event with `detail.slotIndex` so `main.ts` can handle it.
 */
export function renderTableSlots(store: Store): void {
  const container = document.getElementById("table-slots");
  if (!container) return;

  const { game, myPlayerId } = store;
  const { slots, selectedBetSlotIndex, roomStatus } = game;

  if (!slots || slots.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = slots
    .map((s) => renderSlot(s, selectedBetSlotIndex))
    .join("");

  const existing = (container as unknown as { _slotHandler?: EventListener })._slotHandler;
  if (existing) container.removeEventListener("click", existing);

  const handler: EventListener = (e) => {
    const takeSeatBtn = (e.target as Element).closest(".btn-take-seat") as HTMLElement | null;
    if (takeSeatBtn) {
      const slotIndex = parseInt(takeSeatBtn.dataset["slotIndex"] ?? "-1", 10);
      if (slotIndex < 0) return;
      container.dispatchEvent(new CustomEvent("slot-join", { detail: { slotIndex }, bubbles: true }));
      return;
    }

    const slotEl = (e.target as Element).closest(".table-slot") as HTMLElement | null;
    if (!slotEl || roomStatus !== "BETTING") return;
    const slotIndex = parseInt(slotEl.dataset["slotIndex"] ?? "-1", 10);
    if (slotIndex < 0) return;
    container.dispatchEvent(new CustomEvent("slot-select-bet", { detail: { slotIndex }, bubbles: true }));
  };
  (container as unknown as { _slotHandler?: EventListener })._slotHandler = handler;
  container.addEventListener("click", handler);
}

// ─── Main render ──────────────────────────────────────────────────────────────

export function renderUI(store: Store): void {
  const { connection, game } = store;

  // ── Connection badge ────────────────────────────────────────────────────────
  const connCfg = CONN_CONFIG[connection];
  setAttr("conn-dot",   "class", `inline-block w-2.5 h-2.5 rounded-full ${connCfg.dot}`);
  setAttr("conn-label", "class", `badge-status uppercase tracking-widest ${connCfg.label}`);
  setText("conn-label", connCfg.text);

  // ── Chips ───────────────────────────────────────────────────────────────────
  setText("chips-display", game.playerChips > 0
    ? `${game.playerChips.toLocaleString("pl-PL")} 🪙`
    : "–");

  // ── Room status bar ─────────────────────────────────────────────────────────
  const statusBar = document.getElementById("room-status-bar");
  if (statusBar) {
    if (game.roomStatus && game.tableId) {
      const seated = game.slots.filter((s) => s.playerId !== null).length;
      setText("room-status-phase", ROOM_PHASE_LABEL[game.roomStatus]);
      setText("room-status-info",  `${seated} z 5 miejsc · stół ${game.tableId.slice(0, 8)}…`);
      statusBar.classList.remove("hidden");
    } else {
      statusBar.classList.add("hidden");
    }
  }

  // ── Dealer hand ─────────────────────────────────────────────────────────────
  setHTML("dealer-hand", renderHand(game.dealerHand, "czekam na rozdanie…"));
  if (game.dealerHand) {
    const visibleCards = game.dealerHand.cards.filter((c) => !c.hidden);
    setText("dealer-score", visibleCards.length > 0 ? String(game.dealerHand.value) : "?");
    show("dealer-score-badge");
  } else {
    hide("dealer-score-badge");
  }

  // ── Status pill ─────────────────────────────────────────────────────────────
  let statusLabel: string;
  if (game.roomStatus === "PLAYING") {
    const statusKey = (game.status ?? "null") as GameStatus | "null";
    statusLabel = STATUS_LABEL[statusKey];
    if (game.activeSeatIndex !== null) {
      const activeSlot = game.slots.find((s) => s.index === game.activeSeatIndex);
      if (activeSlot && !activeSlot.isSelf) {
        statusLabel = `Tura: ${activeSlot.username}`;
      }
    } else if (game.activePlayerId) {
      const activePs = game.otherPlayers[game.activePlayerId];
      if (activePs) statusLabel = `Tura: ${activePs.username}`;
    }
  } else if (game.roomStatus) {
    statusLabel = ROOM_PHASE_LABEL[game.roomStatus];
  } else {
    statusLabel = "Blackjack — MegaBigWin777";
  }
  setText("game-status-pill", statusLabel);

  // ── Table slots ─────────────────────────────────────────────────────────────
  renderTableSlots(store);

  // ── Result banner ───────────────────────────────────────────────────────────
  renderResult(game.result, game.status);

  // ── Panel visibility ────────────────────────────────────────────────────────
  const roomPhase      = game.roomStatus;
  const waitingForRoom = !roomPhase || roomPhase === "WAITING_FOR_PLAYERS";
  // anyBetPlaced: true once at least one own slot has sent a bet (partial multi-hand progress)
  const anyBetPlaced   = roomPhase === "BETTING" && game.mySeatsBetting.some((s) => s.hasBet);
  const inBetting      = roomPhase === "BETTING" && !game.hasBet;
  const betPlaced      = roomPhase === "BETTING" && game.hasBet;
  const inPlaying      = roomPhase === "PLAYING";
  const roundOver      = roomPhase === "ROUND_OVER";

  // join-panel: only when truly not in any room
  setVisible("join-panel",     waitingForRoom, "flex");
  // bet-panel: seated but not bet yet (also shown while waiting for others)
  setVisible("bet-panel",      (inBetting || betPlaced) && !waitingForRoom, "flex");
  // action-panel: game in progress
  setVisible("action-panel",   inPlaying, "flex");
  // new-game-panel: round finished
  setVisible("new-game-panel", roundOver, "flex");

  // Bet panel helpers
  if (inBetting || betPlaced) {
    const betHint = `min ${game.minBet} – max ${game.maxBet} 🪙`;
    setText("bet-range-hint", betHint);
    // Keep bet-confirm-amount in sync with input
    const inputBet = document.getElementById("input-bet") as HTMLInputElement | null;
    if (inputBet) {
      setText("bet-confirm-amount", inputBet.value ? `(${inputBet.value})` : "");
    }
  }

  // Waiting-for-others / per-slot bet progress inside bet panel
  const waitingEl = document.getElementById("waiting-for-others");
  if (waitingEl) {
    if (anyBetPlaced || betPlaced) {
      const myUnbet     = game.mySeatsBetting.filter((s) => !s.hasBet).length;
      const othersUnbet = Object.values(game.otherPlayers).filter((p) => !p.hasBet).length;

      if (myUnbet > 0) {
        const selected = game.selectedBetSlotIndex;
        const label = selected !== null ? `#${selected}` : "wybierz slot";
        waitingEl.textContent = `Zakład trafi na slot ${label} — kliknij POSTAW (pozostało ${myUnbet} bez zakładu)`;
      } else if (othersUnbet > 0) {
        waitingEl.textContent = `Czekam na zakłady: ${othersUnbet} gracz${othersUnbet === 1 ? "" : "y"}…`;
      } else {
        waitingEl.textContent = "Wszyscy postawili — za chwilę karty!";
      }
      waitingEl.classList.remove("hidden");
    } else {
      waitingEl.classList.add("hidden");
    }
  }

  // Disable place-bet button only when ALL own slots have bet
  const btnPlaceBet = document.getElementById("btn-place-bet") as HTMLButtonElement | null;
  if (btnPlaceBet) btnPlaceBet.disabled = betPlaced;

  // ── Action buttons ──────────────────────────────────────────────────────────
  const available: PlayerActionType[] = game.availableActions;
  const isMyTurn = gameStore.getActiveSeatIndex() !== null;
  setDisabled("btn-hit",    !available.includes("HIT")         || !isMyTurn);
  setDisabled("btn-stand",  !available.includes("STAND")       || !isMyTurn);
  setDisabled("btn-double", !available.includes("DOUBLE_DOWN") || !isMyTurn);
}

// ─── Result banner ────────────────────────────────────────────────────────────

let resultTimerId: ReturnType<typeof setTimeout> | null = null;

function renderResult(result: GameResult, status: GameStatus | null): void {
  const banner = document.getElementById("result-banner");
  const text   = document.getElementById("result-text");
  if (!banner || !text) return;

  if (result && status === "FINISHED") {
    const cfg = RESULT_CONFIG[result];
    text.textContent = cfg.text;
    text.className = `text-5xl md:text-7xl font-extrabold tracking-wider animate-result-pop ${cfg.cls}`;
    banner.classList.remove("hidden");
    banner.classList.add("flex");

    if (resultTimerId) clearTimeout(resultTimerId);
    resultTimerId = setTimeout(() => {
      banner.style.opacity = "0";
      setTimeout(() => {
        banner.classList.add("hidden");
        banner.classList.remove("flex");
        banner.style.opacity = "";
      }, 400);
    }, 3000);
  } else {
    if (resultTimerId) { clearTimeout(resultTimerId); resultTimerId = null; }
    banner.classList.add("hidden");
    banner.classList.remove("flex");
    banner.style.opacity = "";
  }
}

// ─── Log ──────────────────────────────────────────────────────────────────────

export function appendLog(text: string, level: "info" | "warn" | "error" = "info"): void {
  const log = document.getElementById("network-log");
  if (!log) return;

  const colorMap = { info: "text-white/50", warn: "text-yellow-400/80", error: "text-red-400" };
  const ts = new Date().toLocaleTimeString("pl-PL");

  const entry = document.createElement("div");
  entry.className = `log-entry ${colorMap[level]}`;
  entry.textContent = `[${ts}] ${text}`;
  log.appendChild(entry);
  while (log.children.length > 100) log.removeChild(log.firstChild!);
  log.scrollTop = log.scrollHeight;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}
function setText(id: string, text: string): void {
  const e = el(id); if (e) e.textContent = text;
}
function setHTML(id: string, html: string): void {
  const e = el(id); if (e) e.innerHTML = html;
}
function setAttr(id: string, attr: string, value: string): void {
  const e = el(id); if (e) e.setAttribute(attr, value);
}
function setDisabled(id: string, disabled: boolean): void {
  const e = el(id) as HTMLButtonElement | null;
  if (e) e.disabled = disabled;
}
function show(id: string): void {
  const e = el(id); if (e) e.classList.remove("hidden");
}
function hide(id: string): void {
  const e = el(id); if (e) { e.classList.add("hidden"); e.classList.remove("flex"); }
}
function setVisible(id: string, visible: boolean, displayClass = "block"): void {
  const e = el(id);
  if (!e) return;
  if (visible) {
    e.classList.remove("hidden");
    e.classList.add(displayClass);
  } else {
    e.classList.add("hidden");
    e.classList.remove(displayClass);
  }
}
