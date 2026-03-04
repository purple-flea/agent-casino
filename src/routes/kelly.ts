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

// ─── Ruin probability calculator ───
// NOTE: This is also mounted publicly at /api/v1/bankroll-ruin in index.ts (no auth)

kelly.get("/ruin", (c) => {
  c.header("Cache-Control", "public, max-age=60");

  const game = c.req.query("game") ?? "coin_flip";
  const balance = parseFloat(c.req.query("balance") ?? "100");
  const betSize = parseFloat(c.req.query("bet_size") ?? "10");
  const target = parseFloat(c.req.query("target") ?? String(balance * 2));

  if (isNaN(balance) || balance <= 0 || isNaN(betSize) || betSize <= 0) {
    return c.json({ error: "invalid_params", message: "balance and bet_size must be positive numbers" }, 400);
  }

  // Game parameters
  const gameParams: Record<string, { winProb: number; payout: number; houseEdge: number }> = {
    coin_flip:    { winProb: 0.5,     payout: 1.99, houseEdge: 0.5 },
    dice:         { winProb: 0.4925,  payout: 1.98, houseEdge: 0.75 },
    simple_dice:  { winProb: 1/6,     payout: 5.5,  houseEdge: 8.3 },
    roulette:     { winProb: 18/38,   payout: 2.0,  houseEdge: 5.26 },
    blackjack:    { winProb: 0.425,   payout: 2.1,  houseEdge: 0.5 },
    multiplier:   { winProb: 0.5,     payout: 1.96, houseEdge: 2.0 },
    slots:        { winProb: 0.35,    payout: 2.85, houseEdge: 3.0 },
    plinko:       { winProb: 0.35,    payout: 2.8,  houseEdge: 4.0 },
    keno:         { winProb: 0.25,    payout: 3.5,  houseEdge: 12.5 },
    scratch_card: { winProb: 0.33,    payout: 2.7,  houseEdge: 10.8 },
  };

  const gp = gameParams[game];
  if (!gp) {
    return c.json({
      error: "unknown_game",
      valid_games: Object.keys(gameParams),
    }, 400);
  }

  const { winProb, payout, houseEdge } = gp;
  const lossProb = 1 - winProb;
  const p = winProb;
  const q = lossProb;

  // Gambler's ruin formula: P(ruin) = ((q/p)^(B/b) - (q/p)^(T/b)) / (1 - (q/p)^(T/b))
  // Where B = balance, T = target, b = bet_size
  const units = Math.round(balance / betSize);
  const targetUnits = Math.round(target / betSize);

  let ruinProb: number;
  let winProb2: number;

  if (Math.abs(p - q) < 0.0001) {
    // Fair game (p ≈ q): P(ruin) = 1 - units/targetUnits
    ruinProb = 1 - units / targetUnits;
    winProb2 = units / targetUnits;
  } else {
    const ratio = q / p;
    const ruinNum = Math.pow(ratio, units) - Math.pow(ratio, targetUnits);
    const ruinDen = 1 - Math.pow(ratio, targetUnits);
    ruinProb = ruinNum / ruinDen;
    winProb2 = 1 - ruinProb;
  }

  // Expected bets before game ends (absorbing barrier)
  const expBets = p > q
    ? (units / (p - q)) * (1 - Math.pow(q / p, targetUnits - units)) / (1 - Math.pow(q / p, targetUnits))
    : units * (targetUnits - units);  // approximation for near-fair

  // Survival at milestones (using geometric decay for simplicity)
  const survivalRate = Math.pow(1 - houseEdge / 100, betSize / balance);

  const milestones = [10, 25, 50, 100, 250, 500, 1000].map((n) => ({
    after_n_bets: n,
    survival_probability_pct: Math.round(Math.pow(1 - houseEdge / 100, n) * 10000) / 100,
    expected_balance: Math.round((balance - (n * betSize * houseEdge / 100)) * 100) / 100,
  }));

  // Kelly fraction for this game
  const kellyFraction = (p * (payout - 1) - q) / (payout - 1);
  const kellyBet = Math.max(0, Math.round(balance * kellyFraction * 100) / 100);

  return c.json({
    game,
    params: {
      starting_balance: balance,
      bet_size: betSize,
      target_balance: target,
      units_to_ruin: units,
      units_to_target: targetUnits,
    },
    house: {
      win_probability: Math.round(p * 10000) / 100,
      payout_multiplier: payout,
      house_edge_pct: houseEdge,
    },
    ruin_analysis: {
      probability_of_ruin_pct: Math.round(ruinProb * 10000) / 100,
      probability_of_hitting_target_pct: Math.round(winProb2 * 10000) / 100,
      expected_bets_until_end: Math.round(Math.abs(expBets)),
      verdict: ruinProb > 0.8 ? "HIGH RISK: bet size is too large relative to bankroll" :
               ruinProb > 0.5 ? "MODERATE RISK: consider reducing bet size" :
               "ACCEPTABLE: within Kelly Criterion guidelines",
    },
    survival_milestones: milestones,
    kelly_recommendation: {
      optimal_kelly_fraction_pct: Math.round(kellyFraction * 10000) / 100,
      optimal_bet_size: kellyBet,
      current_bet_as_pct_kelly: kellyFraction > 0
        ? Math.round((betSize / balance / kellyFraction) * 100)
        : null,
      note: kellyBet < betSize
        ? `Your bet ($${betSize}) exceeds Kelly optimal ($${kellyBet}). Reduce for long-term survival.`
        : `Your bet ($${betSize}) is within Kelly guidelines.`,
    },
    tip: "Use GET /api/v1/kelly/limits (auth) for personalized limits based on your balance.",
    updated_at: new Date().toISOString(),
  });
});

export { kelly };
