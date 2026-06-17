import { z } from "zod";

const uuidSchema = z.string().uuid();

// ─── Client → Server ─────────────────────────────────────────────────────────

/**
 * JOIN_ROOM — gracz dołącza do pokoju BEZ zakładu.
 * Serwer odpowiada ROOM_STATE (status: BETTING) broadcastem.
 * Zastępuje dawne JOIN_GAME w pierwszej fazie.
 */
export const joinRoomSchema = z.object({
  event: z.literal("JOIN_ROOM"),
  v: z.literal("1"),
  tableId: uuidSchema,
});

/**
 * PLACE_BET — gracz stawia zakład w fazie BETTING.
 * Gdy wszyscy gracze w pokoju postawią → serwer rusza PLAYING i rozdaje karty.
 *
 * `seatIndex` (0–4) jest wymagane przy Multi-Handzie — wskazuje konkretny slot
 * gracza, dla którego zakład jest składany. Gdy pominięte, serwer wybiera
 * pierwszy slot gracza bez zakładu (zachowanie dla pojedynczej ręki).
 */
export const placeBetSchema = z.object({
  event:     z.literal("PLACE_BET"),
  v:         z.literal("1"),
  tableId:   uuidSchema,
  betAmount: z.number().int().min(1).max(500),
  seatIndex: z.number().int().min(0).max(4).optional(),
});

/**
 * JOIN_SLOT — gracz zajmuje konkretne miejsce przy stole (Multi-Hand).
 * Pozwala temu samemu graczu na zajęcie wielu slotów (0–4).
 */
export const joinSlotSchema = z.object({
  event:     z.literal("JOIN_SLOT"),
  v:         z.literal("1"),
  tableId:   uuidSchema,
  seatIndex: z.number().int().min(0).max(4),
});

/**
 * RECONNECT — gracz wraca po odświeżeniu strony.
 * Serwer wyszukuje aktywną sesję po playerId (z JWT) i tableId,
 * a następnie odpowiada pełnym ROOM_STATE + osobistym GAME_STATE.
 */
export const reconnectSchema = z.object({
  event: z.literal("RECONNECT"),
  v: z.literal("1"),
  tableId: uuidSchema,
});

/** @deprecated Zachowany dla kompatybilności — przekierowuje do joinRoom */
export const joinGameSchema = z.object({
  event: z.literal("JOIN_GAME"),
  v: z.literal("1"),
  tableId: uuidSchema,
  betAmount: z.number().int().positive(),
});

export const playerActionSchema = z.object({
  event: z.literal("PLAYER_ACTION"),
  v: z.literal("1"),
  gameId: uuidSchema,
  action: z.enum(["HIT", "STAND", "DOUBLE_DOWN"]),
  idempotencyKey: uuidSchema,
  /**
   * Which of the player's Multi-Hand seats this action targets (0–4).
   * Optional for backward compat — single-hand sessions can omit it.
   * When present the server resolves the game from the seat directly,
   * which fixes the "buttons locked" bug where the stored gameId could
   * be stale for multi-seat players.
   */
  seatIndex: z.number().int().min(0).max(4).optional(),
});

export const leaveGameSchema = z.object({
  event: z.literal("LEAVE_GAME"),
  v: z.literal("1"),
  tableId: uuidSchema,
});

export const pingSchema = z.object({
  event: z.literal("PING"),
  v: z.literal("1"),
  timestamp: z.number().int(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type JoinRoomMessage    = z.infer<typeof joinRoomSchema>;
export type JoinSlotMessage    = z.infer<typeof joinSlotSchema>;
export type PlaceBetMessage    = z.infer<typeof placeBetSchema>;
export type ReconnectMessage   = z.infer<typeof reconnectSchema>;
export type JoinGameMessage    = z.infer<typeof joinGameSchema>;
export type PlayerActionMessage = z.infer<typeof playerActionSchema>;
export type LeaveGameMessage   = z.infer<typeof leaveGameSchema>;
export type PingMessage        = z.infer<typeof pingSchema>;
