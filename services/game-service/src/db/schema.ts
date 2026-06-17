import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { Card } from "../../../../contracts/domain.js";

// ─── players ──────────────────────────────────────────────────────────────────

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  chips: bigint("chips", { mode: "number" }).notNull().default(1000),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── sessions ─────────────────────────────────────────────────────────────────

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_sessions_player").on(table.playerId),
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);

// ─── tables ───────────────────────────────────────────────────────────────────

export const tables = pgTable("tables", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("WAITING"),
  maxBet: bigint("max_bet", { mode: "number" }).notNull().default(500),
  minBet: bigint("min_bet", { mode: "number" }).notNull().default(10),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── games ────────────────────────────────────────────────────────────────────

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    status: varchar("status", { length: 20 }).notNull().default("BETTING"),
    deckSeed: text("deck_seed").notNull(),
    deckState: jsonb("deck_state").$type<Card[]>().notNull(),
    playerHand: jsonb("player_hand").$type<Card[]>().notNull(),
    dealerHand: jsonb("dealer_hand").$type<Card[]>().notNull(),
    betAmount: bigint("bet_amount", { mode: "number" }).notNull().default(0),
    result: varchar("result", { length: 20 }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_games_player_id").on(table.playerId),
    index("idx_games_table_id").on(table.tableId),
    index("idx_games_status").on(table.status),
  ],
);

// ─── rounds ───────────────────────────────────────────────────────────────────

export const rounds = pgTable("rounds", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => games.id),
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id),
  tableId: uuid("table_id")
    .notNull()
    .references(() => tables.id),
  playerHand: jsonb("player_hand").$type<Card[]>().notNull(),
  dealerHand: jsonb("dealer_hand").$type<Card[]>().notNull(),
  betAmount: bigint("bet_amount", { mode: "number" }).notNull(),
  result: varchar("result", { length: 20 }).notNull(),
  chipsDelta: bigint("chips_delta", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── game_events ──────────────────────────────────────────────────────────────

export const gameEvents = pgTable(
  "game_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id),
    sequenceNo: integer("sequence_no").notNull(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_game_events_game").on(table.gameId, table.sequenceNo),
    unique("game_events_game_id_sequence_no_unique").on(table.gameId, table.sequenceNo),
  ],
);

// ─── relations ────────────────────────────────────────────────────────────────

export const playersRelations = relations(players, ({ many }) => ({
  sessions: many(sessions),
  games: many(games),
  rounds: many(rounds),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  player: one(players, {
    fields: [sessions.playerId],
    references: [players.id],
  }),
}));

export const tablesRelations = relations(tables, ({ many }) => ({
  games: many(games),
  rounds: many(rounds),
}));

export const gamesRelations = relations(games, ({ one, many }) => ({
  table: one(tables, {
    fields: [games.tableId],
    references: [tables.id],
  }),
  player: one(players, {
    fields: [games.playerId],
    references: [players.id],
  }),
  rounds: many(rounds),
  events: many(gameEvents),
}));

export const roundsRelations = relations(rounds, ({ one }) => ({
  game: one(games, {
    fields: [rounds.gameId],
    references: [games.id],
  }),
  player: one(players, {
    fields: [rounds.playerId],
    references: [players.id],
  }),
  table: one(tables, {
    fields: [rounds.tableId],
    references: [tables.id],
  }),
}));

export const gameEventsRelations = relations(gameEvents, ({ one }) => ({
  game: one(games, {
    fields: [gameEvents.gameId],
    references: [games.id],
  }),
}));

// ─── inferred types ───────────────────────────────────────────────────────────

export type PlayerRow = typeof players.$inferSelect;
export type GameRow = typeof games.$inferSelect;
export type TableRow = typeof tables.$inferSelect;
export type RoundRow = typeof rounds.$inferSelect;
