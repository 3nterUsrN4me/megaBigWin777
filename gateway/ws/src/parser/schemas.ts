import { z } from "zod";

const uuidSchema = z.string().uuid();

// ─── Client → Server ─────────────────────────────────────────────────────────

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
});

export const leaveGameSchema = z.object({
  event: z.literal("LEAVE_GAME"),
  v: z.literal("1"),
  gameId: uuidSchema,
});

export const pingSchema = z.object({
  event: z.literal("PING"),
  v: z.literal("1"),
  timestamp: z.number().int(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type JoinGameMessage = z.infer<typeof joinGameSchema>;
export type PlayerActionMessage = z.infer<typeof playerActionSchema>;
export type LeaveGameMessage = z.infer<typeof leaveGameSchema>;
export type PingMessage = z.infer<typeof pingSchema>;
