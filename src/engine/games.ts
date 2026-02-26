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
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: { error: "invalid_amount", message: "Bet amount must be a positive finite number" } };
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

  const betId = `bet_${randomUUID()}`;
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

  // Track wagering progress toward first-deposit bonus completion
  const activeBonus = db.select()
    .from(schema.depositBonuses)
    .where(and(
      eq(schema.depositBonuses.agentId, agentId),
      eq(schema.depositBonuses.status, "active"),
    ))
    .get();
  if (activeBonus) {
    const newWagered = Math.round((activeBonus.wageredSoFar + amount) * 100) / 100;
    const completed = newWagered >= activeBonus.wageringRequired;
    db.update(schema.depositBonuses)
      .set({
        wageredSoFar: newWagered,
        ...(completed ? { status: "completed", completedAt: Math.floor(Date.now() / 1000) } : {}),
      })
      .where(eq(schema.depositBonuses.id, activeBonus.id))
      .run();
    if (completed) {
      console.log(`[deposit-bonus] Agent ${agentId} completed wagering requirement — bonus unlocked`);
    }
  }

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

  // ─── Referral Commission (10% of net loss, 3-level chain) ───
  if (!won) {
    const houseProfit = amount;
    const bettor = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (bettor?.referredBy) {
      // Level multipliers: L1=100%, L2=50%, L3=25%
      const levelMultipliers = [1.0, 0.5, 0.25];
      let currentReferredId = agentId;
      let currentReferrerId: string | null = bettor.referredBy;
      for (let level = 0; level < 3 && currentReferrerId; level++) {
        const levelCommission = round2(houseProfit * 0.10 * levelMultipliers[level]);
        if (levelCommission >= 0.01) {
          ledger.credit(currentReferrerId, levelCommission, `referral_commission_l${level + 1}:${betId}`, "casino");
          db.update(schema.referrals)
            .set({ totalEarned: sql`${schema.referrals.totalEarned} + ${levelCommission}` })
            .where(and(
              eq(schema.referrals.referrerId, currentReferrerId),
              eq(schema.referrals.referredId, currentReferredId)
            ))
            .run();
        }
        // Walk up the chain
        const nextReferrer = db.select().from(schema.agents).where(eq(schema.agents.id, currentReferrerId)).get();
        currentReferredId = currentReferrerId;
        currentReferrerId = nextReferrer?.referredBy ?? null;
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

// ─── Blackjack ───

// Card values: 2-10 = face value, J/Q/K = 10, A = 11 (or 1 if bust)
const CARD_NAMES = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function cardValue(card: string): number {
  if (["J","Q","K"].includes(card)) return 10;
  if (card === "A") return 11;
  return parseInt(card, 10);
}

function handValue(cards: string[]): number {
  let total = cards.reduce((sum, c) => sum + cardValue(c), 0);
  let aces = cards.filter(c => c === "A").length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function dealCard(result: number, offset: number): string {
  // Map a 0-100 float + offset to one of 52 card positions
  const idx = Math.floor(((result + offset * 7.3) % 100) / 100 * 52);
  return CARD_NAMES[idx % 13];
}

export function playBlackjack(
  agentId: string,
  action: "hit" | "stand" | "double",
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  // House edge ~2% (dealer hits soft 17, blackjack pays 1.5x)
  const winProb = 0.42; // approximate BJ win probability
  const payout = action === "double" ? 2.0 : 1.5;

  // For doubles, reserve double the amount
  const betAmount = action === "double" ? amount * 2 : amount;

  const validation = validateAndReserve(agentId, betAmount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);

  // Deal hands using deterministic card generation from result
  const playerCard1 = dealCard(result, 0);
  const playerCard2 = dealCard(result, 1);
  const dealerCard1 = dealCard(result, 2);
  const dealerCard2 = dealCard(result, 3);

  let playerCards = [playerCard1, playerCard2];
  let dealerCards = [dealerCard1, dealerCard2];

  // Player blackjack (natural 21) — immediate 1.5x win
  const playerNatural = handValue(playerCards) === 21;
  const dealerNatural = handValue(dealerCards) === 21;

  let won = false;
  let finalPayout = payout;
  let outcome = "stand";

  if (playerNatural && !dealerNatural) {
    won = true;
    finalPayout = 1.5;
    outcome = "blackjack";
  } else if (dealerNatural && !playerNatural) {
    won = false;
    outcome = "dealer_blackjack";
  } else if (playerNatural && dealerNatural) {
    // Push — return bet (simulate as win with 1.0x)
    won = true;
    finalPayout = 1.0;
    outcome = "push";
  } else {
    // Hit: draw one more card for player
    if (action === "hit" || action === "double") {
      playerCards.push(dealCard(result, 4));
    }

    const playerTotal = handValue(playerCards);

    // Dealer draws to 17+
    let dealerOffset = 5;
    while (handValue(dealerCards) < 17) {
      dealerCards.push(dealCard(result, dealerOffset++));
    }
    const dealerTotal = handValue(dealerCards);

    if (playerTotal > 21) {
      won = false;
      outcome = "bust";
    } else if (dealerTotal > 21) {
      won = true;
      finalPayout = action === "double" ? 2.0 : 1.0;
      outcome = "dealer_bust";
    } else if (playerTotal > dealerTotal) {
      won = true;
      finalPayout = action === "double" ? 2.0 : 1.0;
      outcome = "win";
    } else if (playerTotal === dealerTotal) {
      won = true;
      finalPayout = 1.0; // push
      outcome = "push";
    } else {
      won = false;
      outcome = "lose";
    }
  }

  return settleBet(
    agentId, betId, betAmount, won, finalPayout,
    "blackjack",
    {
      action,
      player_cards: playerCards,
      player_total: handValue(playerCards),
      dealer_cards: dealerCards,
      dealer_total: handValue(dealerCards),
      outcome,
      win_probability: round4(winProb),
      roll: round2(result),
    },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Crash ───

export function playCrash(
  agentId: string,
  cashOutAt: number,
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  if (cashOutAt < 1.01 || cashOutAt > 100) {
    return { error: "invalid_cashout", message: "Cash-out multiplier must be between 1.01x and 100x" };
  }

  // Win probability = (1 - house_edge) / cashOutAt
  const winProb = (1 - HOUSE_EDGE) / cashOutAt;
  const payout = cashOutAt;

  const validation = validateAndReserve(agentId, amount, winProb, payout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);

  // Crash point calculation — same curve as multiplier
  const crashPoint = result >= 99.99
    ? 10000
    : round2((1 - HOUSE_EDGE) / (1 - result / 100));

  const won = crashPoint >= cashOutAt;

  return settleBet(
    agentId, betId, amount, won, payout,
    "crash",
    {
      cash_out_at: cashOutAt,
      crash_point: crashPoint,
      cashed_out: won,
      win_probability: round4(winProb),
      roll: round2(result),
    },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Plinko ───

// Payout tables by risk level and number of rows
const PLINKO_PAYOUTS: Record<string, Record<number, number[]>> = {
  low: {
    8:  [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
    12: [10, 3, 1.6, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 1.6, 3, 10],
    16: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1.0, 0.5, 1.0, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
  },
  medium: {
    8:  [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    12: [33, 11, 4, 2, 0.6, 0.3, 0.2, 0.3, 0.6, 2, 4, 11, 33],
    16: [110, 41, 10, 5, 3, 1.5, 1.0, 0.5, 0.3, 0.5, 1.0, 1.5, 3, 5, 10, 41, 110],
  },
  high: {
    8:  [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
    12: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
    16: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};

export function playPlinko(
  agentId: string,
  rows: 8 | 12 | 16,
  risk: "low" | "medium" | "high",
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  if (![8, 12, 16].includes(rows)) {
    return { error: "invalid_rows", message: "Rows must be 8, 12, or 16" };
  }
  if (!["low", "medium", "high"].includes(risk)) {
    return { error: "invalid_risk", message: "Risk must be low, medium, or high" };
  }

  const payouts = PLINKO_PAYOUTS[risk][rows];
  const slots = payouts.length; // rows + 1 slots

  // Win probability: approximate expected value ≈ 0.97 (3% house edge embedded in payout table)
  // Use average payout to estimate win probability for Kelly
  const avgPayout = payouts.reduce((s, p) => s + p, 0) / slots;
  const winProb = 0.5; // each row is 50/50, so overall ~50% chance of beating 1x

  const validation = validateAndReserve(agentId, amount, winProb, avgPayout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const result = calculateResult(seed.seed, cs, nonce);
  const resultHash = getResultHash(seed.seed, cs, nonce);

  // Simulate plinko path: each row, ball goes left or right
  // Use successive bits of the result hash to determine direction
  const path: ("L" | "R")[] = [];
  let position = 0; // starts at 0, ends at 0..rows
  for (let row = 0; row < rows; row++) {
    // Use different sub-results for each row
    const rowResult = calculateResult(seed.seed, `${cs}_row${row}`, nonce);
    const goRight = rowResult < 50;
    path.push(goRight ? "R" : "L");
    if (goRight) position++;
  }

  const multiplier = payouts[position];
  // Plinko always returns something (0.2x–1000x), so always "won" — multiplier drives payout
  const won = true;

  return settleBet(
    agentId, betId, amount, won, multiplier,
    "plinko",
    {
      rows,
      risk,
      path,
      slot: position,
      multiplier,
      payout_table: payouts,
      roll: round2(result),
    },
    seed.seed, seed.seedHash, cs, nonce, resultHash
  );
}

// ─── Slots ───

// Symbols and their relative weights (higher = more common)
// 7 = jackpot (rare), BAR = high, BELL = mid, CHERRY = common, LEMON = common, ORANGE = common, GRAPE = common
const SLOTS_SYMBOLS = ["7", "BAR", "BELL", "CHERRY", "LEMON", "ORANGE", "GRAPE"] as const;
type SlotSymbol = typeof SLOTS_SYMBOLS[number];

// Weights for random symbol generation (total = 100 per reel)
const SLOTS_WEIGHTS: Record<SlotSymbol, number> = {
  "7":      2,
  "BAR":    5,
  "BELL":   8,
  "CHERRY": 20,
  "LEMON":  22,
  "ORANGE": 21,
  "GRAPE":  22,
};

// Payout table: 3-of-a-kind multipliers
const SLOTS_PAYOUTS: Record<SlotSymbol, number> = {
  "7":      250,  // jackpot
  "BAR":    50,
  "BELL":   25,
  "CHERRY": 10,
  "LEMON":  5,
  "ORANGE": 5,
  "GRAPE":  5,
};

// Special: any 3 of the same → use table above
// Any 2 CHERRY → 2x, any 1 CHERRY on reel 1 → 1x (return bet)
// BAR + BAR + anything → 5x
// Expected value ≈ 0.96 (4% house edge)

function pickSymbol(seed: string, clientSeed: string, nonce: number, reel: number): SlotSymbol {
  const result = calculateResult(seed, `${clientSeed}_reel${reel}`, nonce);
  // Map result (0-100) to weighted symbol
  let cumulative = 0;
  for (const sym of SLOTS_SYMBOLS) {
    cumulative += SLOTS_WEIGHTS[sym];
    if (result < cumulative) return sym;
  }
  return "GRAPE"; // fallback
}

export function playSlots(
  agentId: string,
  amount: number,
  clientSeed?: string
): BetResult | GameError {
  // Approximate win probability for Kelly (about 30% chance of landing a paying combo)
  const winProb = 0.35;
  const avgPayout = 3.0; // rough expected payout given win

  const validation = validateAndReserve(agentId, amount, winProb, avgPayout);
  if (!validation.ok) return validation.error;

  const { betId } = validation;
  const seed = getOrCreateActiveSeed(agentId);
  const nonce = incrementNonce(seed.id);
  const cs = clientSeed || `auto_${Date.now()}`;

  const resultHash = getResultHash(seed.seed, cs, nonce);
  const roll = calculateResult(seed.seed, cs, nonce); // used for proof only

  const reel1 = pickSymbol(seed.seed, cs, nonce, 1);
  const reel2 = pickSymbol(seed.seed, cs, nonce, 2);
  const reel3 = pickSymbol(seed.seed, cs, nonce, 3);

  const reels = [reel1, reel2, reel3];

  let multiplier = 0;
  let payline = "none";

  if (reel1 === reel2 && reel2 === reel3) {
    // Three of a kind
    multiplier = SLOTS_PAYOUTS[reel1];
    payline = `3x ${reel1}`;
  } else if (reel1 === "BAR" && reel2 === "BAR") {
    // Double BAR (first two reels)
    multiplier = 5;
    payline = "BAR BAR";
  } else {
    // Cherry specials
    const cherries = reels.filter(r => r === "CHERRY").length;
    if (cherries === 3) {
      multiplier = SLOTS_PAYOUTS["CHERRY"];
      payline = "3x CHERRY";
    } else if (cherries === 2) {
      multiplier = 2;
      payline = "2x CHERRY";
    } else if (reel1 === "CHERRY") {
      multiplier = 1; // return bet on leftmost cherry
      payline = "1x CHERRY";
    }
  }

  const won = multiplier > 0;

  return settleBet(
    agentId, betId, amount, won, Math.max(multiplier, 0),
    "slots",
    {
      reels,
      payline,
      multiplier,
      payout_table: {
        "3x 7 (jackpot)": "250x",
        "3x BAR": "50x",
        "3x BELL": "25x",
        "3x CHERRY": "10x",
        "3x LEMON/ORANGE/GRAPE": "5x",
        "BAR BAR (2-reel)": "5x",
        "2x CHERRY": "2x",
        "1x CHERRY (reel 1)": "1x",
      },
      roll: round2(roll),
    },
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
  action?: "hit" | "stand" | "double";
  cash_out_at?: number;
  rows?: 8 | 12 | 16;
  risk?: "low" | "medium" | "high";
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
      case "blackjack":
        return playBlackjack(agentId, bet.action || "stand", bet.amount, bet.client_seed);
      case "crash":
        return playCrash(agentId, bet.cash_out_at || 2, bet.amount, bet.client_seed);
      case "plinko":
        return playPlinko(agentId, bet.rows || 8, bet.risk || "low", bet.amount, bet.client_seed);
      case "slots":
        return playSlots(agentId, bet.amount, bet.client_seed);
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
    case "blackjack": return 0.42;
    case "crash": return (result.win_probability as number) || 0.5;
    case "plinko": return 0.5;
    case "slots": return 0.35;
    default: return 0.5;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
