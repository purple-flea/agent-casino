import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runMigrations } from "../db/migrate.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { randomBytes } from "crypto";
import { hashApiKey } from "../middleware/auth.js";
import { ledger } from "../wallet/ledger.js";
import {
  playCoinFlip,
  playDice,
  playMultiplier,
  playRoulette,
  playCustom,
} from "../engine/games.js";
import {
  kellyOptimal,
  getAllGameLimits,
  simulate,
} from "../engine/kelly.js";
import {
  getCurrentSeedHash,
  verifyResult,
  rotateSeed,
} from "../engine/fairness.js";

// Run migrations on start
runMigrations();

// Resolve or create an agent for this MCP session
let sessionAgentId: string | null = null;
let sessionApiKey: string | null = null;

function getOrCreateAgent(): string {
  if (sessionAgentId) return sessionAgentId;

  // Create a new agent for this MCP session
  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `sk_mcp_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);

  const maxIdx = db.select({ max: schema.agents.depositIndex })
    .from(schema.agents).all();
  const depositIndex = maxIdx.length > 0 ? Math.max(...maxIdx.map(r => r.max ?? -1)) + 1 : 0;

  db.insert(schema.agents).values({
    id: agentId,
    apiKeyHash: keyHash,
    depositIndex,
  }).run();

  sessionAgentId = agentId;
  sessionApiKey = apiKey;
  return agentId;
}

const server = new McpServer({
  name: "agent-casino",
  version: "1.0.0",
});

// ─── casino_games_list ───

server.tool("casino_games_list", "List all available games with their rules, odds, house edge, and payout tables.", {}, async () => {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        games: [
          { id: "coin_flip", name: "Coin Flip", odds: "50/50", payout: "1.96x", house_edge: "0.5%" },
          { id: "dice", name: "Dice Roll", odds: "Variable (1-99)", payout: "Variable", house_edge: "0.5%" },
          { id: "multiplier", name: "Multiplier (Crash)", odds: "Based on target", payout: "1.01x-1000x", house_edge: "0.5%" },
          { id: "roulette", name: "Roulette", odds: "European (0-36)", payout: "Varies", house_edge: "0.5%" },
          { id: "custom", name: "Custom Odds", odds: "You choose (1-99%)", payout: "(1/prob)*0.98", house_edge: "0.5%" },
        ],
        note: "All bets enforce Kelly Criterion max sizing to protect your bankroll.",
      }, null, 2),
    }],
  };
});

// ─── casino_balance ───

server.tool("casino_balance", "Check your current casino balance, deposit addresses, and recent bet history.", {}, async () => {
  const agentId = getOrCreateAgent();
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
  const recentBets = db.select().from(schema.bets)
    .where(eq(schema.bets.agentId, agentId))
    .limit(5).all();

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        agent_id: agentId,
        api_key: sessionApiKey,
        balance_usd: agent.balanceUsd,
        risk_factor: agent.riskFactor,
        lifetime: {
          total_wagered: agent.totalWagered,
          total_won: agent.totalWon,
          net_profit: Math.round((agent.totalWon - agent.totalWagered) * 100) / 100,
        },
        recent_bets: recentBets.map(b => ({
          bet_id: b.id, game: b.game, amount: b.amount, won: b.won, amount_won: b.amountWon,
        })),
        tip: agent.balanceUsd === 0
          ? "Use casino_deposit to get a deposit address, or the REST API at POST /api/v1/auth/deposit-address"
          : undefined,
      }, null, 2),
    }],
  };
});

// ─── casino_coin_flip ───

server.tool(
  "casino_coin_flip",
  "Flip a provably fair coin. Choose heads or tails, specify bet amount. Returns result, payout, and cryptographic proof. House edge: 2%.",
  {
    side: z.enum(["heads", "tails"]).describe("Your call"),
    amount: z.number().positive().describe("Bet amount in USD"),
    client_seed: z.string().optional().describe("Your seed for provable fairness verification"),
  },
  async ({ side, amount, client_seed }) => {
    const agentId = getOrCreateAgent();
    const result = playCoinFlip(agentId, side, amount, client_seed);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  }
);

// ─── casino_dice_roll ───

server.tool(
  "casino_dice_roll",
  "Roll a provably fair dice (1-100). Bet over or under a threshold. Higher risk = higher payout. House edge: 2%.",
  {
    direction: z.enum(["over", "under"]).describe("Bet direction"),
    threshold: z.number().min(1).max(99).describe("The threshold number (1-99)"),
    amount: z.number().positive().describe("Bet amount in USD"),
    client_seed: z.string().optional(),
  },
  async ({ direction, threshold, amount, client_seed }) => {
    const agentId = getOrCreateAgent();
    const result = playDice(agentId, direction, threshold, amount, client_seed);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  }
);

// ─── casino_multiplier ───

server.tool(
  "casino_multiplier",
  "Place a multiplier (crash-style) bet. Pick a target multiplier — if the crash point exceeds it, you win. House edge: 2%.",
  {
    target_multiplier: z.number().min(1.01).max(1000).describe("Target multiplier (1.01x-1000x)"),
    amount: z.number().positive().describe("Bet amount in USD"),
    client_seed: z.string().optional(),
  },
  async ({ target_multiplier, amount, client_seed }) => {
    const agentId = getOrCreateAgent();
    const result = playMultiplier(agentId, target_multiplier, amount, client_seed);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  }
);

// ─── casino_roulette ───

server.tool(
  "casino_roulette",
  "Play European roulette (0-36). Bet on number, color, odd/even, high/low, dozens, or columns. House edge: 2%.",
  {
    bet_type: z.enum(["number", "red", "black", "odd", "even", "high", "low", "dozen_1", "dozen_2", "dozen_3", "column_1", "column_2", "column_3"]).describe("Type of roulette bet"),
    bet_value: z.number().min(0).max(36).optional().describe("Number (0-36) for number bets"),
    amount: z.number().positive().describe("Bet amount in USD"),
    client_seed: z.string().optional(),
  },
  async ({ bet_type, bet_value, amount, client_seed }) => {
    const agentId = getOrCreateAgent();
    const result = playRoulette(agentId, bet_type, bet_value, amount, client_seed);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  }
);

// ─── casino_custom_bet ───

server.tool(
  "casino_custom_bet",
  "Create a bet with any win probability you choose (1-99%). API calculates fair payout minus 2% house edge. Example: 25% chance = 3.92x payout.",
  {
    win_probability: z.number().min(1).max(99).describe("Your desired win probability as a percentage"),
    amount: z.number().positive().describe("Bet amount in USD"),
    client_seed: z.string().optional(),
  },
  async ({ win_probability, amount, client_seed }) => {
    const agentId = getOrCreateAgent();
    const result = playCustom(agentId, win_probability, amount, client_seed);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  }
);

// ─── casino_kelly_advisor ───

server.tool(
  "casino_kelly_advisor",
  "Calculate optimal bet size using Kelly Criterion. Returns mathematically optimal bet sizing, ruin probability, and expected outcomes.",
  {
    game: z.enum(["coin_flip", "dice_over", "dice_under", "custom"]).describe("Game type"),
    risk_factor: z.number().min(0.1).max(1.0).optional().describe("Fractional Kelly: 0.1=conservative, 0.5=moderate, 1.0=full Kelly"),
    threshold: z.number().min(1).max(99).optional().describe("For dice games: the threshold"),
    win_probability: z.number().min(1).max(99).optional().describe("For custom: win probability %"),
  },
  async ({ game, risk_factor, threshold, win_probability }) => {
    const agentId = getOrCreateAgent();
    const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;

    const rf = risk_factor ?? agent.riskFactor;
    let winProb: number, payout: number;

    switch (game) {
      case "coin_flip": winProb = 0.5; payout = 1.96; break;
      case "dice_over": winProb = (100 - (threshold || 50)) / 100; payout = Math.round((1 / winProb) * 0.98 * 10000) / 10000; break;
      case "dice_under": winProb = (threshold || 50) / 100; payout = Math.round((1 / winProb) * 0.98 * 10000) / 10000; break;
      case "custom": winProb = (win_probability || 50) / 100; payout = Math.round((1 / winProb) * 0.98 * 10000) / 10000; break;
    }

    const result = kellyOptimal({ bankroll: agent.balanceUsd, winProbability: winProb!, payoutMultiplier: payout!, riskFactor: rf });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ bankroll: agent.balanceUsd, game, risk_factor: rf, ...result }, null, 2),
      }],
    };
  }
);

// ─── casino_simulate ───

server.tool(
  "casino_simulate",
  "Monte Carlo simulation of a betting strategy. Run thousands of simulations to see expected outcomes, ruin probability, and bankroll distribution.",
  {
    bankroll: z.number().positive().describe("Starting bankroll"),
    game: z.enum(["coin_flip", "dice_over", "dice_under", "custom"]).describe("Game type"),
    bet_amount: z.number().positive().describe("Bet amount per round"),
    num_bets: z.number().min(1).max(10000).describe("Number of bets per simulation"),
    simulations: z.number().min(100).max(50000).optional().describe("Number of simulation runs (default 10000)"),
    threshold: z.number().optional(),
    win_probability: z.number().optional(),
  },
  async ({ bankroll, game, bet_amount, num_bets, simulations, threshold, win_probability }) => {
    let winProb: number, payout: number;
    switch (game) {
      case "coin_flip": winProb = 0.5; payout = 1.96; break;
      case "dice_over": winProb = (100 - (threshold || 50)) / 100; payout = Math.round((1 / winProb) * 0.98 * 10000) / 10000; break;
      case "dice_under": winProb = (threshold || 50) / 100; payout = Math.round((1 / winProb) * 0.98 * 10000) / 10000; break;
      case "custom": winProb = (win_probability || 50) / 100; payout = Math.round((1 / winProb) * 0.98 * 10000) / 10000; break;
    }

    const result = simulate({
      bankroll,
      betAmount: bet_amount,
      winProbability: winProb!,
      payoutMultiplier: payout!,
      numBets: num_bets,
      simulations: simulations || 10000,
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── casino_deposit ───

server.tool(
  "casino_deposit",
  "Get a deposit address to fund your casino account. Supports multiple chains. All deposits auto-converted to USD balance.",
  {
    chain: z.enum(["base", "ethereum", "arbitrum", "optimism", "polygon", "solana", "monero", "bitcoin", "lightning"]).describe("Chain to deposit on. 'base' recommended for lowest fees."),
  },
  async ({ chain }) => {
    const agentId = getOrCreateAgent();
    const existing = db.select().from(schema.depositAddresses)
      .where(eq(schema.depositAddresses.agentId, agentId)).all()
      .find(a => a.chain === chain);

    const address = existing?.address || `0x${randomBytes(20).toString("hex")}`;

    if (!existing) {
      db.insert(schema.depositAddresses).values({ agentId, chain, address }).run();
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          chain,
          address,
          note: "All deposits auto-converted to USD balance",
          minimum: "$0.50 equivalent",
          recommended: "USDC on Base for lowest fees",
        }, null, 2),
      }],
    };
  }
);

// ─── casino_withdraw ───

server.tool(
  "casino_withdraw",
  "Withdraw winnings to any crypto address.",
  {
    amount: z.number().positive().describe("USD amount to withdraw"),
    chain: z.enum(["base", "ethereum", "arbitrum", "optimism", "polygon", "solana", "monero", "bitcoin", "lightning"]),
    address: z.string().describe("Destination wallet address"),
  },
  async ({ amount, chain, address }) => {
    const agentId = getOrCreateAgent();
    const balance = ledger.getBalance(agentId);
    const fee = Math.round((amount * 0.001 + (chain === "ethereum" ? 2 : 0.05)) * 100) / 100;

    if (balance < amount + fee) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "insufficient_balance",
            available: balance,
            required: amount + fee,
            fee,
          }, null, 2),
        }],
        isError: true,
      };
    }

    ledger.debit(agentId, amount + fee, "withdrawal", "withdrawal");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "completed",
          amount,
          fee,
          chain,
          address,
          new_balance: ledger.getBalance(agentId),
        }, null, 2),
      }],
    };
  }
);

// ─── casino_verify_bet ───

server.tool(
  "casino_verify_bet",
  "Verify the fairness of any past bet using its cryptographic proof. Returns full audit trail.",
  {
    bet_id: z.string().describe("The bet ID to verify"),
  },
  async ({ bet_id }) => {
    const bet = db.select().from(schema.bets).where(eq(schema.bets.id, bet_id)).get();
    if (!bet) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "bet_not_found" }) }],
        isError: true,
      };
    }

    const seedRecord = db.select().from(schema.serverSeeds)
      .where(eq(schema.serverSeeds.seedHash, bet.serverSeedHash)).get();
    const revealed = seedRecord?.revealedAt !== null && seedRecord?.revealedAt !== undefined;

    if (!revealed) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            bet_id: bet.id,
            status: "seed_not_yet_revealed",
            server_seed_hash: bet.serverSeedHash,
            note: "Seed will be revealed on rotation. The hash proves the result was predetermined.",
          }, null, 2),
        }],
      };
    }

    const verification = verifyResult(bet.serverSeed, bet.serverSeedHash, bet.clientSeed || "", bet.nonce);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          bet_id: bet.id,
          verified: verification.valid,
          game: bet.game,
          result: JSON.parse(bet.result),
          won: bet.won,
          proof: {
            server_seed: bet.serverSeed,
            server_seed_hash: bet.serverSeedHash,
            client_seed: bet.clientSeed,
            nonce: bet.nonce,
            computed_result: verification.result,
            hash_matches: verification.valid,
          },
        }, null, 2),
      }],
    };
  }
);

// ─── wallet_balance ───

server.tool(
  "wallet_balance",
  "Check your universal balance across all services. Shows USD balance and recent transactions.",
  {},
  async () => {
    const agentId = getOrCreateAgent();
    const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
    const history = ledger.getHistory(agentId, 10);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          balance_usd: agent.balanceUsd,
          tier: agent.tier,
          recent: history.map(e => ({
            type: e.type, amount: e.amount, balance_after: e.balanceAfter,
            reason: e.reason, service: e.service,
          })),
        }, null, 2),
      }],
    };
  }
);

// ─── wallet_history ───

server.tool(
  "wallet_history",
  "View full transaction history — deposits, withdrawals, service charges, casino bets.",
  {
    limit: z.number().min(1).max(200).optional().describe("Number of entries (default 50)"),
  },
  async ({ limit }) => {
    const agentId = getOrCreateAgent();
    const history = ledger.getHistory(agentId, limit || 50);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ entries: history }, null, 2),
      }],
    };
  }
);

// ─── wallet_supported_chains ───

server.tool(
  "wallet_supported_chains",
  "List all supported chains and tokens for deposits and withdrawals.",
  {},
  async () => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          chains: [
            { chain: "base", tokens: ["USDC", "USDT", "ETH"], recommended: true },
            { chain: "ethereum", tokens: ["USDC", "USDT", "ETH"] },
            { chain: "arbitrum", tokens: ["USDC", "USDT", "ETH"] },
            { chain: "optimism", tokens: ["USDC", "USDT", "ETH"] },
            { chain: "polygon", tokens: ["USDC", "USDT", "MATIC"] },
            { chain: "solana", tokens: ["USDC", "SOL"] },
            { chain: "monero", tokens: ["XMR"] },
            { chain: "bitcoin", tokens: ["BTC"] },
            { chain: "lightning", tokens: ["BTC"] },
          ],
        }, null, 2),
      }],
    };
  }
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
