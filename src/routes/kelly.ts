import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { getAllGameLimits, kellyOptimal, simulate } from "../engine/kelly.js";
import type { AppEnv } from "../types.js";

const kelly = new Hono<AppEnv>();

// ─── Get limits for all games ───

kelly.get("/limits", async (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const limits = getAllGameLimits(agent.balanceUsd, agent.riskFactor);
  return c.json(limits);
});

// ─── Get optimal bet for a specific game ───

kelly.post("/optimal", async (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const { game, threshold, win_probability, risk_factor } = await c.req.json();

  const rf = risk_factor ?? agent.riskFactor;
  const bankroll = agent.balanceUsd;

  let winProb: number;
  let payoutMultiplier: number;

  switch (game) {
    case "coin_flip":
      winProb = 0.5;
      payoutMultiplier = 1.96;
      break;
    case "dice_over":
      if (!threshold || threshold < 1 || threshold > 99) {
        return c.json({ error: "invalid_threshold", message: "Threshold required (1-99)" }, 400);
      }
      winProb = (100 - threshold) / 100;
      payoutMultiplier = Math.round((1 / winProb) * 0.98 * 10000) / 10000;
      break;
    case "dice_under":
      if (!threshold || threshold < 1 || threshold > 99) {
        return c.json({ error: "invalid_threshold", message: "Threshold required (1-99)" }, 400);
      }
      winProb = threshold / 100;
      payoutMultiplier = Math.round((1 / winProb) * 0.98 * 10000) / 10000;
      break;
    case "custom":
      if (!win_probability || win_probability < 1 || win_probability > 99) {
        return c.json({ error: "invalid_probability", message: "win_probability required (1-99)" }, 400);
      }
      winProb = win_probability / 100;
      payoutMultiplier = Math.round((1 / winProb) * 0.98 * 10000) / 10000;
      break;
    default:
      return c.json({ error: "unknown_game", message: "Game must be: coin_flip, dice_over, dice_under, custom" }, 400);
  }

  const result = kellyOptimal({ bankroll, winProbability: winProb, payoutMultiplier, riskFactor: rf });

  return c.json({
    bankroll,
    game,
    win_probability: winProb,
    payout_multiplier: payoutMultiplier,
    risk_factor: rf,
    ...result,
  });
});

// ─── Configure risk factor ───

kelly.put("/config", async (c) => {
  const agentId = c.get("agentId") as string;
  const { risk_factor } = await c.req.json();

  if (typeof risk_factor !== "number" || risk_factor < 0.1 || risk_factor > 1.0) {
    return c.json({
      error: "invalid_risk_factor",
      message: "risk_factor must be between 0.1 and 1.0",
      suggestion: "0.1=ultra conservative, 0.25=default, 0.5=aggressive, 1.0=full Kelly",
    }, 400);
  }

  db.update(schema.agents)
    .set({ riskFactor: risk_factor })
    .where(eq(schema.agents.id, agentId))
    .run();

  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
  const limits = getAllGameLimits(agent.balanceUsd, risk_factor);

  return c.json({
    risk_factor,
    message: `Risk factor updated to ${risk_factor}`,
    new_limits: limits,
  });
});

// ─── Bankroll history ───

kelly.get("/history", async (c) => {
  const agentId = c.get("agentId") as string;

  const entries = db
    .select({
      amount: schema.ledgerEntries.amount,
      balanceAfter: schema.ledgerEntries.balanceAfter,
      type: schema.ledgerEntries.type,
      reason: schema.ledgerEntries.reason,
      createdAt: schema.ledgerEntries.createdAt,
    })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.agentId, agentId))
    .orderBy(schema.ledgerEntries.createdAt)
    .all();

  const curve = entries.map((e) => ({
    balance: e.balanceAfter,
    change: e.type === "credit" ? e.amount : -e.amount,
    reason: e.reason,
    at: new Date(e.createdAt * 1000).toISOString(),
  }));

  return c.json({
    agent_id: agentId,
    data_points: curve.length,
    bankroll_curve: curve,
  });
});

// ─── Monte Carlo Simulation ───

kelly.post("/simulate", async (c) => {
  const { bankroll, game, bet_amount, num_bets, simulations, threshold, win_probability } = await c.req.json();

  if (!bankroll || !game || !bet_amount || !num_bets) {
    return c.json({ error: "missing_params", message: "Required: bankroll, game, bet_amount, num_bets" }, 400);
  }

  let winProb: number;
  let payoutMultiplier: number;

  switch (game) {
    case "coin_flip":
      winProb = 0.5;
      payoutMultiplier = 1.96;
      break;
    case "dice_over":
      winProb = (100 - (threshold || 50)) / 100;
      payoutMultiplier = Math.round((1 / winProb) * 0.98 * 10000) / 10000;
      break;
    case "dice_under":
      winProb = (threshold || 50) / 100;
      payoutMultiplier = Math.round((1 / winProb) * 0.98 * 10000) / 10000;
      break;
    case "custom":
      winProb = (win_probability || 50) / 100;
      payoutMultiplier = Math.round((1 / winProb) * 0.98 * 10000) / 10000;
      break;
    default:
      return c.json({ error: "unknown_game" }, 400);
  }

  const result = simulate({
    bankroll,
    betAmount: bet_amount,
    winProbability: winProb,
    payoutMultiplier,
    numBets: Math.min(num_bets, 10000),
    simulations: Math.min(simulations || 10000, 50000),
  });

  return c.json(result);
});

export { kelly };
