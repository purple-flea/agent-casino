import { db, schema } from "../db/index.js";
import { eq, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface LedgerEntry {
  id: string;
  agentId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  reference: string | null;
  service: string | null;
  createdAt: number;
}

export class BalanceLedger {
  getBalance(agentId: string): number {
    const row = db
      .select({ balance: schema.agents.balanceUsd })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    return row?.balance ?? 0;
  }

  credit(agentId: string, amount: number, reason: string, service?: string, reference?: string): void {
    db.transaction((tx) => {
      tx.update(schema.agents)
        .set({ balanceUsd: sql`${schema.agents.balanceUsd} + ${amount}` })
        .where(eq(schema.agents.id, agentId))
        .run();

      const agent = tx
        .select({ balance: schema.agents.balanceUsd })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();

      tx.insert(schema.ledgerEntries).values({
        id: randomUUID(),
        agentId,
        type: "credit",
        amount,
        balanceAfter: agent!.balance,
        reason,
        reference: reference ?? null,
        service: service ?? null,
      }).run();
    });
  }

  debit(agentId: string, amount: number, reason: string, service?: string, reference?: string): boolean {
    let success = false;

    db.transaction((tx) => {
      const agent = tx
        .select({ balance: schema.agents.balanceUsd })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();

      if (!agent || agent.balance < amount) {
        success = false;
        return;
      }

      tx.update(schema.agents)
        .set({ balanceUsd: sql`${schema.agents.balanceUsd} - ${amount}` })
        .where(eq(schema.agents.id, agentId))
        .run();

      const updated = tx
        .select({ balance: schema.agents.balanceUsd })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();

      tx.insert(schema.ledgerEntries).values({
        id: randomUUID(),
        agentId,
        type: "debit",
        amount,
        balanceAfter: updated!.balance,
        reason,
        reference: reference ?? null,
        service: service ?? null,
      }).run();

      success = true;
    });

    return success;
  }

  reserve(agentId: string, amount: number, reservationId: string): boolean {
    return this.debit(agentId, amount, "reservation", "casino", reservationId);
  }

  releaseReservation(agentId: string, reservationId: string, returnAmount: number): void {
    if (returnAmount > 0) {
      this.credit(agentId, returnAmount, "reservation_release", "casino", reservationId);
    }
  }

  getHistory(agentId: string, limit: number = 50, service?: string): LedgerEntry[] {
    let query = db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.agentId, agentId))
      .orderBy(desc(schema.ledgerEntries.createdAt))
      .limit(limit);

    return query.all() as LedgerEntry[];
  }
}

export const ledger = new BalanceLedger();
