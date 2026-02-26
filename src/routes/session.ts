import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, sql, desc } from "drizzle-orm";
import type { AppEnv } from "../types.js";

const session = new Hono<AppEnv>();

// ─── GET /session/current — active session stats (bets in last 4 hours with <30min gap) ───

session.get("/current", (c) => {
  const agentId = c.get("agentId") as string;
  const fourHoursAgo = Math.floor(Date.now() / 1000) - 4 * 3600;

  const recentBets = db.select({
    id: schema.bets.id,
    game: schema.bets.game,
    amount: schema.bets.amount,
    amountWon: schema.bets.amountWon,
    won: schema.bets.won,
    payoutMultiplier: schema.bets.payoutMultiplier,
    createdAt: schema.bets.createdAt,
  }).from(schema.bets)
    .where(and(
      eq(schema.bets.agentId, agentId),
      sql`${schema.bets.createdAt} >= ${fourHoursAgo}`
    ))
    .orderBy(desc(schema.bets.createdAt))
    .all();

  if (recentBets.length === 0) {
    return c.json({
      session_active: false,
      message: "No activity in the last 4 hours",
      start_playing: "POST /api/v1/bets/batch",
    });
  }

  // Find continuous session: bets with < 30min gap from most recent
  const SESSION_GAP_SECS = 30 * 60; // 30 minutes
  const sessionBets: typeof recentBets = [];
  let prevTs = recentBets[0].createdAt;

  for (const bet of recentBets) {
    if (prevTs - bet.createdAt > SESSION_GAP_SECS) break; // gap too large — session ended
    sessionBets.push(bet);
    prevTs = bet.createdAt;
  }

  const totalWagered = sessionBets.reduce((s, b) => s + b.amount, 0);
  const totalWon = sessionBets.reduce((s, b) => s + b.amountWon, 0);
  const wins = sessionBets.filter(b => b.won).length;
  const losses = sessionBets.filter(b => !b.won).length;
  const netPnl = totalWon - totalWagered;
  const sessionStart = sessionBets[sessionBets.length - 1].createdAt;
  const sessionEnd = sessionBets[0].createdAt;
  const durationSecs = sessionEnd - sessionStart;

  // Game breakdown
  const byGame: Record<string, { bets: number; wagered: number; won: number; wins: number }> = {};
  for (const bet of sessionBets) {
    if (!byGame[bet.game]) byGame[bet.game] = { bets: 0, wagered: 0, won: 0, wins: 0 };
    byGame[bet.game].bets++;
    byGame[bet.game].wagered += bet.amount;
    byGame[bet.game].won += bet.amountWon;
    if (bet.won) byGame[bet.game].wins++;
  }

  const gameBreakdown = Object.entries(byGame).map(([game, stats]) => ({
    game,
    bets: stats.bets,
    wagered: Math.round(stats.wagered * 100) / 100,
    won: Math.round(stats.won * 100) / 100,
    net: Math.round((stats.won - stats.wagered) * 100) / 100,
    win_rate_pct: stats.bets > 0 ? Math.round((stats.wins / stats.bets) * 10000) / 100 : 0,
  })).sort((a, b) => b.bets - a.bets);

  // Trend: is it getting better or worse? Compare first half vs second half
  const half = Math.floor(sessionBets.length / 2);
  const firstHalfBets = sessionBets.slice(half); // older bets (reversed order)
  const secondHalfBets = sessionBets.slice(0, half); // newer bets

  const firstHalfPnl = firstHalfBets.reduce((s, b) => s + b.amountWon - b.amount, 0);
  const secondHalfPnl = secondHalfBets.reduce((s, b) => s + b.amountWon - b.amount, 0);
  const trend = sessionBets.length < 4 ? "insufficient_data"
    : secondHalfPnl > firstHalfPnl ? "improving"
    : secondHalfPnl < firstHalfPnl ? "declining"
    : "stable";

  // Kelly warning: check if they're overbetting
  const agent = db.select({ balanceUsd: schema.agents.balanceUsd, riskFactor: schema.agents.riskFactor })
    .from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  const balance = agent?.balanceUsd ?? 0;
  const riskFactor = agent?.riskFactor ?? 0.25;
  const kellyMax = Math.round(balance * riskFactor * 100) / 100;
  const avgBet = sessionBets.length > 0 ? totalWagered / sessionBets.length : 0;
  const kellyWarning = avgBet > kellyMax * 1.5
    ? `Average bet ($${Math.round(avgBet * 100) / 100}) exceeds Kelly max ($${kellyMax}). Consider reducing size.`
    : null;

  return c.json({
    session_active: true,
    session: {
      started_at: new Date(sessionStart * 1000).toISOString(),
      last_bet_at: new Date(sessionEnd * 1000).toISOString(),
      duration_minutes: Math.round(durationSecs / 60),
      total_bets: sessionBets.length,
      wins,
      losses,
      win_rate_pct: sessionBets.length > 0 ? Math.round((wins / sessionBets.length) * 10000) / 100 : 0,
      total_wagered: Math.round(totalWagered * 100) / 100,
      total_won: Math.round(totalWon * 100) / 100,
      net_pnl: Math.round(netPnl * 100) / 100,
      roi_pct: totalWagered > 0 ? Math.round((netPnl / totalWagered) * 10000) / 100 : 0,
      biggest_win: Math.round(Math.max(...sessionBets.filter(b => b.won).map(b => b.amountWon), 0) * 100) / 100,
      biggest_loss: Math.round(Math.max(...sessionBets.filter(b => !b.won).map(b => b.amount), 0) * 100) / 100,
      trend,
      game_breakdown: gameBreakdown,
    },
    balance_now: Math.round(balance * 100) / 100,
    kelly_max_bet: kellyMax,
    ...(kellyWarning ? { kelly_warning: kellyWarning } : {}),
    advice: netPnl > 0
      ? `You're up $${Math.round(netPnl * 100) / 100} this session. ${trend === "declining" ? "Trend is declining — consider banking profits." : "Keep sizing within Kelly limits."}`
      : `You're down $${Math.round(Math.abs(netPnl) * 100) / 100} this session. Avoid chasing losses — stick to Kelly sizing.`,
  });
});

// ─── GET /session/history — paginated list of past sessions ───

session.get("/history", (c) => {
  const agentId = c.get("agentId") as string;
  const limit = Math.min(parseInt(c.req.query("limit") || "10"), 50);
  const offset = parseInt(c.req.query("offset") || "0");
  const SESSION_GAP_SECS = 30 * 60;

  // Get all bets ordered by time
  const allBets = db.select({
    game: schema.bets.game,
    amount: schema.bets.amount,
    amountWon: schema.bets.amountWon,
    won: schema.bets.won,
    createdAt: schema.bets.createdAt,
  }).from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .orderBy(desc(schema.bets.createdAt))
    .all();

  if (allBets.length === 0) {
    return c.json({
      sessions: [],
      total_sessions: 0,
      pagination: { limit, offset, has_more: false },
      tip: "Place your first bet: POST /api/v1/bets/batch",
    });
  }

  // Group into sessions: split when gap > 30min
  const sessions: Array<{
    started_at: string;
    ended_at: string;
    duration_minutes: number;
    total_bets: number;
    wins: number;
    losses: number;
    win_rate_pct: number;
    total_wagered: number;
    net_pnl: number;
    best_game: string | null;
    top_game_by_bets: string | null;
  }> = [];

  let currentSession: typeof allBets = [];

  for (let i = 0; i < allBets.length; i++) {
    const bet = allBets[i];
    const next = allBets[i + 1];

    currentSession.push(bet);

    const isLastBet = !next;
    const bigGap = next && (bet.createdAt - next.createdAt > SESSION_GAP_SECS);

    if (isLastBet || bigGap) {
      // Flush session
      const sessionEnd = currentSession[0].createdAt;
      const sessionStart = currentSession[currentSession.length - 1].createdAt;
      const wagered = currentSession.reduce((s, b) => s + b.amount, 0);
      const won = currentSession.reduce((s, b) => s + b.amountWon, 0);
      const sessionWins = currentSession.filter(b => b.won).length;

      // Best game by net PnL
      const gameNet: Record<string, number> = {};
      const gameCount: Record<string, number> = {};
      for (const b of currentSession) {
        gameNet[b.game] = (gameNet[b.game] ?? 0) + b.amountWon - b.amount;
        gameCount[b.game] = (gameCount[b.game] ?? 0) + 1;
      }
      const bestGame = Object.entries(gameNet).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const topGameByBets = Object.entries(gameCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      sessions.push({
        started_at: new Date(sessionStart * 1000).toISOString(),
        ended_at: new Date(sessionEnd * 1000).toISOString(),
        duration_minutes: Math.round((sessionEnd - sessionStart) / 60),
        total_bets: currentSession.length,
        wins: sessionWins,
        losses: currentSession.length - sessionWins,
        win_rate_pct: Math.round((sessionWins / currentSession.length) * 10000) / 100,
        total_wagered: Math.round(wagered * 100) / 100,
        net_pnl: Math.round((won - wagered) * 100) / 100,
        best_game: bestGame,
        top_game_by_bets: topGameByBets,
      });

      currentSession = [];
    }
  }

  const totalSessions = sessions.length;
  const paginated = sessions.slice(offset, offset + limit);

  // Summary across all sessions
  const avgNetPnl = sessions.length > 0
    ? Math.round((sessions.reduce((s, sess) => s + sess.net_pnl, 0) / sessions.length) * 100) / 100
    : 0;
  const bestSession = sessions.reduce((best, s) => s.net_pnl > (best?.net_pnl ?? -Infinity) ? s : best, sessions[0] ?? null);
  const worstSession = sessions.reduce((worst, s) => s.net_pnl < (worst?.net_pnl ?? Infinity) ? s : worst, sessions[0] ?? null);

  return c.json({
    sessions: paginated,
    pagination: {
      total: totalSessions,
      limit,
      offset,
      has_more: offset + limit < totalSessions,
    },
    all_time_summary: {
      total_sessions: totalSessions,
      avg_net_pnl_per_session: avgNetPnl,
      best_session_pnl: bestSession ? bestSession.net_pnl : null,
      worst_session_pnl: worstSession ? worstSession.net_pnl : null,
      profitable_sessions: sessions.filter(s => s.net_pnl > 0).length,
      losing_sessions: sessions.filter(s => s.net_pnl < 0).length,
    },
    tip: "GET /api/v1/session/current for your active session. A session ends after 30min of inactivity.",
  });
});

export { session };
