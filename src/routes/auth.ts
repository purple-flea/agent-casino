import { Hono } from "hono";
import { randomBytes, randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, sql, desc } from "drizzle-orm";
import { hashApiKey } from "../middleware/auth.js";
import { ledger } from "../wallet/ledger.js";
import { authMiddleware } from "../middleware/auth.js";
import { sendUsdc } from "../crypto/chain.js";
import type { AppEnv } from "../types.js";

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || "http://localhost:3002";
const WALLET_SERVICE_KEY = process.env.WALLET_SERVICE_KEY;
if (!WALLET_SERVICE_KEY) console.warn("[WARN] WALLET_SERVICE_KEY not set — deposit address generation will fail");

const auth = new Hono<AppEnv>();

// ─── Register (no auth needed) ───

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body.referral_code as string | undefined;

  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `sk_live_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);
  const myReferralCode = `ref_${randomBytes(4).toString("hex")}`;

  // Get next deposit index
  const maxIndex = db
    .select({ max: sql<number>`COALESCE(MAX(deposit_index), -1)` })
    .from(schema.agents)
    .get();
  const depositIndex = (maxIndex?.max ?? -1) + 1;

  // Look up referrer by their referral code
  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = db.select().from(schema.agents).where(eq(schema.agents.referralCode, referralCode)).get();
    if (referrer) referrerId = referrer.id;
  }

  db.insert(schema.agents).values({
    id: agentId,
    apiKeyHash: keyHash,
    depositIndex,
    referralCode: myReferralCode,
    referredBy: referrerId,
  }).run();

  // Create referral record if referred
  if (referrerId) {
    db.insert(schema.referrals).values({
      referrerId: referrerId,
      referredId: agentId,
      commissionRate: 0.10, // 10% of net losses
    }).run();
  }

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    referral_code: myReferralCode,
    balance: 0.0,
    tier: "free",
    risk_factor: 0.25,
    referral_commission: "10% of net losses from referred agents",
    message: "Store your API key securely — it cannot be recovered.",
    next_steps: [
      "GET /api/v1/auth/balance — check your balance",
      "POST /api/v1/auth/deposit-address — get a deposit address",
      "POST /api/v1/games/coin-flip — place your first bet",
      "GET /api/v1/games — see all available games",
      "Share your referral_code — earn 10% of referred agents net losses",
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

  // Request real wallet address from wallet service
  let address: string;
  try {
    const resp = await fetch(`${WALLET_SERVICE_URL}/v1/wallet/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": WALLET_SERVICE_KEY!,
      },
      body: JSON.stringify({
        agent_id: agentId,
        chain,
        index: agent.depositIndex,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error(`[deposit-address] Wallet service error:`, err);
      return c.json({
        error: "wallet_service_error",
        message: "Failed to generate deposit address",
        suggestion: "Try again or contact support",
      }, 502);
    }

    const walletData = await resp.json() as { address: string; addresses?: Record<string, string> };
    // Wallet service may return a single address or chain-specific addresses
    address = walletData.addresses?.[chain] ?? walletData.address;

    if (!address) {
      return c.json({
        error: "wallet_service_error",
        message: "Wallet service returned no address for this chain",
      }, 502);
    }
  } catch (err) {
    console.error(`[deposit-address] Wallet service unreachable:`, err);
    return c.json({
      error: "wallet_service_unavailable",
      message: "Wallet service is not reachable",
      suggestion: "Try again in a moment",
    }, 503);
  }

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
    deposits: [
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
    withdrawals: [
      { chain: "base", token: "USDC", fee: "$0.50 flat", note: "Only Base USDC withdrawals supported" },
    ],
  });
});

// ─── Withdraw ───

auth.post("/withdraw", async (c) => {
  const agentId = c.get("agentId") as string;
  const { amount, address } = await c.req.json();

  // Only Base USDC withdrawals supported
  const chain = "base";
  const token = "USDC";
  const fee = 0.50; // flat fee covers gas

  if (!amount || amount <= 0) {
    return c.json({ error: "invalid_amount", suggestion: "Amount must be positive" }, 400);
  }
  if (amount < 1) {
    return c.json({ error: "minimum_withdrawal", minimum: 1.0, suggestion: "Minimum withdrawal is $1.00" }, 400);
  }
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: "invalid_address", suggestion: "Provide a valid Base/Ethereum address (0x followed by 40 hex characters)" }, 400);
  }

  const totalCost = amount + fee;
  const withdrawalId = randomUUID();

  // Reserve funds atomically to prevent race conditions (double-withdrawal)
  try {
    ledger.reserve(agentId, totalCost, withdrawalId);
  } catch {
    const balance = ledger.getBalance(agentId);
    return c.json({
      error: "insufficient_balance",
      requested: amount,
      fee,
      total_needed: totalCost,
      available: balance,
      suggestion: `Deposit at least $${(totalCost - balance).toFixed(2)} more or reduce withdrawal amount`,
    }, 400);
  }

  if (amount > 1000) {
    // Already reserved above — queue for manual review
    db.insert(schema.withdrawals).values({
      id: withdrawalId,
      agentId,
      amount,
      fee,
      chain,
      token,
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

  // Convert reservation to debit
  ledger.releaseReservation(agentId, withdrawalId, totalCost);
  ledger.debit(agentId, totalCost, "withdrawal", "withdrawal", withdrawalId);

  db.update(schema.agents)
    .set({ totalWithdrawn: sql`${schema.agents.totalWithdrawn} + ${amount}` })
    .where(eq(schema.agents.id, agentId))
    .run();

  // Record withdrawal as pending while we send on-chain
  db.insert(schema.withdrawals).values({
    id: withdrawalId,
    agentId,
    amount,
    fee,
    chain,
    token,
    address,
    status: "pending",
  }).run();

  // Send USDC on Base chain from treasury
  try {
    const result = await sendUsdc(address, amount);

    db.update(schema.withdrawals)
      .set({
        status: "completed",
        txHash: result.txHash,
        completedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(schema.withdrawals.id, withdrawalId))
      .run();

    return c.json({
      status: "completed",
      withdrawal_id: withdrawalId,
      amount,
      fee,
      chain,
      token,
      address,
      tx_hash: result.txHash,
      explorer: `https://basescan.org/tx/${result.txHash}`,
      new_balance: ledger.getBalance(agentId),
    });
  } catch (err) {
    // On-chain send failed — mark as failed and refund
    console.error(`[withdraw] On-chain send failed for ${withdrawalId}:`, err);

    db.update(schema.withdrawals)
      .set({ status: "failed" })
      .where(eq(schema.withdrawals.id, withdrawalId))
      .run();

    // Refund the agent
    ledger.credit(agentId, totalCost, "withdrawal_refund", "withdrawal", withdrawalId);

    db.update(schema.agents)
      .set({ totalWithdrawn: sql`${schema.agents.totalWithdrawn} - ${amount}` })
      .where(eq(schema.agents.id, agentId))
      .run();

    return c.json({
      error: "withdrawal_failed",
      withdrawal_id: withdrawalId,
      message: "On-chain transfer failed — your balance has been refunded",
      suggestion: "Try again in a moment or contact support",
      new_balance: ledger.getBalance(agentId),
    }, 500);
  }
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


// ─── Referral Stats ───

auth.get("/referral/code", async (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  return c.json({
    referral_code: agent.referralCode,
    commission_rate: "10% of net losses from referred agents",
    share_message: "Sign up at api.purpleflea.com/v1/casino with referral_code: " + agent.referralCode,
  });
});

auth.get("/referral/stats", async (c) => {
  const agentId = c.get("agentId") as string;
  
  const referrals_list = db
    .select()
    .from(schema.referrals)
    .where(eq(schema.referrals.referrerId, agentId))
    .all();

  const totalEarned = referrals_list.reduce((sum, r) => sum + r.totalEarned, 0);
  
  return c.json({
    total_referrals: referrals_list.length,
    total_earned_usd: Math.round(totalEarned * 100) / 100,
    commission_rate: "10%",
    referrals: referrals_list.map(r => ({
      referred_agent: r.referredId,
      earned_usd: Math.round(r.totalEarned * 100) / 100,
      since: new Date(r.createdAt * 1000).toISOString(),
    })),
  });
});

export { auth };
