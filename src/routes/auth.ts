import { Hono } from "hono";
import { randomBytes, randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, sql, desc } from "drizzle-orm";
import { hashApiKey } from "../middleware/auth.js";
import { ledger } from "../wallet/ledger.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const auth = new Hono<AppEnv>();

// ─── Register (no auth needed) ───

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body.referral_code as string | undefined;

  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `sk_live_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);

  // Get next deposit index
  const maxIndex = db
    .select({ max: sql<number>`COALESCE(MAX(deposit_index), -1)` })
    .from(schema.agents)
    .get();
  const depositIndex = (maxIndex?.max ?? -1) + 1;

  db.insert(schema.agents).values({
    id: agentId,
    apiKeyHash: keyHash,
    depositIndex,
    referredBy: referralCode ?? null,
  }).run();

  // Create referral record if referred
  if (referralCode) {
    const referrer = db.select().from(schema.agents).where(eq(schema.agents.id, referralCode)).get();
    if (referrer) {
      db.insert(schema.referrals).values({
        referrerId: referralCode,
        referredId: agentId,
        commissionRate: 0.10, // 10% of net losses
      }).run();
    }
  }

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    balance: 0.0,
    tier: "free",
    risk_factor: 0.25,
    message: "Store your API key securely — it cannot be recovered.",
    next_steps: [
      "GET /api/v1/auth/balance — check your balance",
      "POST /api/v1/auth/deposit-address — get a deposit address",
      "POST /api/v1/games/coin-flip — place your first bet",
      "GET /api/v1/games — see all available games",
    ],
  }, 201);
});

// ─── All routes below require auth ───

auth.use("/*", async (c, next) => {
  // Skip auth for register
  if (c.req.path.endsWith("/register") && c.req.method === "POST") {
    return next();
  }
  return authMiddleware(c, next);
});

// ─── Balance ───

auth.get("/balance", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;

  const recentEntries = db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.agentId, agentId))
    .orderBy(desc(schema.ledgerEntries.createdAt))
    .limit(10)
    .all();

  return c.json({
    agent_id: agentId,
    balance_usd: agent.balanceUsd,
    tier: agent.tier,
    risk_factor: agent.riskFactor,
    lifetime: {
      total_deposited: agent.totalDeposited,
      total_withdrawn: agent.totalWithdrawn,
      total_wagered: agent.totalWagered,
      total_won: agent.totalWon,
      net_profit: agent.totalWon - agent.totalWagered,
    },
    recent_activity: recentEntries.map((e) => ({
      type: e.type,
      amount: e.amount,
      balance_after: e.balanceAfter,
      reason: e.reason,
      service: e.service,
      at: new Date(e.createdAt * 1000).toISOString(),
    })),
  });
});

// ─── Deposit Address ───

auth.post("/deposit-address", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const { chain } = await c.req.json();

  const supportedChains = ["base", "ethereum", "arbitrum", "optimism", "polygon", "solana", "monero", "bitcoin", "lightning"];
  if (!supportedChains.includes(chain)) {
    return c.json({
      error: "unsupported_chain",
      supported: supportedChains,
      suggestion: "Use 'base' for lowest fees (USDC on Base)",
    }, 400);
  }

  // Check if address already exists
  const existing = db
    .select()
    .from(schema.depositAddresses)
    .where(eq(schema.depositAddresses.agentId, agentId))
    .all()
    .find((a) => a.chain === chain);

  if (existing) {
    return c.json({
      chain,
      address: existing.address,
      note: "All deposits auto-converted to USD balance",
      minimum: "$0.50 equivalent",
      recommended: "USDC on Base for lowest fees",
    });
  }

  // Generate deterministic address (placeholder — real HD wallet derivation would go here)
  const address = `0x${randomBytes(20).toString("hex")}`;

  db.insert(schema.depositAddresses).values({
    agentId,
    chain,
    address,
  }).run();

  return c.json({
    chain,
    address,
    note: "All deposits auto-converted to USD balance",
    minimum: "$0.50 equivalent",
    recommended: "USDC on Base for lowest fees",
  });
});

// ─── Supported Chains ───

auth.get("/supported-chains", async (c) => {
  return c.json({
    chains: [
      { chain: "base", tokens: ["USDC", "USDT", "ETH"], recommended: true, note: "Lowest fees" },
      { chain: "ethereum", tokens: ["USDC", "USDT", "ETH"], note: "Higher gas fees" },
      { chain: "arbitrum", tokens: ["USDC", "USDT", "ETH"], note: "Low fees" },
      { chain: "optimism", tokens: ["USDC", "USDT", "ETH"], note: "Low fees" },
      { chain: "polygon", tokens: ["USDC", "USDT", "MATIC"], note: "Very low fees" },
      { chain: "solana", tokens: ["USDC", "SOL"], note: "Fast & cheap" },
      { chain: "monero", tokens: ["XMR"], note: "Private transactions" },
      { chain: "bitcoin", tokens: ["BTC"], note: "1 confirmation required" },
      { chain: "lightning", tokens: ["BTC"], note: "Instant via invoice" },
    ],
  });
});

// ─── Withdraw ───

auth.post("/withdraw", async (c) => {
  const agentId = c.get("agentId") as string;
  const { amount, chain, token, address } = await c.req.json();

  if (!amount || amount <= 0) {
    return c.json({ error: "invalid_amount", suggestion: "Amount must be positive" }, 400);
  }
  if (amount < 1) {
    return c.json({ error: "minimum_withdrawal", minimum: 1.0, suggestion: "Minimum withdrawal is $1.00" }, 400);
  }

  const balance = ledger.getBalance(agentId);
  const fee = calculateWithdrawalFee(amount, chain);
  const totalCost = amount + fee;

  if (balance < totalCost) {
    return c.json({
      error: "insufficient_balance",
      requested: amount,
      fee,
      total_needed: totalCost,
      available: balance,
      suggestion: `Deposit at least $${(totalCost - balance).toFixed(2)} more or reduce withdrawal amount`,
    }, 400);
  }

  const withdrawalId = randomUUID();

  if (amount > 1000) {
    // Queue for manual review
    ledger.reserve(agentId, totalCost, withdrawalId);
    db.insert(schema.withdrawals).values({
      id: withdrawalId,
      agentId,
      amount,
      fee,
      chain,
      token: token || "USDC",
      address,
      status: "reviewing",
    }).run();

    return c.json({
      status: "pending_review",
      withdrawal_id: withdrawalId,
      amount,
      fee,
      chain,
      address,
      note: "Withdrawals over $1,000 are reviewed within 1 hour",
    });
  }

  // Auto-process
  ledger.debit(agentId, totalCost, "withdrawal", "withdrawal", withdrawalId);

  db.update(schema.agents)
    .set({ totalWithdrawn: sql`${schema.agents.totalWithdrawn} + ${amount}` })
    .where(eq(schema.agents.id, agentId))
    .run();

  db.insert(schema.withdrawals).values({
    id: withdrawalId,
    agentId,
    amount,
    fee,
    chain,
    token: token || "USDC",
    address,
    status: "completed",
    txHash: `0x${randomBytes(32).toString("hex")}`, // placeholder
    completedAt: Math.floor(Date.now() / 1000),
  }).run();

  return c.json({
    status: "completed",
    withdrawal_id: withdrawalId,
    amount,
    fee,
    chain,
    token: token || "USDC",
    address,
    new_balance: ledger.getBalance(agentId),
  });
});

// ─── Deposit History ───

auth.get("/deposits", async (c) => {
  const agentId = c.get("agentId") as string;
  const rows = db
    .select()
    .from(schema.deposits)
    .where(eq(schema.deposits.agentId, agentId))
    .orderBy(desc(schema.deposits.createdAt))
    .limit(50)
    .all();

  return c.json({ deposits: rows });
});

// ─── Ledger History ───

auth.get("/ledger", async (c) => {
  const agentId = c.get("agentId") as string;
  const entries = ledger.getHistory(agentId, 50);
  return c.json({
    entries: entries.map((e) => ({
      ...e,
      at: new Date(e.createdAt * 1000).toISOString(),
    })),
  });
});

// ─── Withdrawal History ───

auth.get("/withdrawals", async (c) => {
  const agentId = c.get("agentId") as string;
  const rows = db
    .select()
    .from(schema.withdrawals)
    .where(eq(schema.withdrawals.agentId, agentId))
    .orderBy(desc(schema.withdrawals.createdAt))
    .limit(50)
    .all();

  return c.json({ withdrawals: rows });
});

function calculateWithdrawalFee(amount: number, chain: string): number {
  const baseFee = amount * 0.001; // 0.1%
  const networkFees: Record<string, number> = {
    base: 0.01,
    arbitrum: 0.05,
    optimism: 0.05,
    polygon: 0.01,
    ethereum: 2.0,
    solana: 0.01,
    bitcoin: 1.0,
    monero: 0.05,
    lightning: 0.01,
  };
  return Math.round((baseFee + (networkFees[chain] ?? 0.1)) * 100) / 100;
}

export { auth };
