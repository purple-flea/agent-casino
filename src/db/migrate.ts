import { sqlite } from "./index.js";

// Inline migration — creates all tables if they don't exist
const migrations = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  api_key_hash TEXT UNIQUE NOT NULL,
  balance_usd REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'free',
  risk_factor REAL NOT NULL DEFAULT 0.25,
  total_deposited REAL NOT NULL DEFAULT 0,
  total_withdrawn REAL NOT NULL DEFAULT 0,
  total_wagered REAL NOT NULL DEFAULT 0,
  total_won REAL NOT NULL DEFAULT 0,
  total_spent REAL NOT NULL DEFAULT 0,
  deposit_index INTEGER UNIQUE NOT NULL,
  referred_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_active INTEGER
);

CREATE TABLE IF NOT EXISTS deposit_addresses (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (agent_id, chain)
);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_raw REAL NOT NULL,
  amount_usd REAL NOT NULL,
  swap_fee REAL NOT NULL DEFAULT 0,
  tx_hash TEXT NOT NULL,
  wagyu_tx TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  confirmations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  credited_at INTEGER
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount REAL NOT NULL,
  fee REAL NOT NULL,
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  address TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT,
  service TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  game TEXT NOT NULL,
  amount REAL NOT NULL,
  payout_multiplier REAL NOT NULL,
  result TEXT NOT NULL,
  won INTEGER NOT NULL,
  amount_won REAL NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed TEXT,
  nonce INTEGER NOT NULL,
  result_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS server_seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  current_nonce INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  revealed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS referrals (
  referrer_id TEXT NOT NULL REFERENCES agents(id),
  referred_id TEXT NOT NULL REFERENCES agents(id),
  commission_rate REAL NOT NULL DEFAULT 0.10,
  total_earned REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (referrer_id, referred_id)
);

CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  treasury_balance REAL NOT NULL,
  total_agent_balances REAL NOT NULL,
  reserve_ratio REAL NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_deposits_agent ON deposits(agent_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_tx ON deposits(tx_hash, chain);
CREATE INDEX IF NOT EXISTS idx_ledger_agent ON ledger_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_bets_agent ON bets(agent_id);
CREATE INDEX IF NOT EXISTS idx_bets_game ON bets(game);
CREATE INDEX IF NOT EXISTS idx_bets_created ON bets(created_at);
`;

export function runMigrations() {
  sqlite.exec(migrations);
}

// Add referral_code column if missing
try {
  sqlite.exec("ALTER TABLE agents ADD COLUMN referral_code TEXT");
  console.log("[migrate] Added referral_code column");
} catch (e: any) {
  if (!e.message?.includes("duplicate column")) throw e;
}

// Add unique index on referral_code
try {
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_referral_code ON agents(referral_code) WHERE referral_code IS NOT NULL");
  console.log("[migrate] Added referral_code unique index");
} catch (e: any) {
  // Index may already exist
}

// Backfill existing agents without referral codes
import { randomBytes } from "crypto";
const rows = sqlite.prepare("SELECT id FROM agents WHERE referral_code IS NULL").all() as any[];
for (const row of rows) {
  const code = `ref_${randomBytes(4).toString("hex")}`;
  sqlite.prepare("UPDATE agents SET referral_code = ? WHERE id = ?").run(code, row.id);
}
if (rows.length > 0) console.log(`[migrate] Backfilled ${rows.length} referral codes`);
