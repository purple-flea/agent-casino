import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, and, lt } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth.js";
import { ledger } from "../wallet/ledger.js";
import type { AppEnv } from "../types.js";

const daily = new Hono<AppEnv>();

// Daily bonus schedule: streak day → bonus USD
// Caps at day 7 then cycles (7-day loop)
const BONUS_TABLE: Record<number, number> = {
  1: 0.50,
  2: 0.75,
  3: 1.00,
  4: 1.25,
  5: 1.50,
  6: 2.00,
  7: 5.00, // big Sunday bonus
};

function getBonusAmount(streakDay: number): number {
  const day = ((streakDay - 1) % 7) + 1;
  return BONUS_TABLE[day] ?? 0.50;
}

const SECONDS_PER_DAY = 86400;
const STREAK_WINDOW = SECONDS_PER_DAY * 2; // must claim within 48h to keep streak

// ─── GET /daily — status (no claim) ───

daily.get("/", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const now = Math.floor(Date.now() / 1000);

  const lastClaim = db.select()
    .from(schema.dailyBonuses)
    .where(eq(schema.dailyBonuses.agentId, agentId))
    .orderBy(desc(schema.dailyBonuses.claimedAt))
    .limit(1)
    .get();

  const secondsSinceLast = lastClaim ? now - lastClaim.claimedAt : null;
  const canClaim = !lastClaim || secondsSinceLast! >= SECONDS_PER_DAY;
  const streakBroken = lastClaim && secondsSinceLast! > STREAK_WINDOW;
  const currentStreak = lastClaim && !streakBroken ? lastClaim.streakDay : 0;
  const nextStreak = streakBroken ? 1 : currentStreak + 1;
  const nextBonus = getBonusAmount(nextStreak);

  const nextClaimAt = lastClaim && !canClaim
    ? lastClaim.claimedAt + SECONDS_PER_DAY
    : null;
  const secondsUntilNext = nextClaimAt ? Math.max(0, nextClaimAt - now) : 0;

  return c.json({
    can_claim: canClaim,
    current_streak: canClaim ? nextStreak - 1 : currentStreak,
    next_bonus_usd: nextBonus,
    streak_broken: streakBroken ?? false,
    last_claimed_at: lastClaim?.claimedAt ?? null,
    next_claim_in_seconds: secondsUntilNext || null,
    schedule: BONUS_TABLE,
    claim: canClaim ? "POST /api/v1/daily/claim to collect your bonus" : null,
  });
});

// ─── POST /daily/claim — claim daily bonus ───

daily.post("/claim", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const now = Math.floor(Date.now() / 1000);

  const lastClaim = db.select()
    .from(schema.dailyBonuses)
    .where(eq(schema.dailyBonuses.agentId, agentId))
    .orderBy(desc(schema.dailyBonuses.claimedAt))
    .limit(1)
    .get();

  if (lastClaim) {
    const secondsSinceLast = now - lastClaim.claimedAt;
    if (secondsSinceLast < SECONDS_PER_DAY) {
      const remaining = SECONDS_PER_DAY - secondsSinceLast;
      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      return c.json({
        error: "already_claimed",
        message: `Already claimed today. Come back in ${hours}h ${minutes}m.`,
        next_claim_in_seconds: remaining,
        current_streak: lastClaim.streakDay,
        next_bonus_usd: getBonusAmount(lastClaim.streakDay + 1),
      }, 400);
    }
  }

  // Calculate streak
  const streakBroken = lastClaim && (now - lastClaim.claimedAt) > STREAK_WINDOW;
  const streakDay = (!lastClaim || streakBroken) ? 1 : lastClaim.streakDay + 1;
  const bonusAmount = getBonusAmount(streakDay);
  const bonusId = `db_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  // Record bonus and credit balance atomically
  db.insert(schema.dailyBonuses).values({
    id: bonusId,
    agentId,
    amount: bonusAmount,
    streakDay,
  }).run();

  ledger.credit(agentId, bonusAmount, "daily_bonus", "casino", bonusId);

  const newBalance = ledger.getBalance(agentId);
  const isWeeklyBonus = streakDay % 7 === 0;

  return c.json({
    claimed: true,
    bonus_usd: bonusAmount,
    streak_day: streakDay,
    streak_broken: streakBroken ?? false,
    balance_after: newBalance,
    message: isWeeklyBonus
      ? `Weekly streak bonus! +$${bonusAmount.toFixed(2)} (${streakDay}-day streak)`
      : `Daily bonus claimed! +$${bonusAmount.toFixed(2)} (day ${streakDay} streak)`,
    next_bonus_usd: getBonusAmount(streakDay + 1),
    tip: `Come back tomorrow to continue your streak! Day ${streakDay + 1} = $${getBonusAmount(streakDay + 1).toFixed(2)}`,
    play: "GET /api/v1/games to use your bonus",
  });
});

// ─── Loss Recovery Bonus ───
// If agent lost >= $5 in last 24h, they can claim back 10% (max $20) once per 24h

const RECOVERY_THRESHOLD_USD = 5;   // min loss to qualify
const RECOVERY_RATE = 0.10;          // 10% back
const RECOVERY_MAX_USD = 20;         // cap per claim
const RECOVERY_COOLDOWN_S = 86400;   // 24h between claims

daily.get("/recovery", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const now = Math.floor(Date.now() / 1000);
  const since = now - RECOVERY_COOLDOWN_S;

  // Check if already claimed in last 24h
  const lastClaim = db.select({ createdAt: schema.ledgerEntries.createdAt, amount: schema.ledgerEntries.amount })
    .from(schema.ledgerEntries)
    .where(and(
      eq(schema.ledgerEntries.agentId, agentId),
      eq(schema.ledgerEntries.reason, "loss_recovery_bonus"),
      sql`${schema.ledgerEntries.createdAt} > ${since}`,
    ))
    .orderBy(desc(schema.ledgerEntries.createdAt))
    .limit(1)
    .get();

  // Calculate net loss in last 24h from bets
  const lossRow = db.select({
    total_bet: sql<number>`coalesce(sum(${schema.bets.amount}), 0)`,
    total_won: sql<number>`coalesce(sum(${schema.bets.amountWon}), 0)`,
  }).from(schema.bets)
    .where(and(
      eq(schema.bets.agentId, agentId),
      sql`${schema.bets.createdAt} > ${since}`,
    ))
    .get();

  const netLoss = Math.max(0, (lossRow?.total_bet ?? 0) - (lossRow?.total_won ?? 0));
  const eligible = netLoss >= RECOVERY_THRESHOLD_USD && !lastClaim;
  const recoveryAmount = Math.min(netLoss * RECOVERY_RATE, RECOVERY_MAX_USD);
  const nextClaimAt = lastClaim ? lastClaim.createdAt + RECOVERY_COOLDOWN_S : null;

  return c.json({
    eligible,
    net_loss_24h_usd: Math.round(netLoss * 100) / 100,
    recovery_amount_usd: eligible ? Math.round(recoveryAmount * 100) / 100 : 0,
    already_claimed: !!lastClaim,
    last_claim_at: lastClaim?.createdAt ?? null,
    next_eligible_at: nextClaimAt,
    threshold_usd: RECOVERY_THRESHOLD_USD,
    recovery_rate: `${(RECOVERY_RATE * 100).toFixed(0)}%`,
    max_recovery_usd: RECOVERY_MAX_USD,
    claim: eligible ? "POST /api/v1/daily/recovery/claim" : null,
    tip: eligible
      ? `You lost $${netLoss.toFixed(2)} — claim $${recoveryAmount.toFixed(2)} recovery bonus now!`
      : netLoss < RECOVERY_THRESHOLD_USD
        ? `Need $${RECOVERY_THRESHOLD_USD}+ net losses in 24h to qualify (current: $${netLoss.toFixed(2)})`
        : `Already claimed today. Next eligible: ${new Date(nextClaimAt! * 1000).toISOString()}`,
  });
});

daily.post("/recovery/claim", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const now = Math.floor(Date.now() / 1000);
  const since = now - RECOVERY_COOLDOWN_S;

  // Check cooldown
  const lastClaim = db.select({ createdAt: schema.ledgerEntries.createdAt })
    .from(schema.ledgerEntries)
    .where(and(
      eq(schema.ledgerEntries.agentId, agentId),
      eq(schema.ledgerEntries.reason, "loss_recovery_bonus"),
      sql`${schema.ledgerEntries.createdAt} > ${since}`,
    ))
    .limit(1)
    .get();

  if (lastClaim) {
    const nextAt = lastClaim.createdAt + RECOVERY_COOLDOWN_S;
    return c.json({ error: "already_claimed", message: "Recovery bonus already claimed in last 24h", next_eligible_at: nextAt }, 429);
  }

  // Calculate losses
  const lossRow = db.select({
    total_bet: sql<number>`coalesce(sum(${schema.bets.amount}), 0)`,
    total_won: sql<number>`coalesce(sum(${schema.bets.amountWon}), 0)`,
  }).from(schema.bets)
    .where(and(
      eq(schema.bets.agentId, agentId),
      sql`${schema.bets.createdAt} > ${since}`,
    ))
    .get();

  const netLoss = Math.max(0, (lossRow?.total_bet ?? 0) - (lossRow?.total_won ?? 0));
  if (netLoss < RECOVERY_THRESHOLD_USD) {
    return c.json({
      error: "not_eligible",
      message: `Need $${RECOVERY_THRESHOLD_USD}+ net losses in last 24h. Current: $${netLoss.toFixed(2)}`,
      net_loss_24h_usd: Math.round(netLoss * 100) / 100,
    }, 400);
  }

  const recoveryAmount = Math.min(netLoss * RECOVERY_RATE, RECOVERY_MAX_USD);
  ledger.credit(agentId, recoveryAmount, "loss_recovery_bonus", "casino");
  const newBalance = ledger.getBalance(agentId);

  return c.json({
    claimed: true,
    recovery_usd: Math.round(recoveryAmount * 100) / 100,
    net_loss_covered_usd: Math.round(netLoss * 100) / 100,
    balance_after: newBalance,
    message: `Recovery bonus: +$${recoveryAmount.toFixed(2)} (10% of $${netLoss.toFixed(2)} losses)`,
    tip: "Losses happen. We've got your back. Come back and play again!",
    next_eligible_in_hours: 24,
  });
});

export { daily };
