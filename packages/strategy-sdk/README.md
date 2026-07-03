# @touchline/strategy-sdk

Write and run custom trading strategies on the Touchline on-chain prediction market arena.

## What it is

Touchline is a binary-outcome sports prediction market on Solana. A strategy gets a snapshot of the arena each tick — live match state, open offers, your positions, risk budget — and returns a list of intents (create market, post offer, fill offer, cancel offer). The execution layer sends those intents on-chain after checking them against hard risk limits.

## Write your own strategy

```typescript
import { Strategy, ArenaContext, AgentConfig, Intent } from "@touchline/strategy-sdk";

const myStrategy: Strategy = {
  name: "my-strategy",

  onTick(ctx: ArenaContext, cfg: AgentConfig): Intent[] {
    const intents: Intent[] = [];

    // ctx.state  — live match state (phase, minute, goals)
    // ctx.lines  — market lines from the odds stream
    // ctx.markets / ctx.offers / ctx.positions — on-chain accounts
    // ctx.risk   — open exposure, realized PnL, feed staleness

    for (const offer of ctx.offers) {
      // Fill any offer you find interesting
      intents.push({ kind: "fillOffer", offer, fillPot: offer.remainingPot });
    }

    return intents;
  },
};
```

Plug it into the runner:

```typescript
import { runAgent, buildConfig } from "@touchline/strategy-sdk";
import { createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes } from "@solana/kit";
import { readFileSync } from "node:fs";

const cfg = buildConfig();
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(cfg.walletPath, "utf8")))
);
const rpc = createSolanaRpc(cfg.rpcUrl);
const rpcSubscriptions = createSolanaRpcSubscriptions(cfg.rpcUrl.replace(/^http/, "ws"));

await runAgent({ strategy: myStrategy, cfg, signer, rpc, rpcSubscriptions });
```

## Included utilities

| Export | What it does |
|---|---|
| `makeMarketMaker(params)` | Two-sided quoting strategy with inventory skew |
| `makeTaker(params)` | Fills offers where your edge exceeds `minEdgeBps` |
| `fadeTheLineStrategy` | Example: fills offers that diverge from a fixed prior |
| `fairValue(market, state, line, params)` | Poisson-based probability estimate |
| `checkIntent(intent, budget, limits)` | Pre-flight risk check |
| `buildConfig(overrides?)` | Build `AgentConfig` from env vars + defaults |

## Configuration

All config is driven by environment variables (see `buildConfig`):

| Variable | Default |
|---|---|
| `RPC_URL` | `https://api.devnet.solana.com` |
| `WALLET_PATH` | `~/.config/solana/id.json` |
| `NETWORK` | `devnet` |
