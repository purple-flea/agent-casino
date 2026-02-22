import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { getCurrentSeedHash, verifyResult, rotateSeed } from "../engine/fairness.js";
import type { AppEnv } from "../types.js";

const fairness = new Hono<AppEnv>();

// ─── Get current server seed hash (before betting) ───

fairness.get("/seed-hash", async (c) => {
  const agentId = c.get("agentId") as string;
  const hash = getCurrentSeedHash(agentId);

  return c.json({
    server_seed_hash: hash,
    note: "This hash commits to a server seed. After seed rotation, the seed is revealed so you can verify all bets made with it.",
    how_to_verify: [
      "1. Note this hash before placing bets",
      "2. Provide your own client_seed when betting",
      "3. After seed rotation, GET /api/v1/fairness/seeds to see revealed seeds",
      "4. POST /api/v1/fairness/verify with bet_id to verify any past bet",
    ],
  });
});

// ─── Verify a past bet ───

fairness.post("/verify", async (c) => {
  const { bet_id, server_seed, server_seed_hash, client_seed, nonce } = await c.req.json();

  // If bet_id provided, look up from DB
  if (bet_id) {
    const agentId = c.get("agentId") as string;
    const bet = db
      .select()
      .from(schema.bets)
      .where(and(eq(schema.bets.id, bet_id), eq(schema.bets.agentId, agentId)))
      .get();

    if (!bet) {
      return c.json({ error: "bet_not_found", message: `No bet found with id: ${bet_id}` }, 404);
    }

    // Check if the seed has been revealed (rotated)
    const seedRecord = db
      .select()
      .from(schema.serverSeeds)
      .where(eq(schema.serverSeeds.seedHash, bet.serverSeedHash))
      .get();

    const revealed = seedRecord && seedRecord.revealedAt !== null;

    if (!revealed) {
      return c.json({
        bet_id: bet.id,
        status: "seed_not_yet_revealed",
        server_seed_hash: bet.serverSeedHash,
        client_seed: bet.clientSeed,
        nonce: bet.nonce,
        result_hash: bet.resultHash,
        message: "Server seed will be revealed when it rotates (every 1000 bets or on request). You can verify the result_hash matches the server_seed_hash commitment.",
        note: "Request seed rotation via POST /api/v1/fairness/rotate to reveal the seed now.",
      });
    }

    // Verify the bet
    const verification = verifyResult(bet.serverSeed, bet.serverSeedHash, bet.clientSeed || "", bet.nonce);

    return c.json({
      bet_id: bet.id,
      verified: verification.valid,
      game: bet.game,
      result: JSON.parse(bet.result),
      won: bet.won,
      amount_bet: bet.amount,
      amount_won: bet.amountWon,
      proof: {
        server_seed: bet.serverSeed,
        server_seed_hash: bet.serverSeedHash,
        client_seed: bet.clientSeed,
        nonce: bet.nonce,
        result_hash: bet.resultHash,
        computed_result: verification.result,
        hash_matches: verification.valid,
      },
      how_to_verify_yourself: [
        `1. Compute: SHA256("${bet.serverSeed}") should equal "${bet.serverSeedHash}"`,
        `2. Compute: HMAC-SHA256(server_seed, "${bet.clientSeed}:${bet.nonce}") to get result hash`,
        `3. Take first 8 hex chars of result hash, convert to int, mod 10000, divide by 100 = ${verification.result}`,
        "4. Map the result to the game outcome using the game rules",
      ],
    });
  }

  // Manual verification with provided values
  if (!server_seed || !server_seed_hash || !client_seed || nonce === undefined) {
    return c.json({
      error: "missing_params",
      message: "Provide bet_id OR (server_seed, server_seed_hash, client_seed, nonce)",
    }, 400);
  }

  const verification = verifyResult(server_seed, server_seed_hash, client_seed, nonce);

  return c.json({
    verified: verification.valid,
    result: verification.result,
    result_hash: verification.resultHash,
    hash_matches: verification.valid,
  });
});

// ─── Get full audit trail for a bet ───

fairness.get("/audit/:betId", async (c) => {
  const betId = c.req.param("betId");
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();

  if (!bet) {
    return c.json({ error: "bet_not_found" }, 404);
  }

  // Only allow the bet owner to see their audit
  const agentId = c.get("agentId") as string;
  if (bet.agentId !== agentId) {
    return c.json({ error: "forbidden", message: "You can only audit your own bets" }, 403);
  }

  const seedRecord = db
    .select()
    .from(schema.serverSeeds)
    .where(eq(schema.serverSeeds.seedHash, bet.serverSeedHash))
    .get();

  return c.json({
    bet_id: bet.id,
    game: bet.game,
    amount: bet.amount,
    payout_multiplier: bet.payoutMultiplier,
    won: bet.won,
    amount_won: bet.amountWon,
    result: JSON.parse(bet.result),
    fairness: {
      server_seed_hash: bet.serverSeedHash,
      server_seed: seedRecord?.revealedAt ? bet.serverSeed : "[hidden until seed rotation]",
      client_seed: bet.clientSeed,
      nonce: bet.nonce,
      result_hash: bet.resultHash,
      seed_revealed: !!seedRecord?.revealedAt,
      seed_revealed_at: seedRecord?.revealedAt ? new Date(seedRecord.revealedAt * 1000).toISOString() : null,
    },
    timestamp: new Date(bet.createdAt * 1000).toISOString(),
  });
});

// ─── Request seed rotation ───

fairness.post("/rotate", async (c) => {
  const agentId = c.get("agentId") as string;

  const activeSeed = db
    .select()
    .from(schema.serverSeeds)
    .where(and(eq(schema.serverSeeds.agentId, agentId), eq(schema.serverSeeds.active, true)))
    .get();

  if (!activeSeed) {
    return c.json({ message: "No active seed to rotate" });
  }

  rotateSeed(activeSeed.id);

  const newHash = getCurrentSeedHash(agentId);

  return c.json({
    message: "Seed rotated successfully",
    previous_seed: {
      seed: activeSeed.seed,
      seed_hash: activeSeed.seedHash,
      bets_made: activeSeed.currentNonce,
      note: "This seed is now revealed. You can verify all bets made with it.",
    },
    new_seed_hash: newHash,
  });
});

// ─── Get revealed seeds ───

fairness.get("/seeds", async (c) => {
  const agentId = c.get("agentId") as string;

  const seeds = db
    .select()
    .from(schema.serverSeeds)
    .where(eq(schema.serverSeeds.agentId, agentId))
    .all();

  return c.json({
    seeds: seeds.map((s) => ({
      id: s.id,
      seed_hash: s.seedHash,
      seed: s.revealedAt ? s.seed : "[active - not yet revealed]",
      active: s.active,
      bets_made: s.currentNonce,
      revealed_at: s.revealedAt ? new Date(s.revealedAt * 1000).toISOString() : null,
      created_at: new Date(s.createdAt * 1000).toISOString(),
    })),
  });
});

export { fairness };
