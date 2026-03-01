import { randomUUID } from "crypto";
import { ethers } from "ethers";
import { db, schema } from "../db/index.js";
import { eq, sql, and, isNotNull } from "drizzle-orm";
import { ledger } from "../wallet/ledger.js";
import { getUsdcBalance, TREASURY_ADDRESS, ensureGasForSweep } from "./chain.js";
import { deriveXmrDepositKeys } from "./xmr.js";

// ─── First-deposit bonus constants ───
const FIRST_DEPOSIT_BONUS_RATE = 1.0;  // 100% match
const FIRST_DEPOSIT_BONUS_CAP = 25.0;  // max $25 bonus
const WAGERING_MULTIPLIER = 10;         // must wager 10x bonus before withdrawal

function maybeGrantFirstDepositBonus(agentId: string, depositId: string, depositAmountUsd: number): void {
  // Only for genuinely first deposits: totalDeposited was 0 before this credit
  const agent = db.select({ totalDeposited: schema.agents.totalDeposited })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .get();

  // totalDeposited has already been incremented by this point — so first deposit means it equals depositAmountUsd
  if (!agent || agent.totalDeposited > depositAmountUsd + 0.01) return;

  // Check no bonus has been granted yet (unique index on agent_id prevents double-grant)
  const existing = (db as any).run
    ? null
    : null; // will rely on UNIQUE index constraint

  const bonusAmount = Math.min(
    Math.round(depositAmountUsd * FIRST_DEPOSIT_BONUS_RATE * 100) / 100,
    FIRST_DEPOSIT_BONUS_CAP
  );

  if (bonusAmount < 0.01) return;

  const bonusId = `bonus_${randomUUID().slice(0, 12)}`;
  const wageringRequired = Math.round(bonusAmount * WAGERING_MULTIPLIER * 100) / 100;

  try {
    db.insert(schema.depositBonuses).values({
      id: bonusId,
      agentId,
      depositId,
      depositAmount: depositAmountUsd,
      bonusAmount,
      wageringRequired,
      wageredSoFar: 0,
      status: "active",
    }).run();

    // Credit bonus to balance
    ledger.credit(agentId, bonusAmount, `first_deposit_bonus:${bonusId}`, "casino", bonusId);

    console.log(`[deposit-bonus] Granted $${bonusAmount} first-deposit bonus to ${agentId} (wagering: $${wageringRequired})`);
  } catch (err: any) {
    // UNIQUE constraint violation = bonus already claimed, ignore
    if (!err.message?.includes("UNIQUE")) {
      console.error(`[deposit-bonus] Error granting bonus to ${agentId}:`, err.message);
    }
  }
}

// ─── Config ───

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || "http://localhost:3002";
const WALLET_SERVICE_KEY = process.env.WALLET_SERVICE_KEY;
if (!WALLET_SERVICE_KEY) console.warn("[WARN] WALLET_SERVICE_KEY not set — deposit sweeps will fail");
const WAGYU_API_KEY = process.env.WAGYU_API_KEY || "";
if (!WAGYU_API_KEY) console.warn("[WARN] WAGYU_API_KEY not set — Wagyu swap orders will fail");

// ─── Public-wallet service (for XMR balance checks + sweeps via monero-ts) ───

const PUBLIC_WALLET_URL = process.env.PUBLIC_WALLET_URL || "http://localhost:3005";
const CASINO_XMR_API_KEY = process.env.CASINO_XMR_API_KEY || "";
if (!CASINO_XMR_API_KEY) console.warn("[WARN] CASINO_XMR_API_KEY not set — XMR deposit detection will fail");

const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || "";

const POLL_INTERVAL_MS = 60_000;         // 60 seconds — Base USDC
const NON_BASE_POLL_INTERVAL_MS = 90_000; // 90 seconds — non-Base chains (EVM/BTC/SOL/Tron)
const WAGYU_POLL_INTERVAL_MS = 30_000;   // 30 seconds — pending Wagyu swaps
const XMR_POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes — XMR (sync takes ~10s per address)
const MIN_DEPOSIT_USD = 0.50;

// ─── Supported non-Base deposit chains ───

export const SUPPORTED_DEPOSIT_CHAINS = [
  "ethereum", "bsc", "arbitrum", "solana", "bitcoin", "tron", "monero",
] as const;

type NonBaseChain = typeof SUPPORTED_DEPOSIT_CHAINS[number];

// EVM chains with full Wagyu auto-swap support
const EVM_SWAP_CHAINS: NonBaseChain[] = ["ethereum", "bsc", "arbitrum"];

// RPC URLs for non-Base EVM chains
const EVM_RPC: Record<string, string> = {
  ethereum: "https://ethereum.publicnode.com",
  bsc: "https://bsc-dataseed.binance.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};

// ERC-20 token addresses on non-Base EVM chains
const EVM_TOKENS: Record<string, Record<string, string>> = {
  ethereum: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  bsc: {
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  arbitrum: {
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  },
};

// Wagyu chain IDs
const WAGYU_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  base: 8453,
  arbitrum: 42161,
  solana: 1151111081099710,
  bitcoin: 20000000000001,
  monero: 0,
};

// Base USDC address (Wagyu destination token)
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Minimum raw deposit thresholds per chain (to filter dust)
const MIN_NATIVE_WEI = ethers.parseEther("0.002"); // 0.002 ETH/BNB
const MIN_ERC20_RAW = 500000n; // 0.5 USDC/USDT (6 decimals)

// ─── EVM deposit detection ───

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

interface EvmDepositInfo {
  amountRaw: bigint;
  token: string;       // symbol
  tokenAddress: string; // contract address or "ETH"/"BNB"
  decimals: number;
  amountUsd: number;   // approximate (using ETH price if needed)
}

async function detectEvmDeposit(chain: string, address: string): Promise<EvmDepositInfo | null> {
  try {
    const provider = new ethers.JsonRpcProvider(EVM_RPC[chain]);

    // Check ERC-20 USDC/USDT first (already USD-denominated, easiest to value)
    const tokens = EVM_TOKENS[chain] ?? {};
    for (const [symbol, tokenAddr] of Object.entries(tokens)) {
      const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
      const balance: bigint = await contract.balanceOf(address);
      if (balance >= MIN_ERC20_RAW) {
        const amountUsd = Number(balance) / 1e6; // USDC/USDT both have 6 decimals
        return { amountRaw: balance, token: symbol, tokenAddress: tokenAddr, decimals: 6, amountUsd };
      }
    }

    // Check native ETH/BNB
    const nativeBalance = await provider.getBalance(address);
    if (nativeBalance >= MIN_NATIVE_WEI) {
      const nativeToken = chain === "bsc" ? "BNB" : "ETH";
      // Rough USD value using public price API
      const priceUsd = await getNativeTokenPrice(nativeToken);
      const amountUsd = parseFloat(ethers.formatEther(nativeBalance)) * priceUsd;
      if (amountUsd >= MIN_DEPOSIT_USD) {
        return { amountRaw: nativeBalance, token: nativeToken, tokenAddress: "native", decimals: 18, amountUsd };
      }
    }

    return null;
  } catch (err) {
    console.error(`[deposit-monitor] EVM balance check failed for ${chain}:${address}:`, (err as Error).message);
    return null;
  }
}

// ─── Bitcoin deposit detection ───

async function detectBitcoinDeposit(address: string): Promise<number | null> {
  try {
    const res = await fetch(`https://mempool.space/api/address/${address}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const sats =
      (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0) +
      (data.mempool_stats?.funded_txo_sum ?? 0) - (data.mempool_stats?.spent_txo_sum ?? 0);
    return sats / 1e8; // BTC
  } catch {
    return null;
  }
}

// ─── Solana deposit detection ───

async function detectSolanaDeposit(address: string): Promise<number | null> {
  try {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(WAGYU_API_KEY ? { "X-API-KEY": WAGYU_API_KEY } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return (data.result?.value ?? 0) / 1e9; // lamports → SOL
  } catch {
    return null;
  }
}

// ─── Tron deposit detection (USDT TRC-20) ───

async function detectTronDeposit(address: string): Promise<number | null> {
  try {
    // USDT TRC-20 contract: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
    const res = await fetch(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.data?.length) return null;

    // Sum unspent USDT (simplified — balance check)
    const balRes = await fetch(`https://api.trongrid.io/v1/accounts/${address}`, { signal: AbortSignal.timeout(10_000) });
    if (!balRes.ok) return null;
    const balData = await balRes.json() as any;
    const trc20 = balData.data?.[0]?.trc20 ?? [];
    const usdt = trc20.find((t: any) => t["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]);
    if (!usdt) return null;
    return Number(usdt["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]) / 1e6;
  } catch {
    return null;
  }
}

// ─── Price fetching (for native tokens) ───

const _priceCache: Record<string, { price: number; fetchedAt: number }> = {};
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getNativeTokenPrice(symbol: string): Promise<number> {
  const cached = _priceCache[symbol];
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL) return cached.price;

  const coinMap: Record<string, string> = { ETH: "ethereum", BNB: "binancecoin", SOL: "solana", BTC: "bitcoin", XMR: "monero" };
  const coinId = coinMap[symbol];
  if (!coinId) return 0;

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return _priceCache[symbol]?.price ?? 0;
    const data = await res.json() as any;
    const price = data[coinId]?.usd ?? 0;
    _priceCache[symbol] = { price, fetchedAt: Date.now() };
    return price;
  } catch {
    return _priceCache[symbol]?.price ?? 0;
  }
}

// ─── Wagyu swap API ───

interface WagyuOrder {
  orderId: string;
  depositAddress: string;
  depositChain: string;
  depositToken: string;
  depositTokenSymbol: string;
  depositAmount: string;
  expectedOutput: string; // raw USDC (6 decimals)
  expiresAt: string;
  status: string;
}

async function createWagyuOrder(
  fromChain: string,
  fromToken: string,    // symbol or ERC-20 address
  fromAmountRaw: bigint,
): Promise<WagyuOrder | null> {
  const fromChainId = WAGYU_CHAIN_IDS[fromChain];
  if (fromChainId === undefined) {
    console.error(`[wagyu] No chain ID for ${fromChain}`);
    return null;
  }

  try {
    const body = {
      fromChainId,
      toChainId: WAGYU_CHAIN_IDS.base,
      fromToken,
      toToken: BASE_USDC_ADDRESS,
      fromAmount: fromAmountRaw.toString(),
      toAddress: TREASURY_ADDRESS,
    };

    const res = await fetch("https://api.wagyu.xyz/v1/order", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(WAGYU_API_KEY ? { "X-API-KEY": WAGYU_API_KEY } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[wagyu] Order creation failed (${res.status}): ${errText}`);
      return null;
    }

    return await res.json() as WagyuOrder;
  } catch (err) {
    console.error(`[wagyu] Order creation error:`, (err as Error).message);
    return null;
  }
}

async function checkWagyuStatus(orderId: string): Promise<{ status: string; outputAmount?: string } | null> {
  try {
    const res = await fetch(`https://api.wagyu.xyz/v1/order/${orderId}`, {
      headers: WAGYU_API_KEY ? { "X-API-KEY": WAGYU_API_KEY } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return { status: data.status, outputAmount: data.outputAmount ?? data.expectedOutput };
  } catch {
    return null;
  }
}

// ─── Wallet service sweep ───

async function sweepViaWalletService(
  agentId: string,
  chain: string,
  toAddress: string,
  token: string,
  amountRaw: bigint,
): Promise<boolean> {
  try {
    const resp = await fetch(`${WALLET_SERVICE_URL}/v1/wallet/sweep`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": WALLET_SERVICE_KEY!,
      },
      body: JSON.stringify({
        agent_id: agentId,
        chain,
        to_address: toAddress,
        token,
        amount: amountRaw.toString(),
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      console.error(`[sweep] Wallet service sweep failed for ${agentId} on ${chain}:`, err.error ?? err.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[sweep] Wallet service unreachable:`, (err as Error).message);
    return false;
  }
}

// ─── XMR deposit detection via public-wallet (monero-ts WASM) ───

/**
 * Check XMR balance for a deposit address using the public-wallet service.
 * The public-wallet has monero-ts WASM and handles the view-key scanning.
 * Returns piconero balance (1 XMR = 1e12 piconero), or null on error.
 */
async function detectXmrBalance(address: string, viewKey: string): Promise<bigint | null> {
  if (!CASINO_XMR_API_KEY) return null;
  try {
    const res = await fetch(
      `${PUBLIC_WALLET_URL}/v1/wallet/balance/${encodeURIComponent(address)}?chain=monero&view_key=${viewKey}`,
      {
        headers: { "Authorization": `Bearer ${CASINO_XMR_API_KEY}` },
        signal: AbortSignal.timeout(35_000), // XMR sync takes ~10s on first call
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "(unreadable)");
      console.error(`[xmr-detect] Balance check failed (${res.status}): ${err.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as any;
    const piconero = data.balance?.native?.piconero;
    if (!piconero) return 0n;
    return BigInt(piconero);
  } catch (err) {
    console.error(`[xmr-detect] Error checking ${address.slice(0, 20)}...:`, (err as Error).message);
    return null;
  }
}

/**
 * Sweep XMR from a deposit address to a Wagyu deposit address.
 * Uses the public-wallet service's /v1/wallet/send endpoint (monero-ts WASM).
 * Returns tx hash on success, null on failure.
 */
async function sweepXmrToWagyu(
  fromAddress: string,
  viewKey: string,
  spendKey: string,
  toAddress: string,
  amountXmr: string,
): Promise<string | null> {
  if (!CASINO_XMR_API_KEY) return null;
  try {
    const res = await fetch(`${PUBLIC_WALLET_URL}/v1/wallet/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CASINO_XMR_API_KEY}`,
      },
      body: JSON.stringify({
        chain: "monero",
        from: fromAddress,
        to: toAddress,
        amount: amountXmr,
        view_key: viewKey,
        spend_key: spendKey,
      }),
      signal: AbortSignal.timeout(90_000), // XMR sends sync wallet first (~10s) then broadcast
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "(unreadable)");
      console.error(`[xmr-sweep] Send failed (${res.status}): ${err.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as any;
    return data.tx_hash ?? null;
  } catch (err) {
    console.error(`[xmr-sweep] Error:`, (err as Error).message);
    return null;
  }
}

// ─── Credit helper (shared between Base and non-Base flows) ───

function creditDeposit(
  agentId: string,
  depositId: string,
  chain: string,
  token: string,
  amountRaw: number,
  amountUsd: number,
  swapFee: number,
  txHash: string,
  wagyuTx?: string,
): void {
  const existing = db.select({ id: schema.deposits.id })
    .from(schema.deposits)
    .where(eq(schema.deposits.id, depositId))
    .get();

  if (existing) {
    // Update to credited
    db.update(schema.deposits)
      .set({ status: "credited", creditedAt: Math.floor(Date.now() / 1000) })
      .where(eq(schema.deposits.id, depositId))
      .run();
  } else {
    db.insert(schema.deposits).values({
      id: depositId,
      agentId,
      chain,
      token,
      amountRaw,
      amountUsd,
      swapFee,
      txHash,
      wagyuTx,
      status: "credited",
      confirmations: 1,
      creditedAt: Math.floor(Date.now() / 1000),
    }).run();
  }

  ledger.credit(agentId, amountUsd, `deposit:${chain}:${token}`, "deposit", depositId);

  db.update(schema.agents)
    .set({ totalDeposited: sql`${schema.agents.totalDeposited} + ${amountUsd}` })
    .where(eq(schema.agents.id, agentId))
    .run();

  maybeGrantFirstDepositBonus(agentId, depositId, amountUsd);

  console.log(`[deposit-monitor] Credited $${amountUsd.toFixed(2)} (${chain} ${token}) to ${agentId}`);
}

// ─── Check all deposit addresses on Base for new USDC deposits ───

let baseRunning = false;

async function pollBaseDeposits(): Promise<void> {
  if (baseRunning) return;
  baseRunning = true;

  try {
    const addresses = db
      .select()
      .from(schema.depositAddresses)
      .where(eq(schema.depositAddresses.chain, "base"))
      .all();

    for (const addr of addresses) {
      try {
        const balance = await getUsdcBalance(addr.address);

        if (balance < MIN_DEPOSIT_USD) continue;

        // Check if we already credited this address for the current balance.
        const existingCreditedDeposit = db
          .select()
          .from(schema.deposits)
          .where(
            and(
              eq(schema.deposits.agentId, addr.agentId),
              eq(schema.deposits.chain, "base"),
              eq(schema.deposits.status, "credited"),
            )
          )
          .all()
          .find((d) => Math.abs(d.amountUsd - balance) < 0.01);

        if (existingCreditedDeposit) continue;

        const depositId = `dep_${randomUUID().slice(0, 12)}`;
        const amountUsd = Math.round(balance * 100) / 100;

        db.insert(schema.deposits).values({
          id: depositId,
          agentId: addr.agentId,
          chain: "base",
          token: "USDC",
          amountRaw: balance,
          amountUsd,
          swapFee: 0,
          txHash: `poll_${Date.now()}`,
          status: "credited",
          confirmations: 1,
          creditedAt: Math.floor(Date.now() / 1000),
        }).run();

        ledger.credit(addr.agentId, amountUsd, "deposit:base:USDC", "deposit", depositId);

        db.update(schema.agents)
          .set({ totalDeposited: sql`${schema.agents.totalDeposited} + ${amountUsd}` })
          .where(eq(schema.agents.id, addr.agentId))
          .run();

        maybeGrantFirstDepositBonus(addr.agentId, depositId, amountUsd);

        console.log(`[deposit-monitor] Credited $${amountUsd} USDC to ${addr.agentId} from ${addr.address}`);

        // Ensure gas for sweep, then sweep to treasury
        try {
          await ensureGasForSweep(addr.address);
        } catch (gasErr) {
          console.warn(`[deposit-monitor] Gas top-up failed for ${addr.address}: ${(gasErr as Error).message}`);
        }

        try {
          await fetch(`${WALLET_SERVICE_URL}/v1/wallet/sweep`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Service-Key": WALLET_SERVICE_KEY!,
            },
            body: JSON.stringify({
              from_address: addr.address,
              to_address: TREASURY_ADDRESS,
              chain: "base",
              token: "USDC",
            }),
          });
          console.log(`[deposit-monitor] Sweep requested for ${addr.address} → treasury`);
        } catch (sweepErr) {
          console.error(`[deposit-monitor] SWEEP FAILED for ${addr.address} — manual sweep required: ${(sweepErr as Error).message}`);
        }
      } catch (addrErr) {
        console.error(`[deposit-monitor] Error checking ${addr.address}:`, addrErr);
      }
    }
  } catch (err) {
    console.error("[deposit-monitor] Base poll error:", err);
  } finally {
    baseRunning = false;
  }
}

// ─── Poll non-Base EVM chains (ethereum, bsc, arbitrum) ───

let nonBaseRunning = false;

async function pollNonBaseDeposits(): Promise<void> {
  if (nonBaseRunning) return;
  nonBaseRunning = true;

  try {
    for (const chain of SUPPORTED_DEPOSIT_CHAINS) {
      const addresses = db
        .select()
        .from(schema.depositAddresses)
        .where(eq(schema.depositAddresses.chain, chain))
        .all();

      for (const addr of addresses) {
        try {
          await detectAndQueueDeposit(chain, addr.agentId, addr.address);
        } catch (err) {
          console.error(`[deposit-monitor] Error checking ${chain}:${addr.address}:`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    console.error("[deposit-monitor] Non-base poll error:", err);
  } finally {
    nonBaseRunning = false;
  }
}

async function detectAndQueueDeposit(chain: NonBaseChain, agentId: string, address: string): Promise<void> {
  // ── EVM chains (ethereum, bsc, arbitrum) ──
  if (EVM_SWAP_CHAINS.includes(chain as any)) {
    const deposit = await detectEvmDeposit(chain, address);
    if (!deposit || deposit.amountUsd < MIN_DEPOSIT_USD) return;

    // Check for existing pending or credited deposit for this amount
    const existing = db
      .select()
      .from(schema.deposits)
      .where(and(
        eq(schema.deposits.agentId, agentId),
        eq(schema.deposits.chain, chain),
      ))
      .all()
      .find((d) => Math.abs(d.amountRaw - Number(deposit.amountRaw)) < Number(deposit.amountRaw) * 0.01);

    if (existing) return; // already processing or credited

    console.log(`[deposit-monitor] Detected ${ethers.formatUnits(deposit.amountRaw, deposit.decimals)} ${deposit.token} on ${chain} for ${agentId}`);

    // Create Wagyu swap order
    const order = await createWagyuOrder(
      chain,
      deposit.tokenAddress === "native" ? deposit.token : deposit.tokenAddress,
      deposit.amountRaw,
    );

    if (!order) {
      console.error(`[deposit-monitor] Failed to create Wagyu order for ${agentId} ${chain} deposit`);
      return;
    }

    const depositId = `dep_${randomUUID().slice(0, 12)}`;
    const expectedUsd = Number(order.expectedOutput) / 1e6;
    const swapFee = Math.max(0, deposit.amountUsd - expectedUsd);

    // Record as pending with Wagyu order ID
    db.insert(schema.deposits).values({
      id: depositId,
      agentId,
      chain,
      token: deposit.token,
      amountRaw: Number(deposit.amountRaw),
      amountUsd: expectedUsd,
      swapFee: Math.round(swapFee * 100) / 100,
      txHash: `wagyu_order_${order.orderId}`,
      wagyuTx: order.orderId,
      status: "pending",
      confirmations: 0,
    }).run();

    console.log(`[deposit-monitor] Wagyu order ${order.orderId} created — sweeping ${deposit.token} to Wagyu`);

    // Sweep from deposit address to Wagyu's deposit address
    const swept = await sweepViaWalletService(
      agentId,
      chain,
      order.depositAddress,
      deposit.tokenAddress === "native" ? deposit.token : deposit.tokenAddress,
      deposit.amountRaw,
    );

    if (!swept) {
      console.error(`[deposit-monitor] Sweep failed for deposit ${depositId} — Wagyu order may expire`);
    }

    return;
  }

  // ── Bitcoin ──
  if (chain === "bitcoin") {
    const btcAmount = await detectBitcoinDeposit(address);
    if (btcAmount === null || btcAmount < 0.00005) return; // < ~$3 at any reasonable BTC price
    const priceUsd = await getNativeTokenPrice("BTC");
    const amountUsd = btcAmount * priceUsd;
    if (amountUsd < MIN_DEPOSIT_USD) return;

    const existing = db.select().from(schema.deposits)
      .where(and(eq(schema.deposits.agentId, agentId), eq(schema.deposits.chain, "bitcoin")))
      .all().find(d => Math.abs(d.amountRaw - btcAmount) < btcAmount * 0.01);
    if (existing) return;

    console.log(`[deposit-monitor] BTC deposit detected: ${btcAmount} BTC (~$${amountUsd.toFixed(2)}) for ${agentId} — requires manual Wagyu swap`);
    // Record as pending — manual intervention needed until BTC signing is implemented
    db.insert(schema.deposits).values({
      id: `dep_${randomUUID().slice(0, 12)}`,
      agentId,
      chain: "bitcoin",
      token: "BTC",
      amountRaw: btcAmount,
      amountUsd: Math.round(amountUsd * 100) / 100,
      swapFee: 0,
      txHash: `pending_btc_${Date.now()}`,
      status: "pending",
      confirmations: 0,
    }).run();
    return;
  }

  // ── Solana ──
  if (chain === "solana") {
    const solAmount = await detectSolanaDeposit(address);
    if (solAmount === null || solAmount < 0.01) return;
    const priceUsd = await getNativeTokenPrice("SOL");
    const amountUsd = solAmount * priceUsd;
    if (amountUsd < MIN_DEPOSIT_USD) return;

    const existing = db.select().from(schema.deposits)
      .where(and(eq(schema.deposits.agentId, agentId), eq(schema.deposits.chain, "solana")))
      .all().find(d => Math.abs(d.amountRaw - solAmount) < solAmount * 0.01);
    if (existing) return;

    console.log(`[deposit-monitor] SOL deposit detected: ${solAmount} SOL (~$${amountUsd.toFixed(2)}) for ${agentId} — requires manual Wagyu swap`);
    db.insert(schema.deposits).values({
      id: `dep_${randomUUID().slice(0, 12)}`,
      agentId,
      chain: "solana",
      token: "SOL",
      amountRaw: solAmount,
      amountUsd: Math.round(amountUsd * 100) / 100,
      swapFee: 0,
      txHash: `pending_sol_${Date.now()}`,
      status: "pending",
      confirmations: 0,
    }).run();
    return;
  }

  // ── Tron (USDT TRC-20) ──
  if (chain === "tron") {
    const usdtAmount = await detectTronDeposit(address);
    if (usdtAmount === null || usdtAmount < MIN_DEPOSIT_USD) return;

    const existing = db.select().from(schema.deposits)
      .where(and(eq(schema.deposits.agentId, agentId), eq(schema.deposits.chain, "tron")))
      .all().find(d => Math.abs(d.amountRaw - usdtAmount) < usdtAmount * 0.01);
    if (existing) return;

    console.log(`[deposit-monitor] USDT TRC-20 deposit detected: $${usdtAmount} for ${agentId} — requires manual sweep`);
    db.insert(schema.deposits).values({
      id: `dep_${randomUUID().slice(0, 12)}`,
      agentId,
      chain: "tron",
      token: "USDT",
      amountRaw: usdtAmount,
      amountUsd: Math.round(usdtAmount * 100) / 100,
      swapFee: 0,
      txHash: `pending_tron_${Date.now()}`,
      status: "pending",
      confirmations: 0,
    }).run();
    return;
  }

  // ── Monero — handled by pollXmrDeposits (separate timer, slow ~10s sync)
  // Not processed here to avoid blocking the non-base polling loop.
}

// ─── Poll pending Wagyu orders and credit on completion ───

let wagyuRunning = false;

async function checkPendingWagyuSwaps(): Promise<void> {
  if (wagyuRunning) return;
  wagyuRunning = true;

  try {
    const pending = db
      .select()
      .from(schema.deposits)
      .where(
        and(
          eq(schema.deposits.status, "pending"),
          isNotNull(schema.deposits.wagyuTx),
        )
      )
      .all()
      .filter(d => d.wagyuTx?.startsWith("wagyu_order_") === false && d.wagyuTx != null && !d.wagyuTx.startsWith("pending_"));

    for (const deposit of pending) {
      try {
        const statusResult = await checkWagyuStatus(deposit.wagyuTx!);
        if (!statusResult) continue;

        const { status, outputAmount } = statusResult;

        if (status === "completed" || status === "success") {
          // Parse actual USDC received
          const usdReceived = outputAmount
            ? Math.round((Number(outputAmount) / 1e6) * 100) / 100
            : deposit.amountUsd;

          const originalUsd = deposit.amountRaw; // for stable coins, amountRaw ≈ amountUsd
          const swapFee = Math.max(0, Math.round((deposit.amountUsd - usdReceived) * 100) / 100);

          creditDeposit(
            deposit.agentId,
            deposit.id,
            deposit.chain,
            deposit.token,
            deposit.amountRaw,
            usdReceived,
            swapFee,
            deposit.txHash,
            deposit.wagyuTx ?? undefined,
          );

          console.log(`[wagyu] Swap ${deposit.wagyuTx} completed — credited $${usdReceived} to ${deposit.agentId}`);

        } else if (status === "failed" || status === "expired" || status === "refunded") {
          console.warn(`[wagyu] Swap ${deposit.wagyuTx} ${status} — marking deposit as failed`);
          db.update(schema.deposits)
            .set({ status: "failed" })
            .where(eq(schema.deposits.id, deposit.id))
            .run();
        }
        // else: still pending/processing — wait
      } catch (err) {
        console.error(`[wagyu] Status check error for ${deposit.wagyuTx}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[wagyu] Pending swap check error:", err);
  } finally {
    wagyuRunning = false;
  }
}

// ─── XMR deposit polling (separate timer — monero-ts sync takes ~10s per address) ───

let xmrRunning = false;

export async function pollXmrDeposits(): Promise<void> {
  if (xmrRunning) return;
  if (!CASINO_XMR_API_KEY) return; // silently skip if not configured
  xmrRunning = true;

  try {
    const addresses = db
      .select()
      .from(schema.depositAddresses)
      .where(eq(schema.depositAddresses.chain, "monero"))
      .all();

    for (const addr of addresses) {
      try {
        await detectAndQueueXmrDeposit(addr.agentId, addr.address);
      } catch (err) {
        console.error(`[xmr-poll] Error for ${addr.agentId}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[xmr-poll] Poll error:", err);
  } finally {
    xmrRunning = false;
  }
}

async function detectAndQueueXmrDeposit(agentId: string, storedAddress: string): Promise<void> {
  if (!TREASURY_PRIVATE_KEY) {
    console.warn("[xmr-poll] TREASURY_PRIVATE_KEY not set — cannot derive XMR keys");
    return;
  }

  const { address: derivedAddress, privateViewKey, privateSpendKey } = deriveXmrDepositKeys(agentId, TREASURY_PRIVATE_KEY);

  // Fix invalid/legacy addresses generated by the old wallet service derivation
  if (storedAddress !== derivedAddress) {
    db.update(schema.depositAddresses)
      .set({ address: derivedAddress })
      .where(and(
        eq(schema.depositAddresses.agentId, agentId),
        eq(schema.depositAddresses.chain, "monero"),
      ))
      .run();
    console.log(`[xmr-poll] Fixed XMR deposit address for ${agentId} → ${derivedAddress.slice(0, 20)}...`);
    return; // Check balance next poll cycle with corrected address
  }

  // Check XMR balance via public-wallet (uses monero-ts WASM + public node)
  const piconero = await detectXmrBalance(derivedAddress, privateViewKey);
  if (piconero === null || piconero === 0n) return;

  const xmrAmount = Number(piconero) / 1e12;
  const priceUsd = await getNativeTokenPrice("XMR");
  const amountUsd = xmrAmount * (priceUsd || 150); // fallback $150 if CoinGecko down
  if (amountUsd < MIN_DEPOSIT_USD) return;

  // Skip if already processing or credited a deposit of this size
  const existing = db
    .select()
    .from(schema.deposits)
    .where(and(eq(schema.deposits.agentId, agentId), eq(schema.deposits.chain, "monero")))
    .all()
    .find(d => d.status !== "failed" && Math.abs(d.amountRaw - xmrAmount) < xmrAmount * 0.01);
  if (existing) return;

  console.log(`[xmr-poll] XMR deposit detected: ${xmrAmount.toFixed(6)} XMR (~$${amountUsd.toFixed(2)}) for ${agentId}`);

  // Create Wagyu swap order: XMR → Base USDC → Treasury
  const order = await createWagyuOrder("monero", "XMR", piconero);
  if (!order) {
    console.error(`[xmr-poll] Wagyu order failed for ${agentId} — will retry next cycle`);
    return;
  }

  const depositId = `dep_${randomUUID().slice(0, 12)}`;
  const expectedUsd = Number(order.expectedOutput) / 1e6;
  const swapFee = Math.max(0, Math.round((amountUsd - expectedUsd) * 100) / 100);

  db.insert(schema.deposits).values({
    id: depositId,
    agentId,
    chain: "monero",
    token: "XMR",
    amountRaw: xmrAmount,
    amountUsd: Math.round(expectedUsd * 100) / 100,
    swapFee,
    txHash: `xmr_sweep_pending_${Date.now()}`,
    wagyuTx: order.orderId,
    status: "pending",
    confirmations: 0,
  }).run();

  console.log(`[xmr-poll] Wagyu order ${order.orderId} created — sweeping ${xmrAmount.toFixed(6)} XMR to ${order.depositAddress.slice(0, 20)}...`);

  // Sweep XMR from deposit address to Wagyu's deposit address
  const txHash = await sweepXmrToWagyu(
    derivedAddress,
    privateViewKey,
    privateSpendKey,
    order.depositAddress,
    xmrAmount.toFixed(12),
  );

  if (txHash) {
    db.update(schema.deposits)
      .set({ txHash })
      .where(eq(schema.deposits.id, depositId))
      .run();
    console.log(`[xmr-poll] XMR swept to Wagyu: ${txHash}`);
  } else {
    console.error(`[xmr-poll] XMR sweep failed for deposit ${depositId} — Wagyu order ${order.orderId} may expire`);
  }
}

// ─── Timer handles ───

let baseTimer: ReturnType<typeof setInterval> | null = null;
let nonBaseTimer: ReturnType<typeof setInterval> | null = null;
let wagyuTimer: ReturnType<typeof setInterval> | null = null;
let xmrTimer: ReturnType<typeof setInterval> | null = null;

// ─── Start the deposit monitor ───

export function startDepositMonitor(): void {
  console.log(`[deposit-monitor] Starting — polling Base USDC every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[deposit-monitor] Non-Base chains: ${SUPPORTED_DEPOSIT_CHAINS.join(", ")} — polling every ${NON_BASE_POLL_INTERVAL_MS / 1000}s`);
  console.log(`[deposit-monitor] XMR polling every ${XMR_POLL_INTERVAL_MS / 1000}s — ${CASINO_XMR_API_KEY ? "enabled" : "DISABLED (CASINO_XMR_API_KEY not set)"}`);

  // Initial Base poll after 10s
  setTimeout(() => pollBaseDeposits(), 10_000);
  baseTimer = setInterval(pollBaseDeposits, POLL_INTERVAL_MS);

  // Initial non-Base poll after 30s (stagger from Base)
  setTimeout(() => pollNonBaseDeposits(), 30_000);
  nonBaseTimer = setInterval(pollNonBaseDeposits, NON_BASE_POLL_INTERVAL_MS);

  // Wagyu pending swap checker — after 20s, then every 30s
  setTimeout(() => checkPendingWagyuSwaps(), 20_000);
  wagyuTimer = setInterval(checkPendingWagyuSwaps, WAGYU_POLL_INTERVAL_MS);

  // XMR polling moved to separate casino-xmr pm2 process (xmr-monitor.ts)
  // This keeps XMR sync CPU/memory isolated from the main casino process.
}

// ─── Stop the deposit monitor ───

export function stopDepositMonitor(): void {
  [baseTimer, nonBaseTimer, wagyuTimer, xmrTimer].forEach(t => t && clearInterval(t));
  baseTimer = nonBaseTimer = wagyuTimer = xmrTimer = null;
  console.log("[deposit-monitor] Stopped");
}
