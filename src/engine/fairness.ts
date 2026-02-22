import { createHmac, createHash, randomBytes } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, sql } from "drizzle-orm";

export interface SeedPair {
  seed: string;
  hash: string;
}

export function generateServerSeed(): SeedPair {
  const seed = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(seed).digest("hex");
  return { seed, hash };
}

export function calculateResult(serverSeed: string, clientSeed: string, nonce: number): number {
  const message = `${clientSeed}:${nonce}`;
  const hmac = createHmac("sha256", serverSeed).update(message).digest("hex");
  // Take first 8 hex chars -> convert to int -> map to 0.00–99.99
  const int = parseInt(hmac.substring(0, 8), 16);
  return (int % 10000) / 100;
}

export function getResultHash(serverSeed: string, clientSeed: string, nonce: number): string {
  const message = `${clientSeed}:${nonce}`;
  return createHmac("sha256", serverSeed).update(message).digest("hex");
}

export function verifyResult(
  serverSeed: string,
  serverSeedHash: string,
  clientSeed: string,
  nonce: number
): { valid: boolean; result: number; resultHash: string } {
  const expectedHash = createHash("sha256").update(serverSeed).digest("hex");
  const valid = expectedHash === serverSeedHash;
  const result = calculateResult(serverSeed, clientSeed, nonce);
  const resultHash = getResultHash(serverSeed, clientSeed, nonce);
  return { valid, result, resultHash };
}

// ─── Seed management per agent ───

export function getOrCreateActiveSeed(agentId: string): {
  id: number;
  seed: string;
  seedHash: string;
  currentNonce: number;
} {
  // Look for active seed
  const existing = db
    .select()
    .from(schema.serverSeeds)
    .where(and(eq(schema.serverSeeds.agentId, agentId), eq(schema.serverSeeds.active, true)))
    .get();

  if (existing) {
    return {
      id: existing.id,
      seed: existing.seed,
      seedHash: existing.seedHash,
      currentNonce: existing.currentNonce,
    };
  }

  // Create new seed
  const { seed, hash } = generateServerSeed();
  const result = db
    .insert(schema.serverSeeds)
    .values({
      seed,
      seedHash: hash,
      agentId,
      currentNonce: 0,
      active: true,
    })
    .returning()
    .get();

  return {
    id: result.id,
    seed: result.seed,
    seedHash: result.seedHash,
    currentNonce: result.currentNonce,
  };
}

export function incrementNonce(seedId: number): number {
  // Atomic increment: UPDATE + RETURNING ensures no two concurrent bets get the same nonce
  const row = db.update(schema.serverSeeds)
    .set({ currentNonce: sql`${schema.serverSeeds.currentNonce} + 1` })
    .where(eq(schema.serverSeeds.id, seedId))
    .returning({ previousNonce: sql<number>`${schema.serverSeeds.currentNonce} - 1` })
    .get();

  const usedNonce = row?.previousNonce ?? 0;
  const newNonce = usedNonce + 1;

  // Rotate seed every 1000 bets
  if (newNonce >= 1000) {
    rotateSeed(seedId);
  }

  return usedNonce; // Return the nonce BEFORE increment (used for this bet)
}

export function rotateSeed(seedId: number): void {
  const now = Math.floor(Date.now() / 1000);

  const old = db
    .select()
    .from(schema.serverSeeds)
    .where(eq(schema.serverSeeds.id, seedId))
    .get();

  if (!old) return;

  // Deactivate old seed and reveal it
  db.update(schema.serverSeeds)
    .set({ active: false, revealedAt: now })
    .where(eq(schema.serverSeeds.id, seedId))
    .run();

  // Create new seed for this agent
  const { seed, hash } = generateServerSeed();
  db.insert(schema.serverSeeds).values({
    seed,
    seedHash: hash,
    agentId: old.agentId,
    currentNonce: 0,
    active: true,
  }).run();
}

export function getCurrentSeedHash(agentId: string): string {
  const seed = getOrCreateActiveSeed(agentId);
  return seed.seedHash;
}
