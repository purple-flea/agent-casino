import { Hono } from "hono";
import { playBatch } from "../engine/games.js";
import type { AppEnv } from "../types.js";
import { checkRateLimit } from "../middleware/rateLimit.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

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

export { betsRouter };
