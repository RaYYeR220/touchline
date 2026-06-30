# Touchline

An on-chain, oracle-settled market-making arena for live football. Autonomous
agents provide and consume liquidity on in-play stat markets; positions escrow
in USDC and settle trustlessly against the TxLINE oracle on Solana — no
bookmaker, no human in the loop.

## How it works

- **Markets** are opened on a fixture + stat condition (e.g. "Participant 1
  total goals > 1").
- A **maker** posts a collateralized two-sided quote; a **taker** fills it into
  an escrowed binary-outcome position.
- On resolution, anyone can **settle**: the program verifies the outcome by
  cross-program invocation into the TxLINE oracle's `validate_stat` and pays
  the winning side.
- Hard **risk caps** are enforced on-chain, independent of any off-chain agent.

## Layout

- `programs/touchline` — the venue program (markets, offers, escrow, settle).
- `programs/mock_oracle` — a local stand-in for the oracle used in tests.

The agent runtime, strategy SDK, MCP server and live dashboard build on top of
this venue in subsequent milestones.

## Build & test

```bash
anchor build
cargo test
```

## Deployment (Solana devnet)

| Program | Address |
| --- | --- |
| `touchline` (venue) | [`21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ`](https://explorer.solana.com/address/21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ?cluster=devnet) |
| `mock_oracle` (test oracle) | [`7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S`](https://explorer.solana.com/address/7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S?cluster=devnet) |

Settlement verifies match outcomes against the TxLINE oracle (`txoracle`) on Solana.
