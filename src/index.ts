import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";

import { runMigrations } from "./db/migrate.js";
import { authMiddleware } from "./middleware/auth.js";
import { auth } from "./routes/auth.js";
import { games } from "./routes/games.js";
import { betsRouter } from "./routes/bets.js";
import { kelly } from "./routes/kelly.js";
import { fairness } from "./routes/fairness.js";
import { stats } from "./routes/stats.js";
import { tournaments } from "./routes/tournaments.js";
import { challenges } from "./routes/challenges.js";
import { startDepositMonitor } from "./crypto/deposits.js";
import type { AppEnv } from "./types.js";

// Run migrations
runMigrations();

const app = new Hono<AppEnv>();

// ─── Simple in-process rate limiter (sliding window) ───
// buckets: Map<key, { count, windowStart }>
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();

function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip")
      || "unknown";
    const key = `${c.req.path}:${ip}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || now - bucket.windowStart > windowMs) {
      rateLimitBuckets.set(key, { count: 1, windowStart: now });
    } else {
      bucket.count++;
      if (bucket.count > maxRequests) {
        return c.json(
          { error: "rate_limited", message: `Too many requests. Limit: ${maxRequests} per ${windowMs / 1000}s` },
          429
        );
      }
    }
    await next();
  };
}

// Periodically clean up stale buckets (every 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.windowStart < cutoff) rateLimitBuckets.delete(key);
  }
}, 300_000);

// ─── Global middleware ───
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || ["null"];
app.use("*", cors({ origin: ALLOWED_ORIGINS }));
app.use("*", logger());

// ─── Static files (llms.txt, llms-full.txt) ───
app.use("/llms.txt", serveStatic({ path: "public/llms.txt" }));
app.use("/llms-full.txt", serveStatic({ path: "public/llms-full.txt" }));

// ─── Health check ───
app.get("/health", (c) => c.json({ status: "ok", service: "agent-casino", version: "1.0.0" }));

// ─── API v1 ───
const api = new Hono<AppEnv>();

// Rate limits on sensitive public endpoints
api.use("/auth/register", rateLimit(10, 60_000));        // 10 registrations/min per IP
api.use("/kelly/simulate", rateLimit(5, 60_000));        // 5 simulations/min per IP
api.use("/auth/withdraw", rateLimit(5, 60_000));         // 5 withdrawals/min per IP

// General authenticated endpoint limit
api.use("/games/*", rateLimit(60, 60_000));
api.use("/bets/*", rateLimit(60, 60_000));

// Auth routes (register is public, rest needs auth)
api.route("/auth", auth);

// Protected routes
api.use("/games/*", authMiddleware);
api.use("/bets/*", authMiddleware);
api.use("/kelly/*", authMiddleware);
api.use("/fairness/*", authMiddleware);
api.use("/stats/*", authMiddleware);
api.use("/tournaments/create", authMiddleware);
api.use("/tournaments/:id/enter", authMiddleware);
api.use("/tournaments/:id/play", authMiddleware);
api.use("/challenges/*", authMiddleware);

api.route("/games", games);
api.route("/bets", betsRouter);
api.route("/kelly", kelly);
api.route("/fairness", fairness);
api.route("/stats", stats);
api.route("/tournaments", tournaments);
api.route("/challenges", challenges);

// ─── Pricing ───
api.get("/pricing", (c) => c.json({
  house_edge: "0.5% on all games",
  min_bet: 0.01,
  max_bet: "Kelly-limited based on your bankroll",
  withdrawal_fee: "$0.50 flat (Base USDC only)",
  games: {
    coin_flip: { payout: "1.96x", probability: "50%" },
    dice: { payout: "Variable", probability: "Variable (1-99%)" },
    multiplier: { payout: "1.01x-1000x", probability: "Based on target" },
    roulette: { payout: "1.96x-34.3x", probability: "Varies by bet type" },
    custom: { payout: "(1/prob)*0.98", probability: "You choose (1-99%)" },
  },
}));

// ─── API Docs ───
api.get("/docs", (c) => c.json({
  name: "Agent Casino API",
  version: "1.0.0",
  base_url: "/api/v1",
  authentication: "Bearer {api_key} in Authorization header",
  endpoints: {
    auth: {
      "POST /auth/register": "Create agent account, returns API key",
      "GET /auth/balance": "Current balance + recent activity",
      "POST /auth/deposit-address": "Get deposit address for a chain",
      "POST /auth/withdraw": "Withdraw USDC on Base ($0.50 fee, min $1.00)",
      "GET /auth/supported-chains": "List supported chains",
      "GET /auth/deposits": "Deposit history",
      "GET /auth/ledger": "Full transaction history",
      "GET /auth/withdrawals": "Withdrawal history",
    },
    games: {
      "GET /games": "List all games with rules",
      "POST /games/coin-flip": "Flip a coin (1.96x)",
      "POST /games/dice": "Roll dice over/under (variable payout)",
      "POST /games/multiplier": "Crash-style multiplier",
      "POST /games/roulette": "European roulette",
      "POST /games/custom": "Custom win probability",
      "POST /bets/batch": "Multiple bets in one call",
    },
    kelly: {
      "GET /kelly/limits": "Kelly limits for all games",
      "POST /kelly/optimal": "Optimal bet for specific game",
      "PUT /kelly/config": "Set your risk factor",
      "GET /kelly/history": "Bankroll curve over time",
      "POST /kelly/simulate": "Monte Carlo simulation",
    },
    fairness: {
      "GET /fairness/seed-hash": "Current server seed hash",
      "POST /fairness/verify": "Verify any past bet",
      "GET /fairness/audit/:betId": "Full audit trail",
      "POST /fairness/rotate": "Request seed rotation",
      "GET /fairness/seeds": "All seeds (revealed ones shown)",
    },
    stats: {
      "GET /stats/me": "Your lifetime stats",
      "GET /stats/session": "Last 24h stats",
      "GET /stats/leaderboard": "Top agents",
    },
  },
}));

app.route("/api/v1", api);

// ─── Root ───
app.get("/", (c) => c.json({
  name: "Agent Casino",
  description: "Provably fair gambling API for AI agents",
  version: "1.0.0",
  docs: "/api/v1/docs",
  health: "/health",
  llms_txt: "/llms.txt",
  llms_full_txt: "/llms-full.txt",
  quick_start: [
    "1. POST /api/v1/auth/register → get API key",
    "2. POST /api/v1/auth/deposit-address → fund account",
    "3. POST /api/v1/games/coin-flip → place a bet",
  ],
}));

// ─── Start server ───
const port = parseInt(process.env.PORT || "3000");

serve({ fetch: app.fetch, port }, () => {
  console.log(`Agent Casino running on http://localhost:${port}`);
  console.log(`API docs: http://localhost:${port}/api/v1/docs`);
  console.log(`Health: http://localhost:${port}/health`);

  // Start background deposit monitor (polls Base USDC every 60s)
  startDepositMonitor();
});

export { app };
