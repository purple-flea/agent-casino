import { Hono } from "hono";
import { randomBytes, randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, sql, desc, and, gte } from "drizzle-orm";
import { hashApiKey } from "../middleware/auth.js";
import { ledger } from "../wallet/ledger.js";
import { authMiddleware } from "../middleware/auth.js";
import { sendUsdc } from "../crypto/chain.js";
import { deriveXmrDepositKeys } from "../crypto/xmr.js";
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

  // Look up referrer by their referral code (3-level chains supported).
  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = db.select().from(schema.agents).where(eq(schema.agents.referralCode, referralCode)).get();
    if (referrer) {
      referrerId = referrer.id;
    }
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

  // Auto-claim faucet ($1 free credits) for every new agent — fire and forget
  const FAUCET_URL = process.env.FAUCET_URL || "http://localhost:3006";
  fetch(`${FAUCET_URL}/faucet/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_casino_id: agentId }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { /* silent — faucet errors never block registration */ });

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

// ─── Supported chains config for deposit-address endpoint ───

const SUPPORTED_CHAINS = ["base", "ethereum", "bsc", "arbitrum", "solana", "bitcoin", "tron", "monero"] as const;
type SupportedChain = typeof SUPPORTED_CHAINS[number];

interface ChainDepositInfo {
  token: string;
  send_token: string;
  auto_swap: boolean;
  swap_fee: string;
  minimum: string;
  note: string;
  send_instructions: string;
}

const CHAIN_INFO: Record<SupportedChain, ChainDepositInfo> = {
  base: {
    token: "USDC",
    send_token: "USDC",
    auto_swap: false,
    swap_fee: "0%",
    minimum: "$0.50",
    note: "Lowest fees — direct USDC credit, no swap",
    send_instructions: "Send USDC (ERC-20) on Base network to this address",
  },
  ethereum: {
    token: "ETH or USDC/USDT",
    send_token: "ETH, USDC, or USDT",
    auto_swap: true,
    swap_fee: "0.1–0.3%",
    minimum: "$0.50 equivalent",
    note: "Auto-swapped to Base USDC via Wagyu — ETH gas fees apply",
    send_instructions: "Send ETH, USDC, or USDT on Ethereum mainnet to this address",
  },
  bsc: {
    token: "BNB or USDT/USDC",
    send_token: "BNB, USDT, or USDC",
    auto_swap: true,
    swap_fee: "0.1–0.3%",
    minimum: "$0.50 equivalent",
    note: "Auto-swapped to Base USDC via Wagyu",
    send_instructions: "Send BNB, USDT (BSC), or USDC (BSC) to this address",
  },
  arbitrum: {
    token: "ETH or USDC/USDT",
    send_token: "ETH, USDC, or USDT",
    auto_swap: true,
    swap_fee: "0.1–0.3%",
    minimum: "$0.50 equivalent",
    note: "Auto-swapped to Base USDC via Wagyu — low fees",
    send_instructions: "Send ETH, USDC, or USDT on Arbitrum One to this address",
  },
  solana: {
    token: "SOL",
    send_token: "SOL",
    auto_swap: true,
    swap_fee: "0.1–0.3%",
    minimum: "$0.50 equivalent",
    note: "Auto-swapped to Base USDC via Wagyu — manual sweep in v1",
    send_instructions: "Send SOL to this Solana address",
  },
  bitcoin: {
    token: "BTC",
    send_token: "BTC",
    auto_swap: true,
    swap_fee: "0.1–0.5% + BTC mining fee",
    minimum: "~$5 (min Wagyu swap)",
    note: "Auto-swapped to Base USDC via Wagyu — allow 1 confirmation",
    send_instructions: "Send BTC to this native SegWit (bech32) address",
  },
  tron: {
    token: "USDT TRC-20",
    send_token: "USDT",
    auto_swap: false,
    swap_fee: "0%",
    minimum: "$0.50",
    note: "USDT TRC-20 — manual sweep to treasury in v1",
    send_instructions: "Send USDT (TRC-20) on the Tron network to this address",
  },
  monero: {
    token: "XMR",
    send_token: "XMR",
    auto_swap: true,
    swap_fee: "0.1–0.3%",
    minimum: "$0.50 equivalent",
    note: "Private XMR deposits — auto-swapped to Base USDC via Wagyu",
    send_instructions: "Send XMR to this Monero primary address",
  },
};

// ─── Deposit Address ───

auth.post("/deposit-address", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const body = await c.req.json().catch(() => ({})) as { chain?: string };
  const chain = (body.chain ?? "base") as SupportedChain;

  if (!SUPPORTED_CHAINS.includes(chain)) {
    return c.json({
      error: "unsupported_chain",
      supported: SUPPORTED_CHAINS,
      suggestion: "Use 'base' for lowest fees (USDC on Base)",
      chains: SUPPORTED_CHAINS.map(c => ({
        chain: c,
        token: CHAIN_INFO[c].send_token,
        auto_swap: CHAIN_INFO[c].auto_swap,
        swap_fee: CHAIN_INFO[c].swap_fee,
      })),
    }, 400);
  }

  const info = CHAIN_INFO[chain];

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
      send_token: info.send_token,
      send_instructions: info.send_instructions,
      auto_swap: info.auto_swap,
      swap_fee: info.swap_fee,
      minimum: info.minimum,
      note: info.note,
      withdrawals: "USDC on Base only — all deposits converted to USD balance",
    });
  }

  // Monero: derive address deterministically from TREASURY_PRIVATE_KEY + agentId
  // This produces a valid Monero address we can scan with a view key (no wallet service needed).
  if (chain === "monero") {
    const masterKey = process.env.TREASURY_PRIVATE_KEY || "";
    if (!masterKey) {
      return c.json({ error: "xmr_not_configured", message: "XMR deposits not available (missing TREASURY_PRIVATE_KEY)" }, 503);
    }
    const { address: xmrAddress } = deriveXmrDepositKeys(agentId, masterKey);
    db.insert(schema.depositAddresses).values({ agentId, chain, address: xmrAddress }).run();
    return c.json({
      chain,
      address: xmrAddress,
      send_token: info.send_token,
      send_instructions: info.send_instructions,
      auto_swap: info.auto_swap,
      swap_fee: info.swap_fee,
      minimum: info.minimum,
      note: info.note,
      withdrawals: "USDC on Base only — all deposits converted to USD balance",
    }, 201);
  }

  // Request real wallet address from wallet service
  let address: string | undefined;
  try {
    const resp = await fetch(`${WALLET_SERVICE_URL}/v1/wallet/internal/create`, {
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

    const walletData = await resp.json() as { address?: string; addresses?: Array<{chain: string; address: string}> | Record<string, string> };
    const addrList = Array.isArray(walletData.addresses) ? walletData.addresses : [];
    // EVM chains (base, ethereum, bsc, arbitrum) all share the same address
    const evmChains = ["base", "ethereum", "bsc", "arbitrum"];
    const lookupChain = evmChains.includes(chain) && chain !== "ethereum" ? "ethereum" : chain;
    address = addrList.find((a: any) => a.chain === chain)?.address
           || addrList.find((a: any) => a.chain === lookupChain)?.address
           || walletData.address;

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
    send_token: info.send_token,
    send_instructions: info.send_instructions,
    auto_swap: info.auto_swap,
    swap_fee: info.swap_fee,
    minimum: info.minimum,
    note: info.note,
    withdrawals: "USDC on Base only — all deposits converted to USD balance",
  }, 201);
});

// ─── Supported Chains ───

auth.get("/supported-chains", async (c) => {
  return c.json({
    deposits: SUPPORTED_CHAINS.map(chain => ({
      chain,
      send_token: CHAIN_INFO[chain].send_token,
      auto_swap: CHAIN_INFO[chain].auto_swap,
      swap_fee: CHAIN_INFO[chain].swap_fee,
      minimum: CHAIN_INFO[chain].minimum,
      note: CHAIN_INFO[chain].note,
      recommended: chain === "base",
    })),
    withdrawals: [
      { chain: "base", token: "USDC", fee: "$0.50 flat", note: "All withdrawals sent as USDC on Base" },
    ],
    swap_provider: "Wagyu.xyz — cross-chain swaps for all non-Base deposits",
    how_it_works: "Deposit any supported asset → auto-swapped to Base USDC → credited to your balance",
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

  if (!amount || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: "invalid_amount", suggestion: "Amount must be a positive finite number" }, 400);
  }
  if (amount < 1) {
    return c.json({ error: "minimum_withdrawal", minimum: 1.0, suggestion: "Minimum withdrawal is $1.00" }, 400);
  }
  if (amount > 100_000) {
    return c.json({ error: "maximum_withdrawal", maximum: 100000, suggestion: "Maximum single withdrawal is $100,000. Contact support for larger amounts." }, 400);
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
    // Log only the message, not the full error object (may contain sensitive provider data)
    console.error(`[withdraw] On-chain send failed for ${withdrawalId}: ${(err as Error).message}`);

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

// ─── First Deposit Bonus Status ───

auth.get("/deposit-bonus", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;

  const bonus = db.select()
    .from(schema.depositBonuses)
    .where(eq(schema.depositBonuses.agentId, agentId))
    .get();

  const hasMadeDeposit = agent.totalDeposited > 0;

  if (!bonus && !hasMadeDeposit) {
    return c.json({
      status: "available",
      message: "Make your first deposit to claim a 100% match bonus up to $25",
      bonus_offer: {
        match_rate: "100%",
        max_bonus: 25,
        example: "Deposit $25, get $25 bonus = $50 to play with",
        wagering_requirement: "10x the bonus amount before withdrawal",
        example_wagering: "Get $25 bonus → wager $250 across any games to unlock",
      },
      how_to_deposit: "POST /api/v1/auth/deposit-address to get your deposit address",
    });
  }

  if (!bonus && hasMadeDeposit) {
    return c.json({
      status: "not_granted",
      message: "Deposit detected but bonus was not applied (deposit may have been before bonus feature launched)",
      total_deposited: Math.round(agent.totalDeposited * 100) / 100,
    });
  }

  const progressPct = bonus!.wageringRequired > 0
    ? Math.min(100, Math.round((bonus!.wageredSoFar / bonus!.wageringRequired) * 10000) / 100)
    : 100;
  const remaining = Math.max(0, Math.round((bonus!.wageringRequired - bonus!.wageredSoFar) * 100) / 100);

  return c.json({
    status: bonus!.status,
    bonus_id: bonus!.id,
    deposit_amount: Math.round(bonus!.depositAmount * 100) / 100,
    bonus_amount: Math.round(bonus!.bonusAmount * 100) / 100,
    wagering: {
      required: Math.round(bonus!.wageringRequired * 100) / 100,
      completed: Math.round(bonus!.wageredSoFar * 100) / 100,
      remaining,
      progress_pct: progressPct,
    },
    message: bonus!.status === "completed"
      ? "Wagering requirement met! Bonus funds are fully yours — no withdrawal restrictions."
      : bonus!.status === "active"
      ? `Wager $${remaining} more across any games to complete your wagering requirement.`
      : "Bonus expired",
    claimed_at: new Date(bonus!.createdAt * 1000).toISOString(),
    ...(bonus!.completedAt ? { completed_at: new Date(bonus!.completedAt * 1000).toISOString() } : {}),
  });
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
    share_message: "Register at https://casino.purpleflea.com with referral_code: " + agent.referralCode,
  });
});

auth.get("/referral/stats", async (c) => {
  const agentId = c.get("agentId") as string;

  const referrals_list = db
    .select()
    .from(schema.referrals)
    .where(eq(schema.referrals.referrerId, agentId))
    .all();

  // Split by level based on commission rate (L1=10%, L2=5%, L3=2.5%)
  const level1 = referrals_list.filter(r => r.commissionRate >= 0.099);
  const level2 = referrals_list.filter(r => r.commissionRate >= 0.049 && r.commissionRate < 0.099);
  const level3 = referrals_list.filter(r => r.commissionRate < 0.049);

  const totalEarned = referrals_list.reduce((sum, r) => sum + r.totalEarned, 0);
  const earnedL1 = level1.reduce((sum, r) => sum + r.totalEarned, 0);
  const earnedL2 = level2.reduce((sum, r) => sum + r.totalEarned, 0);
  const earnedL3 = level3.reduce((sum, r) => sum + r.totalEarned, 0);

  // 30-day earnings from ledger (credits with reason containing "referral")
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const recentEarnings = db
    .select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(schema.ledgerEntries)
    .where(and(
      eq(schema.ledgerEntries.agentId, agentId),
      eq(schema.ledgerEntries.type, "credit"),
      gte(schema.ledgerEntries.createdAt, thirtyDaysAgo),
      sql`${schema.ledgerEntries.reason} LIKE '%referral%'`,
    ))
    .get();

  return c.json({
    total_referrals: referrals_list.length,
    total_earned_usd: Math.round(totalEarned * 100) / 100,
    last_30_days_usd: Math.round((recentEarnings?.total ?? 0) * 100) / 100,
    by_level: {
      level_1: { count: level1.length, commission: "10%", earned_usd: Math.round(earnedL1 * 100) / 100 },
      level_2: { count: level2.length, commission: "5%", earned_usd: Math.round(earnedL2 * 100) / 100 },
      level_3: { count: level3.length, commission: "2.5%", earned_usd: Math.round(earnedL3 * 100) / 100 },
    },
    grow_tip: level1.length > 0
      ? `${level1.length} direct referral(s). Encourage them to refer more agents for Level 2 income.`
      : "Share your referral code to earn 10% of referred agents' net losses.",
    referrals: referrals_list.map(r => ({
      referred_agent: r.referredId.slice(0, 8) + "...",
      level: r.commissionRate >= 0.099 ? 1 : r.commissionRate >= 0.049 ? 2 : 3,
      commission: `${Math.round(r.commissionRate * 100)}%`,
      earned_usd: Math.round(r.totalEarned * 100) / 100,
      since: new Date(r.createdAt * 1000).toISOString(),
    })),
  });
});

export { auth };
