-- Initial schema per ARCHITECTURE.md §5

CREATE TABLE "players" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" varchar(50) NOT NULL,
  "password_hash" text NOT NULL,
  "chips" bigint DEFAULT 1000 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "players_username_unique" UNIQUE("username")
);

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "player_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL,
  "status" varchar(20) DEFAULT 'WAITING' NOT NULL,
  "max_bet" bigint DEFAULT 500 NOT NULL,
  "min_bet" bigint DEFAULT 10 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "games" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "table_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "status" varchar(20) DEFAULT 'BETTING' NOT NULL,
  "deck_seed" text NOT NULL,
  "deck_state" jsonb NOT NULL,
  "player_hand" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "dealer_hand" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "bet_amount" bigint DEFAULT 0 NOT NULL,
  "result" varchar(20),
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "table_id" uuid NOT NULL,
  "player_hand" jsonb NOT NULL,
  "dealer_hand" jsonb NOT NULL,
  "bet_amount" bigint NOT NULL,
  "result" varchar(20) NOT NULL,
  "chips_delta" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "game_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "game_id" uuid NOT NULL,
  "sequence_no" integer NOT NULL,
  "event_type" varchar(50) NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "game_events_game_id_sequence_no_unique" UNIQUE("game_id","sequence_no")
);

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "games" ADD CONSTRAINT "games_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "games" ADD CONSTRAINT "games_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "idx_sessions_player" ON "sessions" USING btree ("player_id");
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at");
CREATE INDEX "idx_games_player_id" ON "games" USING btree ("player_id");
CREATE INDEX "idx_games_table_id" ON "games" USING btree ("table_id");
CREATE INDEX "idx_games_status" ON "games" USING btree ("status");
CREATE INDEX "idx_game_events_game" ON "game_events" USING btree ("game_id","sequence_no");
