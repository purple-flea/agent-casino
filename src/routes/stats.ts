import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, count, and, gte } from "drizzle-orm";
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

  return c.json({
    leaderboard: topAgents.map((a, i) => ({
      rank: i + 1,
      agent_id: a.id.slice(0, 6) + "...", // partially anonymized
      total_wagered: Math.round(a.totalWagered * 100) / 100,
      total_won: Math.round(a.totalWon * 100) / 100,
      net_profit: Math.round(a.netProfit * 100) / 100,
    })),
    updated_at: new Date().toISOString(),
  });
});

export { stats };
