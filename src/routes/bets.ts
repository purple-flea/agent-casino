import { Hono } from "hono";
import { playBatch } from "../engine/games.js";
import type { AppEnv } from "../types.js";
import { checkRateLimit } from "../middleware/rateLimit.js";

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

  const results = playBatch(agentId, bets);

  const won = results.filter((r) => !("error" in r) && r.won).length;
  const lost = results.filter((r) => !("error" in r) && !r.won).length;
  const errors = results.filter((r) => "error" in r).length;

  return c.json({
    results,
    summary: {
      total: bets.length,
      won,
      lost,
      errors,
    },
  });
});

export { betsRouter };
