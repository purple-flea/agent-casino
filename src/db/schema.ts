import { sqliteTable, text, real, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

// ─── Agents (shared across wallet + casino) ───

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  apiKeyHash: text("api_key_hash").unique().notNull(),
  balanceUsd: real("balance_usd").default(0).notNull(),
  tier: text("tier").default("free").notNull(),
  riskFactor: real("risk_factor").default(0.25).notNull(),
  totalDeposited: real("total_deposited").default(0).notNull(),
  totalWithdrawn: real("total_withdrawn").default(0).notNull(),
  totalWagered: real("total_wagered").default(0).notNull(),
  totalWon: real("total_won").default(0).notNull(),
  totalSpent: real("total_spent").default(0).notNull(),
  depositIndex: integer("deposit_index").unique().notNull(),
  referralCode: text("referral_code"),
  referredBy: text("referred_by"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  lastActive: integer("last_active"),
});

// ─── Deposit Addresses ───

export const depositAddresses = sqliteTable("deposit_addresses", {
  agentId: text("agent_id").notNull().references(() => agents.id),
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.chain] }),
]);

// ─── Deposits ───

export const deposits = sqliteTable("deposits", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  chain: text("chain").notNull(),
  token: text("token").notNull(),
  amountRaw: real("amount_raw").notNull(),
  amountUsd: real("amount_usd").notNull(),
  swapFee: real("swap_fee").default(0).notNull(),
  txHash: text("tx_hash").notNull(),
  wagyuTx: text("wagyu_tx"),
  status: text("status").default("pending").notNull(),
  confirmations: integer("confirmations").default(0).notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  creditedAt: integer("credited_at"),
}, (table) => [
  index("idx_deposits_agent").on(table.agentId),
  index("idx_deposits_status").on(table.status),
  index("idx_deposits_tx").on(table.txHash, table.chain),
]);

// ─── Withdrawals ───

export const withdrawals = sqliteTable("withdrawals", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  amount: real("amount").notNull(),
  fee: real("fee").notNull(),
  chain: text("chain").notNull(),
  token: text("token").notNull(),
  address: text("address").notNull(),
  txHash: text("tx_hash"),
  status: text("status").default("pending").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  completedAt: integer("completed_at"),
});

// ─── Ledger Entries (every balance change) ───

export const ledgerEntries = sqliteTable("ledger_entries", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  type: text("type").notNull(), // credit, debit, reservation, release
  amount: real("amount").notNull(),
  balanceAfter: real("balance_after").notNull(),
  reason: text("reason").notNull(),
  reference: text("reference"),
  service: text("service"), // casino, burner, withdrawal, deposit
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_ledger_agent").on(table.agentId),
  index("idx_ledger_created").on(table.createdAt),
]);

// ─── Bets ───

export const bets = sqliteTable("bets", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  game: text("game").notNull(),
  amount: real("amount").notNull(),
  payoutMultiplier: real("payout_multiplier").notNull(),
  result: text("result").notNull(), // JSON of game-specific result
  won: integer("won", { mode: "boolean" }).notNull(),
  amountWon: real("amount_won").notNull(),
  serverSeed: text("server_seed").notNull(),
  serverSeedHash: text("server_seed_hash").notNull(),
  clientSeed: text("client_seed"),
  nonce: integer("nonce").notNull(),
  resultHash: text("result_hash").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_bets_agent").on(table.agentId),
  index("idx_bets_game").on(table.game),
  index("idx_bets_created").on(table.createdAt),
]);

// ─── Server Seeds (for provably fair rotation) ───

export const serverSeeds = sqliteTable("server_seeds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seed: text("seed").notNull(),
  seedHash: text("seed_hash").notNull(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  currentNonce: integer("current_nonce").default(0).notNull(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  revealedAt: integer("revealed_at"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
});

// ─── Referrals ───

export const referrals = sqliteTable("referrals", {
  referrerId: text("referrer_id").notNull().references(() => agents.id),
  referredId: text("referred_id").notNull().references(() => agents.id),
  commissionRate: real("commission_rate").default(0.10).notNull(),
  totalEarned: real("total_earned").default(0).notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  primaryKey({ columns: [table.referrerId, table.referredId] }),
]);

// ─── Daily Bonuses ───

export const dailyBonuses = sqliteTable("daily_bonuses", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  amount: real("amount").notNull(),
  streakDay: integer("streak_day").notNull(), // 1, 2, 3, ... resets on missed day
  claimedAt: integer("claimed_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_daily_agent").on(table.agentId),
]);

// ─── Treasury Snapshots ───

export const treasurySnapshots = sqliteTable("treasury_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  treasuryBalance: real("treasury_balance").notNull(),
  totalAgentBalances: real("total_agent_balances").notNull(),
  reserveRatio: real("reserve_ratio").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
});

// ─── Tournaments ───

export const tournaments = sqliteTable("tournaments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  game: text("game").notNull(),
  entryFee: real("entry_fee").notNull(),
  prizePool: real("prize_pool").notNull(),
  maxAgents: integer("max_agents").notNull(),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at").notNull(),
  status: text("status").default("upcoming").notNull(), // upcoming, active, completed, cancelled
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_tournaments_status").on(table.status),
  index("idx_tournaments_starts").on(table.startsAt),
]);

export const tournamentEntries = sqliteTable("tournament_entries", {
  id: text("id").primaryKey(),
  tournamentId: text("tournament_id").notNull().references(() => tournaments.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  score: real("score").default(0).notNull(), // total winnings during tournament
  enteredAt: integer("entered_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_tent_tournament").on(table.tournamentId),
  index("idx_tent_agent").on(table.agentId),
]);

// ─── Challenges ───

export const challenges = sqliteTable("challenges", {
  id: text("id").primaryKey(),
  challengerId: text("challenger_id").notNull().references(() => agents.id),
  challengedId: text("challenged_id").notNull().references(() => agents.id),
  game: text("game").notNull(),
  amount: real("amount").notNull(),
  status: text("status").default("pending").notNull(), // pending, accepted, declined, expired
  winnerId: text("winner_id"),
  message: text("message"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  resolvedAt: integer("resolved_at"),
}, (table) => [
  index("idx_challenges_challenger").on(table.challengerId),
  index("idx_challenges_challenged").on(table.challengedId),
  index("idx_challenges_status").on(table.status),
]);
