import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, or, sql } from "drizzle-orm";
import { ledger } from "../wallet/ledger.js";
import {
  playCoinFlip,
  playDice,
  playMultiplier,
  playRoulette,
  playCustom,
} from "../engine/games.js";
import type { AppEnv } from "../types.js";

const challenges = new Hono<AppEnv>();

const HOUSE_TAKE = 0.02; // 2% house cut on challenge winnings

function round2(n: number) { return Math.round(n * 100) / 100; }

// ─── POST /challenge ───

challenges.post("/", async (c) => {
  const challengerId = c.get("agentId") as string;
  let body: { challenged_agent_id?: string; game?: string; amount?: number; message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }
  const { challenged_agent_id, game, amount, message } = body;

  if (!challenged_agent_id || !game || amount == null) {
    return c.json({ error: "missing_fields", message: "Provide challenged_agent_id, game, amount" }, 400);
  }

  if (challenged_agent_id === challengerId) {
    return c.json({ error: "self_challenge", message: "You cannot challenge yourself" }, 400);
  }

  const validGames = ["coin_flip", "dice", "multiplier", "roulette", "custom"];
  if (!validGames.includes(game)) {
    return c.json({ error: "invalid_game", message: `Game must be one of: ${validGames.join(", ")}` }, 400);
  }

  if (typeof amount !== "number" || amount < 0.01) {
    return c.json({ error: "invalid_amount", message: "Amount must be at least $0.01" }, 400);
  }

  // Verify challenged agent exists
  const challenged = db.select().from(schema.agents)
    .where(eq(schema.agents.id, challenged_agent_id)).get();
  if (!challenged) return c.json({ error: "agent_not_found", message: "Challenged agent not found" }, 404);

  // Check challenger balance
  const challengerBalance = ledger.getBalance(challengerId);
  if (challengerBalance < amount) {
    return c.json({ error: "insufficient_balance", message: `You need $${amount} but have $${round2(challengerBalance)}` }, 400);
  }

  // Check challenged agent balance
  const challengedBalance = ledger.getBalance(challenged_agent_id);
  if (challengedBalance < amount) {
    return c.json({ error: "opponent_insufficient_balance", message: `Opponent needs $${amount} but has $${round2(challengedBalance)}` }, 400);
  }

  // Hold challenger's funds in escrow
  const deducted = ledger.debit(challengerId, amount, `challenge_escrow:pending`, "casino");
  if (!deducted) return c.json({ error: "escrow_failed", message: "Could not reserve your funds" }, 400);

  const id = `chl_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  db.insert(schema.challenges).values({
    id,
    challengerId,
    challengedId: challenged_agent_id,
    game,
    amount,
    status: "pending",
    message: message ?? null,
  }).run();

  return c.json({
    challenge_id: id,
    challenger_id: challengerId,
    challenged_id: challenged_agent_id,
    game, amount,
    status: "pending",
    message: "Challenge created. Opponent's funds will be held when they accept.",
    note: `Your $${amount} is in escrow. If declined, it will be returned.`,
  }, 201);
});

// ─── GET /challenges ───

challenges.get("/", (c) => {
  const agentId = c.get("agentId") as string;

  const incoming = db.select().from(schema.challenges)
    .where(and(
      eq(schema.challenges.challengedId, agentId),
      eq(schema.challenges.status, "pending"),
    )).all();

  const outgoing = db.select().from(schema.challenges)
    .where(and(
      eq(schema.challenges.challengerId, agentId),
      eq(schema.challenges.status, "pending"),
    )).all();

  const resolved = db.select().from(schema.challenges)
    .where(and(
      or(
        eq(schema.challenges.challengerId, agentId),
        eq(schema.challenges.challengedId, agentId),
      )!,
      sql`${schema.challenges.status} IN ('accepted', 'declined')`,
    ))
    .orderBy(sql`${schema.challenges.resolvedAt} DESC`)
    .limit(20).all();

  return c.json({
    incoming: incoming.map(c => ({
      id: c.id, challenger_id: c.challengerId, game: c.game,
      amount: c.amount, message: c.message, created_at: c.createdAt,
    })),
    outgoing: outgoing.map(c => ({
      id: c.id, challenged_id: c.challengedId, game: c.game,
      amount: c.amount, message: c.message, created_at: c.createdAt,
    })),
    resolved: resolved.map(c => ({
      id: c.id, challenger_id: c.challengerId, challenged_id: c.challengedId,
      game: c.game, amount: c.amount, status: c.status, winner_id: c.winnerId,
      resolved_at: c.resolvedAt,
    })),
  });
});

// ─── POST /challenges/:id/accept ───

challenges.post("/:id/accept", async (c) => {
  const agentId = c.get("agentId") as string;
  const id = c.req.param("id");

  const challenge = db.select().from(schema.challenges)
    .where(eq(schema.challenges.id, id)).get();

  if (!challenge) return c.json({ error: "not_found" }, 404);
  if (challenge.challengedId !== agentId) {
    return c.json({ error: "forbidden", message: "Only the challenged agent can accept" }, 403);
  }
  if (challenge.status !== "pending") {
    return c.json({ error: "already_resolved", message: `Challenge is already ${challenge.status}` }, 400);
  }

  // Check body for game params
  const body = await c.req.json().catch(() => ({}));

  // Hold challenged agent's funds in escrow
  const challengedFunds = ledger.debit(agentId, challenge.amount, `challenge_escrow:${id}`, "casino");
  if (!challengedFunds) {
    return c.json({ error: "insufficient_balance", message: `You need $${challenge.amount} to accept` }, 400);
  }

  // Play the game using challenger's identity as RNG source (but result is agentId-agnostic)
  // We use the challenger's agentId for the seed (they initiated), and play using the game engine
  // The "loser" doesn't get a bet placed — only one play determines the outcome
  let gameResult: any;
  const playerId = challenge.challengerId; // challenger's seed used for fairness

  switch (challenge.game) {
    case "coin_flip": {
      const side = "heads"; // challenger always calls heads; tails = challenged wins
      gameResult = playCoinFlip(playerId, side, challenge.amount, id);
      break;
    }
    case "dice": {
      // Over 50 = challenger wins
      gameResult = playDice(playerId, "over", 50, challenge.amount, id);
      break;
    }
    case "multiplier": {
      // Default 2x for even odds
      const target = body.target_multiplier ?? 2.0;
      gameResult = playMultiplier(playerId, target, challenge.amount, id);
      break;
    }
    case "roulette": {
      const betType = body.bet_type ?? "red";
      gameResult = playRoulette(playerId, betType, body.bet_value, challenge.amount, id);
      break;
    }
    case "custom": {
      const prob = body.win_probability ?? 50;
      gameResult = playCustom(playerId, prob, challenge.amount, id);
      break;
    }
    default:
      // Refund both and error
      ledger.credit(agentId, challenge.amount, `challenge_refund:${id}`, "casino");
      ledger.credit(challenge.challengerId, challenge.amount, `challenge_refund:${id}`, "casino");
      return c.json({ error: "invalid_game" }, 400);
  }

  if ("error" in gameResult) {
    // Game error — refund challenged agent and mark as error
    ledger.credit(agentId, challenge.amount, `challenge_refund:${id}`, "casino");
    // Challenger funds already deducted when challenge was created — refund them too
    ledger.credit(challenge.challengerId, challenge.amount, `challenge_refund:${id}`, "casino");
    return c.json({ error: "game_failed", detail: gameResult }, 400);
  }

  // game was played using challenger's balance, deducting their amount
  // Now determine: if challenger WON the game → challenger wins the challenge
  // The game already settled the bet against challenger's balance
  // We need to also transfer the challenged agent's escrowed funds to winner

  const challengerWon = gameResult.won;
  const winnerId = challengerWon ? challenge.challengerId : agentId;
  const loserId = challengerWon ? agentId : challenge.challengerId;

  // Prize pool = both amounts. Game already paid challenger their own payout.
  // We need to give the winner the OPPONENT's escrowed amount (minus house cut).
  const opponentEscrow = challenge.amount;
  const houseCut = round2(opponentEscrow * HOUSE_TAKE);
  const winnerPayout = round2(opponentEscrow - houseCut);

  // Transfer loser's escrow to winner
  ledger.credit(winnerId, winnerPayout, `challenge_win:${id}`, "casino");

  // If challenger won: challenger already got their payout from the game engine.
  // The challenged agent (loser) already had funds deducted from escrow. ✓
  // If challenged won: refund the challenged agent's escrow they just lost in game + give them challenger's escrow
  // But wait — game was played with challenger's funds. Challenged agent's escrow is already held.
  // Challenger lost the game → their own bet was already settled (lost). Challenged agent gets their opponent's escrow.
  // The game engine already settled challenger's bet. We just need to handle the escrow transfer.

  // Challenged agent: if they won, give back their own escrow + opponent's (minus house)
  if (!challengerWon) {
    // Give challenged agent back their own escrow (they "win" overall)
    ledger.credit(agentId, challenge.amount, `challenge_escrow_return:${id}`, "casino");
  }
  // If challenger won: challenger lost their bet in game engine (net neutral on own funds) + gets challenged's escrow
  // Challenged agent: their escrow is already deducted. ✓

  db.update(schema.challenges).set({
    status: "accepted",
    winnerId,
    resolvedAt: Math.floor(Date.now() / 1000),
  }).where(eq(schema.challenges.id, id)).run();

  return c.json({
    challenge_id: id,
    winner: winnerId,
    loser: loserId,
    game: challenge.game,
    amount: challenge.amount,
    house_cut: houseCut,
    payout_to_winner: winnerPayout,
    game_result: gameResult.result,
    proof: gameResult.proof,
    message: `${winnerId === challenge.challengerId ? "Challenger" : "Challenged agent"} wins!`,
  });
});

// ─── POST /challenges/:id/decline ───

challenges.post("/:id/decline", async (c) => {
  const agentId = c.get("agentId") as string;
  const id = c.req.param("id");

  const challenge = db.select().from(schema.challenges)
    .where(eq(schema.challenges.id, id)).get();

  if (!challenge) return c.json({ error: "not_found" }, 404);
  if (challenge.challengedId !== agentId) {
    return c.json({ error: "forbidden", message: "Only the challenged agent can decline" }, 403);
  }
  if (challenge.status !== "pending") {
    return c.json({ error: "already_resolved", message: `Challenge is already ${challenge.status}` }, 400);
  }

  // Refund challenger's escrowed funds
  ledger.credit(challenge.challengerId, challenge.amount, `challenge_refund:${id}`, "casino");

  db.update(schema.challenges).set({
    status: "declined",
    resolvedAt: Math.floor(Date.now() / 1000),
  }).where(eq(schema.challenges.id, id)).run();

  return c.json({ challenge_id: id, status: "declined", message: "Challenge declined. Challenger's funds have been returned." });
});

// ─── GET /challenges/open — public list of open challenges (no auth) ───
// NOTE: registered in index.ts before auth middleware, so it bypasses auth
challenges.get("/open", (c) => {
  const open = db.select({
    id: schema.challenges.id,
    challengerId: schema.challenges.challengerId,
    game: schema.challenges.game,
    amount: schema.challenges.amount,
    createdAt: schema.challenges.createdAt,
  }).from(schema.challenges)
    .where(eq(schema.challenges.status, "pending"))
    .orderBy(sql`${schema.challenges.createdAt} DESC`)
    .limit(20)
    .all();

  return c.json({
    open_challenges: open.map(c => ({
      id: c.id,
      challenger: c.challengerId.slice(0, 8) + "...",
      game: c.game,
      amount: c.amount,
      posted_at: new Date(c.createdAt * 1000).toISOString(),
      how_to_accept: `POST /api/v1/challenges/${c.id}/accept (requires auth)`,
    })),
    tip: "Register to challenge or accept challenges: POST /api/v1/auth/register",
    updated_at: new Date().toISOString(),
  });
});

export { challenges };
