# ARCHITECTURE.md — megaBigWin777 · Blackjack Casino Simulator

> **Single Source of Truth** dla zespołu agentów. Wszelkie zmiany w kontraktach, schematach i milestone'ach wymagają aktualizacji tego dokumentu przed mergem do `main`.

---

## TLDR — Kluczowe Decyzje Architektoniczne

1. **Cel:** Symulator kasyna online z jedną grą — Blackjack — zbudowany na WebSocketach, z trwałym stanem gry w bazie danych.
2. **Stack:** Node.js + TypeScript (backend), Hono lub Fastify jako HTTP/WS host, `ws` (natywna biblioteka WebSocket), PostgreSQL + Drizzle ORM, Redis (pub/sub + sesje), React + Vite (frontend).
3. **Moduły (5):** `game-core` (czysta logika, zero side-effects), `game-service` (DB + transakcje), `websocket-gateway` (routing wiadomości), `auth-lobby` (gracze, sesje, tokeny), `frontend-client` (UI + WS client).
4. **Izolacja logiki:** `game-core` to zbiór czystych funkcji/maszyny stanów bez żadnych zależności sieciowych ani bazodanowych. Testowany w 100% jednostkowo.
5. **Deterministyczne RNG:** seedowany generator (`@faker-js/faker` / `seedrandom`) — każdy test tasowania jest w pełni powtarzalny.
6. **Kontrakty:** folder `/contracts` zawiera JSON Schemas + TypeScript types dla każdej wiadomości WebSocket i każdego zdarzenia domenowego. Zmiany kontraktów wymagają testu kontraktowego przed integracją.
7. **Protokół WebSocket:** wersjonowany (`"v": "1"`), zdarzenia: `JOIN_GAME`, `JOIN_ACK`, `START_GAME`, `DEAL`, `PLAYER_ACTION`, `GAME_STATE`, `ERROR`, `PING`/`PONG`, `LEAVE_GAME`, `HEARTBEAT`.
8. **Testy:** Vitest — unit (game-core ≥ 90% pokrycia), integracyjne (SQLite in-memory + serwer WS), kontraktowe (ajv walidacja schematów z `/contracts`). Próg pokrycia: 80% globalnie, 90% game-core.
9. **CI/CD:** GitHub Actions — lint → unit → integration → contract → coverage gate → build. Pre-commit hooks (husky + lint-staged).
10. **Bezpieczeństwo stanu:** transakcje DB + idempotency keys na każdej akcji gracza + optional write-ahead event log.
11. **Tech Lead Agent: TAK — wymagany.** Koordynuje kontrakty, autoryzuje zmiany API, jest gatekeeper CI i rozstrzyga konflikty interfejsów między agentami modułów.
12. **MCP Servers:** projekt **nie wymaga** serwerów MCP — złożoność nie uzasadnia dodatkowej infrastruktury; komunikacja wewnątrz-serwisowa odbywa się przez bezpośrednie wywołania funkcji i kolejki zdarzeń w Redis.

---

## Spis Treści

1. [Cel i Zakres](#1-cel-i-zakres)
2. [Wymagania Funkcjonalne i Niefunkcjonalne](#2-wymagania-funkcjonalne-i-niefunkcjonalne)
3. [Proponowana Architektura](#3-proponowana-architektura)
4. [Stack Technologiczny](#4-stack-technologiczny)
5. [Schemat Bazy Danych](#5-schemat-bazy-danych)
6. [Model Domenowy](#6-model-domenowy)
7. [Protokół WebSocket](#7-protokół-websocket)
8. [Izolacja Logiki — Wzorzec game-core](#8-izolacja-logiki--wzorzec-game-core)
9. [Strategia Testów](#9-strategia-testów)
10. [CI/CD i Metryki Jakości](#10-cicd-i-metryki-jakości)
11. [Bezpieczeństwo i Skalowalność](#11-bezpieczeństwo-i-skalowalność)
12. [Plan Iteracyjny — Kamienie Milowe](#12-plan-iteracyjny--kamienie-milowe)
13. [Rola Tech Lead Agenta](#13-rola-tech-lead-agenta)
14. [Układ Repozytorium](#14-układ-repozytorium)
15. [Wskazówki dla Agentów — Unikanie Halucynacji](#15-wskazówki-dla-agentów--unikanie-halucynacji)

---

## 1. Cel i Zakres

### Cel

Zbudować w pełni funkcjonalny symulator gry Blackjack działający w architekturze klient-serwer opartej na WebSocketach. System ma:

- Utrzymywać trwały stan każdej rozgrywki (zapisany w DB).
- Obsługiwać wiele równoczesnych stolików (rooms) z izolowanym stanem gry.
- Prezentować UI w czasie rzeczywistym (aktualizacje przez WebSocket push).
- Być testowalny, modularny i deterministyczny.

### Zakres — Co Jest W Projekcie

- Gra Blackjack: standard Las Vegas (dealer hits on soft 17, Blackjack wypłaca 3:2, split jednorazowy opcjonalnie).
- Jeden gracz (human) vs. dealer (AI).
- Wirtualne żetony — stan konta zapisany w DB.
- Lobby: lista dostępnych stolików, dołączanie i opuszczanie stołu.
- Autoryzacja uproszczona: username + hasło (JWT sesja).
- Historia rund (opcjonalnie w v2).

### Zakres — Co Jest Poza Projektem

- Wiele gier kasynowych (poker, ruletka itp.) — wykluczone.
- Płatności realne, KYC, regulacje — wykluczone.
- Mobile native app — wykluczone (responsywny web jest OK).
- Multiplayer (wielu graczy przy jednym stole jednocześnie) — wykluczone w v1.

---

## 2. Wymagania Funkcjonalne i Niefunkcjonalne

### Funkcjonalne (F)

| ID   | Wymaganie |
|------|-----------|
| F-01 | Gracz może się zarejestrować i zalogować (JWT). |
| F-02 | Gracz widzi listę stolików (lobby). |
| F-03 | Gracz może dołączyć do stołu i postawić zakład. |
| F-04 | Serwer tasuje talię i rozdaje karty (gracz + dealer). |
| F-05 | Gracz może wykonać akcje: HIT, STAND, DOUBLE_DOWN. |
| F-06 | Dealer gra według ustalonych zasad (stała maszyna stanów). |
| F-07 | System oblicza wynik i aktualizuje konto gracza. |
| F-08 | Stan gry jest przywracany po rozłączeniu gracza. |
| F-09 | Gracz może opuścić stolik w dowolnym momencie (LEAVE_GAME). |

### Niefunkcjonalne (NF)

| ID    | Wymaganie |
|-------|-----------|
| NF-01 | Czas odpowiedzi akcji gracza < 200 ms (p95). |
| NF-02 | Stan gry musi być atomowo zapisywany (transakcje DB). |
| NF-03 | Zero duplikacji akcji: idempotency keys na każdej operacji. |
| NF-04 | WebSocket protokół wersjonowany (`"v": "1"`). |
| NF-05 | Testowalność: pokrycie ≥ 90% dla game-core, ≥ 80% globalnie. |
| NF-06 | Deterministyczne tasowanie (seedowany RNG) dla reprodukowalności testów. |
| NF-07 | Modularność: każdy moduł jest niezależnie deployowalny (monorepo z izolacją). |
| NF-08 | Linting i TypeScript strict mode w całym projekcie. |

---

## 3. Proponowana Architektura

### Diagram Logiczny (tekstowy)

```
┌──────────────────────────────────────────────────────────────────┐
│                        FRONTEND CLIENT                           │
│  React + Vite · WebSocket Client · Zustand/Context State         │
│  [ UI Components ] ──► [ WS Client Manager ] ──► [ Event Bus ]   │
└────────────────────────────┬─────────────────────────────────────┘
                             │ WebSocket (ws://)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                     WEBSOCKET GATEWAY                            │
│  ws library · Message Router · Session Validator                 │
│  [ WS Server ] → [ Message Deserializer ] → [ Route Dispatcher ] │
│       ▲                                           │              │
│       │ push events                               ▼              │
│  [ Event Emitter ] ◄─────── [ Game Service API ]                 │
└───────────────────────────────┬──────────────────────────────────┘
                                │ function calls / DI
              ┌─────────────────┴───────────────────┐
              ▼                                     ▼
┌─────────────────────────┐         ┌───────────────────────────┐
│     GAME SERVICE         │         │       AUTH / LOBBY         │
│  Drizzle ORM · Postgres  │         │  JWT · bcrypt · Sessions   │
│  Transactions · Idempot. │         │  [ Player Repo ]           │
│  [ Game Repo ]           │         │  [ Session Store (Redis) ] │
│  [ Round Repo ]          │         │  [ Lobby Service ]         │
│       │                  │         └───────────────────────────┘
│       │ pure fn calls    │
│       ▼                  │
│  ┌──────────────────┐    │
│  │   GAME CORE      │    │
│  │  Pure Functions  │    │
│  │  State Machine   │    │
│  │  Seeded RNG      │    │
│  │  (zero deps)     │    │
│  └──────────────────┘    │
└─────────────────────────┘

           ┌──────────────────────────────────────┐
           │           INFRASTRUKTURA              │
           │  PostgreSQL · Redis · Node.js runtime │
           └──────────────────────────────────────┘
```

### Przepływ Danych — Akcja Gracza

```
Gracz klika "HIT"
  → Frontend: WS.send({ event: "PLAYER_ACTION", action: "HIT", ... })
  → Gateway: deserializuje, waliduje schema, sprawdza sessionId
  → Game Service: pobiera GameState z DB (transakcja), wywołuje game-core.applyAction()
  → Game Core: zwraca nowy GameState (pure function)
  → Game Service: zapisuje GameState w DB (commit transakcji)
  → Gateway: emituje GAME_STATE event do klienta
  → Frontend: aktualizuje UI
```

---

## 4. Stack Technologiczny

### Backend

| Komponent | Wybór | Uzasadnienie |
|-----------|-------|--------------|
| Runtime | Node.js 22 LTS | Stabilne WS, async I/O, TypeScript natywnie |
| HTTP/WS Host | **Fastify 4** | Szybszy niż Express, plugin `@fastify/websocket` upraszcza integrację WS |
| WebSocket Library | **`ws` (via @fastify/websocket)** | Niskopoziomowa, bez magia Socket.IO, lekka, łatwa do testowania |
| Język | TypeScript 5 (strict) | Kontrakty są silnie typowane, eliminuje klasę błędów |
| ORM | **Drizzle ORM** | Typesafe SQL, brak magia ActiveRecord, migra czytelne SQL, obsługa transakcji |
| Baza Danych | **PostgreSQL 16** | ACID, transakcje, stabilny stan gry, jsonb dla event log |
| Cache/PubSub | **Redis 7** | Sesje (TTL), pub/sub dla przyszłego skalowania, rate limiting |
| Auth | **JWT (jose)** + bcrypt | Bezstanowe tokeny, łatwa weryfikacja w WS handshake |
| Walidacja | **zod** | Schema inference → TypeScript types, działa w runtime |
| Test Framework | **Vitest** | Natywny ESM, szybki, kompatybilny z Vite, mocki, snapshots |
| Logger | **Pino** | Structured logging, niska latencja |

### Frontend

| Komponent | Wybór | Uzasadnienie |
|-----------|-------|--------------|
| Framework | **React 19** | Ekosystem, deweloperzy dostępni |
| Build Tool | **Vite 6** | HMR, spójny dev experience z Vitest |
| State Management | **Zustand** | Prosty, bez boilerplate, łatwy do mockowania w testach |
| WS Client | Natywny `WebSocket` API | Brak dodatkowych zależności, pełna kontrola |
| CSS | **Tailwind CSS 4** | Utility-first, szybki prototyp |
| Testy | **Vitest + Testing Library** | Spójny tooling z backendem |

### Alternatywy — Pro/Contra

**Socket.IO vs `ws`**
- Socket.IO ✅ automatyczne reconnect, rooms, namespaces; ❌ magiczne abstrakcje utrudniają testowanie, 50 KB overhead, ukrywa protokół.
- `ws` ✅ przejrzysty protokół, testowalny, lekki; ❌ reconnect/heartbeat trzeba napisać samemu (ale mamy go w specyfikacji poniżej).
- **Decyzja: `ws`** — pełna kontrola nad protokołem = niższe ryzyko halucynacji agentów.

**PostgreSQL vs MongoDB**
- PostgreSQL ✅ ACID, JOIN, transakcje, relacyjny model pasuje do rachunkowości żetonów; ❌ mniej elastyczne schema.
- MongoDB ✅ elastyczne dokumenty, łatwy event-sourcing; ❌ brak full transakcji w v4 (multi-doc), trudniejsza spójność konta.
- **Decyzja: PostgreSQL** — transakcje atomowe są krytyczne dla bezpieczeństwa stanu gry.

**Drizzle vs Prisma**
- Drizzle ✅ lżejszy bundle, SQL first, migracje czytelne; ❌ mniejszy ekosystem.
- Prisma ✅ duży ekosystem, dobry DX; ❌ generowany client, abstrakcja ukrywająca SQL.
- **Decyzja: Drizzle** — transparentność SQL ważna przy debugowaniu stanu gry.

---

## 5. Schemat Bazy Danych

### Tabele

```sql
-- Gracze
CREATE TABLE players (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username    VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  chips       BIGINT NOT NULL DEFAULT 1000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aktywne sesje WS (powiązanie sessionId z playerId)
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stoliki (rooms)
CREATE TABLE tables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'WAITING',
  -- WAITING | ACTIVE | FINISHED
  max_bet     BIGINT NOT NULL DEFAULT 500,
  min_bet     BIGINT NOT NULL DEFAULT 10,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aktywne gry (jedna na stół)
CREATE TABLE games (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        UUID NOT NULL REFERENCES tables(id),
  player_id       UUID NOT NULL REFERENCES players(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'BETTING',
  -- BETTING | DEALING | PLAYER_TURN | DEALER_TURN | FINISHED
  deck_seed       TEXT NOT NULL,         -- seed RNG do odtworzenia talii
  deck_state      JSONB NOT NULL,        -- aktualna talia (pozostałe karty)
  player_hand     JSONB NOT NULL DEFAULT '[]',
  dealer_hand     JSONB NOT NULL DEFAULT '[]',
  bet_amount      BIGINT NOT NULL DEFAULT 0,
  result          VARCHAR(20),
  -- WIN | LOSS | PUSH | BLACKJACK
  idempotency_key TEXT,                  -- klucz ostatniej przetworzonej akcji
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Historia rund (archiwum zakończonych gier)
CREATE TABLE rounds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID NOT NULL REFERENCES games(id),
  player_id   UUID NOT NULL REFERENCES players(id),
  table_id    UUID NOT NULL REFERENCES tables(id),
  player_hand JSONB NOT NULL,
  dealer_hand JSONB NOT NULL,
  bet_amount  BIGINT NOT NULL,
  result      VARCHAR(20) NOT NULL,
  chips_delta BIGINT NOT NULL,           -- zmiana salda (+ wygrana, - przegrana)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Event Log (opcjonalny write-ahead log dla event sourcingu)
CREATE TABLE game_events (
  id          BIGSERIAL PRIMARY KEY,
  game_id     UUID NOT NULL REFERENCES games(id),
  sequence_no INTEGER NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(game_id, sequence_no)
);
```

### Indeksy

```sql
CREATE INDEX idx_games_player_id    ON games(player_id);
CREATE INDEX idx_games_table_id     ON games(table_id);
CREATE INDEX idx_games_status       ON games(status);
CREATE INDEX idx_game_events_game   ON game_events(game_id, sequence_no);
CREATE INDEX idx_sessions_player    ON sessions(player_id);
CREATE INDEX idx_sessions_expires   ON sessions(expires_at);
```

---

## 6. Model Domenowy

### TypeScript Types (plik: `/contracts/domain.ts`)

```typescript
// ─── Karta ───────────────────────────────────────────────────────────────────
export type Suit = "HEARTS" | "DIAMONDS" | "CLUBS" | "SPADES";
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";

export interface Card {
  suit: Suit;
  rank: Rank;
  hidden?: boolean; // true = odwrócona karta dealera
}

// ─── Ręka ─────────────────────────────────────────────────────────────────────
export interface Hand {
  cards: Card[];
  value: number;     // obliczona wartość (ace = 11 lub 1)
  isSoft: boolean;   // true jeśli As liczony jako 11
  isBust: boolean;   // value > 21
  isBlackjack: boolean; // 2 karty, wartość 21
}

// ─── Stan Gry ─────────────────────────────────────────────────────────────────
export type GameStatus =
  | "BETTING"
  | "DEALING"
  | "PLAYER_TURN"
  | "DEALER_TURN"
  | "FINISHED";

export type GameResult = "WIN" | "LOSS" | "PUSH" | "BLACKJACK" | null;

export interface GameState {
  gameId: string;
  tableId: string;
  playerId: string;
  status: GameStatus;
  playerHand: Hand;
  dealerHand: Hand;     // hidden[0] podczas PLAYER_TURN
  betAmount: number;
  result: GameResult;
  deckSeed: string;
  deckRemaining: number; // ile kart zostało w talii
  updatedAt: string;    // ISO 8601
}

// ─── Akcja Gracza ─────────────────────────────────────────────────────────────
export type PlayerActionType = "HIT" | "STAND" | "DOUBLE_DOWN";

export interface PlayerAction {
  type: PlayerActionType;
  idempotencyKey: string; // UUID v4, unikalny per akcja
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
export type TableStatus = "WAITING" | "ACTIVE" | "FINISHED";

export interface TableInfo {
  tableId: string;
  name: string;
  status: TableStatus;
  minBet: number;
  maxBet: number;
  hasPlayer: boolean;
}

// ─── Gracz ────────────────────────────────────────────────────────────────────
export interface PlayerProfile {
  playerId: string;
  username: string;
  chips: number;
}
```

---

## 7. Protokół WebSocket

### Konwencje Ogólne

- Transport: WebSocket over TLS (`wss://`) w produkcji, `ws://` lokalnie.
- Format: JSON (UTF-8).
- Każda wiadomość zawiera pole `event` (string) i `v` (wersja protokołu, string `"1"`).
- Identyfikacja sesji: JWT token przekazywany w nagłówku `Authorization: Bearer <token>` podczas HTTP Upgrade (WS handshake). Po nawiązaniu połączenia, serwer przypisuje `sessionId` (UUID).
- Obsługa błędów: każdy błąd zwraca `ERROR` event z kodem i komunikatem.
- Heartbeat: klient wysyła `PING` co 30s; serwer odpowiada `PONG`; brak odpowiedzi przez 60s → rozłączenie.

### Zdarzenia — Kierunek Klient → Serwer

#### `JOIN_GAME`

```json
{
  "event": "JOIN_GAME",
  "v": "1",
  "tableId": "uuid-v4",
  "betAmount": 50
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/client/join_game.schema.json",
  "type": "object",
  "required": ["event", "v", "tableId", "betAmount"],
  "additionalProperties": false,
  "properties": {
    "event":     { "type": "string", "const": "JOIN_GAME" },
    "v":         { "type": "string", "const": "1" },
    "tableId":   { "type": "string", "format": "uuid" },
    "betAmount": { "type": "integer", "minimum": 1 }
  }
}
```

#### `PLAYER_ACTION`

```json
{
  "event": "PLAYER_ACTION",
  "v": "1",
  "gameId": "uuid-v4",
  "action": "HIT",
  "idempotencyKey": "uuid-v4"
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/client/player_action.schema.json",
  "type": "object",
  "required": ["event", "v", "gameId", "action", "idempotencyKey"],
  "additionalProperties": false,
  "properties": {
    "event":          { "type": "string", "const": "PLAYER_ACTION" },
    "v":              { "type": "string", "const": "1" },
    "gameId":         { "type": "string", "format": "uuid" },
    "action":         { "type": "string", "enum": ["HIT", "STAND", "DOUBLE_DOWN"] },
    "idempotencyKey": { "type": "string", "format": "uuid" }
  }
}
```

#### `LEAVE_GAME`

```json
{
  "event": "LEAVE_GAME",
  "v": "1",
  "gameId": "uuid-v4"
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/client/leave_game.schema.json",
  "type": "object",
  "required": ["event", "v", "gameId"],
  "additionalProperties": false,
  "properties": {
    "event":  { "type": "string", "const": "LEAVE_GAME" },
    "v":      { "type": "string", "const": "1" },
    "gameId": { "type": "string", "format": "uuid" }
  }
}
```

#### `PING`

```json
{
  "event": "PING",
  "v": "1",
  "timestamp": 1718554800000
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/client/ping.schema.json",
  "type": "object",
  "required": ["event", "v", "timestamp"],
  "additionalProperties": false,
  "properties": {
    "event":     { "type": "string", "const": "PING" },
    "v":         { "type": "string", "const": "1" },
    "timestamp": { "type": "integer" }
  }
}
```

---

### Zdarzenia — Kierunek Serwer → Klient

#### `JOIN_ACK`

```json
{
  "event": "JOIN_ACK",
  "v": "1",
  "gameId": "uuid-v4",
  "tableId": "uuid-v4",
  "playerId": "uuid-v4",
  "sessionId": "uuid-v4",
  "minBet": 10,
  "maxBet": 500
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/server/join_ack.schema.json",
  "type": "object",
  "required": ["event", "v", "gameId", "tableId", "playerId", "sessionId", "minBet", "maxBet"],
  "additionalProperties": false,
  "properties": {
    "event":     { "type": "string", "const": "JOIN_ACK" },
    "v":         { "type": "string", "const": "1" },
    "gameId":    { "type": "string", "format": "uuid" },
    "tableId":   { "type": "string", "format": "uuid" },
    "playerId":  { "type": "string", "format": "uuid" },
    "sessionId": { "type": "string", "format": "uuid" },
    "minBet":    { "type": "integer", "minimum": 1 },
    "maxBet":    { "type": "integer", "minimum": 1 }
  }
}
```

#### `DEAL`

```json
{
  "event": "DEAL",
  "v": "1",
  "gameId": "uuid-v4",
  "playerHand": {
    "cards": [
      { "suit": "HEARTS", "rank": "A" },
      { "suit": "CLUBS",  "rank": "K" }
    ],
    "value": 21,
    "isSoft": false,
    "isBust": false,
    "isBlackjack": true
  },
  "dealerHand": {
    "cards": [
      { "suit": "SPADES", "rank": "7" },
      { "suit": "DIAMONDS", "rank": "2", "hidden": true }
    ],
    "value": 7,
    "isSoft": false,
    "isBust": false,
    "isBlackjack": false
  }
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/server/deal.schema.json",
  "type": "object",
  "required": ["event", "v", "gameId", "playerHand", "dealerHand"],
  "additionalProperties": false,
  "properties": {
    "event":      { "type": "string", "const": "DEAL" },
    "v":          { "type": "string", "const": "1" },
    "gameId":     { "type": "string", "format": "uuid" },
    "playerHand": { "$ref": "#/$defs/hand" },
    "dealerHand": { "$ref": "#/$defs/hand" }
  },
  "$defs": {
    "card": {
      "type": "object",
      "required": ["suit", "rank"],
      "properties": {
        "suit":   { "type": "string", "enum": ["HEARTS","DIAMONDS","CLUBS","SPADES"] },
        "rank":   { "type": "string", "enum": ["2","3","4","5","6","7","8","9","10","J","Q","K","A"] },
        "hidden": { "type": "boolean" }
      }
    },
    "hand": {
      "type": "object",
      "required": ["cards", "value", "isSoft", "isBust", "isBlackjack"],
      "properties": {
        "cards":       { "type": "array", "items": { "$ref": "#/$defs/card" } },
        "value":       { "type": "integer", "minimum": 0, "maximum": 30 },
        "isSoft":      { "type": "boolean" },
        "isBust":      { "type": "boolean" },
        "isBlackjack": { "type": "boolean" }
      }
    }
  }
}
```

#### `GAME_STATE`

```json
{
  "event": "GAME_STATE",
  "v": "1",
  "gameId": "uuid-v4",
  "status": "PLAYER_TURN",
  "playerHand": { "...": "jak wyżej" },
  "dealerHand":  { "...": "jak wyżej" },
  "betAmount": 50,
  "result": null,
  "availableActions": ["HIT", "STAND", "DOUBLE_DOWN"],
  "playerChips": 950
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/server/game_state.schema.json",
  "type": "object",
  "required": ["event","v","gameId","status","playerHand","dealerHand","betAmount","result","availableActions","playerChips"],
  "additionalProperties": false,
  "properties": {
    "event":            { "type": "string", "const": "GAME_STATE" },
    "v":                { "type": "string", "const": "1" },
    "gameId":           { "type": "string", "format": "uuid" },
    "status":           { "type": "string", "enum": ["BETTING","DEALING","PLAYER_TURN","DEALER_TURN","FINISHED"] },
    "playerHand":       { "$ref": "deal.schema.json#/$defs/hand" },
    "dealerHand":       { "$ref": "deal.schema.json#/$defs/hand" },
    "betAmount":        { "type": "integer", "minimum": 0 },
    "result":           { "type": ["string","null"], "enum": ["WIN","LOSS","PUSH","BLACKJACK",null] },
    "availableActions": { "type": "array", "items": { "type": "string", "enum": ["HIT","STAND","DOUBLE_DOWN"] } },
    "playerChips":      { "type": "integer", "minimum": 0 }
  }
}
```

#### `ERROR`

```json
{
  "event": "ERROR",
  "v": "1",
  "code": "INVALID_ACTION",
  "message": "Cannot HIT when game status is FINISHED",
  "gameId": "uuid-v4"
}
```

**JSON Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ws/server/error.schema.json",
  "type": "object",
  "required": ["event", "v", "code", "message"],
  "additionalProperties": false,
  "properties": {
    "event":   { "type": "string", "const": "ERROR" },
    "v":       { "type": "string", "const": "1" },
    "code":    { "type": "string", "enum": [
      "INVALID_ACTION", "INSUFFICIENT_CHIPS", "TABLE_FULL",
      "GAME_NOT_FOUND", "UNAUTHORIZED", "INVALID_MESSAGE",
      "PROTOCOL_VERSION_MISMATCH", "INTERNAL_ERROR"
    ]},
    "message": { "type": "string" },
    "gameId":  { "type": "string", "format": "uuid" }
  }
}
```

#### `HEARTBEAT`

```json
{
  "event": "HEARTBEAT",
  "v": "1",
  "serverTime": 1718554800000,
  "gameId": "uuid-v4",
  "status": "PLAYER_TURN"
}
```

#### `PONG`

```json
{
  "event": "PONG",
  "v": "1",
  "timestamp": 1718554800000
}
```

### Kody Błędów — Pełna Tabela

| Kod | Opis |
|-----|------|
| `UNAUTHORIZED` | Brak lub nieprawidłowy JWT |
| `INVALID_MESSAGE` | Wiadomość nie przeszła walidacji JSON Schema |
| `PROTOCOL_VERSION_MISMATCH` | `"v"` różne od `"1"` |
| `GAME_NOT_FOUND` | gameId nie istnieje lub nie należy do gracza |
| `INVALID_ACTION` | Akcja niedozwolona w aktualnym stanie gry |
| `INSUFFICIENT_CHIPS` | Za mało żetonów na zakład |
| `TABLE_FULL` | Stolik jest zajęty |
| `INTERNAL_ERROR` | Błąd serwera — patrz logi |

### Mechanizm Idempotentności

Każda wiadomość `PLAYER_ACTION` zawiera `idempotencyKey` (UUID v4 generowany przez klienta). Serwer sprawdza `games.idempotency_key` przed przetworzeniem akcji:

- Jeśli `idempotencyKey` == ostatni zapisany → zwróć cached `GAME_STATE` (bez ponownego przetwarzania).
- Jeśli `idempotencyKey` != ostatni zapisany → przetwórz i zapisz nowy klucz atomowo w tej samej transakcji.

---

## 8. Izolacja Logiki — Wzorzec game-core

### Zasady

1. `game-core` to **czysty moduł TypeScript** bez żadnych importów z `pg`, `redis`, `ws`, `fastify` ani jakichkolwiek Node.js API sieciowych.
2. Wszystkie funkcje są **deterministyczne** — ten sam input zawsze daje ten sam output.
3. RNG jest **wstrzykiwany** jako parametr funkcji `createDeck(seed: string)` — nie ma globalnego stanu.
4. Błędy domenowe zwracają `Result<T, DomainError>` (either pattern) — nie rzucają wyjątków (nie wymuszają obsługi przez `try/catch`).

### Publiczne API game-core

```typescript
// contracts/game-core.api.ts

export interface DomainError {
  code: "BUST" | "INVALID_ACTION" | "GAME_OVER" | "BLACKJACK";
  message: string;
}

export type Result<T, E = DomainError> =
  | { ok: true;  value: T }
  | { ok: false; error: E };

// Tworzy potasowaną talię z deterministycznym seed
export type CreateDeck = (seed: string) => Card[];

// Rozdaje początkowe karty (2 dla gracza, 2 dla dealera, jedna ukryta)
export type DealInitialCards = (deck: Card[]) => {
  playerHand: Card[];
  dealerHand: Card[];   // dealer.cards[1].hidden = true
  remainingDeck: Card[];
};

// Oblicza wartość ręki
export type CalculateHandValue = (cards: Card[]) => {
  value: number;
  isSoft: boolean;
  isBust: boolean;
  isBlackjack: boolean;
};

// Przetwarza akcję gracza HIT
export type ApplyHit = (
  deck: Card[],
  playerHand: Card[]
) => Result<{ newCard: Card; playerHand: Card[]; remainingDeck: Card[] }>;

// Przetwarza STAND (uruchamia logikę dealera)
export type ApplyStand = (
  deck: Card[],
  dealerHand: Card[]
) => Result<{ dealerHand: Card[]; remainingDeck: Card[] }>;

// Przetwarza DOUBLE_DOWN
export type ApplyDoubleDown = (
  deck: Card[],
  playerHand: Card[]
) => Result<{ newCard: Card; playerHand: Card[]; remainingDeck: Card[] }>;

// Określa wynik rundy
export type DetermineResult = (
  playerHand: Card[],
  dealerHand: Card[]
) => GameResult;

// Oblicza zmianę żetonów
export type CalculateChipsDelta = (
  result: GameResult,
  betAmount: number
) => number;
```

### Wzorzec Maszyny Stanów

```typescript
// contracts/game-state-machine.ts

export type GameTransition =
  | { from: "BETTING";     action: "DEAL_CARDS";   to: "DEALING"      }
  | { from: "DEALING";     action: "CARDS_DEALT";  to: "PLAYER_TURN"  }
  | { from: "DEALING";     action: "BLACKJACK";    to: "FINISHED"     }
  | { from: "PLAYER_TURN"; action: "HIT";          to: "PLAYER_TURN"  }
  | { from: "PLAYER_TURN"; action: "BUST";         to: "FINISHED"     }
  | { from: "PLAYER_TURN"; action: "STAND";        to: "DEALER_TURN"  }
  | { from: "PLAYER_TURN"; action: "DOUBLE_DOWN";  to: "DEALER_TURN"  }
  | { from: "DEALER_TURN"; action: "DEALER_DONE";  to: "FINISHED"     };

// Dozwolone akcje per status
export const ALLOWED_ACTIONS: Record<GameStatus, PlayerActionType[]> = {
  BETTING:     [],
  DEALING:     [],
  PLAYER_TURN: ["HIT", "STAND", "DOUBLE_DOWN"],
  DEALER_TURN: [],
  FINISHED:    [],
};
```

---

## 9. Strategia Testów

### Konfiguracja Vitest

**Plik: `vitest.config.ts` (root)**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "services/game-core/src/**/*.test.ts",
      "services/game-service/src/**/*.test.ts",
      "gateway/ws/src/**/*.test.ts",
      "services/auth-lobby/src/**/*.test.ts",
      "frontend/src/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        global: {
          lines:      80,
          functions:  80,
          branches:   75,
          statements: 80,
        },
      },
      include: ["services/**/src/**", "gateway/**/src/**"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
    },
  },
});
```

**Plik: `services/game-core/vitest.config.ts` (game-core — wyższy próg)**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      thresholds: {
        global: {
          lines:      90,
          functions:  90,
          branches:   85,
          statements: 90,
        },
      },
    },
  },
});
```

### Testy Jednostkowe — game-core

#### Przykład 1: Obliczanie Wartości Ręki

```typescript
// services/game-core/src/__tests__/calculateHandValue.test.ts
import { describe, it, expect } from "vitest";
import { calculateHandValue } from "../calculateHandValue";

describe("calculateHandValue", () => {
  it("liczy wartość prostą bez Asa", () => {
    const result = calculateHandValue([
      { suit: "HEARTS",   rank: "7" },
      { suit: "DIAMONDS", rank: "9" },
    ]);
    expect(result).toEqual({ value: 16, isSoft: false, isBust: false, isBlackjack: false });
  });

  it("liczy Asa jako 11 gdy suma <= 21", () => {
    const result = calculateHandValue([
      { suit: "HEARTS", rank: "A" },
      { suit: "CLUBS",  rank: "6" },
    ]);
    expect(result).toEqual({ value: 17, isSoft: true, isBust: false, isBlackjack: false });
  });

  it("zmienia Asa na 1 gdy suma > 21", () => {
    const result = calculateHandValue([
      { suit: "HEARTS",   rank: "A" },
      { suit: "CLUBS",    rank: "6" },
      { suit: "DIAMONDS", rank: "9" },
    ]);
    expect(result).toEqual({ value: 16, isSoft: false, isBust: false, isBlackjack: false });
  });

  it("wykrywa Blackjack (A + figura)", () => {
    const result = calculateHandValue([
      { suit: "HEARTS", rank: "A" },
      { suit: "CLUBS",  rank: "K" },
    ]);
    expect(result).toEqual({ value: 21, isSoft: false, isBust: false, isBlackjack: true });
  });

  it("wykrywa bust > 21", () => {
    const result = calculateHandValue([
      { suit: "HEARTS",   rank: "K" },
      { suit: "DIAMONDS", rank: "Q" },
      { suit: "CLUBS",    rank: "5" },
    ]);
    expect(result).toEqual({ value: 25, isSoft: false, isBust: true, isBlackjack: false });
  });
});
```

#### Przykład 2: Deterministyczny RNG — Tasowanie

```typescript
// services/game-core/src/__tests__/createDeck.test.ts
import { describe, it, expect } from "vitest";
import { createDeck } from "../createDeck";

describe("createDeck (deterministyczny RNG)", () => {
  it("zwraca 52 karty", () => {
    const deck = createDeck("test-seed-42");
    expect(deck).toHaveLength(52);
  });

  it("te same seed → identyczna kolejność kart", () => {
    const deck1 = createDeck("reproducible-seed");
    const deck2 = createDeck("reproducible-seed");
    expect(deck1).toEqual(deck2);
  });

  it("różne seed → różna kolejność kart", () => {
    const deck1 = createDeck("seed-A");
    const deck2 = createDeck("seed-B");
    expect(deck1).not.toEqual(deck2);
  });

  it("każda karta jest unikalna", () => {
    const deck = createDeck("unique-test");
    const keys = deck.map(c => `${c.suit}-${c.rank}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(52);
  });
});
```

#### Przykład 3: Zachowanie Dealera

```typescript
// services/game-core/src/__tests__/applyStand.test.ts
import { describe, it, expect } from "vitest";
import { applyStand } from "../applyStand";
import { calculateHandValue } from "../calculateHandValue";

describe("applyStand (logika dealera)", () => {
  it("dealer dobiera karty do wartości >= 17 (hard)", () => {
    const fixedDeck = [
      { suit: "HEARTS", rank: "5" },
      { suit: "CLUBS",  rank: "K" },
    ];
    const dealerStartHand = [
      { suit: "SPADES",   rank: "6" },
      { suit: "DIAMONDS", rank: "9" },
    ];
    const result = applyStand(fixedDeck, dealerStartHand);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { value } = calculateHandValue(result.value.dealerHand);
      expect(value).toBeGreaterThanOrEqual(17);
    }
  });

  it("dealer MUSI dobierać na soft 16 (As+5)", () => {
    const fixedDeck = [{ suit: "HEARTS", rank: "3" }];
    const dealerStartHand = [
      { suit: "CLUBS",  rank: "A" },
      { suit: "HEARTS", rank: "5" },
    ];
    const result = applyStand(fixedDeck, dealerStartHand);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dealerHand.length).toBe(3);
    }
  });
});
```

### Testy Integracyjne

#### Setup — SQLite In-Memory (Drizzle + better-sqlite3)

```typescript
// services/game-service/src/__tests__/setup.ts
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema";

export function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle/migrations" });
  return db;
}
```

#### Przykład Testu Integracyjnego

```typescript
// services/game-service/src/__tests__/gameService.integration.test.ts
import { describe, it, beforeEach, expect } from "vitest";
import { createTestDb } from "./setup";
import { GameService } from "../GameService";

describe("GameService (integracja, SQLite in-memory)", () => {
  let db: ReturnType<typeof createTestDb>;
  let gameService: GameService;

  beforeEach(() => {
    db = createTestDb();
    gameService = new GameService(db);
  });

  it("tworzy grę i zapisuje w DB", async () => {
    const game = await gameService.createGame({
      tableId: "table-uuid-test",
      playerId: "player-uuid-test",
      betAmount: 50,
      deckSeed: "integration-seed-1",
    });
    expect(game.id).toBeDefined();
    expect(game.status).toBe("DEALING");
  });

  it("przetwarza akcję HIT i aktualizuje stan w DB", async () => {
    const game = await gameService.createGame({ /* ... */ });
    const updatedGame = await gameService.applyPlayerAction(
      game.id,
      { type: "HIT", idempotencyKey: "idem-key-1" }
    );
    expect(updatedGame.status).toBe("PLAYER_TURN");
  });

  it("idempotentność: ta sama idempotencyKey nie duplikuje akcji", async () => {
    const game = await gameService.createGame({ /* ... */ });
    const first  = await gameService.applyPlayerAction(game.id, { type: "HIT", idempotencyKey: "same-key" });
    const second = await gameService.applyPlayerAction(game.id, { type: "HIT", idempotencyKey: "same-key" });
    expect(first.playerHand.cards.length).toBe(second.playerHand.cards.length);
  });
});
```

### Testy Kontraktowe

Każdy moduł **przed integracją z innym** musi przejść walidację schematu JSON z `/contracts`.

```typescript
// contracts/__tests__/wsMessages.contract.test.ts
import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import joinGameSchema from "../ws/client/join_game.schema.json";
import gameStateSchema from "../ws/server/game_state.schema.json";

const ajv = new Ajv({ strict: true });
addFormats(ajv);

describe("Kontrakty WebSocket — walidacja schematów", () => {
  it("JOIN_GAME: valid payload przechodzi walidację", () => {
    const validate = ajv.compile(joinGameSchema);
    const valid = validate({
      event: "JOIN_GAME", v: "1",
      tableId: "123e4567-e89b-12d3-a456-426614174000",
      betAmount: 50,
    });
    expect(valid).toBe(true);
  });

  it("JOIN_GAME: brak wymaganego pola tableId → błąd", () => {
    const validate = ajv.compile(joinGameSchema);
    const valid = validate({ event: "JOIN_GAME", v: "1", betAmount: 50 });
    expect(valid).toBe(false);
  });

  it("GAME_STATE: invalid status → błąd", () => {
    const validate = ajv.compile(gameStateSchema);
    const valid = validate({
      event: "GAME_STATE", v: "1",
      status: "UNKNOWN_STATUS",
      /* ... */
    });
    expect(valid).toBe(false);
  });
});
```

### Testy WS Gateway

```typescript
// gateway/ws/src/__tests__/gateway.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { createTestServer } from "./testServer";

describe("WS Gateway — deserializacja wiadomości", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let ws: WebSocket;

  beforeAll(async () => {
    server = await createTestServer();
    ws = new WebSocket(`ws://localhost:${server.port}`, {
      headers: { Authorization: `Bearer ${server.testToken}` }
    });
    await new Promise(res => ws.on("open", res));
  });

  afterAll(() => { ws.close(); server.close(); });

  it("odpowiada ERROR na nieprawidłowy JSON", async () => {
    ws.send("not-json");
    const msg = await new Promise<string>(res => ws.once("message", res));
    const parsed = JSON.parse(msg.toString());
    expect(parsed.event).toBe("ERROR");
    expect(parsed.code).toBe("INVALID_MESSAGE");
  });

  it("odpowiada ERROR na nieznaną wersję protokołu", async () => {
    ws.send(JSON.stringify({ event: "PING", v: "99", timestamp: Date.now() }));
    const msg = await new Promise<string>(res => ws.once("message", res));
    const parsed = JSON.parse(msg.toString());
    expect(parsed.event).toBe("ERROR");
    expect(parsed.code).toBe("PROTOCOL_VERSION_MISMATCH");
  });
});
```

---

## 10. CI/CD i Metryki Jakości

### Pipeline GitHub Actions

**Plik: `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main, "cursor/**"]
  pull_request:
    branches: [main]

jobs:
  quality-gate:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: blackjack_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: --health-cmd "redis-cli ping" --health-interval 5s

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci --workspaces

      - name: Lint (ESLint + TypeScript)
        run: npm run lint --workspaces

      - name: Type Check
        run: npm run typecheck --workspaces

      - name: Unit Tests (game-core)
        run: npm run test:unit --workspace=services/game-core -- --coverage

      - name: Contract Tests
        run: npm run test:contracts --workspace=contracts

      - name: Unit Tests (all)
        run: npm run test:unit --workspaces -- --coverage

      - name: Integration Tests
        run: npm run test:integration --workspaces
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/blackjack_test
          REDIS_URL: redis://localhost:6379

      - name: Coverage Gate
        run: npm run coverage:check --workspaces

      - name: Build
        run: npm run build --workspaces
```

### Pre-commit Hooks

**Plik: `.husky/pre-commit`**

```bash
#!/bin/sh
npx lint-staged
```

**Plik: `.lintstagedrc.json`**

```json
{
  "*.{ts,tsx}": [
    "eslint --fix",
    "prettier --write"
  ],
  "contracts/**/*.json": [
    "node scripts/validate-schemas.js"
  ]
}
```

### Metryki Jakości — Progi

| Metryka | Próg | Dotyczy |
|---------|------|---------|
| Line coverage | ≥ 90% | `game-core` |
| Line coverage | ≥ 80% | wszystkie moduły |
| Branch coverage | ≥ 85% | `game-core` |
| Branch coverage | ≥ 75% | wszystkie moduły |
| Lint errors | 0 | wszystkie pliki |
| TypeScript errors | 0 | strict mode |
| Contract tests | 100% pass | przed każdym merge |
| Build | success | przed każdym merge |

---

## 11. Bezpieczeństwo i Skalowalność

### Bezpieczeństwo

- **Autoryzacja WS:** JWT weryfikowany podczas HTTP Upgrade (`Sec-WebSocket-Protocol` lub `Authorization` header). Każde zdarzenie sprawdza czy `gameId` należy do uwierzytelnionego gracza.
- **Ochrona przed duplikacją:** `idempotencyKey` per akcja (UUID v4 z klienta) + unikalny klucz w DB.
- **Rate limiting:** Redis + sliding window (max 60 wiadomości/min per połączenie WS).
- **Sanityzacja danych:** zod parse na każdej przychodzącj wiadomości WS — automatyczne odrzucenie nieznanych pól (`strict: true`).
- **Bezpieczeństwo RNG:** seed generowany serwerowo (`crypto.randomUUID()`), nie przekazywany klientowi. Klient nie ma wpływu na kolejność kart.
- **SQL Injection:** ORM (Drizzle) z parametryzowanymi zapytaniami — brak surowego SQL z wejścia użytkownika.

### Skalowalność (podstawowa)

- **Horizontal scaling:** Redis pub/sub jako backplane dla wielu instancji Node.js (jeden gracz może trafić na inny węzeł po reconnect).
- **Connection state:** stan gry w PostgreSQL (nie w pamięci serwera) — bezstanowy WS gateway.
- **Skalowanie DB:** read replicas dla lobby (odczyt listy stolików), write master dla operacji na grze.
- **Event-sourcing opcja:** tabela `game_events` jako write-ahead log pozwala odtworzyć stan gry bez snapshotów (włączona opcjonalnie w v2).

### Ochrona Stanu Gry — Strategie

1. **Transakcje DB:** każda operacja na `games` + `players.chips` wykonywana w jednej transakcji `BEGIN/COMMIT`.
2. **Optimistic locking:** pole `updated_at` jako wersja — jeśli zmieniona między odczytem a zapisem, retry.
3. **Idempotency keys:** opisane w sekcji 7. Zapobiega podwójnemu przetworzeniu tej samej akcji.
4. **Reconnect graceful:** po reconnect klient wysyła `JOIN_GAME` z istniejącym `gameId` — serwer zwraca aktualny `GAME_STATE`.

---

## 12. Plan Iteracyjny — Kamienie Milowe

> Każdy agent pracuje wyłącznie nad swoim modułem. Przed mergem do `main` — green CI.

---

### Moduł 1: `game-core`

**Agent:** `agent-game-core`
**Cel modułu:** Czysta, deterministyczna logika Blackjacka bez żadnych zewnętrznych zależności.

#### M1-1: Typy i Kontrakty Domenowe

- **Cel:** Zdefiniować wszystkie typy TypeScript domeny gry.
- **Pliki do utworzenia:**
  - `contracts/domain.ts` — typy `Card`, `Hand`, `GameState`, `PlayerAction`, `GameResult`
  - `contracts/game-core.api.ts` — publiczne API sygnatury funkcji
  - `contracts/game-state-machine.ts` — przejścia stanów i `ALLOWED_ACTIONS`
- **Kryteria zakończenia:**
  - `npm run typecheck` bez błędów
  - `npm run lint` bez błędów
  - Pliki w `/contracts` są walidowane przez `npm run test:contracts`
- **Komendy CI:** `npm run typecheck --workspace=contracts && npm run lint --workspace=contracts`
- **Checklista merge:** ✅ typecheck green · ✅ lint green · ✅ kontrakt zaakceptowany przez Tech Lead Agenta
- **Rollback:** usunąć pliki z `/contracts`, nie mergować do `main`

#### M1-2: Implementacja Talii i RNG

- **Cel:** Implementacja `createDeck` z deterministycznym seedowanym RNG.
- **Pliki do utworzenia:**
  - `services/game-core/src/createDeck.ts`
  - `services/game-core/src/__tests__/createDeck.test.ts`
  - `services/game-core/package.json` (zależności: `seedrandom`, `@types/seedrandom`)
- **Kryteria zakończenia:**
  - Testy jednostkowe: 4/4 green (52 karty, reproducibility, uniqueness, different seeds)
  - Coverage: 100% dla `createDeck.ts`
  - `npm run test:unit --workspace=services/game-core`
- **Komendy CI:** `npm run test:unit --workspace=services/game-core -- --coverage`
- **Checklista merge:** ✅ 4/4 testy green · ✅ 100% coverage createDeck · ✅ lint green
- **Rollback:** revert commit, nie mergować

#### M1-3: Obliczanie Wartości Ręki

- **Cel:** `calculateHandValue` — obsługa Asa (1 lub 11), bust, blackjack.
- **Pliki do utworzenia:**
  - `services/game-core/src/calculateHandValue.ts`
  - `services/game-core/src/__tests__/calculateHandValue.test.ts` (min. 10 przypadków)
- **Kryteria zakończenia:**
  - Testy: minimum 10 przypadków brzegowych (asy, bust, blackjack, soft hands)
  - Coverage `calculateHandValue.ts`: 100%
  - `npm run test:unit --workspace=services/game-core -- --coverage`
- **Komendy CI:** jak wyżej
- **Checklista merge:** ✅ ≥10 testów green · ✅ 100% coverage · ✅ lint green
- **Rollback:** revert commit

#### M1-4: Akcje Gracza (HIT, STAND, DOUBLE_DOWN)

- **Cel:** `applyHit`, `applyStand`, `applyDoubleDown` — implementacja z logiką dealera w `applyStand`.
- **Pliki do utworzenia:**
  - `services/game-core/src/applyHit.ts`
  - `services/game-core/src/applyStand.ts`
  - `services/game-core/src/applyDoubleDown.ts`
  - `services/game-core/src/__tests__/applyHit.test.ts`
  - `services/game-core/src/__tests__/applyStand.test.ts`
  - `services/game-core/src/__tests__/applyDoubleDown.test.ts`
- **Kryteria zakończenia:**
  - Testy dla każdej akcji: min 5 przypadków
  - Dealer zawsze dobiera do ≥17 (hard) lub ≥18 (soft 17 rule — hits soft 17)
  - Coverage game-core: ≥ 90%
- **Komendy CI:** `npm run test:unit --workspace=services/game-core -- --coverage`
- **Checklista merge:** ✅ ≥15 testów łącznie green · ✅ ≥90% coverage · ✅ lint · ✅ Tech Lead review
- **Rollback:** revert commit

#### M1-5: Wynik Rundy i Integracja Modułu

- **Cel:** `determineResult`, `calculateChipsDelta`, eksport publicznego API.
- **Pliki do utworzenia:**
  - `services/game-core/src/determineResult.ts`
  - `services/game-core/src/calculateChipsDelta.ts`
  - `services/game-core/src/index.ts` (barrel export)
  - `services/game-core/src/__tests__/determineResult.test.ts`
  - `services/game-core/src/__tests__/integration.test.ts` (pełna rozgrywka end-to-end, brak serwera)
- **Kryteria zakończenia:**
  - Pełna rozgrywka E2E w testach: HIT→BUST, STAND→WIN, BLACKJACK, PUSH
  - Coverage game-core: ≥ 90% lines, ≥ 85% branches
  - Wszystkie sygnatury zgodne z `contracts/game-core.api.ts`
- **Komendy CI:** `npm run test:unit --workspace=services/game-core -- --coverage && npm run typecheck --workspace=services/game-core`
- **Checklista merge:** ✅ E2E testy green · ✅ ≥90% coverage · ✅ typecheck · ✅ kontrakt API zgodny · ✅ Tech Lead merge approval

---

### Moduł 2: `game-service`

**Agent:** `agent-game-service`
**Cel modułu:** Warstwa persystencji — operacje na DB, transakcje, idempotency.

#### M2-1: Schemat DB i Migracje

- **Cel:** Inicjalizacja Drizzle ORM, schemat tabel, migracje.
- **Pliki do utworzenia:**
  - `services/game-service/src/db/schema.ts` — Drizzle schema dla wszystkich tabel
  - `services/game-service/drizzle/migrations/0001_initial.sql`
  - `services/game-service/drizzle.config.ts`
- **Kryteria zakończenia:**
  - Migracja uruchamia się bez błędów na PostgreSQL test DB
  - `npm run db:migrate --workspace=services/game-service`
- **Komendy CI:** `npm run db:migrate --workspace=services/game-service`
- **Checklista merge:** ✅ migracja green · ✅ schema zgodna z sekcją 5 ARCHITECTURE.md · ✅ Tech Lead approval
- **Rollback:** `npm run db:rollback`, revert migration file

#### M2-2: Repozytoria (GameRepository, PlayerRepository)

- **Cel:** CRUD operacje z typowaniem Drizzle.
- **Pliki do utworzenia:**
  - `services/game-service/src/repositories/GameRepository.ts`
  - `services/game-service/src/repositories/PlayerRepository.ts`
  - `services/game-service/src/__tests__/GameRepository.test.ts` (SQLite in-memory)
  - `services/game-service/src/__tests__/PlayerRepository.test.ts`
- **Kryteria zakończenia:**
  - CRUD operacje: create, findById, update, findActiveByPlayer
  - Testy integracyjne: min 8 przypadków łącznie
  - `npm run test:integration --workspace=services/game-service`
- **Komendy CI:** `npm run test:integration --workspace=services/game-service`
- **Checklista merge:** ✅ 8+ testów green · ✅ typecheck · ✅ lint
- **Rollback:** revert commit

#### M2-3: GameService — Transakcje i Idempotency

- **Cel:** Serwis biznesowy z transakcjami i obsługą idempotency keys.
- **Pliki do utworzenia:**
  - `services/game-service/src/GameService.ts`
  - `services/game-service/src/__tests__/GameService.integration.test.ts`
- **Kryteria zakończenia:**
  - Test idempotentności: wysłanie tej samej `idempotencyKey` dwa razy daje identyczny wynik
  - Test transakcji: rollback przy błędzie (chips NIE mogą być odjęte przy błędzie zapisu gry)
  - Min 10 testów integracyjnych
- **Komendy CI:** `npm run test:integration --workspace=services/game-service -- --coverage`
- **Checklista merge:** ✅ idempotency test green · ✅ transakcja rollback test green · ✅ ≥80% coverage · ✅ Tech Lead review
- **Rollback:** revert commit; sprawdzić czy dane testowe nie zanieczyszczają staging DB

#### M2-4: Event Log (opcjonalny write-ahead)

- **Cel:** Zapis każdej akcji do `game_events` dla audytu i odtwarzania stanu.
- **Pliki do utworzenia:**
  - `services/game-service/src/repositories/EventLogRepository.ts`
  - `services/game-service/src/__tests__/EventLog.test.ts`
- **Kryteria zakończenia:**
  - Każda akcja gracza tworzy wpis w `game_events` z unikalnym `sequence_no`
  - Test: odtworzenie stanu z event log = stan z DB snapshot
- **Komendy CI:** `npm run test:integration --workspace=services/game-service`
- **Checklista merge:** ✅ event log test green · ✅ sequence_no unikalność test · ✅ lint
- **Rollback:** revert, feature flag wyłącza event log (defaultowo disabled w v1)

#### M2-5: Integracja z game-core

- **Cel:** GameService wywołuje funkcje game-core jako czyste funkcje (DI).
- **Pliki do modyfikacji/utworzenia:**
  - `services/game-service/src/GameService.ts` (integracja z game-core)
  - `services/game-service/src/__tests__/GameServiceWithCore.integration.test.ts`
- **Kryteria zakończenia:**
  - Pełna rozgrywka przez GameService: bet → deal → HIT → STAND → wynik → aktualizacja chips
  - Test: chips gracza poprawnie zaktualizowane po wyniku gry
  - Kontrakt: typy z `contracts/domain.ts` używane w całym serwisie
- **Komendy CI:** `npm run test:integration --workspace=services/game-service && npm run typecheck --workspace=services/game-service`
- **Checklista merge:** ✅ pełna rozgrywka test green · ✅ chips delta test · ✅ typecheck · ✅ Tech Lead approval

---

### Moduł 3: `websocket-gateway`

**Agent:** `agent-ws-gateway`
**Cel modułu:** WS server, routing wiadomości, serializacja/deserializacja, heartbeat.

#### M3-1: Serwer WS i Handshake JWT

- **Cel:** Uruchomić Fastify + @fastify/websocket; weryfikacja JWT podczas Upgrade.
- **Pliki do utworzenia:**
  - `gateway/ws/src/server.ts`
  - `gateway/ws/src/auth/jwtVerify.ts`
  - `gateway/ws/src/__tests__/server.test.ts` (test połączenia z/bez tokenu)
- **Kryteria zakończenia:**
  - Połączenie z prawidłowym JWT: 101 Switching Protocols
  - Połączenie bez JWT: zamknięcie z kodem 1008 (policy violation)
  - Testy WS: min 4 przypadki
- **Komendy CI:** `npm run test:unit --workspace=gateway/ws`
- **Checklista merge:** ✅ auth test green · ✅ lint · ✅ typecheck
- **Rollback:** revert; nie deployować bez JWT guard

#### M3-2: Parser i Walidator Wiadomości

- **Cel:** Deserializacja JSON + walidacja zod schema dla każdego zdarzenia.
- **Pliki do utworzenia:**
  - `gateway/ws/src/parser/messageParser.ts`
  - `gateway/ws/src/parser/schemas.ts` (zod schemas per event, importujące `/contracts`)
  - `gateway/ws/src/__tests__/messageParser.test.ts`
- **Kryteria zakończenia:**
  - Test: nieprawidłowy JSON → `ERROR INVALID_MESSAGE`
  - Test: nieznany event → `ERROR INVALID_MESSAGE`
  - Test: mismatched version → `ERROR PROTOCOL_VERSION_MISMATCH`
  - Test: valid JOIN_GAME → zwrócony parsed object
  - Coverage messageParser: ≥ 90%
- **Komendy CI:** `npm run test:unit --workspace=gateway/ws -- --coverage`
- **Checklista merge:** ✅ 4+ testy green · ✅ ≥90% coverage · ✅ kontrakt schemas zgodne z `/contracts`
- **Rollback:** revert; gateway nie przyjmuje wiadomości bez validacji

#### M3-3: Router Zdarzeń

- **Cel:** Dispatching zdarzenia do odpowiednich handlerów (JOIN_GAME, PLAYER_ACTION, LEAVE_GAME, PING).
- **Pliki do utworzenia:**
  - `gateway/ws/src/router/messageRouter.ts`
  - `gateway/ws/src/handlers/joinGameHandler.ts`
  - `gateway/ws/src/handlers/playerActionHandler.ts`
  - `gateway/ws/src/handlers/leaveGameHandler.ts`
  - `gateway/ws/src/handlers/pingHandler.ts`
  - `gateway/ws/src/__tests__/messageRouter.test.ts`
- **Kryteria zakończenia:**
  - Mock GameService: JOIN_GAME wywołuje `joinGameHandler`
  - Mock: PING → PONG response w < 50ms
  - Min 6 testów
- **Komendy CI:** `npm run test:unit --workspace=gateway/ws`
- **Checklista merge:** ✅ routing testy green · ✅ lint · ✅ typecheck
- **Rollback:** revert, wyłączyć affected handler

#### M3-4: Heartbeat i Reconnect

- **Cel:** PING/PONG heartbeat; graceful reconnect — przywrócenie stanu gry.
- **Pliki do utworzenia:**
  - `gateway/ws/src/heartbeat/heartbeatManager.ts`
  - `gateway/ws/src/__tests__/heartbeat.test.ts`
- **Kryteria zakończenia:**
  - Test: brak PONG przez 60s → connection terminated
  - Test: reconnect z istniejącym gameId → GAME_STATE push
  - Heartbeat interwał konfigurowalny (env var `WS_HEARTBEAT_INTERVAL_MS`)
- **Komendy CI:** `npm run test:unit --workspace=gateway/ws`
- **Checklista merge:** ✅ heartbeat timeout test · ✅ reconnect test · ✅ lint
- **Rollback:** wyłączyć heartbeat timeout feature flagiem

#### M3-5: Error Handling i Logging

- **Cel:** Centralna obsługa błędów, ustrukturyzowane logi (Pino), metryki latencji.
- **Pliki do utworzenia:**
  - `gateway/ws/src/errors/errorHandler.ts`
  - `gateway/ws/src/middleware/requestLogger.ts`
  - `gateway/ws/src/__tests__/errorHandler.test.ts`
- **Kryteria zakończenia:**
  - Każdy uncaught error zwraca `INTERNAL_ERROR` (bez stack trace do klienta)
  - Logi zawierają: `sessionId`, `event`, `durationMs`, `error.code`
  - Test: błąd w handlerze → ERROR event do klienta, log na serwer
- **Komendy CI:** `npm run test:unit --workspace=gateway/ws`
- **Checklista merge:** ✅ error handler test · ✅ log format test · ✅ lint
- **Rollback:** revert

#### M3-6: Testy E2E Gateway

- **Cel:** Pełny E2E test z prawdziwym WS klientem i mock GameService.
- **Pliki do utworzenia:**
  - `gateway/ws/src/__tests__/e2e.test.ts`
- **Kryteria zakończenia:**
  - Sekwencja: connect → JOIN_GAME → JOIN_ACK → PLAYER_ACTION HIT → GAME_STATE — wszystko w jednym teście
  - Test rate limiting: >60 wiadomości/min → ERROR lub rozłączenie
  - Coverage gateway: ≥ 80% łącznie
- **Komendy CI:** `npm run test:unit --workspace=gateway/ws -- --coverage`
- **Checklista merge:** ✅ E2E test green · ✅ rate limit test · ✅ ≥80% coverage · ✅ Tech Lead approval

---

### Moduł 4: `auth-lobby`

**Agent:** `agent-auth-lobby`
**Cel modułu:** Rejestracja, logowanie, JWT, zarządzanie sesjami, lista stolików.

#### M4-1: Rejestracja i Logowanie (REST)

- **Cel:** `POST /auth/register`, `POST /auth/login` — HTTP REST endpoints.
- **Pliki do utworzenia:**
  - `services/auth-lobby/src/routes/authRoutes.ts`
  - `services/auth-lobby/src/services/AuthService.ts`
  - `services/auth-lobby/src/__tests__/AuthService.test.ts`
- **Kryteria zakończenia:**
  - Rejestracja: hasło hashowane bcrypt (rounds=12)
  - Login: zwraca JWT (exp=1h) + refreshToken (exp=7d)
  - Test: duplikat username → 409 Conflict
  - Test: błędne hasło → 401 Unauthorized
  - Min 6 testów
- **Komendy CI:** `npm run test:unit --workspace=services/auth-lobby`
- **Checklista merge:** ✅ 6+ testy green · ✅ lint · ✅ typecheck
- **Rollback:** revert; nie deployować bez bcrypt

#### M4-2: JWT Middleware i Sesje Redis

- **Cel:** Weryfikacja JWT w WS handshake i HTTP requests; Redis dla sesji.
- **Pliki do utworzenia:**
  - `services/auth-lobby/src/middleware/jwtMiddleware.ts`
  - `services/auth-lobby/src/services/SessionService.ts`
  - `services/auth-lobby/src/__tests__/jwtMiddleware.test.ts`
- **Kryteria zakończenia:**
  - Test: expired JWT → 401
  - Test: blacklisted token (logout) → 401
  - Session store: Redis TTL = JWT expiry
  - Min 5 testów
- **Komendy CI:** `npm run test:unit --workspace=services/auth-lobby`
- **Checklista merge:** ✅ 5+ testy green · ✅ Redis session test · ✅ lint
- **Rollback:** revert; wyczyścić Redis test keys

#### M4-3: Lobby — Lista Stolików

- **Cel:** `GET /lobby/tables` — lista stolików z statusem i dostępnością.
- **Pliki do utworzenia:**
  - `services/auth-lobby/src/routes/lobbyRoutes.ts`
  - `services/auth-lobby/src/services/LobbyService.ts`
  - `services/auth-lobby/src/__tests__/LobbyService.test.ts`
- **Kryteria zakończenia:**
  - Zwraca tablicę `TableInfo[]` zgodną z `contracts/domain.ts`
  - Test: zalogowany gracz widzi stolik ze statusem WAITING
  - Test: niezalogowany gracz → 401
  - Min 4 testy
- **Komendy CI:** `npm run test:unit --workspace=services/auth-lobby`
- **Checklista merge:** ✅ 4+ testy green · ✅ typy zgodne z contracts · ✅ lint
- **Rollback:** revert

#### M4-4: Profil Gracza i Saldo

- **Cel:** `GET /player/profile`, `GET /player/chips` — dane gracza.
- **Pliki do utworzenia:**
  - `services/auth-lobby/src/routes/playerRoutes.ts`
  - `services/auth-lobby/src/__tests__/playerRoutes.test.ts`
- **Kryteria zakończenia:**
  - Zwraca `PlayerProfile` z `contracts/domain.ts`
  - Test: aktualne saldo chips po grze
  - Min 3 testy
- **Komendy CI:** `npm run test:unit --workspace=services/auth-lobby`
- **Checklista merge:** ✅ 3+ testy green · ✅ typecheck · ✅ lint
- **Rollback:** revert

#### M4-5: Integracja z Gateway i Testy E2E Auth

- **Cel:** Pełny flow: register → login → JWT → WS connect → JWT verified.
- **Pliki do utworzenia:**
  - `services/auth-lobby/src/__tests__/authE2E.integration.test.ts`
- **Kryteria zakończenia:**
  - Pełna sekwencja: register → login → WS connect z JWT → JOIN_ACK
  - Coverage auth-lobby: ≥ 80%
- **Komendy CI:** `npm run test:integration --workspace=services/auth-lobby -- --coverage`
- **Checklista merge:** ✅ E2E test green · ✅ ≥80% coverage · ✅ Tech Lead approval

---

### Moduł 5: `frontend-client`

**Agent:** `agent-frontend`
**Cel modułu:** React UI, WS klient, zarządzanie stanem gry po stronie klienta.

#### M5-1: Setup Projektu i Komponent Lobby

- **Cel:** Vite + React + Tailwind + Zustand; ekran lobby z listą stolików.
- **Pliki do utworzenia:**
  - `frontend/src/App.tsx`
  - `frontend/src/components/Lobby/LobbyScreen.tsx`
  - `frontend/src/stores/lobbyStore.ts`
  - `frontend/src/__tests__/LobbyScreen.test.tsx`
- **Kryteria zakończenia:**
  - Lista stolików renderuje się poprawnie z mock danymi
  - Test: kliknięcie stołu wywołuje `joinTable` action w store
  - `npm run test --workspace=frontend`
- **Komendy CI:** `npm run test --workspace=frontend && npm run lint --workspace=frontend`
- **Checklista merge:** ✅ test green · ✅ lint · ✅ typecheck
- **Rollback:** revert

#### M5-2: WS Client Manager

- **Cel:** Klasa zarządzająca połączeniem WS: connect, reconnect, send, receive, heartbeat.
- **Pliki do utworzenia:**
  - `frontend/src/ws/WebSocketManager.ts`
  - `frontend/src/__tests__/WebSocketManager.test.ts`
- **Kryteria zakończenia:**
  - Test: `connect()` z prawidłowym URL → emituje `onOpen`
  - Test: mock serwer zwraca `ERROR` → store aktualizuje błąd
  - Test: brak PONG → reconnect po 60s (mock timers)
  - Używa natywnego `WebSocket` API (brak Socket.IO)
  - Min 5 testów (z `vi.useFakeTimers()` dla heartbeat)
- **Komendy CI:** `npm run test --workspace=frontend`
- **Checklista merge:** ✅ 5+ testy green · ✅ lint · ✅ typecheck
- **Rollback:** revert

#### M5-3: Widok Stołu i Logika Gry

- **Cel:** Ekran gry: karty gracza, karty dealera, zakład, przyciski akcji.
- **Pliki do utworzenia:**
  - `frontend/src/components/Game/GameTable.tsx`
  - `frontend/src/components/Game/CardHand.tsx`
  - `frontend/src/components/Game/ActionButtons.tsx`
  - `frontend/src/stores/gameStore.ts`
  - `frontend/src/__tests__/GameTable.test.tsx`
  - `frontend/src/__tests__/ActionButtons.test.tsx`
- **Kryteria zakończenia:**
  - Test: `GAME_STATE` event z WS → UI wyświetla poprawne karty
  - Test: przyciski HIT/STAND/DOUBLE_DOWN wyświetlane/ukrywane wg `availableActions`
  - Test: bust → wyświetlony komunikat "Bust!"
  - Min 8 testów renderowania (React Testing Library)
- **Komendy CI:** `npm run test --workspace=frontend`
- **Checklista merge:** ✅ 8+ testy green · ✅ lint · ✅ typecheck
- **Rollback:** revert

#### M5-4: Walidacja Kontraktu po Stronie Klienta

- **Cel:** Klient waliduje przychodzące wiadomości WS (zod) przed aktualizacją store.
- **Pliki do utworzenia:**
  - `frontend/src/ws/messageValidator.ts` (zod schemas z `/contracts`)
  - `frontend/src/__tests__/messageValidator.test.ts`
- **Kryteria zakończenia:**
  - Test: nieprawidłowy `GAME_STATE` (brak pola) → log error, NIE aktualizuje store
  - Test: kontrakt schema konsumer-producent: valid message → aktualizacja store
  - Min 4 testy kontraktowe
- **Komendy CI:** `npm run test --workspace=frontend && npm run test:contracts`
- **Checklista merge:** ✅ 4+ testy green · ✅ kontrakt test green · ✅ lint
- **Rollback:** revert

#### M5-5: Ekran Logowania i Rejestracji

- **Cel:** UI dla auth flow: register, login, JWT storage (httpOnly cookie lub memory).
- **Pliki do utworzenia:**
  - `frontend/src/components/Auth/LoginScreen.tsx`
  - `frontend/src/components/Auth/RegisterScreen.tsx`
  - `frontend/src/stores/authStore.ts`
  - `frontend/src/__tests__/LoginScreen.test.tsx`
- **Kryteria zakończenia:**
  - Test: błędne dane → wyświetlony komunikat błędu
  - Test: poprawny login → redirect do Lobby
  - Min 4 testy
- **Komendy CI:** `npm run test --workspace=frontend`
- **Checklista merge:** ✅ 4+ testy green · ✅ lint · ✅ typecheck
- **Rollback:** revert

#### M5-6: Testy E2E Frontend (Pełna Gra)

- **Cel:** Pełna sekwencja UI: login → lobby → join table → gra → wynik.
- **Pliki do utworzenia:**
  - `frontend/src/__tests__/e2e/fullGame.e2e.test.tsx` (mock WS server)
- **Kryteria zakończenia:**
  - Pełna gra z mock WS: login → JOIN_ACK → DEAL → HIT → GAME_STATE → FINISHED z wynikiem
  - Test: saldo chips aktualizuje się po grze
  - Coverage frontend: ≥ 75%
- **Komendy CI:** `npm run test --workspace=frontend -- --coverage`
- **Checklista merge:** ✅ E2E test green · ✅ ≥75% coverage · ✅ Tech Lead approval

---

## 13. Rola Tech Lead Agenta

### Decyzja: TAK — Tech Lead Agent jest Wymagany

**Uzasadnienie techniczne:**

Projekt jest podzielony na 5 modułów rozwijanych przez 5 niezależnych agentów. Bez koordynatora:

1. **Konflikty kontraktów:** Agent `game-service` może zmienić typ `GameState`, podczas gdy `websocket-gateway` i `frontend` używają starego kształtu — brak walidacji cross-modułowej.
2. **Dryfowanie schematów:** JSON Schemas w `/contracts` mogą stać się nieaktualne względem faktycznych implementacji.
3. **Kolejność milestone'ów:** `game-service` zależy od `game-core`; `gateway` zależy od obu; `frontend` zależy od `gateway` — błędna kolejność blocuje agentów.
4. **CI jako gatekeeper:** Bez centralnego nadzoru agent może mergować failing PR, który blokuje downstream modułów.
5. **Rozbieżność typów:** `contracts/domain.ts` musi być autorytatywnym źródłem — ktoś musi pilnować aby zmiany były koordynowane.

**Koszty/Korzyści:**

| Aspekt | Koszt | Korzyść |
|--------|-------|---------|
| Dedykowany agent | Dodatkowe zasoby obliczeniowe | Eliminacja konfliktów cross-modułowych |
| Overhead review | Wolniejszy merge dla zmieniających API | Zero breaking changes bez autoryzacji |
| Koordynacja MS | Czas na planning | Gwarancja poprawnej kolejności prac |

### Zakres Obowiązków Tech Lead Agenta

#### A. Utrzymanie ARCHITECTURE.md (Single Source of Truth)

- [ ] Każda zmiana architektury musi przejść przez Tech Lead Agenta przed mergem.
- [ ] Sekcje do utrzymywania: protokół WS, schemat DB, model domenowy, API kontrakt.
- [ ] Format zmian: PR do `main` z opisem uzasadnienia + update ARCHITECTURE.md.

#### B. Autoryzacja Kontraktów (`/contracts`)

- [ ] Każdy PR zmieniający pliki w `/contracts/**` wymaga review i approve od Tech Lead Agenta.
- [ ] Przed apprve — weryfikacja, że wszystkie moduły używające kontraktu mają zaktualizowane testy.
- [ ] Wersjonowanie: zmiany breaking w protokole WS → nowy `"v": "2"` (backward compat).
- [ ] Changelog: `contracts/CHANGELOG.md` z datą i opisem każdej zmiany.

#### C. CI Gatekeeper

- [ ] Tech Lead Agent monitoruje status CI na `main` i `cursor/**` branchach.
- [ ] Failing CI blokuje merge — Tech Lead identyfikuje przyczynę i przypisuje do właściwego agenta.
- [ ] Coverage regression (< thresholds) → blokada merge, issue do odpowiedniego agenta.
- [ ] Contract test failures → highest priority, blokada wszystkich downstream modułów.

#### D. Koordynacja Kamieni Milowych

- [ ] Utrzymywanie tablicy zależności milestone'ów (M1 → M2 → M3 / M4 / M5 równolegle).
- [ ] Blokowanie startu milestone gdy poprzedni nie jest green.
- [ ] Przed startem każdego milestone: weryfikacja że wymagane kontrakty są zatwierdzone.
- [ ] Po zakończeniu milestone: update statusu w ARCHITECTURE.md (sekcja postępu).

#### E. Rozwiązywanie Konfliktów Interfejsów

- [ ] Gdy dwa agenty mają konfliktujące propozycje zmiany kontraktu — Tech Lead decyduje i dokumentuje.
- [ ] Priorytety: (1) stabilność gry, (2) testowalność, (3) DX agentów.
- [ ] Każda decyzja zapisana w `decisions/ADR-NNN-title.md` (Architecture Decision Record).

#### F. Zapobieganie Halucynacjom Agentów

- [ ] Przed integracją: wymagane contract tests (ajv) — bez nich merge zablokowany.
- [ ] Każdy agent musi cytować konkretne typy z `contracts/domain.ts` — nie wolno redefiniować typów lokalnie.
- [ ] Test snapshots dla kluczowych wiadomości WS — zmiany snapshots wymagają review Tech Lead.
- [ ] Zakaz commitowania `// @ts-ignore` i `any` bez approval Tech Lead.

### Checklista Merge — Tech Lead Review

Przed każdym merge do `main` Tech Lead weryfikuje:

```
[ ] 1. CI zielone (lint + typecheck + unit + integration + contract + coverage)
[ ] 2. Brak zmian w /contracts bez contract tests
[ ] 3. Typy importowane z /contracts — nie redefiniowane lokalnie
[ ] 4. JSON Schemas w /contracts zaktualizowane przy zmianie wiadomości WS
[ ] 5. Brak @ts-ignore bez uzasadnienia w komentarzu
[ ] 6. Idempotency key zaimplementowany dla nowych akcji mutujących stan
[ ] 7. Testy integracyjne obejmują happy path + error path
[ ] 8. Logika biznesowa nie znajduje się w gateway/frontend (należy do game-core/service)
[ ] 9. ARCHITECTURE.md zaktualizowany jeśli zmienił się interfejs/schemat
[ ] 10. Brak bezpośrednich zapytań SQL w warstwie gateway lub frontend
```

---

## 14. Układ Repozytorium

```
megaBigWin777/
│
├── ARCHITECTURE.md                    ← Ten dokument (Single Source of Truth)
├── README.md                          ← Skrót + quickstart
├── package.json                       ← npm workspaces root
├── tsconfig.base.json                 ← Bazowy TypeScript config (strict)
├── .eslintrc.json                     ← ESLint config (root)
├── .prettierrc                        ← Prettier config
├── vitest.config.ts                   ← Globalny config Vitest
├── .husky/
│   ├── pre-commit
│   └── commit-msg
├── .lintstagedrc.json
│
├── contracts/                         ← ŹRÓDŁO PRAWDY DLA KONTRAKTÓW
│   ├── domain.ts                      ← Typy domenowe (Card, Hand, GameState...)
│   ├── game-core.api.ts               ← Sygnatury publicznych funkcji game-core
│   ├── game-state-machine.ts          ← Przejścia stanów i ALLOWED_ACTIONS
│   ├── CHANGELOG.md                   ← Historia zmian kontraktów
│   ├── ws/
│   │   ├── client/
│   │   │   ├── join_game.schema.json
│   │   │   ├── player_action.schema.json
│   │   │   ├── leave_game.schema.json
│   │   │   └── ping.schema.json
│   │   └── server/
│   │       ├── join_ack.schema.json
│   │       ├── deal.schema.json
│   │       ├── game_state.schema.json
│   │       ├── error.schema.json
│   │       ├── heartbeat.schema.json
│   │       └── pong.schema.json
│   ├── __tests__/
│   │   └── wsMessages.contract.test.ts
│   └── package.json
│
├── services/
│   ├── game-core/                     ← Czysta logika Blackjacka (zero deps zewnętrznych)
│   │   ├── src/
│   │   │   ├── createDeck.ts
│   │   │   ├── calculateHandValue.ts
│   │   │   ├── applyHit.ts
│   │   │   ├── applyStand.ts
│   │   │   ├── applyDoubleDown.ts
│   │   │   ├── determineResult.ts
│   │   │   ├── calculateChipsDelta.ts
│   │   │   └── index.ts              ← Barrel export
│   │   ├── src/__tests__/
│   │   │   ├── createDeck.test.ts
│   │   │   ├── calculateHandValue.test.ts
│   │   │   ├── applyHit.test.ts
│   │   │   ├── applyStand.test.ts
│   │   │   ├── applyDoubleDown.test.ts
│   │   │   ├── determineResult.test.ts
│   │   │   └── integration.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts          ← Wyższy próg coverage (90%)
│   │
│   ├── game-service/                  ← Persystencja, transakcje, idempotency
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   └── schema.ts
│   │   │   ├── repositories/
│   │   │   │   ├── GameRepository.ts
│   │   │   │   ├── PlayerRepository.ts
│   │   │   │   └── EventLogRepository.ts
│   │   │   └── GameService.ts
│   │   ├── src/__tests__/
│   │   │   ├── setup.ts              ← SQLite in-memory
│   │   │   ├── GameRepository.test.ts
│   │   │   ├── PlayerRepository.test.ts
│   │   │   ├── GameService.integration.test.ts
│   │   │   ├── EventLog.test.ts
│   │   │   └── GameServiceWithCore.integration.test.ts
│   │   ├── drizzle/
│   │   │   ├── migrations/
│   │   │   └── meta/
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── auth-lobby/                    ← Auth, sesje, lobby
│       ├── src/
│       │   ├── routes/
│       │   │   ├── authRoutes.ts
│       │   │   ├── lobbyRoutes.ts
│       │   │   └── playerRoutes.ts
│       │   ├── services/
│       │   │   ├── AuthService.ts
│       │   │   ├── SessionService.ts
│       │   │   └── LobbyService.ts
│       │   └── middleware/
│       │       └── jwtMiddleware.ts
│       ├── src/__tests__/
│       │   ├── AuthService.test.ts
│       │   ├── jwtMiddleware.test.ts
│       │   ├── LobbyService.test.ts
│       │   ├── playerRoutes.test.ts
│       │   └── authE2E.integration.test.ts
│       ├── package.json
│       └── tsconfig.json
│
├── gateway/
│   └── ws/                            ← WebSocket Gateway
│       ├── src/
│       │   ├── server.ts
│       │   ├── auth/
│       │   │   └── jwtVerify.ts
│       │   ├── parser/
│       │   │   ├── messageParser.ts
│       │   │   └── schemas.ts
│       │   ├── router/
│       │   │   └── messageRouter.ts
│       │   ├── handlers/
│       │   │   ├── joinGameHandler.ts
│       │   │   ├── playerActionHandler.ts
│       │   │   ├── leaveGameHandler.ts
│       │   │   └── pingHandler.ts
│       │   ├── heartbeat/
│       │   │   └── heartbeatManager.ts
│       │   ├── errors/
│       │   │   └── errorHandler.ts
│       │   └── middleware/
│       │       └── requestLogger.ts
│       ├── src/__tests__/
│       │   ├── server.test.ts
│       │   ├── messageParser.test.ts
│       │   ├── messageRouter.test.ts
│       │   ├── heartbeat.test.ts
│       │   ├── errorHandler.test.ts
│       │   └── e2e.test.ts
│       ├── package.json
│       └── tsconfig.json
│
├── frontend/                          ← React + Vite klient
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Auth/
│   │   │   │   ├── LoginScreen.tsx
│   │   │   │   └── RegisterScreen.tsx
│   │   │   ├── Lobby/
│   │   │   │   └── LobbyScreen.tsx
│   │   │   └── Game/
│   │   │       ├── GameTable.tsx
│   │   │       ├── CardHand.tsx
│   │   │       └── ActionButtons.tsx
│   │   ├── stores/
│   │   │   ├── authStore.ts
│   │   │   ├── lobbyStore.ts
│   │   │   └── gameStore.ts
│   │   └── ws/
│   │       ├── WebSocketManager.ts
│   │       └── messageValidator.ts
│   ├── src/__tests__/
│   │   ├── LobbyScreen.test.tsx
│   │   ├── WebSocketManager.test.ts
│   │   ├── GameTable.test.tsx
│   │   ├── ActionButtons.test.tsx
│   │   ├── messageValidator.test.ts
│   │   ├── LoginScreen.test.tsx
│   │   └── e2e/
│   │       └── fullGame.e2e.test.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── tailwind.config.ts
│   ├── package.json
│   └── tsconfig.json
│
├── decisions/                         ← Architecture Decision Records
│   └── ADR-001-websocket-library.md
│
├── scripts/
│   ├── validate-schemas.js            ← Walidacja JSON Schemas w CI
│   ├── seed-db.ts                     ← Seed danych testowych
│   └── generate-types.ts             ← Generowanie typów z JSON Schemas (opcja)
│
└── .github/
    └── workflows/
        └── ci.yml
```

---

## 15. Wskazówki dla Agentów — Unikanie Halucynacji

### Zasady Pracy z Kontraktami

1. **ZAWSZE importuj typy z `/contracts`** — nigdy nie definiuj lokalnie `Card`, `Hand`, `GameState` ani żadnego innego typu domenowego. Lokalna redefinicja = source of truth conflict.

2. **PRZED implementacją zweryfikuj kontrakt:**
   - Przeczytaj odpowiedni plik z `/contracts`.
   - Uruchom `npm run test:contracts` — jeśli failing → zatrzymaj prace, zgłoś do Tech Lead Agenta.

3. **PO zmianie kontraktu:**
   - Zaktualizuj `contracts/CHANGELOG.md`.
   - Uruchom wszystkie testy kontraktowe.
   - Utwórz PR z tagiem `[contract-change]` w tytule.
   - Zablokuj merge bez approve Tech Lead Agenta.

4. **Nigdy nie używaj `any` w TypeScript** — jeśli typ jest nieznany, użyj `unknown` i wykonaj runtime validation z zod.

### Zasady Pracy z Testami

5. **Każda nowa funkcja = nowy test** — brak testu = nieukończone zadanie.

6. **Deterministyczne testy:** jeśli test zależy od losowości — użyj seeded RNG i zafixuj seed w teście. Testy muszą dawać identyczny wynik przy każdym uruchomieniu.

7. **Mocki vs. integracja:**
   - `game-core` testy: zero mocków — czyste funkcje, pełna izolacja.
   - `game-service` testy integracyjne: SQLite in-memory — NIE mockuj DB.
   - `gateway` testy: mockuj `GameService`, prawdziwy WS server.
   - `frontend` testy: mockuj WebSocket, prawdziwy React render.

8. **Test snapshot policy:** snapshots dla serializowanych wiadomości WS. Przy zmianie snapshota — wymagany opis dlaczego snapshot się zmienił w commit message.

### Zasady Aktualizacji ARCHITECTURE.md

9. **ARCHITECTURE.md jest immutable bez PR** — żaden agent nie edytuje go bezpośrednio na `main`. Każda zmiana przez PR z opisem.

10. **Sekcje wymagające aktualizacji przy zmianach:**
    - Zmiana protokołu WS → Sekcja 7 (Protokół WebSocket)
    - Nowa tabela DB → Sekcja 5 (Schemat DB)
    - Nowy typ domenowy → Sekcja 6 (Model Domenowy)
    - Nowy milestone lub zmiana kryteriów → Sekcja 12

### Zasady Kodowania

11. **Separacja warstw jest nienaruszalna:**
    - `game-core`: zero importów z `pg`, `redis`, `ws`, `fastify`, Node.js `net`/`http`
    - `gateway`: zero importów z `drizzle`, `pg`, bezpośrednio — tylko przez `GameService` API
    - `frontend`: zero bezpośrednich zapytań HTTP do DB

12. **Idempotency keys:** każda akcja mutująca stan gry (w `game-service`) musi obsługiwać `idempotencyKey`. Brak tej obsługi = bug krytyczny, blokada merge.

13. **Error codes:** używaj tylko kodów z tabeli w Sekcji 7 (Kody Błędów). Nie wymyślaj nowych kodów bez PR do ARCHITECTURE.md + approve Tech Lead Agenta.

14. **Wersja protokołu:** pole `"v": "1"` jest obowiązkowe w każdej wiadomości WS. Test kontraktowy weryfikuje jego obecność.

### Format Zmian w Commit Messages

```
<type>(<scope>): <opis>

type: feat | fix | test | refactor | docs | ci | chore
scope: game-core | game-service | ws-gateway | auth-lobby | frontend | contracts | ci

Przykłady:
feat(game-core): implement calculateHandValue with soft ace logic
test(game-core): add 10 edge cases for bust detection
fix(ws-gateway): handle PROTOCOL_VERSION_MISMATCH correctly
docs(contracts): update GAME_STATE schema with availableActions field
[contract-change] feat(contracts): add DOUBLE_DOWN to PlayerActionType
```

### Procedura Eskalacji

Gdy agent natrafi na sytuację nieopisaną w ARCHITECTURE.md:

1. **Zatrzymaj implementację** — nie zgaduj ani nie halucynuj rozwiązania.
2. **Utwórz issue** z tagiem `[architecture-question]` i opisem problemu.
3. **Czekaj na odpowiedź Tech Lead Agenta** — który aktualizuje ARCHITECTURE.md.
4. **Implementuj zgodnie z zaktualizowanym dokumentem.**

---

*Dokument wygenerowany: 2026-06-16. Wersja: 1.0.0. Właściciel: Tech Lead Agent.*
*Następna planowana aktualizacja: po zakończeniu M1 (game-core) — weryfikacja kontraktów.*
