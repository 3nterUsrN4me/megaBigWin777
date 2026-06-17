import { eq, sql } from "drizzle-orm";
import { players, type PlayerRow } from "../db/schema.js";
import type { Transaction } from "../db/client.js";

export class PlayerRepository {
  async findById(tx: Transaction, playerId: string): Promise<PlayerRow | undefined> {
    const [row] = await tx
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    return row;
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
