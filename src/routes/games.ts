import { Hono } from "hono";
import {
  playCoinFlip,
  playDice,
  playMultiplier,
  playRoulette,
  playCustom,
  playBlackjack,
  playCrash,
  playPlinko,
  playSlots,
  playSimpleDice,
  playHiLo,
  playKeno,
  playScratchCard,
  playVideoPokerDeal,
  playVideoPokerDraw,
  playBatch,
  playWheel,
  playMines,
  playBaccarat,
} from "../engine/games.js";
import type { AppEnv } from "../types.js";
import { checkRateLimit } from "../middleware/rateLimit.js";

const games = new Hono<AppEnv>();

// ─── List available games ───

games.get("/", (c) => {
  return c.json({
    games: [
      {
        id: "coin_flip",
        name: "Coin Flip",
        description: "Choose heads or tails. 50/50 odds.",
        house_edge: "0.5%",
        payout: "1.96x",
        endpoint: "POST /api/v1/games/coin-flip",
        params: { side: "heads | tails", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "dice",
        name: "Dice Roll",
        description: "Roll 1-100. Bet over or under a threshold. Variable odds.",
        house_edge: "0.5%",
        payout: "Variable (e.g. over 50 = 1.96x, over 90 = 9.8x)",
        endpoint: "POST /api/v1/games/dice",
        params: { direction: "over | under", threshold: "1-99", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "multiplier",
        name: "Multiplier (Crash)",
        description: "Pick a target multiplier. If the crash point exceeds it, you win.",
        house_edge: "0.5%",
        payout: "Your target multiplier (1.01x - 1000x)",
        endpoint: "POST /api/v1/games/multiplier",
        params: { target_multiplier: "1.01-1000", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "roulette",
        name: "Roulette",
        description: "European roulette (0-36). Bet on number, color, odd/even, high/low, dozens, columns.",
        house_edge: "0.5%",
        payout: "Varies by bet type",
        endpoint: "POST /api/v1/games/roulette",
        params: {
          bet_type: "number | red | black | odd | even | high | low | dozen_1 | dozen_2 | dozen_3 | column_1 | column_2 | column_3",
          bet_value: "0-36 (for number bets)",
          amount: "number",
          client_seed: "string (optional)",
        },
      },
      {
        id: "custom",
        name: "Custom Odds",
        description: "Define your own win probability (1-99%). API calculates fair payout minus house edge.",
        house_edge: "0.5%",
        payout: "Calculated: (1 / probability) * 0.98",
        endpoint: "POST /api/v1/games/custom",
        params: { win_probability: "1-99 (percentage)", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "blackjack",
        name: "Blackjack",
        description: "Beat the dealer to 21 without going bust. Stand, hit, or double down. Blackjack pays 1.5x.",
        house_edge: "~2%",
        payout: "1x win, 1.5x blackjack, 2x double-down win",
        endpoint: "POST /api/v1/games/blackjack",
        params: { action: "hit | stand | double", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "crash",
        name: "Crash",
        description: "Set your cash-out multiplier before the round starts. Win if the crash point exceeds your target.",
        house_edge: "0.5%",
        payout: "Your cash-out multiplier (1.01x - 100x)",
        endpoint: "POST /api/v1/games/crash",
        params: { cash_out_at: "1.01-100 (multiplier)", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "plinko",
        name: "Plinko",
        description: "Drop a ball through a peg grid. Landing slot determines payout multiplier.",
        house_edge: "~3%",
        payout: "Depends on rows + risk level (up to 1000x on 16-row high risk)",
        endpoint: "POST /api/v1/games/plinko",
        params: { rows: "8 | 12 | 16", risk: "low | medium | high", amount: "number", client_seed: "string (optional)" },
      },
      {
        id: "slots",
        name: "Slots",
        description: "3-reel slot machine with 7 symbols. Jackpot 250x on triple 7s. Provably fair.",
        house_edge: "~4%",
        payout: "1x (cherry) to 250x (triple 7)",
        endpoint: "POST /api/v1/games/slots",
        params: { amount: "number", client_seed: "string (optional)" },
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
      },
      {
        id: "simple_dice",
        name: "Simple Dice",
        description: "Pick a number 1-6. If the die rolls your number, you win 5.5x. House edge 8.3%.",
        house_edge: "8.3%",
        payout: "5.5x",
        endpoint: "POST /api/v1/games/simple-dice",
        params: { pick: "1-6 (integer)", amount: "number", client_seed: "string (optional)" },
        example: { pick: 3, amount: 10, "expected_if_win": 55 },
      },
      {
        id: "hilo",
        name: "Hi-Lo Card",
        description: "A card is dealt (A-K). Guess if the next card is higher or lower. Payout scales with risk. Equal cards = push (no loss).",
        house_edge: "~4%",
        payout: "1.05x (easy) to 12x (long shot)",
        endpoint: "POST /api/v1/games/hilo",
        params: { guess: "higher | lower", amount: "number", client_seed: "string (optional)" },
        example: { guess: "higher", amount: 5, note: "Payout depends on first card — higher card = harder to guess higher" },
      },
      {
        id: "keno",
        name: "Keno",
        description: "Pick 1-10 numbers from 1-80. House draws 20 numbers. Payout scales with how many of your picks are drawn. Up to 250,000x jackpot for 10/10.",
        house_edge: "~8%",
        payout: "3.5x (1-spot catch) to 250,000x (10/10 match)",
        endpoint: "POST /api/v1/games/keno",
        params: { picks: "array of 1-10 integers (1-80)", amount: "number", client_seed: "string (optional)" },
        example: { picks: [7, 14, 21, 42, 77], amount: 5 },
        payout_table: {
          "1 spot: catch 1": "3.5x",
          "2 spots: catch 2": "16x",
          "3 spots: 2 catch=2x, 3 catch=50x": "",
          "5 spots: 3=3x, 4=25x, 5=1000x": "",
          "10 spots: 5=10x, 7=500x, 10=250000x": "",
        },
      },
      {
        id: "wheel",
        name: "Wheel of Fortune",
        description: "Spin the wheel! 8 sectors ranging from 💥 BUST to 🎉 10x jackpot. Pure luck, provably fair.",
        house_edge: "~9.5%",
        payout: "0x (BUST) / 0.5x / 1x / 1.5x / 2x / 3x / 5x / 10x",
        endpoint: "POST /api/v1/games/wheel",
        params: { amount: "number", client_seed: "string (optional)" },
        sectors: { bust_0x: "35%", half_0_5x: "25%", even_1x: "15%", one_5x: "10%", double_2x: "8%", triple_3x: "4%", fiver_5x: "2%", jackpot_10x: "1%" },
      },
      {
        id: "scratch_card",
        name: "Scratch Card",
        description: "Reveal 3 symbols. Triple match wins big. Any pair wins 2x. Instant result, provably fair.",
        house_edge: "~10%",
        payout: "2x (pair) to 50x (triple diamond)",
        endpoint: "POST /api/v1/games/scratch-card",
        params: { amount: "number", client_seed: "string (optional)" },
        symbols: ["💎 50x", "7️⃣ 20x", "⭐ 15x", "🍀 12x", "🔔 8x", "🍒 5x", "pair 2x"],
      },
      {
        id: "mines",
        name: "Mines",
        description: "5x5 grid with hidden mines. Reveal cells left-to-right, top-to-bottom. More mines + more reveals = higher payout. Hit a mine and you lose it all. Provably fair.",
        house_edge: "2.5%",
        payout: "Scales with risk: 1 mine 1 reveal=1.02x, 3 mines 5 reveals=~6x, 10 mines 10 reveals=~130x",
        endpoint: "POST /api/v1/games/mines",
        params: { mines: "1-24 (mines on the grid)", reveals: "1 to 25-mines (tiles to reveal)", amount: "number", client_seed: "string (optional)" },
        example: { mines: 3, reveals: 5, amount: 10, note: "3 mines, reveal 5 tiles — moderate risk" },
      },
      {
        id: "video_poker",
        name: "Video Poker (Jacks or Better)",
        description: "2-phase game: deal 5 cards, choose which to hold, draw replacements. Payout based on final poker hand. ~98.5% RTP with optimal play.",
        house_edge: "~1.5% (with optimal strategy)",
        payout: "1x (Jacks or Better) to 800x (Royal Flush)",
        endpoints: {
          deal: "POST /api/v1/games/video-poker/deal — get 5 cards (free, no bet)",
          draw: "POST /api/v1/games/video-poker/draw { holds, nonce, amount } — place bet, draw, evaluate hand",
        },
        payout_table: {
          "Royal Flush": "800x", "Straight Flush": "50x", "Four of a Kind": "25x",
          "Full House": "9x", "Flush": "6x", "Straight": "4x",
          "Three of a Kind": "3x", "Two Pair": "2x", "Jacks or Better": "1x",
        },
        workflow: "1. POST /deal to see your hand. 2. Decide which cards to hold. 3. POST /draw with holds array + nonce from deal + your bet amount.",
      },
      {
        id: "baccarat",
        name: "Baccarat",
        description: "Classic card game — bet on Player, Banker, or Tie. Banker has lowest house edge (1.06%). Two or three cards dealt per side per standard baccarat rules.",
        house_edge: "Player 1.24% | Banker 1.06% | Tie 14.4%",
        payout: "Player 1:1, Banker 0.95:1, Tie 8:1",
        endpoint: "POST /api/v1/games/baccarat",
        params: { bet_on: "player | banker | tie", amount: "number", client_seed: "string (optional)" },
        example: { bet_on: "banker", amount: 10, note: "Banker has the lowest house edge — optimal strategy" },
      },
    ],
    batch_endpoint: "POST /api/v1/bets/batch",
    note: "All bets enforce Kelly Criterion max sizing. Use GET /api/v1/kelly/limits to see your current limits.",
  });
});

// ─── Coin Flip ───

games.post("/coin-flip", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { side, amount, client_seed } = await c.req.json();

  if (!["heads", "tails"].includes(side)) {
    return c.json({ error: "invalid_side", message: "Side must be 'heads' or 'tails'" }, 400);
  }

  const result = playCoinFlip(agentId, side, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Dice ───

games.post("/dice", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { direction, threshold, amount, client_seed } = await c.req.json();

  if (!["over", "under"].includes(direction)) {
    return c.json({ error: "invalid_direction", message: "Direction must be 'over' or 'under'" }, 400);
  }

  const result = playDice(agentId, direction, threshold, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Multiplier ───

games.post("/multiplier", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { target_multiplier, amount, client_seed } = await c.req.json();

  const result = playMultiplier(agentId, target_multiplier, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Roulette ───

games.post("/roulette", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { bet_type, bet_value, amount, client_seed } = await c.req.json();

  const result = playRoulette(agentId, bet_type, bet_value, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Custom Odds ───

games.post("/custom", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { win_probability, amount, client_seed } = await c.req.json();

  const result = playCustom(agentId, win_probability, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Blackjack ───

games.post("/blackjack", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { action, amount, client_seed } = await c.req.json();

  if (!["hit", "stand", "double"].includes(action)) {
    return c.json({ error: "invalid_action", message: "Action must be 'hit', 'stand', or 'double'" }, 400);
  }

  const result = playBlackjack(agentId, action, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Crash ───

games.post("/crash", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { cash_out_at, amount, client_seed } = await c.req.json();

  const result = playCrash(agentId, cash_out_at, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Plinko ───

games.post("/plinko", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { rows, risk, amount, client_seed } = await c.req.json();

  const result = playPlinko(agentId, rows, risk, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Slots ───

games.post("/slots", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { amount, client_seed } = await c.req.json();

  const result = playSlots(agentId, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Simple Dice (pick 1-6, win 5.5x, 8.3% house edge) ───

games.post("/simple-dice", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { pick, amount, client_seed } = await c.req.json();

  const result = playSimpleDice(agentId, pick, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Hi-Lo Card Game ───

games.post("/hilo", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { guess, amount, client_seed } = await c.req.json();

  if (!["higher", "lower"].includes(guess)) {
    return c.json({ error: "invalid_guess", message: "Guess must be 'higher' or 'lower'" }, 400);
  }

  const result = playHiLo(agentId, guess, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Keno ───

games.post("/keno", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const { picks, amount, client_seed } = body;

  if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
    return c.json({ error: "invalid_picks", message: "picks must be an array of 1-10 unique integers between 1-80", example: { picks: [7, 14, 21, 42, 77], amount: 5 } }, 400);
  }

  const result = playKeno(agentId, picks, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Wheel of Fortune ───

games.post("/wheel", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { amount, client_seed } = await c.req.json().catch(() => ({}));

  const result = playWheel(agentId, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Mines ───

games.post("/mines", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const { mines, reveals, amount, client_seed } = body;

  if (!Number.isInteger(mines) || mines < 1 || mines > 24) {
    return c.json({ error: "invalid_mines", message: "mines must be an integer 1-24", example: { mines: 3, reveals: 5, amount: 10 } }, 400);
  }
  if (!Number.isInteger(reveals) || reveals < 1 || reveals > 25 - mines) {
    return c.json({ error: "invalid_reveals", message: `reveals must be 1 to ${25 - mines} for ${mines} mines`, example: { mines: 3, reveals: 5, amount: 10 } }, 400);
  }

  const result = playMines(agentId, mines, reveals, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Scratch Card ───

games.post("/scratch-card", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { amount, client_seed } = await c.req.json().catch(() => ({}));

  const result = playScratchCard(agentId, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Video Poker ───

// Phase 1: Deal (free - no bet, just shows cards)
games.post("/video-poker/deal", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const { client_seed } = body;

  const result = playVideoPokerDeal(agentId, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// Phase 2: Draw (places bet)
games.post("/video-poker/draw", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const { holds, nonce, amount, client_seed } = body;

  if (!Array.isArray(holds) || holds.length !== 5) {
    return c.json({
      error: "invalid_holds",
      message: "holds must be an array of exactly 5 booleans",
      example: { holds: [true, false, true, true, false], nonce: 42, amount: 5 },
    }, 400);
  }

  const result = playVideoPokerDraw(agentId, nonce, holds, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// ─── Baccarat ───

games.post("/baccarat", async (c) => {
  const agentId = c.get("agentId") as string;
  const rl = checkRateLimit(agentId, "games", 60);
  if (!rl.allowed) {
    return c.json({ error: "rate_limit_exceeded", message: "Max 60 game requests/min", reset_at: new Date(rl.resetAt).toISOString() }, 429);
  }
  const { bet_on, amount, client_seed } = await c.req.json().catch(() => ({}));

  const result = playBaccarat(agentId, bet_on, amount, client_seed);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

export { games };
