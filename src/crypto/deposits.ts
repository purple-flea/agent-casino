import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, sql, and } from "drizzle-orm";
import { ledger } from "../wallet/ledger.js";
import { getUsdcBalance, TREASURY_ADDRESS } from "./chain.js";

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || "http://localhost:3002";
const WALLET_SERVICE_KEY = process.env.WALLET_SERVICE_KEY;
if (!WALLET_SERVICE_KEY) console.warn("[WARN] WALLET_SERVICE_KEY not set — deposit sweeps will fail");
const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MIN_DEPOSIT_USD = 0.50;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

// ─── Check all deposit addresses on Base for new USDC deposits ───

async function pollDeposits(): Promise<void> {
  if (running) return; // skip if previous poll still running
  running = true;

  try {
    // Get all Base deposit addresses
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
        // We look for any credited deposit for this agent+chain with the same
        // approximate amount, regardless of age — to prevent re-crediting when
        // the treasury sweep fails and USDC remains on the deposit address.
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
        const amountUsd = Math.round(balance * 100) / 100; // USDC is already USD

        // Record the deposit
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

        // Credit agent balance
        ledger.credit(addr.agentId, amountUsd, "deposit:base:USDC", "deposit", depositId);

        // Update total deposited
        db.update(schema.agents)
          .set({ totalDeposited: sql`${schema.agents.totalDeposited} + ${amountUsd}` })
          .where(eq(schema.agents.id, addr.agentId))
          .run();

        console.log(`[deposit-monitor] Credited $${amountUsd} USDC to ${addr.agentId} from ${addr.address}`);

        // Sweep to treasury via wallet service
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
          // Non-fatal — funds are safe in deposit address, can sweep later.
          // IMPORTANT: Until sweep succeeds the deposit record (status="credited") will
          // prevent re-crediting on subsequent polls. Manual sweep required if this persists.
          console.error(`[deposit-monitor] SWEEP FAILED for ${addr.address} — manual sweep required: ${(sweepErr as Error).message}`);
        }
      } catch (addrErr) {
        // Log and continue to next address
        console.error(`[deposit-monitor] Error checking ${addr.address}:`, addrErr);
      }
    }
  } catch (err) {
    console.error("[deposit-monitor] Poll error:", err);
  } finally {
    running = false;
  }
}

// ─── Start the deposit monitor ───

export function startDepositMonitor(): void {
  console.log(`[deposit-monitor] Starting — polling every ${POLL_INTERVAL_MS / 1000}s for Base USDC deposits`);

  // Initial poll after 10s (let server start first)
  setTimeout(() => {
    pollDeposits();
  }, 10_000);

  // Then every 60s
  timer = setInterval(pollDeposits, POLL_INTERVAL_MS);
}

// ─── Stop the deposit monitor ───

export function stopDepositMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[deposit-monitor] Stopped");
  }
}
