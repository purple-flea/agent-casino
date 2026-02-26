import { Hono } from "hono";
import { playBatch } from "../engine/games.js";
import type { AppEnv } from "../types.js";
import { checkRateLimit } from "../middleware/rateLimit.js";
import { db, schema } from "../db/index.js";
import { eq, and, sql, desc } from "drizzle-orm";

const betsRouter = new Hono<AppEnv>();

// ─── Batch Betting ───

betsRouter.post("/batch", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "batch", 10);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 10 batch calls/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { bets } = await c.req.json();

  if (!Array.isArray(bets) || bets.length === 0) {
    return c.json({ error: "invalid_bets", message: "Provide an array of bets" }, 400);
  }

  if (bets.length > 20) {
    return c.json({ error: "too_many_bets", message: "Maximum 20 bets per batch call" }, 400);
  }

  const results = playBatch(agentId, bets);

  const won = results.filter((r) => !("error" in r) && (r as any).won).length;
  const lost = results.filter((r) => !("error" in r) && !(r as any).won).length;
  const errors = results.filter((r) => "error" in r).length;

  // Financial summary
  const totalWagered = results
    .filter((r) => !("error" in r))
    .reduce((sum, r) => sum + ((r as any).amount ?? 0), 0);
  const totalWon = results
    .filter((r) => !("error" in r))
    .reduce((sum, r) => sum + ((r as any).amount_won ?? 0), 0);
  const netPnl = Math.round((totalWon - totalWagered) * 100) / 100;

  // Get updated balance for Kelly recommendation
  const agent = db.select({ balanceUsd: schema.agents.balanceUsd, riskFactor: schema.agents.riskFactor })
    .from(schema.agents).where(eq(schema.agents.id, agentId)).get();

  const balance = agent?.balanceUsd ?? 0;
  const riskFactor = agent?.riskFactor ?? 0.25;
  const kellyMaxNext = Math.round(balance * riskFactor * 100) / 100;

  return c.json({
    results,
    summary: {
      total: bets.length,
      won,
      lost,
      errors,
      total_wagered: Math.round(totalWagered * 100) / 100,
      total_won: Math.round(totalWon * 100) / 100,
      net_pnl: netPnl,
      win_rate_pct: (won + lost) > 0 ? Math.round((won / (won + lost)) * 10000) / 100 : 0,
    },
    balance_after: Math.round(balance * 100) / 100,
    kelly_max_next_bet: kellyMaxNext,
    kelly_tip: netPnl < 0 && Math.abs(netPnl) > totalWagered * 0.2
      ? `Significant loss session (${netPnl < 0 ? '-' : ''}$${Math.abs(netPnl)}). Kelly max next bet: $${kellyMaxNext}`
      : undefined,
  });
});

// ─── GET /bets/history — paginated bet history with filters ───

betsRouter.get("/history", (c) => {
  const agentId = c.get("agentId") as string;

  const game = c.req.query("game");
  const outcome = c.req.query("outcome"); // "won" | "lost"
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
  const offset = parseInt(c.req.query("offset") || "0");
  const since = c.req.query("since"); // ISO date string e.g. "2026-02-01"

  // Build WHERE conditions
  let conditions = [eq(schema.bets.agentId, agentId)];

  if (game) {
    const VALID_GAMES = ["coin_flip", "dice", "multiplier", "roulette", "custom", "blackjack", "crash", "plinko", "slots"];
    if (!VALID_GAMES.includes(game)) {
      return c.json({ error: "invalid_game", message: `game must be one of: ${VALID_GAMES.join(", ")}` }, 400);
    }
    conditions.push(eq(schema.bets.game, game));
  }

  if (outcome === "won") {
    conditions.push(eq(schema.bets.won, true));
  } else if (outcome === "lost") {
    conditions.push(eq(schema.bets.won, false));
  }

  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      const sinceTs = Math.floor(sinceDate.getTime() / 1000);
      conditions.push(sql`${schema.bets.createdAt} >= ${sinceTs}`);
    }
  }

  const bets = db.select({
    id: schema.bets.id,
    game: schema.bets.game,
    amount: schema.bets.amount,
    amountWon: schema.bets.amountWon,
    payoutMultiplier: schema.bets.payoutMultiplier,
    won: schema.bets.won,
    resultHash: schema.bets.resultHash,
    createdAt: schema.bets.createdAt,
  })
    .from(schema.bets)
    .where(and(...conditions))
    .orderBy(desc(schema.bets.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  // Count total for pagination
  const total = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.bets)
    .where(and(...conditions))
    .get();

  // Summary for filtered set
  const summaryRows = db.select({
    totalWagered: sql<number>`COALESCE(SUM(${schema.bets.amount}), 0)`,
    totalWon: sql<number>`COALESCE(SUM(${schema.bets.amountWon}), 0)`,
    wins: sql<number>`SUM(CASE WHEN ${schema.bets.won} = 1 THEN 1 ELSE 0 END)`,
    biggestWin: sql<number>`COALESCE(MAX(${schema.bets.amountWon}), 0)`,
    totalBets: sql<number>`COUNT(*)`,
  }).from(schema.bets).where(and(...conditions)).get();

  const totalBets = summaryRows?.totalBets ?? 0;
  const wins = summaryRows?.wins ?? 0;

  return c.json({
    bets: bets.map(b => ({
      id: b.id,
      game: b.game,
      amount: Math.round(b.amount * 100) / 100,
      amount_won: Math.round(b.amountWon * 100) / 100,
      multiplier: b.payoutMultiplier,
      won: b.won,
      net: Math.round((b.amountWon - b.amount) * 100) / 100,
      verify: `GET /api/v1/fairness/verify?hash=${b.resultHash}`,
      at: new Date(b.createdAt * 1000).toISOString(),
    })),
    pagination: {
      total: total?.count ?? 0,
      limit,
      offset,
      has_more: offset + bets.length < (total?.count ?? 0),
    },
    summary: {
      total_bets: totalBets,
      total_wagered: Math.round((summaryRows?.totalWagered ?? 0) * 100) / 100,
      total_won_amount: Math.round((summaryRows?.totalWon ?? 0) * 100) / 100,
      net_pnl: Math.round(((summaryRows?.totalWon ?? 0) - (summaryRows?.totalWagered ?? 0)) * 100) / 100,
      win_rate_pct: totalBets > 0 ? Math.round((wins / totalBets) * 10000) / 100 : 0,
      biggest_win: Math.round((summaryRows?.biggestWin ?? 0) * 100) / 100,
    },
    filters: { game: game ?? null, outcome: outcome ?? null, since: since ?? null },
    tip: "Add ?game=slots&outcome=won to filter. ?since=2026-02-01 for date range.",
  });
});

// ─── GET /bets/export.csv — download full bet history as CSV ───

betsRouter.get("/export.csv", (c) => {
  const agentId = c.get("agentId") as string;

  const game = c.req.query("game");
  const outcome = c.req.query("outcome");
  const since = c.req.query("since");
  const until = c.req.query("until");

  let conditions = [eq(schema.bets.agentId, agentId)];

  if (game) {
    const VALID_GAMES = ["coin_flip", "dice", "multiplier", "roulette", "custom", "blackjack", "crash", "plinko", "slots"];
    if (VALID_GAMES.includes(game)) conditions.push(eq(schema.bets.game, game));
  }
  if (outcome === "won") conditions.push(eq(schema.bets.won, true));
  else if (outcome === "lost") conditions.push(eq(schema.bets.won, false));

  if (since) {
    const ts = Math.floor(new Date(since).getTime() / 1000);
    if (!isNaN(ts)) conditions.push(sql`${schema.bets.createdAt} >= ${ts}`);
  }
  if (until) {
    const ts = Math.floor(new Date(until).getTime() / 1000);
    if (!isNaN(ts)) conditions.push(sql`${schema.bets.createdAt} <= ${ts}`);
  }

  const bets = db.select({
    id: schema.bets.id,
    game: schema.bets.game,
    amount: schema.bets.amount,
    amountWon: schema.bets.amountWon,
    payoutMultiplier: schema.bets.payoutMultiplier,
    won: schema.bets.won,
    serverSeedHash: schema.bets.serverSeedHash,
    clientSeed: schema.bets.clientSeed,
    nonce: schema.bets.nonce,
    resultHash: schema.bets.resultHash,
    createdAt: schema.bets.createdAt,
  })
    .from(schema.bets)
    .where(and(...conditions))
    .orderBy(desc(schema.bets.createdAt))
    .limit(10000) // max 10k rows per export
    .all();

  // Build CSV
  const headers = [
    "bet_id", "game", "amount_usd", "amount_won_usd", "net_usd",
    "payout_multiplier", "won", "server_seed_hash", "client_seed",
    "nonce", "result_hash", "timestamp_utc",
  ];

  const escapeCell = (val: string | number | boolean | null | undefined): string => {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = bets.map(b => [
    b.id,
    b.game,
    (Math.round(b.amount * 100) / 100).toFixed(2),
    (Math.round(b.amountWon * 100) / 100).toFixed(2),
    (Math.round((b.amountWon - b.amount) * 100) / 100).toFixed(2),
    (Math.round(b.payoutMultiplier * 10000) / 10000).toString(),
    b.won ? "true" : "false",
    b.serverSeedHash ?? "",
    b.clientSeed ?? "",
    b.nonce?.toString() ?? "",
    b.resultHash ?? "",
    new Date(b.createdAt * 1000).toISOString(),
  ].map(escapeCell).join(","));

  const csv = [headers.join(","), ...rows].join("\r\n");

  const filename = `bets_${agentId.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.csv`;

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  c.header("Cache-Control", "private, no-cache");

  return c.body(csv);
});

export { betsRouter };
