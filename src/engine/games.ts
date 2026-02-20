import { randomUUID } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, sql, and } from "drizzle-orm";
import {
  getOrCreateActiveSeed,
  incrementNonce,
  calculateResult,
  getResultHash,
} from "./fairness.js";
import { enforceKelly, type KellyResult } from "./kelly.js";
import { ledger } from "../wallet/ledger.js";

const HOUSE_EDGE = 0.005;

export interface BetResult {
  bet_id: string;
  game: string;
  amount_bet: number;
  result: Record<string, unknown>;
  won: boolean;
  payout_multiplier: number;
  amount_won: number;
  new_balance: number;
  proof: {
    server_seed_hash: string;
    client_seed: string;
    nonce: number;
    result_hash: string;
  };
  kelly: {
    bankroll: number;
    risk_factor: number;
    max_bet_this_game: number;
    bets_until_ruin: number;
    suggested_bet: number;
  };
}

export interface GameError {
  error: string;
  message: string;
  suggestion?: string;
  max_bet?: number;
  kelly?: KellyResult;
}

function getAgentConfig(agentId: string) {
  return db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .get()!;
}

function validateAndReserve(
  agentId: string,
  amount: number,
  winProbability: number,
  payoutMultiplier: number
): { ok: true; betId: string; agent: typeof schema.agents.$inferSelect } | { ok: false; error: GameError } {
  if (amount <= 0) {
    return { ok: false, error: { error: "invalid_amount", message: "Bet amount must be positive" } };
  }
  if (amount < 0.01) {
    return { ok: false, error: { error: "minimum_bet", message: "Minimum bet is $0.01" } };
  }

  const agent = getAgentConfig(agentId);
  const bankroll = agent.balanceUsd;

  if (bankroll < amount) {
    return {
      ok: false,
      error: {
        error: "insufficient_balance",
        required: amount,
        message: `Balance $${bankroll.toFixed(2)} is less than bet $${amount.toFixed(2)}`,
        suggestion: `Deposit at least $${(amount - bankroll).toFixed(2)} or reduce bet size`,
      } as GameError,
    };
  }

  // Enforce Kelly Criterion
  const kellyCheck = enforceKelly(amount, bankroll, winProbability, payoutMultiplier, agent.riskFactor);
  if (!kellyCheck.allowed) {
    return {
      ok: false,
      error: {
        error: "kelly_limit_exceeded",
        message: `Bet $${amount.toFixed(2)} exceeds Kelly limit of $${kellyCheck.max_bet.toFixed(2)}`,
        max_bet: kellyCheck.max_bet,
        suggestion: `Reduce bet to $${kellyCheck.max_bet.toFixed(2)} or lower. Kelly protects your bankroll from ruin.`,
        kelly: kellyCheck.kelly,
      } as GameError,
    };
  }

  const betId = `bet_${randomUUID().slice(0, 8)}`;
  const reserved = ledger.reserve(agentId, amount, betId);
  if (!reserved) {
    return {
      ok: false,
      error: { error: "insufficient_balance", message: "Could not reserve funds" },
    };
  }

  return { ok: true, betId, agent };
}

function settleBet(
  agentId: string,
  betId: string,
  amount: number,
  won: boolean,
  payoutMultiplier: number,
  game: string,
  resultData: Record<string, unknown>,
  serverSeed: string,
  serverSeedHash: string,
  clientSeed: string,
  nonce: number,
  resultHash: string
): BetResult {
  const amountWon = won ? amount * payoutMultiplier : 0;

  // Release reservation with winnings (or 0 if lost)
  ledger.releaseReservation(agentId, betId, amountWon);

  // Update agent stats
  db.update(schema.agents)
    .set({
      totalWagered: sql`${schema.agents.totalWagered} + ${amount}`,
      totalWon: sql`${schema.agents.totalWon} + ${amountWon}`,
    })
    .where(eq(schema.agents.id, agentId))
    .run();

  const newBalance = ledger.getBalance(agentId);

  // Record bet
  db.insert(schema.bets).values({
    id: betId,
    agentId,
    game,
    amount,
    payoutMultiplier,
    result: JSON.stringify(resultData),
    won,
    amountWon,
    serverSeed,
    serverSeedHash,
    clientSeed,
    nonce,
    resultHash,
  }).run();

  // ─── Referral Commission (10% of net loss on losing bets) ───
  if (!won) {
    const houseProfit = amount; // agent lost full bet
    const bettor = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (bettor?.referredBy) {
      const commission = round2(houseProfit * 0.10);
      if (commission >= 0.01) {
        ledger.credit(bettor.referredBy, commission, `referral_commission:${betId}`, "casino");
        db.update(schema.referrals)
          .set({ totalEarned: sql`${schema.referrals.totalEarned} + ${commission}` })
          .where(and(
            eq(schema.referrals.referrerId, bettor.referredBy),
            eq(schema.referrals.referredId, agentId)
          ))
          .run();
      }
    }
  }

  // Get Kelly info for response
  const agent = getAgentConfig(agentId);
  const winProb = getWinProbForGame(game, resultData);
  const kelly = enforceKelly(amount, newBalance, winProb, payoutMultiplier, agent.riskFactor);

  return {
    bet_id: betId,
    game,
    amount_bet: amount,
    result: resultData,
    won,
    payout_multiplier: payoutMultiplier,
    amount_won: round2(amountWon),
    new_balance: round2(newBalance),
    proof: {
      server_seed_hash: serverSeedHash,
      client_seed: clientSeed,
      nonce,
      result_hash: resultHash,
    },
    kelly: {
      bankroll: round2(newBalance),
      risk_factor: agent.riskFactor,
      max_bet_this_game: kelly.max_bet,
      bets_until_ruin: kelly.kelly.bets_until_ruin,
      suggested_bet: kelly.kelly.suggested_bet,
    },
  };
}

// ─── Coin Flip ───

export function playCoinFlip(
  agentId: string,
  side: "heads" | "tails",
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  const winProb = 0.5;
  const payout = 1.99; // 2% house edge

  const validation = validateAndReserve(agentId, amount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);
  const outcome: "heads" | "tails" = result < 50 ? "heads" : "tails";
  const won = outcome === side;

  return settleBet(
    agentId, betId, amount, won, payout,
    "coin_flip",
    { side_chosen: side, outcome, roll: round2(result) },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Dice Roll ───

export function playDice(
  agentId: string,
  direction: "over" | "under",
  threshold: number,
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  if (threshold < 1 || threshold > 99) {
    return { error: "invalid_threshold", message: "Threshold must be between 1 and 99" };
  }

  const winProb = direction === "over"
    ? (100 - threshold) / 100
    : threshold / 100;
  const fairPayout = 1 / winProb;
  const payout = round4(fairPayout * (1 - HOUSE_EDGE));

  const validation = validateAndReserve(agentId, amount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);
  const diceValue = Math.floor(result) + 1; // 1-100
  const won = direction === "over" ? diceValue > threshold : diceValue < threshold;

  return settleBet(
    agentId, betId, amount, won, payout,
    "dice",
    { direction, threshold, dice_value: diceValue, win_probability: round4(winProb), roll: round2(result) },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Multiplier (Crash-style) ───

export function playMultiplier(
  agentId: string,
  targetMultiplier: number,
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  if (targetMultiplier < 1.01 || targetMultiplier > 1000) {
    return { error: "invalid_multiplier", message: "Target multiplier must be between 1.01x and 1000x" };
  }

  const winProb = (1 - HOUSE_EDGE) / targetMultiplier;
  const payout = targetMultiplier;

  const validation = validateAndReserve(agentId, amount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);

  // Generate crash point: house edge built into the curve
  // crash_point = (1 - house_edge) / (1 - result/100)
  // Capped to avoid infinity when result approaches 100
  const crashPoint = result >= 99.99
    ? 10000
    : round2((1 - HOUSE_EDGE) / (1 - result / 100));

  const won = crashPoint >= targetMultiplier;

  return settleBet(
    agentId, betId, amount, won, payout,
    "multiplier",
    { target_multiplier: targetMultiplier, crash_point: crashPoint, win_probability: round4(winProb), roll: round2(result) },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Roulette ───

type RouletteBetType = "number" | "red" | "black" | "odd" | "even" | "high" | "low" | "dozen_1" | "dozen_2" | "dozen_3" | "column_1" | "column_2" | "column_3";

const RED_NUMBERS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

export function playRoulette(
  agentId: string,
  betType: RouletteBetType,
  betValue: number | undefined,
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  let winProb: number;
  let payout: number;

  switch (betType) {
    case "number":
      if (betValue === undefined || betValue < 0 || betValue > 36) {
        return { error: "invalid_number", message: "Number must be 0-36" };
      }
      winProb = 1 / 37;
      payout = round4(35 * (1 - HOUSE_EDGE));
      break;
    case "red":
    case "black":
    case "odd":
    case "even":
    case "high":
    case "low":
      winProb = 18 / 37;
      payout = round4(2 * (1 - HOUSE_EDGE));
      break;
    case "dozen_1":
    case "dozen_2":
    case "dozen_3":
    case "column_1":
    case "column_2":
    case "column_3":
      winProb = 12 / 37;
      payout = round4(3 * (1 - HOUSE_EDGE));
      break;
    default:
      return { error: "invalid_bet_type", message: `Unknown bet type: ${betType}` };
  }

  const validation = validateAndReserve(agentId, amount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);

  // Map result to 0-36
  const number = Math.floor(result * 37 / 100);
  const isRed = RED_NUMBERS.includes(number);
  const isBlack = number > 0 && !isRed;

  let won = false;
  switch (betType) {
    case "number": won = number === betValue; break;
    case "red": won = isRed; break;
    case "black": won = isBlack; break;
    case "odd": won = number > 0 && number % 2 === 1; break;
    case "even": won = number > 0 && number % 2 === 0; break;
    case "high": won = number >= 19; break;
    case "low": won = number >= 1 && number <= 18; break;
    case "dozen_1": won = number >= 1 && number <= 12; break;
    case "dozen_2": won = number >= 13 && number <= 24; break;
    case "dozen_3": won = number >= 25 && number <= 36; break;
    case "column_1": won = number > 0 && number % 3 === 1; break;
    case "column_2": won = number > 0 && number % 3 === 2; break;
    case "column_3": won = number > 0 && number % 3 === 0; break;
  }

  return settleBet(
    agentId, betId, amount, won, payout,
    "roulette",
    {
      bet_type: betType,
      bet_value: betValue,
      number,
      color: number === 0 ? "green" : isRed ? "red" : "black",
      win_probability: round4(winProb),
      roll: round2(result),
    },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Custom Odds ───

export function playCustom(
  agentId: string,
  winProbabilityPct: number,
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  if (winProbabilityPct < 1 || winProbabilityPct > 99) {
    return { error: "invalid_probability", message: "Win probability must be between 1% and 99%" };
  }

  const winProb = winProbabilityPct / 100;
  const fairPayout = 1 / winProb;
  const payout = round4(fairPayout * (1 - HOUSE_EDGE));

  const validation = validateAndReserve(agentId, amount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);
  const won = result < winProbabilityPct;

  return settleBet(
    agentId, betId, amount, won, payout,
    "custom",
    { win_probability_pct: winProbabilityPct, payout_multiplier: payout, roll: round2(result), threshold: winProbabilityPct },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Batch Betting ───

interface BatchBetInput {
  game: string;
  amount: number;
  side?: "heads" | "tails";
  direction?: "over" | "under";
  threshold?: number;
  target_multiplier?: number;
  bet_type?: RouletteBetType;
  bet_value?: number;
  win_probability?: number;
  client_seed?: string;
}

export function playBatch(agentId: string, bets: BatchBetInput[]): (BetResult | GameError)[] {
  if (bets.length > 20) {
    return [{ error: "too_many_bets", message: "Maximum 20 bets per batch" }];
  }

  return bets.map((bet) => {
    switch (bet.game) {
      case "coin_flip":
        return playCoinFlip(agentId, bet.side || "heads", bet.amount, bet.client_seed);
      case "dice":
        return playDice(agentId, bet.direction || "over", bet.threshold || 50, bet.amount, bet.client_seed);
      case "multiplier":
        return playMultiplier(agentId, bet.target_multiplier || 2, bet.amount, bet.client_seed);
      case "roulette":
        return playRoulette(agentId, (bet.bet_type || "red") as RouletteBetType, bet.bet_value, bet.amount, bet.client_seed);
      case "custom":
        return playCustom(agentId, bet.win_probability || 50, bet.amount, bet.client_seed);
      default:
        return { error: "unknown_game", message: `Unknown game: ${bet.game}` };
    }
  });
}

// Helpers

function getWinProbForGame(game: string, result: Record<string, unknown>): number {
  switch (game) {
    case "coin_flip": return 0.5;
    case "dice": return (result.win_probability as number) || 0.5;
    case "multiplier": return (result.win_probability as number) || 0.5;
    case "roulette": return (result.win_probability as number) || 18 / 37;
    case "custom": return ((result.win_probability_pct as number) || 50) / 100;
    default: return 0.5;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
