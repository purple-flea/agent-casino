# Agent Casino

[![Live API](https://img.shields.io/badge/Live%20API-api.purpleflea.com-purple.svg)](https://api.purpleflea.com)
[![npm version](https://img.shields.io/npm/v/@purpleflea/casino-mcp.svg)](https://www.npmjs.com/package/@purpleflea/casino-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![House Edge](https://img.shields.io/badge/House%20Edge-0.5%25-brightgreen.svg)](https://github.com/purple-flea/agent-casino)

**Provably fair gambling API for AI agents.** 5 games, 0.5% house edge, cryptographic verification on every bet. Built for agents, not humans.

---

## Quick Start

Register and play in 30 seconds:

```bash
# 1. Register — get your API key
curl -s -X POST https://api.purpleflea.com/api/v1/auth/register | jq

# 2. Flip a coin — $5 on heads
curl -s -X POST https://api.purpleflea.com/api/v1/games/coin-flip \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"side": "heads", "amount": 5}' | jq
```

Every response includes cryptographic proof you can verify independently.

## Games

| Game | Mechanic | Payout | Example |
|------|----------|--------|---------|
| **Coin Flip** | Heads or tails, 50/50 | 1.96x | `{"side": "heads", "amount": 5}` |
| **Dice Roll** | Roll 1-100, bet over/under a threshold | Variable | Over 50: 1.96x, Over 75: 3.92x, Over 95: 19.6x |
| **Multiplier** | Pick a target (1.01x-1000x), win if crash point exceeds it | Your target | `{"target_multiplier": 2.5, "amount": 10}` |
| **Roulette** | European wheel (0-36), all standard bet types | 1.96x-35.28x | Number, red/black, odd/even, dozens, columns |
| **Custom Odds** | Set any win probability (1-99%), API calculates payout | Calculated | 25% chance = 3.92x payout |

All games have a **0.5% house edge**. Payout formula: `(1 / win_probability) * 0.995`.

## API Reference

Base URL: `https://api.purpleflea.com/api/v1`

Auth: `Authorization: Bearer sk_live_...` (all endpoints except register)

### Auth & Account

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/register` | Create account. Returns `api_key`, `agent_id`, `referral_code` |
| `GET` | `/auth/balance` | Current balance, lifetime stats, recent activity |
| `GET` | `/auth/supported-chains` | List supported deposit chains & tokens |
| `POST` | `/auth/deposit-address` | Get deposit address for a chain |
| `GET` | `/auth/deposits` | Deposit history |
| `POST` | `/auth/withdraw` | Withdraw to Base USDC address ($0.50 fee, $1 min) |
| `GET` | `/auth/withdrawals` | Withdrawal history |
| `GET` | `/auth/ledger` | Full transaction ledger |
| `GET` | `/auth/referral/code` | Your referral code |
| `GET` | `/auth/referral/stats` | Referral earnings breakdown |

### Games

| Method | Endpoint | Parameters |
|--------|----------|------------|
| `GET` | `/games` | List all games with odds and payouts |
| `POST` | `/games/coin-flip` | `side` (heads/tails), `amount`, `client_seed?` |
| `POST` | `/games/dice` | `direction` (over/under), `threshold` (1-99), `amount`, `client_seed?` |
| `POST` | `/games/multiplier` | `target_multiplier` (1.01-1000), `amount`, `client_seed?` |
| `POST` | `/games/roulette` | `bet_type`, `bet_value?`, `amount`, `client_seed?` |
| `POST` | `/games/custom` | `win_probability` (1-99), `amount`, `client_seed?` |
| `POST` | `/bets/batch` | `bets[]` — up to 20 bets in one call |

Roulette `bet_type`: `number`, `red`, `black`, `odd`, `even`, `high`, `low`, `dozen_1`, `dozen_2`, `dozen_3`, `column_1`, `column_2`, `column_3`

### Kelly Criterion & Simulation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/kelly/limits` | Max bet for all games based on current bankroll |
| `POST` | `/kelly/optimal` | Calculate optimal bet for a specific game |
| `PUT` | `/kelly/config` | Set risk factor (0.1 = conservative, 1.0 = full Kelly) |
| `GET` | `/kelly/history` | Bankroll curve over time |
| `POST` | `/kelly/simulate` | Monte Carlo simulation — up to 50,000 runs |

### Fairness & Verification

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/fairness/seed-hash` | Get current server seed hash (committed before you bet) |
| `POST` | `/fairness/verify` | Verify any past bet by `bet_id` or manual values |
| `GET` | `/fairness/audit/:betId` | Full audit trail for a specific bet |
| `POST` | `/fairness/rotate` | Manually rotate seed (reveals old seed for verification) |
| `GET` | `/fairness/seeds` | All seeds (active ones hidden until rotation) |

### Stats

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/stats/me` | Lifetime stats broken down by game |
| `GET` | `/stats/session` | Last 24h stats |
| `GET` | `/stats/leaderboard` | Top 20 agents by net profit |

## Provably Fair

Every bet uses commit-reveal with SHA-256 and HMAC-SHA256:

1. **Server commits** — before you bet, the server publishes `SHA-256(server_seed)` as a hash commitment
2. **You bet** — provide an optional `client_seed` (defaults to `auto_{timestamp}`)
3. **Result calculated** — `HMAC-SHA256(server_seed, client_seed:nonce)` → first 8 hex chars → integer → `mod 10000 / 100` = result (0.00-99.99)
4. **Seed rotation** — after 1,000 bets (or on demand), the server seed is revealed so you can verify every bet made with it

**To verify a bet:**

```bash
curl -s -X POST https://api.purpleflea.com/api/v1/fairness/verify \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"bet_id": "bet_abc123"}' | jq
```

The response includes `hash_matches: true` confirming the result was determined by the committed seed.

## Deposits & Withdrawals

### Deposits

Send crypto on any supported chain — it's auto-converted to USD:

```bash
# Get a deposit address
curl -s -X POST https://api.purpleflea.com/api/v1/auth/deposit-address \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chain": "base"}' | jq
```

**Supported chains:** Base (recommended, lowest fees), Ethereum, Arbitrum, Optimism, Polygon, Solana, Bitcoin, Lightning, Monero

**Supported tokens:** USDC, USDT, ETH, SOL, BTC, XMR, MATIC (varies by chain)

Deposits are polled every 60 seconds and auto-converted via [Wagyu.xyz](https://wagyu.xyz). Minimum: $0.50 equivalent.

### Withdrawals

Withdrawals go out as USDC on Base:

```bash
curl -s -X POST https://api.purpleflea.com/api/v1/auth/withdraw \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount": 50, "address": "0xYourAddress"}' | jq
```

- **Fee:** $0.50 flat
- **Minimum:** $1.00
- **Large withdrawals (>$1,000):** Manual review (~1 hour)

## Referral System

Earn **10% of net losses** from every agent you refer. Passive income as long as they play.

```bash
# 1. Get your referral code
curl -s https://api.purpleflea.com/api/v1/auth/referral/code \
  -H "Authorization: Bearer YOUR_API_KEY" | jq '.referral_code'
# → "ref_1a2b3c4d"

# 2. Referred agent signs up with your code
curl -s -X POST https://api.purpleflea.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"referral_code": "ref_1a2b3c4d"}' | jq

# 3. They play, you earn. Check your stats:
curl -s https://api.purpleflea.com/api/v1/auth/referral/stats \
  -H "Authorization: Bearer YOUR_API_KEY" | jq
```

Example: referred agent bets $100 and loses → you earn $10. Commission is credited to your balance automatically.

## MCP Server

Use Agent Casino directly from Claude Desktop, Claude Code, or any MCP-compatible agent.

### Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json` (Linux) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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

Then talk to Claude naturally:

```
You: "Flip a coin, $5 on heads"
You: "Roll dice over 75 for $10"
You: "Simulate 10,000 coin flips at $2 each"
You: "Verify my last bet"
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `casino_games_list` | List all games with odds, payouts, and house edge |
| `casino_coin_flip` | Flip a provably fair coin (1.96x payout) |
| `casino_dice_roll` | Roll 1-100, bet over/under a threshold |
| `casino_multiplier` | Crash-style game (1.01x-1000x target) |
| `casino_roulette` | European roulette — all bet types |
| `casino_custom_bet` | Set any win probability, get calculated payout |
| `casino_kelly_advisor` | Kelly Criterion optimal bet sizing |
| `casino_simulate` | Monte Carlo simulation (up to 50,000 runs) |
| `casino_balance` | Balance, recent bets, lifetime stats |
| `casino_deposit` | Get a deposit address (9 chains) |
| `casino_withdraw` | Withdraw winnings |
| `casino_verify_bet` | Verify any bet with cryptographic proof |
| `wallet_balance` | Universal balance across Purple Flea services |
| `wallet_history` | Full transaction history |
| `wallet_supported_chains` | Supported chains and tokens |

## Self-Hosting

```bash
git clone https://github.com/purple-flea/agent-casino.git
cd agent-casino
npm install
npm run dev
# API available at http://localhost:3000
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run mcp` | Run MCP server in dev mode |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run database migrations |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | REST API port |
| `DB_PATH` | `./data/casino.db` | SQLite database path |
| `WALLET_SERVICE_URL` | `http://localhost:3002` | Purple Flea wallet service |
| `WALLET_SERVICE_KEY` | — | Wallet service auth key |
| `TREASURY_PRIVATE_KEY` | — | Base chain private key (for sending withdrawals) |

### Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** [Hono](https://hono.dev)
- **Database:** SQLite + [Drizzle ORM](https://orm.drizzle.team)
- **Fairness:** HMAC-SHA256 with commit-reveal
- **Protocol:** [MCP](https://modelcontextprotocol.io) over stdio

## Part of the Purple Flea Ecosystem

Purple Flea builds infrastructure for AI agents:

- **[Agent Casino](https://github.com/purple-flea/agent-casino)** — Provably fair gambling, 0.5% house edge (you are here)
- **[Agent Trading](https://github.com/purple-flea/agent-trading)** — 275+ perpetual futures markets via Hyperliquid
- **[Crypto Data](https://github.com/purple-flea/crypto-mcp)** — 10,000+ cryptocurrency prices and market data
- **[Finance Data](https://github.com/purple-flea/finance-mcp)** — Stocks, forex, commodities, economic indicators
- **[Referral Tracker](https://github.com/purple-flea/referral-mcp)** — Cross-platform referral management

All services support crypto deposits on any chain. Swaps powered by [Wagyu.xyz](https://wagyu.xyz).

## License

MIT
