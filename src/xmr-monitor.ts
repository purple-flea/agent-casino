/**
 * XMR deposit monitor — standalone pm2 process (casino-xmr).
 *
 * Runs in a separate process from the main casino to isolate the CPU and
 * memory spikes from monero-ts WASM sync cycles. Results are written to
 * the shared SQLite DB (casino.db) so the main process picks them up on
 * the next ledger credit pass.
 *
 * Communication: SQLite (deposits table) — same DB as the main casino process.
 * No IPC needed; writes are visible to the main process immediately.
 */

import { pollXmrDeposits } from "./crypto/deposits.js";

const XMR_POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes — matches main monitor setting

const CASINO_XMR_API_KEY = process.env.CASINO_XMR_API_KEY || "";

if (!CASINO_XMR_API_KEY) {
  console.warn("[xmr-monitor] CASINO_XMR_API_KEY not set — XMR polling will be skipped");
}

console.log(`[xmr-monitor] Starting — XMR deposit polling every ${XMR_POLL_INTERVAL_MS / 1000}s`);

// Initial poll after 30s (allow daemon connection to warm up)
setTimeout(async () => {
  console.log("[xmr-monitor] Running initial XMR poll...");
  await pollXmrDeposits().catch((err: Error) =>
    console.error("[xmr-monitor] Initial poll error:", err.message)
  );
}, 30_000);

// Recurring poll
setInterval(async () => {
  console.log("[xmr-monitor] Running scheduled XMR poll...");
  await pollXmrDeposits().catch((err: Error) =>
    console.error("[xmr-monitor] Poll error:", err.message)
  );
}, XMR_POLL_INTERVAL_MS);
