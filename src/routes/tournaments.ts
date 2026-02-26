import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { ledger } from "../wallet/ledger.js";
import {
  playCoinFlip,
  playDice,
  playMultiplier,
  playRoulette,
  playCustom,
} from "../engine/games.js";
import type { AppEnv } from "../types.js";

const tournaments = new Hono<AppEnv>();

// ─── Helpers ───

function round2(n: number) { return Math.round(n * 100) / 100; }

function syncTournamentStatus() {
  const now = Math.floor(Date.now() / 1000);
  // Activate upcoming tournaments that have started
  db.update(schema.tournaments)
    .set({ status: "active" })
    .where(and(
      eq(schema.tournaments.status, "upcoming"),
      lte(schema.tournaments.startsAt, now),
      gte(schema.tournaments.endsAt, now),
    ))
    .run();
  // Mark tournaments as completed
  db.update(schema.tournaments)
    .set({ status: "completed" })
    .where(and(
      eq(schema.tournaments.status, "active"),
      lte(schema.tournaments.endsAt, now),
    ))
    .run();
}

function distributePrizes(tournamentId: string) {
  const tournament = db.select().from(schema.tournaments)
    .where(eq(schema.tournaments.id, tournamentId)).get();
  if (!tournament || tournament.status !== "completed") return;

  const entries = db.select().from(schema.tournamentEntries)
    .where(eq(schema.tournamentEntries.tournamentId, tournamentId))
    .orderBy(desc(schema.tournamentEntries.score))
    .limit(3).all();

  if (entries.length === 0) return;

  const splits = [0.6, 0.3, 0.1];
  for (let i = 0; i < entries.length; i++) {
    const prize = round2(tournament.prizePool * splits[i]);
    if (prize > 0) {
      ledger.credit(entries[i].agentId, prize, `tournament_prize_${i + 1}:${tournamentId}`, "casino");
    }
  }
}

// ─── POST /tournaments/create ───

tournaments.post("/create", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json();
  const { name, game, entry_fee_usdc, prize_pool_usdc, max_agents, starts_at, ends_at } = body;

  if (!name || !game || entry_fee_usdc == null || prize_pool_usdc == null || !max_agents || !starts_at || !ends_at) {
    return c.json({ error: "missing_fields", message: "Provide name, game, entry_fee_usdc, prize_pool_usdc, max_agents, starts_at, ends_at" }, 400);
  }

  const validGames = ["coin_flip", "dice", "multiplier", "roulette", "custom"];
  if (!validGames.includes(game)) {
    return c.json({ error: "invalid_game", message: `Game must be one of: ${validGames.join(", ")}` }, 400);
  }

  if (entry_fee_usdc < 0) return c.json({ error: "invalid_entry_fee", message: "Entry fee cannot be negative" }, 400);
  if (prize_pool_usdc <= 0) return c.json({ error: "invalid_prize_pool", message: "Prize pool must be positive" }, 400);
  if (max_agents < 2) return c.json({ error: "invalid_max_agents", message: "Tournament needs at least 2 agents" }, 400);

  const now = Math.floor(Date.now() / 1000);
  if (ends_at <= starts_at) return c.json({ error: "invalid_times", message: "ends_at must be after starts_at" }, 400);
  if (ends_at <= now) return c.json({ error: "invalid_times", message: "Tournament must end in the future" }, 400);

  const id = `trn_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const status = starts_at <= now ? "active" : "upcoming";

  db.insert(schema.tournaments).values({
    id, name, game,
    entryFee: entry_fee_usdc,
    prizePool: prize_pool_usdc,
    maxAgents: max_agents,
    startsAt: starts_at,
    endsAt: ends_at,
    status,
    createdBy: agentId,
  }).run();

  return c.json({
    tournament_id: id, name, game,
    entry_fee: entry_fee_usdc,
    prize_pool: prize_pool_usdc,
    max_agents,
    starts_at, ends_at, status,
    message: "Tournament created",
  }, 201);
});

// ─── GET /tournaments ───

tournaments.get("/", (c) => {
  syncTournamentStatus();
  const list = db.select().from(schema.tournaments)
    .where(sql`${schema.tournaments.status} IN ('upcoming', 'active')`)
    .orderBy(schema.tournaments.startsAt)
    .all();

  const enriched = list.map((t) => {
    const agentCount = db.select({ count: sql<number>`count(*)` })
      .from(schema.tournamentEntries)
      .where(eq(schema.tournamentEntries.tournamentId, t.id))
      .get()?.count ?? 0;
    return {
      id: t.id, name: t.name, game: t.game,
      entry_fee: t.entryFee, prize_pool: t.prizePool,
      agent_count: agentCount, max_agents: t.maxAgents,
      starts_at: t.startsAt, ends_at: t.endsAt, status: t.status,
    };
  });

  return c.json({ tournaments: enriched });
});

// ─── GET /tournaments/:id ───

tournaments.get("/:id", (c) => {
  syncTournamentStatus();
  const id = c.req.param("id");
  const tournament = db.select().from(schema.tournaments)
    .where(eq(schema.tournaments.id, id)).get();

  if (!tournament) return c.json({ error: "not_found" }, 404);

  const entries = db.select().from(schema.tournamentEntries)
    .where(eq(schema.tournamentEntries.tournamentId, id))
    .orderBy(desc(schema.tournamentEntries.score))
    .all();

  const leaderboard = entries.map((e, i) => ({
    rank: i + 1,
    agent_id: e.agentId,
    score: e.score,
    winnings: e.score,
  }));

  const agentCount = entries.length;

  return c.json({
    tournament: {
      id: tournament.id, name: tournament.name, game: tournament.game,
      entry_fee: tournament.entryFee, prize_pool: tournament.prizePool,
      agent_count: agentCount, max_agents: tournament.maxAgents,
      starts_at: tournament.startsAt, ends_at: tournament.endsAt, status: tournament.status,
      created_by: tournament.createdBy,
    },
    leaderboard,
  });
});

// ─── POST /tournaments/:id/enter ───

tournaments.post("/:id/enter", async (c) => {
  syncTournamentStatus();
  const agentId = c.get("agentId") as string;
  const id = c.req.param("id");

  const tournament = db.select().from(schema.tournaments)
    .where(eq(schema.tournaments.id, id)).get();

  if (!tournament) return c.json({ error: "not_found" }, 404);
  if (tournament.status === "completed" || tournament.status === "cancelled") {
    return c.json({ error: "tournament_closed", message: "This tournament is no longer open for entry" }, 400);
  }

  // Check already entered
  const existing = db.select().from(schema.tournamentEntries)
    .where(and(
      eq(schema.tournamentEntries.tournamentId, id),
      eq(schema.tournamentEntries.agentId, agentId),
    )).get();
  if (existing) return c.json({ error: "already_entered", message: "You are already entered in this tournament" }, 400);

  // Check max agents
  const agentCount = db.select({ count: sql<number>`count(*)` })
    .from(schema.tournamentEntries)
    .where(eq(schema.tournamentEntries.tournamentId, id))
    .get()?.count ?? 0;

  if (agentCount >= tournament.maxAgents) {
    return c.json({ error: "tournament_full", message: "This tournament is full" }, 400);
  }

  // Deduct entry fee
  if (tournament.entryFee > 0) {
    const deducted = ledger.debit(agentId, tournament.entryFee, `tournament_entry:${id}`, "casino");
    if (!deducted) {
      return c.json({ error: "insufficient_balance", message: `You need $${tournament.entryFee} to enter this tournament` }, 400);
    }
  }

  const entryId = `tent_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db.insert(schema.tournamentEntries).values({
    id: entryId,
    tournamentId: id,
    agentId,
    score: 0,
  }).run();

  return c.json({
    tournament_id: id,
    agent_id: agentId,
    position: "entered",
    entry_fee_paid: tournament.entryFee,
    message: `Successfully entered tournament "${tournament.name}"`,
  });
});

// ─── POST /tournaments/:id/play ───

tournaments.post("/:id/play", async (c) => {
  syncTournamentStatus();
  const agentId = c.get("agentId") as string;
  const id = c.req.param("id");

  const tournament = db.select().from(schema.tournaments)
    .where(eq(schema.tournaments.id, id)).get();

  if (!tournament) return c.json({ error: "not_found" }, 404);

  if (tournament.status !== "active") {
    return c.json({ error: "tournament_not_active", message: `Tournament status is "${tournament.status}". Only active tournaments can be played.` }, 400);
  }

  // Verify entry
  const entry = db.select().from(schema.tournamentEntries)
    .where(and(
      eq(schema.tournamentEntries.tournamentId, id),
      eq(schema.tournamentEntries.agentId, agentId),
    )).get();

  if (!entry) return c.json({ error: "not_entered", message: "You must enter the tournament before playing. POST /tournaments/:id/enter" }, 403);

  const body = await c.req.json();
  const { game, amount, side, direction, threshold, target_multiplier, bet_type, bet_value, win_probability, client_seed } = body;

  if (!game || amount == null) {
    return c.json({ error: "missing_fields", message: "Provide game and amount" }, 400);
  }

  if (game !== tournament.game) {
    return c.json({ error: "wrong_game", message: `This tournament uses ${tournament.game}. You submitted ${game}.` }, 400);
  }

  let result: any;

  switch (game) {
    case "coin_flip":
      if (!side) return c.json({ error: "missing_side", message: "Provide side (heads/tails)" }, 400);
      result = playCoinFlip(agentId, side, amount, client_seed);
      break;
    case "dice":
      if (!direction || threshold == null) return c.json({ error: "missing_params", message: "Provide direction and threshold" }, 400);
      result = playDice(agentId, direction, threshold, amount, client_seed);
      break;
    case "multiplier":
      if (target_multiplier == null) return c.json({ error: "missing_params", message: "Provide target_multiplier" }, 400);
      result = playMultiplier(agentId, target_multiplier, amount, client_seed);
      break;
    case "roulette":
      if (!bet_type) return c.json({ error: "missing_params", message: "Provide bet_type" }, 400);
      result = playRoulette(agentId, bet_type, bet_value, amount, client_seed);
      break;
    case "custom":
      if (win_probability == null) return c.json({ error: "missing_params", message: "Provide win_probability" }, 400);
      result = playCustom(agentId, win_probability, amount, client_seed);
      break;
    default:
      return c.json({ error: "invalid_game" }, 400);
  }

  if ("error" in result) return c.json(result, 400);

  // Update tournament score with net winnings from this bet
  const netWinnings = result.amount_won - amount; // positive if won, negative if lost
  const newScore = round2(entry.score + netWinnings);

  db.update(schema.tournamentEntries)
    .set({ score: newScore })
    .where(and(
      eq(schema.tournamentEntries.tournamentId, id),
      eq(schema.tournamentEntries.agentId, agentId),
    ))
    .run();

  // Check if tournament just ended
  syncTournamentStatus();
  const refreshed = db.select().from(schema.tournaments)
    .where(eq(schema.tournaments.id, id)).get();
  if (refreshed?.status === "completed") {
    distributePrizes(id);
  }

  return c.json({
    ...result,
    tournament_score: newScore,
    tournament_id: id,
  });
});

export { tournaments };
