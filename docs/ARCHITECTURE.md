# Touchline architecture

This is the deep-dive companion to the root README: the settlement trust
model, the agent loop, and the risk model, with file references into
`programs/touchline` and `packages/agent`.

## 1. Program topology

Four account types, one program-owned vault per market:

- **`Market`** — `authority`, `fixture_id`, `stat_key`, `predicate`
  (`threshold` + `GreaterThan`/`LessThan`/`EqualTo`), `mint`,
  `oracle_program`, `status` (`Open`/`Settled`), `total_pot`, PDA bumps.
  Seeds: `["market", fixture_id, stat_key, predicate.threshold,
  predicate.comparison]` — so a market is uniquely identified by *what it
  bets on*, not by a counter, and re-creating the same market is a
  deterministic no-op collision, not a duplicate.
- **`Offer`** — a maker's resting two-sided-market quote: `market`, `maker`,
  `maker_side`, `price_yes_bps`, `remaining_pot`. Seeds:
  `["offer", market, maker, offer_id]`.
- **`Position`** — a filled trade: `market`, `maker`, `taker`,
  `price_yes_bps` (frozen at fill time), `pot`, `maker_side`, `settled`.
  Seeds: `["position", offer, position_id]`.
- **vault** — an SPL token account owned by the `Market` PDA (`token::authority
  = market`), seeds `["vault", market]`. Every stake — maker collateral at
  `post_offer`, taker collateral at `fill_offer` — moves into this single
  account; every payout at `settle` (or refund at `cancel_offer`) moves out
  of it, signed by the market PDA's own seeds.

All five instructions — `create_market`, `post_offer`, `fill_offer`,
`cancel_offer`, `settle` — are permissionless in the sense that matters: any
signer can create a market, any signer can settle *any* position once the
oracle can answer it. There is no admin key that decides outcomes.

### On-chain risk caps (`programs/touchline/src/constants.rs`)

These are enforced in the program itself, not just in the off-chain agent, so
they hold even against a strategy with a bug or a hostile counter-party:

- `MAX_POT_PER_FILL = 100_000_000` (100 USDC, 6 decimals) — checked in
  `fill_offer` (`ErrorCode::FillCapExceeded`).
- `MAX_POT_PER_MARKET = 5_000_000_000` (5,000 USDC) — cumulative cap on
  `market.total_pot`, checked in `fill_offer` (`ErrorCode::MarketCapExceeded`).
- Price bounds `1..=9999` bps on `post_offer` (`ErrorCode::InvalidPrice`) —
  a quote can never be priced at literal 0% or 100%.
- Mint decimals pinned to `6` at `create_market` (`ErrorCode::WrongMint`) —
  keeps stake-fraction arithmetic (`pot * price_bps / 10_000`) exact for a
  USDC-shaped mint.
- Every arithmetic step in stake/payout math goes through `checked_*` and
  bails out to `ErrorCode::MathOverflow` rather than wrapping.

## 2. The settlement CPI trust model

This is the part that makes Touchline trustless rather than "trust the
keeper." `programs/touchline/src/instructions/settle.rs` does exactly this,
in order:

1. **Map the market's predicate to the oracle's type.** The venue program
   stores its own `Predicate` (so it doesn't have to import the oracle crate
   for storage), and translates it to `txoracle::types::TraderPredicate` only
   at settlement time.

2. **CPI into the oracle's `validate_stat`**, passing the caller-supplied
   Merkle proof material (`ts`, `fixture_summary`, `fixture_proof`,
   `main_tree_proof`, `stat1`, `stat2`, `op`) plus the mapped predicate. The
   oracle account passed in (`oracle_program`) is constrained with
   `#[account(address = market.oracle_program)]` — it is **read from the
   market that was created**, not from whatever the settler passes in, so a
   settler cannot redirect settlement to a different, friendlier oracle.

3. **Read the verdict back via Solana's CPI return-data mechanism**
   (`get_return_data()`), because `declare_program!(txoracle)` generates a
   `Result<()>` wrapper for `validate_stat` (the published `txoracle` IDL has
   no `returns` field) even though the program actually communicates its
   boolean answer through `set_return_data`. The handler fails closed on
   every axis:
   - No return data at all → `ErrorCode::OracleRejected`.
   - Return data's origin program isn't the pinned `oracle_program` →
     `ErrorCode::OracleRejected` (`require_keys_eq!`).
   - Return payload isn't exactly one byte → `ErrorCode::OracleRejected`.
   - Otherwise, byte `1` = YES, anything else = NO.

4. **Determine the winner** (`(yes && maker_side == Yes) || (!yes &&
   maker_side == No)`), **write `position.settled = true` before** doing the
   token transfer (checks-effects-interactions ordering — the state flip that
   blocks a second settlement happens before any external call), then
   transfer `position.pot` out of the vault to the winner's own ATA. The
   payout destination is constrained by `token::authority = position.maker`
   / `token::authority = position.taker` in the `Settle` account struct, so
   there's no way to redirect a payout to an attacker-supplied token account
   even if the attacker is the one who calls `settle`.

Double-settlement is rejected structurally, not by an extra `require!`: the
`Settle` account struct itself carries `constraint = !position.settled @
ErrorCode::AlreadySettled` on the `position` account, so the single source of
truth for "has this been settled" lives in one place.

### Mock oracle vs. production `txoracle`

Solana devnet's World Cup fixtures served by TxLINE are **scheduled replays**,
which don't reliably produce a settle-able `stat-validation` response the way
a live match would. `programs/mock_oracle` exists to unblock full lifecycle
testing against that gap: its `validate_stat` mirrors `txoracle`'s exact
Borsh argument layout (same field order and types — see the comment in
`mock_oracle/src/lib.rs`) so the bytes a CPI produces against it are
byte-for-byte what a CPI to the real oracle would produce, but it **ignores
the Merkle proofs and evaluates the predicate directly** against the stat
value the caller supplies. That means the mock is deliberately unsafe against
adversarial input — anyone calling `settle` against a mock-oracle market can
supply whatever stat value they want and the mock will "verify" it. This is
fine and expected for devnet/testing; it would be a critical vulnerability
against a market with real value, which is exactly why the MCP server's
`settle` write tool documents (and the code comments call out) that write
mode must never be pointed at a real-value mint.

There is one open, explicitly documented question about the production path
(see the `I1` comment in `settle.rs`): the real `txoracle` IDL defines a
`PredicateFailed` error, which raises the possibility that a **false**
predicate *reverts the CPI* rather than returning `false` the way the mock
does. `settle.rs`'s `get_return_data` handling is already correct and
fail-closed against the mock's behavior; if production `txoracle` in fact
reverts on a false predicate, resolving the NO side of a market will need to
CPI the *negated* predicate to obtain an affirmative `true` from the oracle,
rather than reading `false` back from the same call. That's a mainnet
integration detail, not a devnet gap — nothing here is deployed against
production `txoracle` today.

## 3. The agent loop

`packages/agent/src/arena.ts` (`runAgent`) is the whole runtime, wired as one
pipeline per tick:

```
stateSource (TxLINE SSE, or synthetic for --dry-run)
        │  MatchState + MarketLine events, merged (perception/index.ts)
        ▼
ArenaContext  { state, lines, markets, offers, positions, risk, nowMs }
        │
        ▼
strategy.onTick(ctx, cfg)  →  Intent[]        (strategy/mm.ts | strategy/taker.ts)
        │
        ▼
checkIntent(intent, budget, cfg.risk)         (risk/guards.ts — hard gate)
        │  ok                                    │ rejected → logged, dropped
        ▼
executor.execute(intent)                      (exec/executor.ts — builds + signs + sends the tx)
        │
        ▼
applyExposure(budget, intent)                 (arena.ts — local risk-budget bookkeeping)
        │
        ▼ (once the match reaches a terminal phase)
keeper.settle(position, market, statValue)    (keeper/settle.ts — CPI settle instruction)
        │
        ▼
releaseSettledPosition(budget, ...)           (arena.ts — realizedPnl + exposure release)
```

### Perception

`perception/index.ts`'s `perceive()` merges TxLINE's `scores` and `odds` SSE
streams (via `Promise.race` over both iterators) into one event stream of
`{ state?: MatchState, line?: MarketLine }`. `perception/matchState.ts` holds
the pure reducers (`reduceScore`, `lineFromOdds`) that are unit tested
directly, since the SSE glue itself is network-dependent and intentionally
left untested.

### Fair-value model (`model/fairValue.ts`, `model/poisson.ts`)

Deterministic, no I/O, no randomness — fully specified and fully unit tested
(45 tests between `poisson.test.ts` and `fairValue.test.ts`):

1. Read the current accumulated stat count `c` from `MatchState` (only
   full-game P1/P2 goals are wired up today; other stat keys return `0` and
   are a documented extension point).
2. `remainingFraction = clamp((90 − minute) / 90, 0, 1)`, forced to `0` in a
   terminal phase (`F`, `FET`, `FPE`).
3. `lambdaRemaining = baseRate[statKey] * remainingFraction` — the expected
   number of additional occurrences between now and full time, under a
   Poisson process with the configured per-90-minute rate
   (`DEFAULT_BASE_RATE`: 1.4 goals/team, 2.5 yellows/team, 0.3 reds/team, 5.0
   corners/team — all tunable via `StrategyParams.baseRate`).
4. Convert to a model probability `pModel` depending on the predicate:
   - `GreaterThan`: already true if `c > threshold`, else
     `poissonSf(threshold − c, lambdaRemaining)` — survival function, i.e.
     `P(X > threshold − c)`.
   - `LessThan`: `1 − poissonSf(threshold − c − 1, lambdaRemaining)`.
   - `EqualTo`: `poissonPmf(threshold − c, lambdaRemaining)` (0 if already
     impossible).
5. **Blend with the live market line**: `fair = w·pModel + (1−w)·lineProb`,
   `w = modelWeight` (default `0.5`), or just `pModel` if no line is known
   yet for that `(fixtureId, statKey)`.

`poissonSf`/`poissonPmf` accumulate the CDF/PMF terms iteratively in
probability space (not closed-form), which keeps them numerically stable for
the rate ranges this model actually uses and keeps every edge case (negative
k, zero/NaN lambda) an explicit, tested branch rather than an accident of
floating point.

### Strategies (`strategy/mm.ts`, `strategy/taker.ts`)

- **Market maker** (`makeMarketMaker`): pulls all quotes in a terminal phase,
  stands down entirely in a no-trade phase, otherwise creates a market for
  any line that doesn't have one yet (canonical `GreaterThan 1` predicate),
  then quotes both sides around the blended fair value with a configurable
  half-spread, an inventory-skew adjustment (shifts both quotes toward
  rebalancing when the maker is one-sided on a market), a high-certainty
  pull (stops quoting once fair value is outside `[0.01, 0.99]` — the spread
  is meaningless that close to a known outcome), and pot sizing that backs
  off to half the remaining exposure budget near the cap.
- **Taker** (`makeTaker`): scans every open offer, computes the same blended
  fair value for the offer's market, fills only when the signed edge exceeds
  `minEdgeBps`, and sizes the fill to the smaller of the offer's remaining
  pot and whatever fits under `maxStakePerPosition`.

Both strategies deliberately under-enforce their own limits — they rely on
`checkIntent` as the final, authoritative gate before anything reaches the
chain (see below), matching the on-chain program's own stance that no
off-chain computation is trusted unless it's checked again close to the
transaction boundary.

### Execution and settlement

`exec/executor.ts`'s `Executor` turns an `Intent` into a fully signed
`@solana/kit` transaction against the generated `venue-client` instruction
builders (`getCreateMarketInstructionAsync`, etc.), deriving PDAs and ATAs
itself. `keeper/settle.ts`'s `Keeper` does the same for `settle`, defaulting
to zeroed Merkle-proof fields — correct against `mock_oracle`, which ignores
them, and a placeholder to be replaced with real proof material once the
agent settles against production `txoracle`. Note the explicit refusal in
`arena.ts`'s `statValueFromState`: if a market's `statKey` isn't one the
agent knows how to read off `MatchState` (today: only P1/P2 goals), the
keeper skips settlement rather than submitting a fabricated `0` — an
incorrect settlement is worse than a late one.

## 4. The risk model

Two halves: a static `RiskLimits` config and a live `RiskBudget` that the
arena loop mutates every tick (`packages/agent/src/risk/guards.ts`,
`packages/agent/src/arena.ts`).

**`RiskLimits`** (devnet defaults in `config.ts`):

| Limit | Default | Meaning |
| --- | --- | --- |
| `maxStakePerPosition` | 10 USDC | Cap on the locked stake for any single `postOffer`/`fillOffer`. |
| `maxOpenExposure` | 200 USDC | Cap on total locked stake across all live positions. |
| `maxDailyLossBps` | 2000 (20%) | Halt new exposure once `realizedLoss > maxOpenExposure × 20%`. |
| `minEdgeBps` | 50 | Minimum edge the taker strategy requires to fill (mirrored, independently, in the guard). |
| `noTradePhases` | `NS, F, FET, FPE, I, A, C, TXCC, TXCS, P` | Phases where no new exposure is allowed at all. |
| `maxFeedStalenessMs` | 60,000 | Halt everything if the perception feed hasn't updated in this long. |

**`checkIntent(intent, budget, limits)`** is the single hard gate every
`Intent` must clear before `Executor` ever builds a transaction, evaluated in
this order:

1. `cancelOffer` is always allowed — it only removes exposure, never adds it.
2. Feed staleness blocks everything else — a stale feed means the fair-value
   model is looking at old data, so no new risk should be taken regardless of
   what the strategy computed.
3. No-trade phase blocks everything else.
4. `createMarket` is then allowed unconditionally (creating a market alone
   locks no collateral).
5. Daily-loss halt: blocks any new exposure (not `cancelOffer`/`createMarket`)
   once realized losses exceed the configured fraction of `maxOpenExposure`.
6. Per-position stake cap, computed the same way the venue program computes
   maker/taker stake (`pot × priceYesBps / 10_000` or its complement) so the
   guard's number always matches what actually gets locked on-chain.
7. Total open-exposure cap against the projected new total.

**`RiskBudget`** (`openExposure`, `realizedPnl`, `feedStaleMs`, `phase`) is
maintained entirely client-side in `arena.ts` — it is *not* an on-chain
account, so it resets whenever the process restarts (consistent with the
"session-local registry" limitation called out in the README: this is a
demonstration-grade single-process budget, not a persisted ledger). After
every confirmed intent, `applyExposure` adds or releases the correct stake
fraction (`postOffer` locks the maker side, `fillOffer` locks the taker's
counter-side, `cancelOffer` releases the maker's side back); after every
confirmed settlement, `releaseSettledPosition` releases the agent's own stake
and applies the realized win/loss to `realizedPnl`, which then feeds back
into rule 5 above on the next tick.

## 5. Platform surface

- **`@touchline/strategy-sdk`** re-exports the full agent surface — types,
  `runAgent`, both reference strategies, `fairValue`, `checkIntent`,
  `Executor`/`Keeper`, config helpers — so a third-party strategy is just an
  object implementing `Strategy.onTick(ctx, cfg): Intent[]` plugged into the
  same runner, risk guards, and executor the reference strategies use.
- **`@touchline/mcp`** wraps the same read paths (`list_markets`,
  `get_market`, `fair_value`) and the same `Executor`/`Keeper` write paths
  (`create_market`, `post_offer`, `fill_offer`, `cancel_offer`, `settle`)
  behind an MCP stdio server, so an LLM agent gets the identical risk-checked
  execution path a scripted strategy gets — write tools are opt-in via
  `TOUCHLINE_MCP_ALLOW_WRITES=1` and the wallet is never loaded until the
  first write call.
- **`@touchline/x402`** sells the same `fairValue` computation the agent
  trades on as a metered HTTP endpoint, gated by an x402 `402 Payment
  Required` challenge/response instead of an API key — the same model, priced
  per call instead of embedded in a strategy.
- **`@touchline/app`** is a read-only client of the venue program: it calls
  `getProgramAccounts` with an Anchor discriminator filter for each of
  `Market`/`Offer`/`Position`, decodes them with the generated `venue-client`
  decoders, and (best-effort, since a settled `Position` doesn't itself
  record which side won) recovers each settlement's outcome by locating and
  decoding the `settle` instruction's transaction data for that position.
  There is no backend and no indexer — it's a static Vite app reading Solana
  directly, polling every 10 seconds.

## 6. Test coverage

- **Program**: `cargo test -p touchline` — 16 LiteSVM tests across
  `lib.rs` (program ID sanity), `tests/venue.rs` (market creation, mint
  decimals rejection, offer posting/locking, cancel refunds, per-fill and
  per-market cap rejection, fill escrow accounting), and
  `tests/settlement.rs` (YES wins, NO wins, a two-stat `Add` predicate, wrong
  oracle program rejection, double-settle rejection, an attacker-supplied ATA
  rejection, and a full vault-drained assertion).
- **Agent**: `npx vitest run` inside `packages/agent` — 143 tests across
  `poisson.test.ts` (21), `guards.test.ts` (32), `fairValue.test.ts` (24),
  `matchState.test.ts` (27), `taker.test.ts` (17), and `mm.test.ts` (22).
