import { Hono } from "hono";
import {
  playCoinFlip,
  playDice,
  playMultiplier,
  playRoulette,
  playCustom,
  playBatch,
} from "../engine/games.js";
import type { AppEnv } from "../types.js";
import { checkRateLimit } from "../middleware/rateLimit.js";

const games = new Hono<AppEnv>();

// ─── List available games ───

games.get("/", (c) => {
  return c.json({
    games: [
      {
        id: "coin_flip",
        name: "Coin Flip",
        description: "Choose heads or tails. 50/50 odds.",
        house_edge: "0.5%",
        payout: "1.96x",
        endpoint: "POST /api/v1/games/coin-flip",
        params: { side: "heads | tails", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "dice",
        name: "Dice Roll",
        description: "Roll 1-100. Bet over or under a threshold. Variable odds.",
        house_edge: "0.5%",
        payout: "Variable (e.g. over 50 = 1.96x, over 90 = 9.8x)",
        endpoint: "POST /api/v1/games/dice",
        params: { direction: "over | under", threshold: "1-99", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "multiplier",
        name: "Multiplier (Crash)",
        description: "Pick a target multiplier. If the crash point exceeds it, you win.",
        house_edge: "0.5%",
        payout: "Your target multiplier (1.01x - 1000x)",
        endpoint: "POST /api/v1/games/multiplier",
        params: { target_multiplier: "1.01-1000", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "roulette",
        name: "Roulette",
        description: "European roulette (0-36). Bet on number, color, odd/even, high/low, dozens, columns.",
        house_edge: "0.5%",
        payout: "Varies by bet type",
        endpoint: "POST /api/v1/games/roulette",
        params: {
          bet_type: "number | red | black | odd | even | high | low | dozen_1 | dozen_2 | dozen_3 | column_1 | column_2 | column_3",
          bet_value: "0-36 (for number bets)",
          amount: "number",
          client_seed: "string (optional)",
        },
      },
      {
        id: "custom",
        name: "Custom Odds",
        description: "Define your own win probability (1-99%). API calculates fair payout minus house edge.",
        house_edge: "0.5%",
        payout: "Calculated: (1 / probability) * 0.98",
        endpoint: "POST /api/v1/games/custom",
        params: { win_probability: "1-99 (percentage)", amount: "number", client_seed: "string (optional)" },
      },
    ],
    batch_endpoint: "POST /api/v1/bets/batch",
    note: "All bets enforce Kelly Criterion max sizing. Use GET /api/v1/kelly/limits to see your current limits.",
  });
});

// ─── Coin Flip ───

games.post("/coin-flip", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { side, amount, client_seed } = await c.req.json();

  if (!["heads", "tails"].includes(side)) {
    return c.json({ error: "invalid_side", message: "Side must be 'heads' or 'tails'" }, 400);
  }

  const result = playCoinFlip(agentId, side, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Dice ───

games.post("/dice", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { direction, threshold, amount, client_seed } = await c.req.json();

  if (!["over", "under"].includes(direction)) {
    return c.json({ error: "invalid_direction", message: "Direction must be 'over' or 'under'" }, 400);
  }

  const result = playDice(agentId, direction, threshold, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Multiplier ───

games.post("/multiplier", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { target_multiplier, amount, client_seed } = await c.req.json();

  const result = playMultiplier(agentId, target_multiplier, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Roulette ───

games.post("/roulette", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { bet_type, bet_value, amount, client_seed } = await c.req.json();

  const result = playRoulette(agentId, bet_type, bet_value, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Custom Odds ───

games.post("/custom", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { win_probability, amount, client_seed } = await c.req.json();

  const result = playCustom(agentId, win_probability, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

export { games };
