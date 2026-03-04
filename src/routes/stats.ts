import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, count, and, gte } from "drizzle-orm";
import { ledger } from "../wallet/ledger.js";
import type { AppEnv } from "../types.js";

const stats = new Hono<AppEnv>();

// ─── My stats ───

stats.get("/me", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;

  // Game breakdown
  const gameStats = db
    .select({
      game: schema.bets.game,
      totalBets: count(),
      totalWagered: sql<number>`SUM(${schema.bets.amount})`,
      totalWon: sql<number>`SUM(${schema.bets.amountWon})`,
      wins: sql<number>`SUM(CASE WHEN ${schema.bets.won} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .groupBy(schema.bets.game)
    .all();

  const totalBets = gameStats.reduce((s, g) => s + g.totalBets, 0);
  const totalWins = gameStats.reduce((s, g) => s + g.wins, 0);

  // Streak analysis — last 50 bets ordered by time
  const recentBets = db
    .select({ won: schema.bets.won, amountWon: schema.bets.amountWon, amount: schema.bets.amount, createdAt: schema.bets.createdAt })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .orderBy(desc(schema.bets.createdAt))
    .limit(50)
    .all();

  let currentStreak = 0;
  let currentStreakType: "win" | "loss" | null = null;
  let bestWinStreak = 0;
  let bestLossStreak = 0;
  let tempStreak = 0;
  let tempType: boolean | null = null;

  for (const bet of recentBets) {
    if (currentStreakType === null) {
      currentStreakType = bet.won ? "win" : "loss";
      currentStreak = 1;
    } else if ((bet.won && currentStreakType === "win") || (!bet.won && currentStreakType === "loss")) {
      currentStreak++;
    } else {
      break; // streak ended
    }
  }

  // Full streak history for best streak
  const allBets = db
    .select({ won: schema.bets.won })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .orderBy(desc(schema.bets.createdAt))
    .all();

  tempStreak = 0;
  tempType = null;
  for (const bet of allBets) {
    if (tempType === null || tempType === bet.won) {
      tempStreak++;
      tempType = bet.won;
      if (bet.won) bestWinStreak = Math.max(bestWinStreak, tempStreak);
      else bestLossStreak = Math.max(bestLossStreak, tempStreak);
    } else {
      tempStreak = 1;
      tempType = bet.won;
    }
  }

  return c.json({
    agent_id: agentId,
    balance: agent.balanceUsd,
    lifetime: {
      total_bets: totalBets,
      total_wagered: agent.totalWagered,
      total_won: agent.totalWon,
      net_profit: Math.round((agent.totalWon - agent.totalWagered) * 100) / 100,
      win_rate: totalBets > 0 ? Math.round((totalWins / totalBets) * 10000) / 100 : 0,
      total_deposited: agent.totalDeposited,
      total_withdrawn: agent.totalWithdrawn,
    },
    streaks: {
      current_streak: currentStreak,
      current_streak_type: currentStreakType,
      best_win_streak: bestWinStreak,
      best_loss_streak: bestLossStreak,
      tip: currentStreakType === "loss" && currentStreak >= 3
        ? "You're on a loss streak — consider reducing bet size (Kelly Criterion: GET /api/v1/kelly/limits)"
        : currentStreakType === "win" && currentStreak >= 3
        ? "You're on a win streak — house edge still applies, consider locking in some profits"
        : null,
    },
    by_game: gameStats.map((g) => ({
      game: g.game,
      bets: g.totalBets,
      wagered: g.totalWagered,
      won: g.totalWon,
      net: Math.round((g.totalWon - g.totalWagered) * 100) / 100,
      win_rate: g.totalBets > 0 ? Math.round((g.wins / g.totalBets) * 10000) / 100 : 0,
    })),
    member_since: new Date(agent.createdAt * 1000).toISOString(),
  });
});

// ─── Session stats (last 24h) ───

stats.get("/session", async (c) => {
  const agentId = c.get("agentId") as string;
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

  const sessionBets = db
    .select()
    .from(schema.bets)
    .where(and(
      eq(schema.bets.agentId, agentId),
      gte(schema.bets.createdAt, oneDayAgo),
    ))
    .all();

  const wagered = sessionBets.reduce((s, b) => s + b.amount, 0);
  const won = sessionBets.reduce((s, b) => s + b.amountWon, 0);
  const wins = sessionBets.filter((b) => b.won).length;

  return c.json({
    period: "last_24h",
    bets: sessionBets.length,
    wagered: Math.round(wagered * 100) / 100,
    won: Math.round(won * 100) / 100,
    net: Math.round((won - wagered) * 100) / 100,
    win_rate: sessionBets.length > 0 ? Math.round((wins / sessionBets.length) * 10000) / 100 : 0,
    recent_bets: sessionBets.slice(-10).reverse().map((b) => ({
      bet_id: b.id,
      game: b.game,
      amount: b.amount,
      won: b.won,
      amount_won: b.amountWon,
      at: new Date(b.createdAt * 1000).toISOString(),
    })),
  });
});

// ─── Leaderboard ───

stats.get("/leaderboard", async (c) => {
  const game = c.req.query("game"); // optional: filter by game

  // Overall top agents by net profit
  const topAgents = db
    .select({
      id: schema.agents.id,
      totalWagered: schema.agents.totalWagered,
      totalWon: schema.agents.totalWon,
      netProfit: sql<number>`${schema.agents.totalWon} - ${schema.agents.totalWagered}`,
    })
    .from(schema.agents)
    .orderBy(desc(sql`${schema.agents.totalWon} - ${schema.agents.totalWagered}`))
    .limit(20)
    .all();

  // Per-game top players if game filter is provided
  let gameLeaderboard = null;
  const supportedGames = ["coin_flip", "dice", "multiplier", "roulette", "custom", "blackjack", "crash", "plinko"];

  if (game && supportedGames.includes(game)) {
    const gameStats = db
      .select({
        agentId: schema.bets.agentId,
        totalBets: count(),
        totalWon: sql<number>`SUM(${schema.bets.amountWon})`,
        totalWagered: sql<number>`SUM(${schema.bets.amount})`,
        biggestWin: sql<number>`MAX(${schema.bets.amountWon})`,
        wins: sql<number>`SUM(CASE WHEN ${schema.bets.won} = 1 THEN 1 ELSE 0 END)`,
      })
      .from(schema.bets)
      .where(eq(schema.bets.game, game))
      .groupBy(schema.bets.agentId)
      .orderBy(desc(sql`SUM(${schema.bets.amountWon}) - SUM(${schema.bets.amount})`))
      .limit(10)
      .all();

    gameLeaderboard = gameStats.map((g, i) => ({
      rank: i + 1,
      agent_id: g.agentId.slice(0, 6) + "...",
      bets: g.totalBets,
      net_profit: Math.round((g.totalWon - g.totalWagered) * 100) / 100,
      biggest_win: Math.round(g.biggestWin * 100) / 100,
      win_rate_pct: g.totalBets > 0 ? Math.round((g.wins / g.totalBets) * 10000) / 100 : 0,
    }));
  }

  // Biggest single wins across all games
  const biggestWins = db
    .select({
      agentId: schema.bets.agentId,
      game: schema.bets.game,
      amount: schema.bets.amount,
      amountWon: schema.bets.amountWon,
      payoutMultiplier: schema.bets.payoutMultiplier,
      createdAt: schema.bets.createdAt,
    })
    .from(schema.bets)
    .where(eq(schema.bets.won, true))
    .orderBy(desc(schema.bets.amountWon))
    .limit(5)
    .all();

  return c.json({
    overall_leaderboard: topAgents.map((a, i) => ({
      rank: i + 1,
      agent_id: a.id.slice(0, 6) + "...",
      total_wagered: Math.round(a.totalWagered * 100) / 100,
      total_won: Math.round(a.totalWon * 100) / 100,
      net_profit: Math.round(a.netProfit * 100) / 100,
    })),
    ...(gameLeaderboard !== null ? { game_leaderboard: { game, entries: gameLeaderboard } } : {}),
    biggest_wins: biggestWins.map((b) => ({
      agent_id: b.agentId.slice(0, 6) + "...",
      game: b.game,
      bet: Math.round(b.amount * 100) / 100,
      won: Math.round(b.amountWon * 100) / 100,
      multiplier: b.payoutMultiplier,
      at: new Date(b.createdAt * 1000).toISOString(),
    })),
    supported_games: supportedGames,
    filter_tip: "Add ?game=blackjack to see per-game leaderboard",
    updated_at: new Date().toISOString(),
  });
});

// ─── Referral leaderboard (public) ───

stats.get("/referral-leaderboard", async (c) => {
  c.header("Cache-Control", "public, max-age=60");

  // Top referrers by total commission earned (from referrals table total_earned)
  const topReferrers = db
    .select({
      referrerId: schema.referrals.referrerId,
      totalEarned: sql<number>`COALESCE(SUM(${schema.referrals.totalEarned}), 0)`,
      referralCount: sql<number>`COUNT(*)`,
    })
    .from(schema.referrals)
    .groupBy(schema.referrals.referrerId)
    .orderBy(desc(sql`SUM(${schema.referrals.totalEarned})`))
    .limit(10)
    .all();

  // Look up referral codes for display
  const enriched = topReferrers.map((r, i) => {
    const agent = db.select({
      referralCode: schema.agents.referralCode,
      createdAt: schema.agents.createdAt,
    }).from(schema.agents).where(eq(schema.agents.id, r.referrerId)).get();

    return {
      rank: i + 1,
      agent_id: r.referrerId.slice(0, 8) + "...",
      referral_code: agent?.referralCode ?? null,
      total_earned_usd: Math.round(r.totalEarned * 100) / 100,
      referral_count: r.referralCount,
      member_since: agent?.createdAt
        ? new Date(agent.createdAt * 1000).toISOString().slice(0, 10)
        : null,
    };
  });

  // Network-wide referral stats
  const networkStats = db.select({
    totalReferrals: sql<number>`COUNT(*)`,
    totalCommissions: sql<number>`COALESCE(SUM(${schema.referrals.totalEarned}), 0)`,
  }).from(schema.referrals).get();

  return c.json({
    referral_leaderboard: enriched,
    network: {
      total_referral_relationships: networkStats?.totalReferrals ?? 0,
      total_commissions_paid_usd: Math.round((networkStats?.totalCommissions ?? 0) * 100) / 100,
    },
    how_to_join: {
      step_1: "POST /api/v1/auth/register to get your referral code",
      step_2: "Share your code — earn 10% of referred agents net losses",
      step_3: "3-level deep: earn on who your referrals refer too",
      commission_structure: "Level 1: 10%, Level 2: 5%, Level 3: 2.5%",
    },
    updated_at: new Date().toISOString(),
  });
});

// ─── Profit leaderboard with time period filter (public) ───

stats.get("/profit-leaderboard", async (c) => {
  const period = c.req.query("period") ?? "all"; // all | week | month | today
  const limitParam = Math.min(parseInt(c.req.query("limit") || "10"), 20);
  c.header("Cache-Control", "public, max-age=30");

  const now = Math.floor(Date.now() / 1000);
  let sinceTs: number | null = null;
  let periodLabel = "All Time";

  if (period === "today") {
    sinceTs = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    periodLabel = "Today (UTC)";
  } else if (period === "week") {
    sinceTs = now - 7 * 86400;
    periodLabel = "Last 7 Days";
  } else if (period === "month") {
    sinceTs = now - 30 * 86400;
    periodLabel = "Last 30 Days";
  }

  let leaderboard;

  if (sinceTs !== null) {
    // Time-filtered: compute from bets table
    const betStats = db.select({
      agentId: schema.bets.agentId,
      totalWagered: sql<number>`COALESCE(SUM(${schema.bets.amount}), 0)`,
      totalWon: sql<number>`COALESCE(SUM(${schema.bets.amountWon}), 0)`,
      totalBets: sql<number>`COUNT(*)`,
      wins: sql<number>`SUM(CASE WHEN ${schema.bets.won} = 1 THEN 1 ELSE 0 END)`,
      biggestWin: sql<number>`COALESCE(MAX(${schema.bets.amountWon}), 0)`,
    })
      .from(schema.bets)
      .where(sql`${schema.bets.createdAt} >= ${sinceTs}`)
      .groupBy(schema.bets.agentId)
      .orderBy(desc(sql`SUM(${schema.bets.amountWon}) - SUM(${schema.bets.amount})`))
      .limit(limitParam)
      .all();

    leaderboard = betStats.map((s, i) => ({
      rank: i + 1,
      agent: s.agentId.slice(0, 8) + "...",
      net_profit: Math.round((s.totalWon - s.totalWagered) * 100) / 100,
      total_wagered: Math.round(s.totalWagered * 100) / 100,
      total_bets: s.totalBets,
      win_rate_pct: s.totalBets > 0 ? Math.round((s.wins / s.totalBets) * 10000) / 100 : 0,
      biggest_win: Math.round(s.biggestWin * 100) / 100,
    }));
  } else {
    // All-time: use agents aggregates (faster)
    const agentStats = db.select({
      id: schema.agents.id,
      totalWagered: schema.agents.totalWagered,
      totalWon: schema.agents.totalWon,
    })
      .from(schema.agents)
      .orderBy(desc(sql`${schema.agents.totalWon} - ${schema.agents.totalWagered}`))
      .limit(limitParam)
      .all();

    leaderboard = agentStats.map((a, i) => ({
      rank: i + 1,
      agent: a.id.slice(0, 8) + "...",
      net_profit: Math.round((a.totalWon - a.totalWagered) * 100) / 100,
      total_wagered: Math.round(a.totalWagered * 100) / 100,
    }));
  }

  // Only show agents with positive net profit
  const profitable = leaderboard.filter(e => e.net_profit > 0);

  return c.json({
    period: periodLabel,
    leaderboard: profitable.length > 0 ? profitable : leaderboard.slice(0, limitParam),
    profitable_count: profitable.length,
    period_options: ["today", "week", "month", "all"],
    tip: "Add ?period=week for last 7 days. ?period=today for today's top gainers.",
    updated_at: new Date().toISOString(),
  });
});

// ─── Current win/loss streak ───
stats.get("/streak", (c) => {
  const agentId = c.get("agentId") as string;

  const recentBets = db.select({
    won: schema.bets.won,
    game: schema.bets.game,
    amount: schema.bets.amount,
    amountWon: schema.bets.amountWon,
    createdAt: schema.bets.createdAt,
  })
    .from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .orderBy(desc(schema.bets.createdAt))
    .limit(100)
    .all();

  if (recentBets.length === 0) {
    return c.json({ current_streak: 0, streak_type: null, last_result: null, tip: "Place bets to start building a streak" });
  }

  // Calculate current streak
  const firstResult = recentBets[0].won;
  let currentStreak = 0;
  for (const bet of recentBets) {
    if (bet.won === firstResult) currentStreak++;
    else break;
  }

  // Best win streak across last 100 bets
  let bestWinStreak = 0, tempStreak = 0;
  for (const bet of [...recentBets].reverse()) {
    if (bet.won) { tempStreak++; bestWinStreak = Math.max(bestWinStreak, tempStreak); }
    else tempStreak = 0;
  }

  // Hot/cold analysis per game (last 20 bets)
  const last20 = recentBets.slice(0, 20);
  const gameStats: Record<string, { wins: number; total: number }> = {};
  for (const b of last20) {
    if (!gameStats[b.game]) gameStats[b.game] = { wins: 0, total: 0 };
    gameStats[b.game].total++;
    if (b.won) gameStats[b.game].wins++;
  }

  const hotGames = Object.entries(gameStats)
    .filter(([, s]) => s.total >= 3 && s.wins / s.total > 0.6)
    .map(([g, s]) => ({ game: g, win_rate: Math.round(s.wins / s.total * 100), sample: s.total }));

  const coldGames = Object.entries(gameStats)
    .filter(([, s]) => s.total >= 3 && s.wins / s.total < 0.35)
    .map(([g, s]) => ({ game: g, win_rate: Math.round(s.wins / s.total * 100), sample: s.total }));

  const streakEmoji = firstResult
    ? (currentStreak >= 5 ? "🔥" : currentStreak >= 3 ? "✅" : "➕")
    : (currentStreak >= 5 ? "🧊" : "❌");

  return c.json({
    current_streak: currentStreak,
    streak_type: firstResult ? "winning" : "losing",
    streak_emoji: streakEmoji,
    last_result: { won: recentBets[0].won, game: recentBets[0].game, amount: recentBets[0].amount },
    best_win_streak_last_100: bestWinStreak,
    recent_win_rate: Math.round(last20.filter(b => b.won).length / Math.max(1, last20.length) * 100),
    hot_games: hotGames,
    cold_games: coldGames,
    sample_size: Math.min(recentBets.length, 100),
  });
});

// ─── Agent-to-agent payment ───
// Transfer casino balance from one agent to another
stats.post("/pay", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json().catch(() => ({}));
  const { to_agent_id, amount, memo } = body as { to_agent_id?: string; amount?: number; memo?: string };

  if (!to_agent_id || !amount) {
    return c.json({
      error: "invalid_request",
      message: "Provide to_agent_id and amount",
      example: { to_agent_id: "ag_abc123", amount: 5.00, memo: "Thanks for the signal" },
    }, 400);
  }

  if (typeof amount !== "number" || amount < 0.01) {
    return c.json({ error: "invalid_amount", message: "Amount must be at least $0.01" }, 400);
  }

  if (to_agent_id === agentId) {
    return c.json({ error: "same_agent", message: "Cannot pay yourself" }, 400);
  }

  // Verify recipient exists
  const recipient = db.select().from(schema.agents).where(eq(schema.agents.id, to_agent_id)).get();
  if (!recipient) {
    return c.json({ error: "recipient_not_found", message: `Agent ${to_agent_id} not found` }, 404);
  }

  // Check sender balance
  const senderBalance = ledger.getBalance(agentId);
  if (senderBalance < amount) {
    return c.json({
      error: "insufficient_balance",
      message: `Your balance $${senderBalance.toFixed(2)} is less than $${amount.toFixed(2)}`,
    }, 400);
  }

  const txId = `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Math.floor(Date.now() / 1000);

  // Atomic: debit sender, credit recipient
  ledger.debit(agentId, amount, "payment_sent", "payment", txId);
  ledger.credit(to_agent_id, amount, "payment_received", "payment", txId);

  // Update agent stats
  db.update(schema.agents)
    .set({ lastActive: now })
    .where(eq(schema.agents.id, agentId))
    .run();

  return c.json({
    tx_id: txId,
    from: agentId,
    to: to_agent_id,
    amount,
    memo: memo ?? null,
    sender_new_balance: ledger.getBalance(agentId),
    timestamp: new Date(now * 1000).toISOString(),
    message: `$${amount.toFixed(2)} sent to ${to_agent_id}`,
    note: "Payments are instant and irreversible within the casino platform.",
  });
});

export { stats };
