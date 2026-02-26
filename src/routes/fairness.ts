import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, sql, desc } from "drizzle-orm";
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

// ─── GET /audit-summary — provably-fair audit summary (authenticated) ───

fairness.get("/audit-summary", async (c) => {
  const agentId = c.get("agentId") as string;

  // Total bets by this agent
  const totalBets = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .get()?.count ?? 0;

  // All server seeds (revealed + active)
  const seeds = db.select()
    .from(schema.serverSeeds)
    .where(eq(schema.serverSeeds.agentId, agentId))
    .all();

  const revealedSeeds = seeds.filter(s => s.revealedAt !== null);
  const activeSeeds = seeds.filter(s => s.active);

  // How many bets used revealed seeds (can be independently verified)
  const verifiableBets = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.bets)
    .where(and(
      eq(schema.bets.agentId, agentId),
    ))
    .get()?.count ?? 0;

  // Win rate
  const winStats = db.select({
    wins: sql<number>`SUM(CASE WHEN ${schema.bets.won} = 1 THEN 1 ELSE 0 END)`,
    totalWagered: sql<number>`COALESCE(SUM(${schema.bets.amount}), 0)`,
    totalWon: sql<number>`COALESCE(SUM(${schema.bets.amountWon}), 0)`,
  })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .get();

  const wins = winStats?.wins ?? 0;
  const winRate = totalBets > 0 ? Math.round((wins / totalBets) * 10000) / 100 : 0;
  const totalWagered = winStats?.totalWagered ?? 0;
  const totalWon = winStats?.totalWon ?? 0;

  // Theoretical RTP (house edge 0.5% → 99.5% RTP)
  const actualRtp = totalWagered > 0 ? Math.round((totalWon / totalWagered) * 10000) / 100 : 0;
  const expectedRtp = 99.5; // 0.5% house edge

  // Recent bets for verifiable sample
  const recentBets = db.select({
    id: schema.bets.id,
    game: schema.bets.game,
    serverSeedHash: schema.bets.serverSeedHash,
    serverSeed: schema.bets.serverSeed,
    clientSeed: schema.bets.clientSeed,
    nonce: schema.bets.nonce,
    won: schema.bets.won,
    createdAt: schema.bets.createdAt,
  })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .orderBy(desc(schema.bets.createdAt))
    .limit(5)
    .all();

  // Check which recent bets are verifiable (seed revealed)
  const revealedHashes = new Set(revealedSeeds.map(s => s.seedHash));
  const verifiableSample = recentBets.map(b => ({
    bet_id: b.id,
    game: b.game,
    won: b.won,
    seed_revealed: revealedHashes.has(b.serverSeedHash),
    server_seed_hash: b.serverSeedHash,
    server_seed: revealedHashes.has(b.serverSeedHash) ? b.serverSeed : "[rotate to reveal]",
    client_seed: b.clientSeed,
    nonce: b.nonce,
    verify_now: revealedHashes.has(b.serverSeedHash)
      ? `POST /api/v1/fairness/verify { "bet_id": "${b.id}" }`
      : `POST /api/v1/fairness/rotate → then verify bet_id: ${b.id}`,
  }));

  const activeSeed = activeSeeds[0];

  return c.json({
    agent_id: agentId,
    fairness_score: totalBets === 0 ? "no_bets_yet" : revealedSeeds.length > 0 ? "auditable" : "committed",
    summary: {
      total_bets: totalBets,
      verifiable_bets: totalBets, // all bets are verifiable once seed rotates
      revealed_seed_count: revealedSeeds.length,
      active_seed_committed: !!activeSeed,
      win_rate_pct: winRate,
      actual_rtp_pct: actualRtp,
      expected_rtp_pct: expectedRtp,
      rtp_deviation_pct: totalWagered > 0 ? Math.round((actualRtp - expectedRtp) * 100) / 100 : null,
    },
    active_seed: activeSeed ? {
      seed_hash: activeSeed.seedHash,
      bets_on_this_seed: activeSeed.currentNonce,
      note: "This hash commits the server to a secret seed. Rotation reveals the seed so you can verify all bets made with it.",
    } : null,
    revealed_seeds_count: revealedSeeds.length,
    recent_bets_sample: verifiableSample,
    how_provably_fair_works: [
      "1. Before betting, the server commits to a secret seed by publishing its SHA-256 hash",
      "2. You provide your own client_seed when betting (or a random one is used)",
      "3. Result = HMAC-SHA256(server_seed, 'client_seed:nonce') — deterministic, tamper-proof",
      "4. After rotation, the server seed is revealed — verify any bet independently",
      "5. If SHA256(server_seed) !== server_seed_hash, the server cheated (impossible in practice)",
    ],
    quick_verify: totalBets > 0 ? {
      step_1: "POST /api/v1/fairness/rotate to reveal current seed",
      step_2: `POST /api/v1/fairness/verify { "bet_id": "${recentBets[0]?.id ?? "YOUR_BET_ID"}" }`,
      step_3: "Inspect the proof object — computed_result should match the actual outcome",
    } : {
      note: "Make some bets first, then rotate your seed to verify them",
    },
    house_edge: "0.5% (0.995x payout multiplier applied to fair odds)",
    audit_tool: "Any SHA-256 + HMAC-SHA256 tool can independently verify results. No Purple Flea software needed.",
  });
});

export { fairness };
