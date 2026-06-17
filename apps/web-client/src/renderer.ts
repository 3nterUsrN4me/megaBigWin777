import type { Card, Hand, GameResult, GameStatus, PlayerActionType, ConnectionStatus } from "./types.js";
import type { Store } from "./gameStore.js";

// ─── Suit helpers ─────────────────────────────────────────────────────────────

const SUIT_SYMBOL: Record<string, string> = {
  HEARTS:   "♥",
  DIAMONDS: "♦",
  CLUBS:    "♣",
  SPADES:   "♠",
};

const RED_SUITS = new Set(["HEARTS", "DIAMONDS"]);

// ─── Card HTML ────────────────────────────────────────────────────────────────

function renderCard(card: Card, delay = 0): string {
  if (card.hidden) {
    return `<div class="card card-back" style="animation-delay:${delay}ms" title="Ukryta karta krupiera"></div>`;
  }

  const suit    = SUIT_SYMBOL[card.suit] ?? card.suit;
  const isRed   = RED_SUITS.has(card.suit);
  const colorCls = isRed ? "red" : "";
  const style   = delay > 0 ? `style="animation-delay:${delay}ms"` : "";

  return `
    <div class="card card-face ${colorCls}" ${style} title="${card.rank}${suit}">
      <div class="card-corner-tl">
        <div>${card.rank}</div>
        <div>${suit}</div>
      </div>
      <div class="flex flex-col items-center gap-0.5">
        <span class="card-value">${card.rank}</span>
        <span class="card-suit">${suit}</span>
      </div>
      <div class="card-corner-br">
        <div>${card.rank}</div>
        <div>${suit}</div>
      </div>
    </div>
  `.trim();
}

function renderHand(hand: Hand | null, placeholder: string): string {
  if (!hand || hand.cards.length === 0) {
    return `<p class="text-white/25 text-sm italic">${placeholder}</p>`;
  }
  return hand.cards.map((c, i) => renderCard(c, i * 80)).join("");
}

// ─── Result banner ────────────────────────────────────────────────────────────

const RESULT_CONFIG: Record<NonNullable<GameResult>, { text: string; cls: string }> = {
  WIN:       { text: "🏆 WYGRANA!",    cls: "text-chip-gold drop-shadow-[0_0_30px_rgba(245,200,66,1)]" },
  LOSS:      { text: "💀 PRZEGRANA",   cls: "text-red-400 drop-shadow-[0_0_30px_rgba(220,38,38,1)]" },
  PUSH:      { text: "🤝 REMIS",       cls: "text-blue-300 drop-shadow-[0_0_20px_rgba(147,197,253,1)]" },
  BLACKJACK: { text: "🃏 BLACKJACK!",  cls: "text-emerald-400 drop-shadow-[0_0_30px_rgba(52,211,153,1)]" },
};

// ─── Status pill text ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<GameStatus | "null", string> = {
  BETTING:     "Obstawiam…",
  DEALING:     "Rozdaję karty…",
  PLAYER_TURN: "Twoja tura",
  DEALER_TURN: "Tura krupiera…",
  FINISHED:    "Koniec rundy",
  null:        "Blackjack",
};

// ─── Connection status ────────────────────────────────────────────────────────

const CONN_CONFIG: Record<ConnectionStatus, { dot: string; label: string; text: string }> = {
  disconnected: { dot: "bg-gray-500",    label: "text-gray-400",   text: "Rozłączony" },
  connecting:   { dot: "bg-yellow-400 animate-pulse",  label: "text-yellow-400", text: "Łączę…" },
  connected:    { dot: "bg-emerald-400", label: "text-emerald-400", text: "Połączony" },
  error:        { dot: "bg-red-500",     label: "text-red-400",    text: "Błąd" },
};

// ─── Main render ──────────────────────────────────────────────────────────────

export function renderUI(store: Store): void {
  const { connection, game } = store;

  // ── Connection status
  const connCfg = CONN_CONFIG[connection];
  setAttr("conn-dot",   "class", `inline-block w-2.5 h-2.5 rounded-full ${connCfg.dot}`);
  setAttr("conn-label", "class", `badge-status uppercase tracking-widest ${connCfg.label}`);
  setText("conn-label", connCfg.text);

  // ── Chips
  if (game.playerChips > 0) {
    setText("chips-display", `${game.playerChips.toLocaleString("pl-PL")} 🪙`);
  } else {
    setText("chips-display", "–");
  }

  // ── Dealer hand
  setHTML("dealer-hand", renderHand(game.dealerHand, "czekam na rozdanie…"));
  if (game.dealerHand) {
    const visibleCards = game.dealerHand.cards.filter(c => !c.hidden);
    const score = visibleCards.length > 0 ? String(game.dealerHand.value) : "?";
    setText("dealer-score", score);
    show("dealer-score-badge");
  } else {
    hide("dealer-score-badge");
  }

  // ── Player hand
  setHTML("player-hand", renderHand(game.playerHand, "twoje karty pojawią się tutaj…"));
  if (game.playerHand) {
    setText("player-score", String(game.playerHand.value));
    show("player-score-badge");
    // Score badge color
    const scoreEl = document.getElementById("player-score-badge");
    if (scoreEl) {
      const bust = game.playerHand.isBust;
      const bj   = game.playerHand.isBlackjack;
      scoreEl.className = [
        "text-sm font-bold px-3 py-1 rounded-full border",
        bust ? "bg-red-900/60 border-red-500/40 text-red-300" :
          bj   ? "bg-emerald-900/60 border-emerald-500/40 text-emerald-300" :
                 "bg-black/50 border-white/20 text-white/80",
      ].join(" ");
    }
  } else {
    hide("player-score-badge");
  }

  // ── Bet badge
  if (game.betAmount > 0) {
    setText("bet-display", String(game.betAmount));
    show("bet-badge");
  } else {
    hide("bet-badge");
  }

  // ── Status pill
  const statusKey = (game.status ?? "null") as GameStatus | "null";
  setText("game-status-pill", STATUS_LABEL[statusKey]);

  // ── Result banner
  renderResult(game.result, game.status);

  // ── Panel visibility
  const inGame   = game.gameId !== null;
  const finished = game.status === "FINISHED";

  if (inGame) {
    hide("join-panel");
    showFlex("action-panel");
    if (finished) {
      showFlex("new-game-panel");
    } else {
      hide("new-game-panel");
    }
  } else {
    showFlex("join-panel");
    hide("action-panel");
    hide("new-game-panel");
  }

  // ── Action buttons availability
  const available: PlayerActionType[] = game.availableActions;
  setDisabled("btn-hit",    !available.includes("HIT"));
  setDisabled("btn-stand",  !available.includes("STAND"));
  setDisabled("btn-double", !available.includes("DOUBLE_DOWN"));
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
  // Keep last 100 lines
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
  const e = el(id); if (e) { e.classList.remove("hidden"); }
}

function hide(id: string): void {
  const e = el(id); if (e) { e.classList.add("hidden"); e.classList.remove("flex"); }
}

function showFlex(id: string): void {
  const e = el(id); if (e) { e.classList.remove("hidden"); e.classList.add("flex"); }
}
