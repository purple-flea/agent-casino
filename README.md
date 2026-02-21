# Agent Casino

[![npm version](https://img.shields.io/npm/v/@purpleflea/casino-mcp.svg)](https://www.npmjs.com/package/@purpleflea/casino-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![House Edge](https://img.shields.io/badge/House%20Edge-0.5%25-brightgreen.svg)](https://github.com/purple-flea/agent-casino)

**Provably fair gambling for AI agents.** 0.5% house edge — the lowest in crypto. Coin flip, dice, roulette, crash, and custom odds with Kelly Criterion bankroll protection. Blue chip infrastructure for AI agents by [Purple Flea](https://purpleflea.com).

---

## Why Agent Casino?

| Feature | Details |
|---------|---------|
| **0.5% House Edge** | Lowest in crypto. Most casinos: 1-5%. Ours: 0.5%. |
| **Provably Fair** | Every bet verified with SHA-256 + HMAC. Full audit trail. |
| **Kelly Criterion** | Built-in bankroll protection prevents ruin. Math-optimal sizing. |
| **5 Games** | Coin flip, dice, roulette, crash/multiplier, custom odds |
| **Monte Carlo Sim** | Test any strategy with up to 50,000 simulations before risking capital |
| **Multi-Chain Deposits** | Base, Ethereum, Arbitrum, Solana, Bitcoin, Monero, Lightning |
| **Referral System** | Agents earn **10% commission** on net losses from referred players |
| **MCP Native** | Drop into Claude, GPT, or any MCP-compatible agent |

## Quick Start

### As an MCP Server (Claude Desktop / Claude Code)

```bash
npx @purpleflea/casino-mcp
```

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "casino": {
      "command": "npx",
      "args": ["-y", "@purpleflea/casino-mcp"]
    }
  }
}
```

### As a REST API

```bash
git clone https://github.com/purple-flea/agent-casino.git
cd agent-casino
npm install
npm run dev
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `casino_games_list` | List all games with odds, payouts, and house edge |
| `casino_coin_flip` | Flip a provably fair coin — heads or tails, 1.96x payout |
| `casino_dice_roll` | Roll 1-100, bet over/under a threshold. Variable payout. |
| `casino_multiplier` | Crash-style game — pick a target (1.01x-1000x) |
| `casino_roulette` | European roulette — number, color, odd/even, dozens, columns |
| `casino_custom_bet` | Set any win probability (1-99%), get calculated payout |
| `casino_kelly_advisor` | Kelly Criterion optimal bet sizing for any game |
| `casino_simulate` | Monte Carlo simulation — test strategies before playing |
| `casino_balance` | Check balance, recent bets, lifetime stats |
| `casino_deposit` | Get a deposit address (9 chains supported) |
| `casino_withdraw` | Withdraw winnings to any crypto address |
| `casino_verify_bet` | Verify any past bet with cryptographic proof |
| `wallet_balance` | Universal balance across all Purple Flea services |
| `wallet_history` | Full transaction history |
| `wallet_supported_chains` | List supported chains and tokens |

## Games

### Coin Flip
50/50 odds, **1.96x payout**. Choose heads or tails. Simplest bet.

### Dice Roll
Roll 1-100. Bet over or under any threshold (1-99). Higher risk = higher payout.
- Over 50: 1.96x | Over 75: 3.92x | Over 90: 9.8x | Over 95: 19.6x

### Multiplier (Crash)
Pick a target multiplier from 1.01x to 1000x. If the crash point exceeds your target, you win.

### European Roulette
Full roulette: bet on numbers (0-36), colors, odd/even, high/low, dozens, or columns.

### Custom Odds
Define your own win probability (1-99%). The API calculates fair payout with 0.5% house edge.

## Example: Play a Game

```
You: "Flip a coin, $5 on heads"

Agent calls casino_coin_flip:
  side: "heads"
  amount: 5

Response:
  result: "heads"
  won: true
  payout: 9.80
  proof: {
    server_seed_hash: "a1b2c3..."
    result_hash: "d4e5f6..."
  }
```

## Provably Fair System

Every bet is cryptographically verifiable:

1. **Before your bet**: Server commits to a seed hash (SHA-256)
2. **Your bet**: You provide an optional client seed
3. **Result**: HMAC-SHA256(server_seed, client_seed:nonce) determines outcome
4. **After rotation**: Server seed is revealed — you can verify every past bet

Seeds auto-rotate every 1,000 bets with full audit trail.

## Kelly Criterion

Built-in bankroll protection prevents gambler's ruin:

- **Fractional Kelly**: Configure risk factor (0.1 = conservative, 1.0 = full Kelly)
- **Per-game limits**: Automatic max bet calculation for each game type
- **Monte Carlo**: Simulate thousands of runs to understand your strategy's outcomes

## Referral Program

Agents earn **10% commission** on net losses from players they refer. Share your referral code and earn passive income as other agents play.

## Architecture

- **Runtime**: Node.js + TypeScript
- **Framework**: Hono (REST API)
- **Database**: SQLite + Drizzle ORM
- **Fairness**: HMAC-SHA256 with server seed commitment
- **Protocol**: MCP (Model Context Protocol) over stdio

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | REST API port | `3000` |
| `DB_PATH` | SQLite database path | `./data/casino.db` |

## Part of the Purple Flea Ecosystem

Purple Flea builds blue chip infrastructure for AI agents:

- **[Agent Casino](https://github.com/purple-flea/agent-casino)** — Provably fair gambling, 0.5% house edge (you are here)
- **[Agent Trading](https://github.com/purple-flea/agent-trading)** — 275+ perpetual futures markets (TSLA, NVDA, GOLD, SILVER via Hyperliquid HIP-3)
- **[Burner Identity](https://github.com/purple-flea/burner-identity)** — Disposable emails & phone numbers

All services support crypto deposits via any chain/token. Swaps powered by [Wagyu.xyz](https://wagyu.xyz) — aggregator of aggregators, best rates guaranteed, routes through Hyperliquid (as liquid as Binance, even for XMR).

## License

MIT
