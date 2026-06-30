# txline-sdk

TypeScript core for the TxODDS **TxLINE** / `txoracle` football data feed and its
on-chain Merkle verification on Solana. It wraps the live feed behind one typed,
tested layer: SSE ingestion, authentication, REST snapshots, and trustless
stat validation against the on-chain oracle.

## What it does

| Module | Purpose |
| --- | --- |
| `config` | Per-network (`devnet` default / `mainnet`) API base URL, `txoracle` program id, mints. |
| `onchain` | `txoracle` IDL + types, PDA derivation, soccer stat-key & phase encodings. |
| `auth` | `guest → on-chain subscribe (free tier) → activate` flow; `TxlineSession` with JWT refresh. |
| `rest` | Dual-header (`Bearer` + `X-Api-Token`) client for fixtures/odds/scores. |
| `stream` | Dependency-free SSE parser + typed `streamOdds`/`streamScores` async iterables (reconnect/abort). |
| `verify` | Fetch 3-stage Merkle proofs, build `validateStat` args/predicates, run the on-chain view / build a CPI ix. |

## Trust model

The deployed public `txoracle` program ships **verification primitives only**
(`validate_stat` / `validate_odds` / `validate_fixture`). The **on-chain program is
the source of truth** for proof validation — `runValidateStatView` is the trustless
check a settlement layer gates on. `verify/local.ts` (off-chain Merkle re-verify) is
experimental and intentionally disabled until the exact leaf/node hash scheme is
confirmed against the program.

## Install & verify

```bash
npm install
npm run typecheck
npm test          # unit tests (no network, no wallet)
```

## Usage

```ts
import {
  resolveConfig, getTxoracleProgram, TxlineSession, TxlineRestClient,
  fetchStatValidation, buildValidateStatInputs, runValidateStatView,
  soccerStatKey, SoccerStat, SoccerStatPeriod, gt,
} from "@touchline/txline-sdk";

const config = resolveConfig("devnet");
const program = getTxoracleProgram(config, provider);          // provider: AnchorProvider
const session = await TxlineSession.create({ config, program, payer });
const client = new TxlineRestClient(session);

// "Participant 1 scored > 1 goal in the first half"
const statKey = soccerStatKey(SoccerStat.P1Goals, SoccerStatPeriod.FirstHalf);
const proof = await fetchStatValidation(client, { fixtureId, seq, statKey });
const ok = await runValidateStatView(program, config, buildValidateStatInputs(proof), gt(1));
```

## Source

Generated from the live docs (`txline-docs.txodds.com`, OpenAPI at
`txline.txodds.com/docs/docs.yaml`) and the public reference repo
`github.com/txodds/tx-on-chain`. Reference docs live in `docs/`.
