# Touchline

**An on-chain, oracle-settled market-making arena for live football.**

Autonomous agents post and take liquidity on in-play stat markets — "will
Participant 1 score more than 1 goal?" — with positions escrowed in USDC and
settled trustlessly by reading match outcomes straight off Solana. No
bookmaker sets the line, no operator decides the outcome, and no human has to
be in the loop for a market to open, fill, or pay out.

**Live dashboard → https://rayyer220.github.io/touchline/** (reads devnet arena state straight from the program, no backend).

```
clients: strategy-sdk consumers, MCP tools, x402 /signal callers
        |
        v
+------------------------------------------------------------+
| @touchline/agent  (or the MCP / x402 process embedding it) |
|                                                            |
| perceive (TxLINE SSE)                                      |
|   -> fairValue()          Poisson model, blended w/ line   |
|   -> strategy.onTick()   makeMarketMaker | makeTaker | you |
|   -> checkIntent()       hard risk guards                  |
|   -> Executor            builds + signs + sends the tx     |
|   -> Keeper              settles finished positions        |
+------------------------------------------------------------+
        |
        | instructions (venue-client: Kit + Codama)
        v
+------------------------------------------------------------+
| touchline venue program  (Anchor, on-chain)                |
|                                                            |
| Market -> Offer -> Position, USDC vault (PDA-owned)        |
| create_market | post_offer | fill_offer | cancel_offer     |
| settle  ---CPI--->  txoracle.validate_stat                 |
+------------------------------------------------------------+
        ^
        | getProgramAccounts (read-only, no backend)
        |
   packages/app — the live dashboard
```

## Why this exists

In-play sports betting on-chain almost always cheats on the hard part: an
operator (or an off-chain "resolver") still decides who won. That reintroduces
exactly the trust assumption a blockchain is supposed to remove, and it's the
reason serious market makers stay away.

Touchline removes the operator. Every market is opened against a specific
fixture and stat predicate (e.g. "P1 total goals > 1"). Every position is
collateralized in USDC and held in a program-owned vault. And every
settlement is a cross-program invocation into **TxLINE's `txoracle` program**,
which verifies the final stat against Merkle roots TxLINE posts on-chain from
match data. The venue program never trusts a keeper's word for the outcome —
it trusts the oracle's return value, checked against the pinned oracle program
ID, or it fails closed.

On top of that trustless core sits an open agent platform: a reference
market-maker and taker, a strategy SDK so anyone can plug in their own edge,
an MCP server so an LLM agent can observe and trade the arena directly, and an
x402-metered signal API so the fair-value model itself can be sold per-request.

## How a market lives and dies

- **Markets** are opened on a fixture + stat predicate (`GreaterThan` /
  `LessThan` / `EqualTo` a threshold), pinned to one oracle program and one
  6-decimal collateral mint.
- A **maker** posts a collateralized two-sided quote (`post_offer`); a
  **taker** fills into it (`fill_offer`), and the venue escrows both sides'
  stake in the market's vault.
- On resolution, anyone can call **`settle`** — permissionless, no special
  role required. The program CPIs into the oracle's `validate_stat`, reads the
  boolean verdict back via Solana's CPI return-data mechanism, and pays the
  winning side straight out of the vault.
- Hard **risk caps are enforced on-chain**, independent of whatever an
  off-chain agent thinks its own limits are: a per-fill cap, a per-market
  cumulative cap, price bounds, and a mint/decimals check on market creation.
- Unmatched maker liquidity can be pulled any time with **`cancel_offer`**,
  which refunds exactly the locked stake.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the settlement trust
model, the agent loop, and the risk model in full detail.

## Deployed on Solana devnet

- **`touchline`** (venue program) —
  `21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ`
  https://explorer.solana.com/address/21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ?cluster=devnet
- **`mock_oracle`** (test double for the oracle, used by devnet settlement) —
  `7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S`
  https://explorer.solana.com/address/7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S?cluster=devnet
- **`txoracle`** (TxLINE's oracle program, devnet) —
  `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
  https://explorer.solana.com/address/6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J?cluster=devnet

### A market's full lifecycle, on-chain

- `createMarket` —
  https://explorer.solana.com/tx/2Vb2BKEUZ8KNLTvmmPFoMcGpq8KHFqNPmJiQk1aK3fmu5s8FNW3Efp1n6NkswA2XLRKJ861AFjokjzzr1zBgDu9Q?cluster=devnet
- `postOffer` —
  https://explorer.solana.com/tx/3p6gCCpZ1b4yewKDGGMmZeAJWJwt2bsskafXR4MS45P4VocEBuQeksbHxhd7YPTmATATmg8P8h5fQFmqptMCsPCk?cluster=devnet
- `fillOffer` —
  https://explorer.solana.com/tx/4cfvmawskMmrPJD8RfDbUmpZTKrToTztnF7oEKzm11FPEtst8Zr3ZgGhNE1gAzvPKzJyxiMcAGkAbpX96muaAMts?cluster=devnet
- `settle` —
  https://explorer.solana.com/tx/2paRGLpUAGcWYHAyoMDiPUEen4UPx89Y7JuKwM2MRXtp4MpvFnPg8aBktkkpgtAsyNjEfUq4RDbiGAqJUDR78SGf?cluster=devnet

## Monorepo map

- `programs/touchline` — the venue program: markets, offers, positions, the
  USDC vault, and oracle-CPI settlement.
- `programs/mock_oracle` — a permissive stand-in for `txoracle` used in tests
  and on devnet (evaluates the predicate directly instead of walking a Merkle
  proof). **Never point this at anything with real value** — anyone can make
  it say a market resolved however they like.
- `packages/txline-sdk` — TypeScript client for TxLINE's live football feed:
  auth (`guest → subscribe → activate`), REST snapshots, dependency-free SSE
  streaming of odds/scores, and Merkle-proof fetch + `validate_stat` CPI
  helpers.
- `packages/venue-client` — the generated (Codama / `@solana/kit`) typed
  client for the venue program: instruction builders, account decoders, PDA
  finders.
- `packages/agent` — the autonomous agent runtime: perception, the Poisson
  fair-value model, market-maker and taker strategies, hard risk guards, the
  transaction executor, the settlement keeper, and the arena tick loop.
- `packages/strategy-sdk` — the public surface for writing your own strategy
  against the arena, re-exporting everything from `@touchline/agent`.
- `packages/mcp` — an MCP server exposing 8 tools so any MCP-capable LLM agent
  can observe and trade the arena (read tools always on; write tools opt-in).
- `packages/x402` — a pay-per-request signal API: `GET /signal` behind an
  x402 paywall on Solana devnet, selling the same fair-value estimate the
  agent uses internally.
- `packages/app` — the live dashboard (Vite): polls the venue program
  directly over RPC and renders open markets, the fill tape, settlements, and
  per-agent risk gauges, with no backend of its own.

## Run it

### Prerequisites

Rust (via `rust-toolchain.toml`, pinned to 1.89.0), the Solana/Agave CLI,
Anchor 1.x, Node ≥ 18, and Yarn (the package manager Anchor.toml expects).

### 0. Install once, from the repo root

```bash
npm install     # this is an npm workspace — one install links every package/*
```

### 1. Build & test the venue program

```bash
anchor build
cargo test -p touchline     # 16 LiteSVM (Rust) tests: venue.rs + settlement.rs + lib.rs
```

The test suite runs entirely in-process against LiteSVM — no local validator
required — and covers offer/fill/cancel accounting, both risk caps, wrong-mint
rejection, double-settle rejection, wrong-oracle-program rejection, and a
full settle-and-drain-the-vault path for both a maker win and a taker win.

### 2. Run an agent

```bash
cd packages/agent
npx vitest run                          # 143 unit tests — model, guards, strategies, perception

# Dry run against synthetic match state, no wallet or network writes required:
npx tsx src/index.ts --strategy mm --dry-run --ticks 5

# Live on devnet (needs a funded devnet wallet at WALLET_PATH):
RPC_URL=https://api.devnet.solana.com \
WALLET_PATH=~/.config/solana/id.json \
npx tsx src/index.ts --strategy taker --tick-ms 5000
```

### 3. Run the live dashboard

```bash
cd packages/app
npm run dev
```

Reads `Market` / `Offer` / `Position` accounts straight from the venue
program via `getProgramAccounts` (no indexer, no backend) and falls back to a
bundled demo snapshot if the RPC read fails.

### 4. Run the MCP server

```bash
npx tsx packages/mcp/src/index.ts
```

Register it with any stdio-capable MCP client. Exposes
`list_markets`, `get_market`, and `fair_value` as always-on read tools, plus
`create_market`, `post_offer`, `fill_offer`, `cancel_offer`, and `settle` as
write tools gated behind `TOUCHLINE_MCP_ALLOW_WRITES=1`.

### 5. Run the x402 signal endpoint

```bash
SERVER_WALLET=<your-devnet-address> \
RPC_URL=<devnet-rpc> \
npx tsx packages/x402/src/index.ts

curl -i http://localhost:4021/signal      # → 402 Payment Required
```

Paying clients settle $0.01 USDC through the public x402.org facilitator and
get back the same Poisson probability estimate the agent trades on.

Verified end-to-end on devnet — a client paid and received the signal in one
call; the facilitator-sponsored USDC settlement (Circle devnet mint, `exact` SVM
scheme) landed on-chain:
https://explorer.solana.com/tx/3CfbQigEnYKV1QtTegcV7ohdpiNXsWPtuXNhZ3SrUwfo2YYENt7cRnsGTemDuS2b7bRsMDUK7dKCCBKBJqoPxA3M?cluster=devnet

### Environment variables

| Variable | Used by | Default |
| --- | --- | --- |
| `RPC_URL` | agent, mcp, x402, app (`VITE_RPC_URL`) | `https://api.devnet.solana.com` |
| `WALLET_PATH` | agent, mcp, x402 client | `~/.config/solana/id.json` |
| `NETWORK` | agent, mcp | `devnet` |
| `TOUCHLINE_MCP_ALLOW_WRITES` | mcp | unset (read-only) |
| `SERVER_WALLET` | x402 server | — (required) |
| `PORT` | x402 server | `4021` |
| `FACILITATOR_URL` | x402 server | `https://x402.org/facilitator` |
| `SERVER_URL` | x402 client | `http://localhost:4021` |

## Tech

Anchor 1.x (program), `@solana/kit` v6 + Codama (generated TypeScript client,
no more hand-written IDL bindings), TxLINE's `txoracle` for stat verification,
`@modelcontextprotocol/sdk` for the MCP server, `@x402/*` for the payment
layer, Vite for the dashboard.

## Honest limitations

- **Devnet only.** Both `touchline` and the collateral mint live on Solana
  devnet; nothing here has been deployed or capitalized on mainnet.
- **Settlement uses `mock_oracle` on devnet**, not TxLINE's production
  `txoracle`. The mock mirrors `txoracle.validate_stat`'s exact argument
  layout and evaluates the predicate directly instead of walking a Merkle
  proof — it exists because devnet World Cup fixtures are scheduled replays
  that don't reliably produce a settle-able `stat-validation` response yet.
  The venue program's `settle` instruction calls the real `txoracle` IDL and
  is written to fail closed either way (see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)); the one open question,
  documented in code, is whether the production oracle *returns* false on a
  failed predicate or *reverts* — that determines how a NO-outcome
  settlement is finally shaped against mainnet `txoracle`.
- **Fair value is a documented, deterministic model, not a prediction
  engine.** It's a time-decayed Poisson estimate blended with the live market
  line — good enough to give a strategy a principled edge, not a claim of
  perfect pricing.
- **The agent's on-chain registry is session-local.** It tracks markets,
  offers, and positions only from transactions it sent this run;
  `getProgramAccounts`-based discovery on restart isn't implemented, so a
  restarted agent will recreate markets rather than resume old ones. (The
  dashboard, unlike the agent, *does* read full chain state.)
- **Risk limits are conservative devnet defaults**, not tuned for any
  particular bankroll: 10 USDC per position, 200 USDC total open exposure,
  a 20%-of-exposure daily loss halt.

## License

MIT — see [`LICENSE`](LICENSE).
