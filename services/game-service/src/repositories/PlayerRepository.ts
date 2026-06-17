import { eq, sql } from "drizzle-orm";
import { players, type PlayerRow } from "../db/schema.js";
import type { Transaction } from "../db/client.js";

/** Placeholder for dev/JWT-only players — real auth is not wired yet. */
const DEV_PASSWORD_HASH = "dev-no-auth";

export class PlayerRepository {
  async findById(tx: Transaction, playerId: string): Promise<PlayerRow | undefined> {
    const [row] = await tx
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    return row;
  }

  /**
   * Ensures a player row exists for the given JWT `sub`.
   * Creates one with default chips when missing (dev / first join).
   */
  async findOrCreate(
    tx: Transaction,
    playerId: string,
    username: string,
  ): Promise<PlayerRow> {
    const existing = await this.findById(tx, playerId);
    if (existing) return existing;

    const candidates = [
      username.trim() || playerId,
      playerId,
      `player-${playerId.slice(0, 8)}`,
    ];

    for (const candidate of candidates) {
      try {
        const [row] = await tx
          .insert(players)
          .values({
            id: playerId,
            username: candidate,
            passwordHash: DEV_PASSWORD_HASH,
            chips: 1000,
          })
          .returning();
        if (row) return row;
      } catch {
        const refetched = await this.findById(tx, playerId);
        if (refetched) return refetched;
      }
    }

    const fallback = await this.findById(tx, playerId);
    if (!fallback) {
      throw new Error(`Failed to create player ${playerId}`);
    }
    return fallback;
  }

  async findByIdForUpdate(
    tx: Transaction,
    playerId: string,
  ): Promise<PlayerRow | undefined> {
    const [row] = await tx
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .for("update")
      .limit(1);
    return row;
  }

  async deductChips(
    tx: Transaction,
    playerId: string,
    amount: number,
  ): Promise<PlayerRow> {
    const [row] = await tx
      .update(players)
      .set({
        chips: sql`${players.chips} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(players.id, playerId))
      .returning();
    if (!row) {
      throw new Error(`Player ${playerId} not found during chip deduction`);
    }
    return row;
  }

  async creditChips(
    tx: Transaction,
    playerId: string,
    amount: number,
  ): Promise<PlayerRow> {
    const [row] = await tx
      .update(players)
      .set({
        chips: sql`${players.chips} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(players.id, playerId))
      .returning();
    if (!row) {
      throw new Error(`Player ${playerId} not found during chip credit`);
    }
    return row;
  }

  async settleRound(
    tx: Transaction,
    playerId: string,
    betAmount: number,
    chipsDelta: number,
  ): Promise<PlayerRow> {
    return this.creditChips(tx, playerId, betAmount + chipsDelta);
  }
}
