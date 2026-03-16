import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, sql, desc, and } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const achievements = new Hono<AppEnv>();

interface Achievement {
  id: string;
  name: string;
  description: string;
  emoji: string;
  unlocked: boolean;
  progress?: number;     // 0-100
  progress_label?: string;
}

// ─── GET /achievements — compute achievements from existing bet data ───

achievements.get("/", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;

  // Aggregate stats needed for achievements
  const totalStats = db.select({
    totalBets: sql<number>`COUNT(*)`,
    totalWagered: sql<number>`COALESCE(SUM(${schema.bets.amount}), 0)`,
    totalWon: sql<number>`COALESCE(SUM(${schema.bets.amountWon}), 0)`,
    wins: sql<number>`SUM(CASE WHEN ${schema.bets.won} = 1 THEN 1 ELSE 0 END)`,
    biggestWin: sql<number>`COALESCE(MAX(${schema.bets.amountWon}), 0)`,
    biggestBet: sql<number>`COALESCE(MAX(${schema.bets.amount}), 0)`,
  }).from(schema.bets).where(eq(schema.bets.agentId, agentId)).get();

  // Unique games played
  const gamesPlayed = db.select({ game: schema.bets.game })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .groupBy(schema.bets.game)
    .all();
  const uniqueGames = new Set(gamesPlayed.map(g => g.game));

  // Slots jackpot hit (250x multiplier)
  const jackpotHit = db.select({ id: schema.bets.id })
    .from(schema.bets)
    .where(and(
      eq(schema.bets.agentId, agentId),
      eq(schema.bets.game, "slots"),
      sql`${schema.bets.payoutMultiplier} >= 250`,
    ))
    .limit(1).get();

  // Best win streak (scan last 1000 bets)
  const recentBets = db.select({ won: schema.bets.won })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .orderBy(desc(schema.bets.createdAt))
    .limit(1000).all();

  let bestWinStreak = 0, currentStreak = 0;
  for (const bet of recentBets) {
    if (bet.won) { currentStreak++; bestWinStreak = Math.max(bestWinStreak, currentStreak); }
    else { currentStreak = 0; }
  }

  // Daily bonus claims
  const dailyCount = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.dailyBonuses)
    .where(eq(schema.dailyBonuses.agentId, agentId))
    .get();

  // Current daily streak
  const lastBonus = db.select()
    .from(schema.dailyBonuses)
    .where(eq(schema.dailyBonuses.agentId, agentId))
    .orderBy(desc(schema.dailyBonuses.claimedAt))
    .limit(1).get();

  const t = totalStats;
  const totalBets = t?.totalBets ?? 0;
  const totalWagered = t?.totalWagered ?? 0;
  const biggestWin = t?.biggestWin ?? 0;
  const biggestBet = t?.biggestBet ?? 0;
  const wins = t?.wins ?? 0;
  const dailyClaims = dailyCount?.count ?? 0;
  const currentDailyStreak = lastBonus?.streakDay ?? 0;

  function pct(val: number, target: number): number {
    return Math.min(100, Math.round((val / target) * 100));
  }

  const list: Achievement[] = [
    // ─── Bet count milestones ───
    {
      id: "first_bet",
      name: "First Chip",
      description: "Place your first bet",
      emoji: "🎰",
      unlocked: totalBets >= 1,
      progress: pct(totalBets, 1),
    },
    {
      id: "bet_10",
      name: "Getting Warmed Up",
      description: "Place 10 bets",
      emoji: "🔥",
      unlocked: totalBets >= 10,
      progress: pct(totalBets, 10),
      progress_label: `${totalBets}/10 bets`,
    },
    {
      id: "bet_100",
      name: "Centurion",
      description: "Place 100 bets",
      emoji: "💯",
      unlocked: totalBets >= 100,
      progress: pct(totalBets, 100),
      progress_label: `${totalBets}/100 bets`,
    },
    {
      id: "bet_1000",
      name: "High Roller",
      description: "Place 1,000 bets",
      emoji: "🎩",
      unlocked: totalBets >= 1000,
      progress: pct(totalBets, 1000),
      progress_label: `${totalBets}/1,000 bets`,
    },
    // ─── Volume milestones ───
    {
      id: "volume_10",
      name: "Ten Dollar Club",
      description: "Wager $10 total",
      emoji: "💵",
      unlocked: totalWagered >= 10,
      progress: pct(totalWagered, 10),
      progress_label: `$${totalWagered.toFixed(2)}/$10`,
    },
    {
      id: "volume_100",
      name: "The Hundred",
      description: "Wager $100 total",
      emoji: "💴",
      unlocked: totalWagered >= 100,
      progress: pct(totalWagered, 100),
      progress_label: `$${totalWagered.toFixed(2)}/$100`,
    },
    {
      id: "volume_1000",
      name: "Grand Master",
      description: "Wager $1,000 total",
      emoji: "💎",
      unlocked: totalWagered >= 1000,
      progress: pct(totalWagered, 1000),
      progress_label: `$${totalWagered.toFixed(2)}/$1,000`,
    },
    // ─── Big wins ───
    {
      id: "big_win_5",
      name: "Payday",
      description: "Win $5 in a single bet",
      emoji: "🤑",
      unlocked: biggestWin >= 5,
      progress: pct(biggestWin, 5),
      progress_label: `Best: $${biggestWin.toFixed(2)}`,
    },
    {
      id: "big_win_50",
      name: "Jackpot Junior",
      description: "Win $50 in a single bet",
      emoji: "🏆",
      unlocked: biggestWin >= 50,
      progress: pct(biggestWin, 50),
      progress_label: `Best: $${biggestWin.toFixed(2)}`,
    },
    {
      id: "big_win_500",
      name: "Whale Alert",
      description: "Win $500 in a single bet",
      emoji: "🐋",
      unlocked: biggestWin >= 500,
      progress: pct(biggestWin, 500),
      progress_label: `Best: $${biggestWin.toFixed(2)}`,
    },
    // ─── Streak achievements ───
    {
      id: "streak_5",
      name: "On a Roll",
      description: "Win 5 bets in a row",
      emoji: "🎯",
      unlocked: bestWinStreak >= 5,
      progress: pct(bestWinStreak, 5),
      progress_label: `Best streak: ${bestWinStreak}`,
    },
    {
      id: "streak_10",
      name: "Unstoppable",
      description: "Win 10 bets in a row",
      emoji: "⚡",
      unlocked: bestWinStreak >= 10,
      progress: pct(bestWinStreak, 10),
      progress_label: `Best streak: ${bestWinStreak}`,
    },
    // ─── Game variety ───
    {
      id: "game_explorer",
      name: "Game Explorer",
      description: "Try 5 different games",
      emoji: "🗺️",
      unlocked: uniqueGames.size >= 5,
      progress: pct(uniqueGames.size, 5),
      progress_label: `${uniqueGames.size}/5 games tried`,
    },
    {
      id: "game_master",
      name: "Casino Master",
      description: "Try all 9 games",
      emoji: "👑",
      unlocked: uniqueGames.size >= 9,
      progress: pct(uniqueGames.size, 9),
      progress_label: `${uniqueGames.size}/9 games tried`,
    },
    // ─── Slots jackpot ───
    {
      id: "slots_jackpot",
      name: "Triple Sevens",
      description: "Hit the 250x jackpot on Slots",
      emoji: "7️⃣",
      unlocked: !!jackpotHit,
      progress: jackpotHit ? 100 : 0,
    },
    // ─── Daily bonus ───
    {
      id: "daily_first",
      name: "First Timer",
      description: "Claim your first daily bonus",
      emoji: "📅",
      unlocked: dailyClaims >= 1,
      progress: pct(dailyClaims, 1),
    },
    {
      id: "daily_7",
      name: "Week Warrior",
      description: "Claim 7 daily bonuses",
      emoji: "🌟",
      unlocked: dailyClaims >= 7,
      progress: pct(dailyClaims, 7),
      progress_label: `${dailyClaims}/7 claims`,
    },
    {
      id: "daily_30",
      name: "Monthly Regular",
      description: "Claim 30 daily bonuses",
      emoji: "🗓️",
      unlocked: dailyClaims >= 30,
      progress: pct(dailyClaims, 30),
      progress_label: `${dailyClaims}/30 claims`,
    },
    {
      id: "streak_7_daily",
      name: "Perfect Week",
      description: "Reach a 7-day daily bonus streak",
      emoji: "🏅",
      unlocked: currentDailyStreak >= 7,
      progress: pct(currentDailyStreak, 7),
      progress_label: `Current streak: day ${currentDailyStreak}`,
    },
    // ─── Bold bets ───
    {
      id: "bold_bet",
      name: "Bold Move",
      description: "Place a single bet over $5",
      emoji: "😤",
      unlocked: biggestBet >= 5,
      progress: pct(biggestBet, 5),
    },
    {
      id: "all_in",
      name: "All In",
      description: "Place a single bet over $50",
      emoji: "💥",
      unlocked: biggestBet >= 50,
      progress: pct(biggestBet, 50),
    },
  ];

  const unlocked = list.filter(a => a.unlocked);
  const locked = list.filter(a => !a.unlocked);

  return c.json({
    unlocked_count: unlocked.length,
    total_achievements: list.length,
    completion_pct: Math.round((unlocked.length / list.length) * 100),
    achievements: {
      unlocked,
      locked: locked.map(a => ({
        ...a,
        hint: `Progress: ${a.progress ?? 0}%`,
      })),
    },
    stats_snapshot: {
      total_bets: totalBets,
      total_wagered: Math.round(totalWagered * 100) / 100,
      biggest_single_win: Math.round(biggestWin * 100) / 100,
      best_win_streak: bestWinStreak,
      unique_games_played: uniqueGames.size,
      daily_bonus_claims: dailyClaims,
      current_daily_streak: currentDailyStreak,
    },
  });
});

// ─── GET /achievements/catalogue — public, no auth, all available achievements ───

const CATALOGUE_CACHE = { data: null as object | null, ts: 0 };

achievements.get("/catalogue", (c) => {
  const now = Date.now();
  if (CATALOGUE_CACHE.data && now - CATALOGUE_CACHE.ts < 3_600_000) {
    return c.json(CATALOGUE_CACHE.data);
  }

  const catalogue = [
    // Bet count milestones
    { id: "first_bet",   name: "First Chip",       emoji: "🎰", category: "bets",    description: "Place your first bet",   requirement: "1 bet" },
    { id: "bet_10",      name: "Getting Warmed Up", emoji: "🔥", category: "bets",    description: "Place 10 bets",          requirement: "10 bets" },
    { id: "bet_100",     name: "Centurion",         emoji: "💯", category: "bets",    description: "Place 100 bets",         requirement: "100 bets" },
    { id: "bet_1000",    name: "High Roller",       emoji: "🎩", category: "bets",    description: "Place 1,000 bets",       requirement: "1,000 bets" },
    // Volume milestones
    { id: "volume_10",   name: "Ten Dollar Club",   emoji: "💵", category: "volume",  description: "Wager $10 total",        requirement: "Wager $10" },
    { id: "volume_100",  name: "The Hundred",       emoji: "💴", category: "volume",  description: "Wager $100 total",       requirement: "Wager $100" },
    { id: "volume_1000", name: "Grand Master",      emoji: "💎", category: "volume",  description: "Wager $1,000 total",     requirement: "Wager $1,000" },
    // Big wins
    { id: "big_win_5",   name: "Payday",            emoji: "🤑", category: "wins",    description: "Win $5 in a single bet",   requirement: "Single win >= $5" },
    { id: "big_win_50",  name: "Jackpot Junior",    emoji: "🏆", category: "wins",    description: "Win $50 in a single bet",  requirement: "Single win >= $50" },
    { id: "big_win_500", name: "Whale Alert",       emoji: "🐋", category: "wins",    description: "Win $500 in a single bet", requirement: "Single win >= $500" },
    // Win streaks
    { id: "streak_5",    name: "On a Roll",         emoji: "🎯", category: "streaks", description: "Win 5 bets in a row",      requirement: "5-bet win streak" },
    { id: "streak_10",   name: "Unstoppable",       emoji: "⚡", category: "streaks", description: "Win 10 bets in a row",     requirement: "10-bet win streak" },
    // Game variety
    { id: "game_explorer", name: "Game Explorer",   emoji: "🗺️", category: "variety", description: "Try 5 different games",    requirement: "5 unique game types" },
    { id: "game_master", name: "Casino Master",     emoji: "👑", category: "variety", description: "Try all 9+ game types",    requirement: "9 unique game types" },
    // Jackpot
    { id: "slots_jackpot", name: "Triple Sevens",   emoji: "7️⃣", category: "special", description: "Hit the 250x jackpot on Slots", requirement: "Triple 7 on slots" },
    // Daily bonus
    { id: "daily_first", name: "First Timer",       emoji: "📅", category: "daily",   description: "Claim your first daily bonus",     requirement: "1 daily claim" },
    { id: "daily_7",     name: "Week Warrior",      emoji: "🌟", category: "daily",   description: "Claim 7 daily bonuses",            requirement: "7 daily claims" },
    { id: "daily_30",    name: "Monthly Regular",   emoji: "🗓️", category: "daily",   description: "Claim 30 daily bonuses",           requirement: "30 daily claims" },
    { id: "streak_7_daily", name: "Perfect Week",   emoji: "🏅", category: "daily",   description: "Reach a 7-day daily bonus streak", requirement: "7-day consecutive streak" },
    // Bold bets
    { id: "bold_bet",    name: "Bold Move",         emoji: "😤", category: "bets",    description: "Place a single bet over $5",       requirement: "Single bet >= $5" },
    { id: "all_in",      name: "All In",            emoji: "💥", category: "bets",    description: "Place a single bet over $50",      requirement: "Single bet >= $50" },
  ];

  const data = {
    total: catalogue.length,
    achievements: catalogue,
    how_to_check: "GET /api/v1/achievements (auth required) — shows your unlock status + progress",
    note: "Achievements are computed in real-time from your bet history. No separate tracking table.",
  };

  CATALOGUE_CACHE.data = data;
  CATALOGUE_CACHE.ts = now;
  return c.json(data);
});

export { achievements };
