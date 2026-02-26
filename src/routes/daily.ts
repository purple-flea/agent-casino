import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
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

export { daily };
