import { and, eq, ne } from "drizzle-orm";
import type { Card } from "../../../../contracts/domain";
import { games, rounds, tables, type GameRow } from "../db/schema.js";
import type { Transaction } from "../db/client.js";

export interface CreateGameInput {
  tableId: string;
  playerId: string;
  deckSeed: string;
  deckState: Card[];
  playerHand: Card[];
  dealerHand: Card[];
  betAmount: number;
  status: string;
  result?: string | null;
}

export interface UpdateGameInput {
  status?: string;
  deckState?: Card[];
  playerHand?: Card[];
  dealerHand?: Card[];
  betAmount?: number;
  result?: string | null;
  idempotencyKey?: string | null;
}

export class GameRepository {
  async findById(tx: Transaction, gameId: string): Promise<GameRow | undefined> {
    const [row] = await tx
      .select()
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1);
    return row;
  }

  async findByIdForUpdate(
    tx: Transaction,
    gameId: string,
    playerId: string,
  ): Promise<GameRow | undefined> {
    const [row] = await tx
      .select()
      .from(games)
      .where(and(eq(games.id, gameId), eq(games.playerId, playerId)))
      .for("update")
      .limit(1);
    return row;
  }

  async findActiveByPlayer(
    tx: Transaction,
    playerId: string,
  ): Promise<GameRow | undefined> {
    const [row] = await tx
      .select()
      .from(games)
      .where(
        and(
          eq(games.playerId, playerId),
          ne(games.status, "FINISHED"),
        ),
      )
      .limit(1);
    return row;
  }

  async findActiveByTable(
    tx: Transaction,
    tableId: string,
  ): Promise<GameRow | undefined> {
    const [row] = await tx
      .select()
      .from(games)
      .where(
        and(
          eq(games.tableId, tableId),
          ne(games.status, "FINISHED"),
        ),
      )
      .limit(1);
    return row;
  }

  async findAllActiveByTable(
    tx: Transaction,
    tableId: string,
  ): Promise<GameRow[]> {
    return tx
      .select()
      .from(games)
      .where(
        and(
          eq(games.tableId, tableId),
          ne(games.status, "FINISHED"),
        ),
      );
  }

  async findActiveByTableAndPlayer(
    tx: Transaction,
    tableId: string,
    playerId: string,
  ): Promise<GameRow | undefined> {
    const [row] = await tx
      .select()
      .from(games)
      .where(
        and(
          eq(games.tableId, tableId),
          eq(games.playerId, playerId),
          ne(games.status, "FINISHED"),
        ),
      )
      .limit(1);
    return row;
  }

  async create(tx: Transaction, input: CreateGameInput): Promise<GameRow> {
    const [row] = await tx
      .insert(games)
      .values({
        tableId: input.tableId,
        playerId: input.playerId,
        deckSeed: input.deckSeed,
        deckState: input.deckState,
        playerHand: input.playerHand,
        dealerHand: input.dealerHand,
        betAmount: input.betAmount,
        status: input.status,
        result: input.result ?? null,
      })
      .returning();
    return row!;
  }

  async update(
    tx: Transaction,
    gameId: string,
    input: UpdateGameInput,
  ): Promise<GameRow> {
    const [row] = await tx
      .update(games)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(games.id, gameId))
      .returning();
    if (!row) {
      throw new Error(`Game ${gameId} not found during update`);
    }
    return row;
  }

  async insertRound(
    tx: Transaction,
    params: {
      gameId: string;
      playerId: string;
      tableId: string;
      playerHand: Card[];
      dealerHand: Card[];
      betAmount: number;
      result: string;
      chipsDelta: number;
    },
  ): Promise<void> {
    await tx.insert(rounds).values({
      gameId: params.gameId,
      playerId: params.playerId,
      tableId: params.tableId,
      playerHand: params.playerHand,
      dealerHand: params.dealerHand,
      betAmount: params.betAmount,
      result: params.result,
      chipsDelta: params.chipsDelta,
    });
  }

  async setTableStatus(
    tx: Transaction,
    tableId: string,
    status: string,
  ): Promise<void> {
    await tx
      .update(tables)
      .set({ status })
      .where(eq(tables.id, tableId));
  }

  async findTable(tx: Transaction, tableId: string) {
    const [row] = await tx
      .select()
      .from(tables)
      .where(eq(tables.id, tableId))
      .limit(1);
    return row;
  }
}
