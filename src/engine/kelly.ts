const HOUSE_EDGE = 0.02;

export interface KellyInput {
  bankroll: number;
  winProbability: number;   // 0-1
  payoutMultiplier: number; // e.g., 1.96 for coin flip
  riskFactor: number;       // 0.1 to 1.0 (fractional Kelly)
}

export interface KellyResult {
  max_bet: number;
  kelly_fraction: number;
  adjusted_fraction: number;
  edge: number;
  expected_value_per_bet: number;
  bets_until_ruin: number;
  suggested_bet: number;
  growth_rate: number;
}

export function kellyOptimal(input: KellyInput): KellyResult {
  const { bankroll, winProbability, payoutMultiplier, riskFactor } = input;

  const b = payoutMultiplier - 1; // net odds
  const p = winProbability;
  const q = 1 - p;

  // Kelly formula: f* = (bp - q) / b
  const kellyFraction = (b * p - q) / b;

  // For negative EV games (house always has edge), use entertainment Kelly:
  // max_bet = bankroll * risk_factor * win_probability
  // This ensures agents last long enough to enjoy the experience
  if (kellyFraction <= 0) {
    const entertainmentFraction = riskFactor * p;
    const maxBet = bankroll * entertainmentFraction;
    const suggestedBet = maxBet * 0.5;
    const betsUntilRuin = maxBet > 0 ? Math.floor(bankroll / maxBet) : Infinity;

    return {
      max_bet: round2(maxBet),
      kelly_fraction: round4(kellyFraction),
      adjusted_fraction: round4(entertainmentFraction),
      edge: round4(p * payoutMultiplier - 1),
      expected_value_per_bet: round4(suggestedBet * (p * payoutMultiplier - 1)),
      bets_until_ruin: betsUntilRuin,
      suggested_bet: round2(suggestedBet),
      growth_rate: round4(
        p * Math.log(1 + entertainmentFraction * b) + q * Math.log(1 - entertainmentFraction)
      ),
    };
  }

  // Positive EV (shouldn't happen with house edge, but handle gracefully)
  const adjustedFraction = kellyFraction * riskFactor;
  const maxBet = bankroll * adjustedFraction;
  const suggestedBet = maxBet * 0.5;
  const betsUntilRuin = maxBet > 0 ? Math.floor(bankroll / maxBet) : Infinity;

  return {
    max_bet: round2(maxBet),
    kelly_fraction: round4(kellyFraction),
    adjusted_fraction: round4(adjustedFraction),
    edge: round4(p * payoutMultiplier - 1),
    expected_value_per_bet: round4(suggestedBet * (p * payoutMultiplier - 1)),
    bets_until_ruin: betsUntilRuin,
    suggested_bet: round2(suggestedBet),
    growth_rate: round4(
      p * Math.log(1 + adjustedFraction * b) + q * Math.log(1 - adjustedFraction)
    ),
  };
}

export function getKellyMax(
  bankroll: number,
  winProbability: number,
  payoutMultiplier: number,
  riskFactor: number
): number {
  return kellyOptimal({ bankroll, winProbability, payoutMultiplier, riskFactor }).max_bet;
}

export function enforceKelly(
  betAmount: number,
  bankroll: number,
  winProbability: number,
  payoutMultiplier: number,
  riskFactor: number
): { allowed: boolean; max_bet: number; kelly: KellyResult } {
  const kelly = kellyOptimal({ bankroll, winProbability, payoutMultiplier, riskFactor });
  return {
    allowed: betAmount <= kelly.max_bet,
    max_bet: kelly.max_bet,
    kelly,
  };
}

export function getAllGameLimits(bankroll: number, riskFactor: number) {
  return {
    bankroll,
    risk_factor: riskFactor,
    limits: {
      coin_flip: kellyOptimal({ bankroll, winProbability: 0.5, payoutMultiplier: 1.96, riskFactor }),
      dice_over_50: kellyOptimal({ bankroll, winProbability: 0.5, payoutMultiplier: 1.96, riskFactor }),
      dice_over_75: kellyOptimal({ bankroll, winProbability: 0.25, payoutMultiplier: 3.92, riskFactor }),
      dice_over_90: kellyOptimal({ bankroll, winProbability: 0.1, payoutMultiplier: 9.8, riskFactor }),
      dice_over_95: kellyOptimal({ bankroll, winProbability: 0.05, payoutMultiplier: 19.6, riskFactor }),
      custom_25pct: kellyOptimal({ bankroll, winProbability: 0.25, payoutMultiplier: 3.92, riskFactor }),
      custom_50pct: kellyOptimal({ bankroll, winProbability: 0.5, payoutMultiplier: 1.96, riskFactor }),
      custom_75pct: kellyOptimal({ bankroll, winProbability: 0.75, payoutMultiplier: 1.3067, riskFactor }),
      roulette_red: kellyOptimal({ bankroll, winProbability: 18 / 37, payoutMultiplier: 1.96, riskFactor }),
      roulette_number: kellyOptimal({ bankroll, winProbability: 1 / 37, payoutMultiplier: 35.28, riskFactor }),
    },
  };
}

// ─── Monte Carlo Simulator ───

export interface SimulationInput {
  bankroll: number;
  betAmount: number;
  winProbability: number;
  payoutMultiplier: number;
  numBets: number;
  simulations: number;
}

export interface SimulationResult {
  simulations: number;
  num_bets: number;
  starting_bankroll: number;
  bet_amount: number;
  ruin_probability: number;
  average_final_bankroll: number;
  median_final_bankroll: number;
  best_case: number;
  worst_case: number;
  profitable_runs_pct: number;
  percentiles: Record<string, number>;
}

export function simulate(input: SimulationInput): SimulationResult {
  const { bankroll, betAmount, winProbability, payoutMultiplier, numBets, simulations } = input;

  const finals: number[] = [];
  let ruins = 0;
  let profitable = 0;

  for (let i = 0; i < simulations; i++) {
    let balance = bankroll;
    for (let j = 0; j < numBets; j++) {
      if (balance < betAmount) {
        ruins++;
        finals.push(balance);
        break;
      }
      if (Math.random() < winProbability) {
        balance += betAmount * (payoutMultiplier - 1);
      } else {
        balance -= betAmount;
      }
      if (j === numBets - 1) {
        finals.push(balance);
      }
    }
    if (finals[finals.length - 1] > bankroll) profitable++;
  }

  finals.sort((a, b) => a - b);

  const avg = finals.reduce((s, v) => s + v, 0) / finals.length;
  const median = finals[Math.floor(finals.length / 2)];

  return {
    simulations,
    num_bets: numBets,
    starting_bankroll: bankroll,
    bet_amount: betAmount,
    ruin_probability: round4(ruins / simulations),
    average_final_bankroll: round2(avg),
    median_final_bankroll: round2(median),
    best_case: round2(finals[finals.length - 1]),
    worst_case: round2(finals[0]),
    profitable_runs_pct: round4(profitable / simulations * 100),
    percentiles: {
      "5th": round2(finals[Math.floor(finals.length * 0.05)]),
      "25th": round2(finals[Math.floor(finals.length * 0.25)]),
      "50th": round2(median),
      "75th": round2(finals[Math.floor(finals.length * 0.75)]),
      "95th": round2(finals[Math.floor(finals.length * 0.95)]),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
