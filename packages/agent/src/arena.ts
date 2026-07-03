/**
 * Arena — the autonomous agent orchestration loop.
 *
 * Wires perception (state source) → strategy → risk guards → executor.
 * Tracks a RiskBudget across ticks and runs the keeper for settled positions.
 *
 * Local registry v1 note: markets / offers / positions are tracked only from
 * transactions sent in this session.  On-chain discovery (getProgramAccounts)
 * is not implemented; the agent will recreate markets if restarted without a
 * persistent store.
 */
import type {
  Rpc,
  SolanaRpcApi,
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  TransactionSigner,
} from "@solana/kit";
import type {
  ArenaContext,
  Intent,
  MatchState,
  MarketLine,
  MarketView,
  OfferView,
  PositionView,
} from "./types.js";
import type { AgentConfig } from "./config.js";
import type { Strategy } from "./strategy/types.js";
import { checkIntent, type RiskBudget } from "./risk/guards.js";
import { Executor } from "./exec/executor.js";
import { Keeper } from "./keeper/settle.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Compute + log intents but do NOT send transactions. */
  dryRun?: boolean;
  /** Stop after this many ticks. Runs indefinitely if undefined. */
  maxTicks?: number;
  /** Milliseconds between ticks. Default: 5 000. */
  tickMs?: number;
  /**
   * Source of perception events (MatchState + MarketLine updates).
   * Pass a synthetic generator for demos/dry-run.
   * Omit to tick without live state (prints a warning each tick).
   */
  stateSource?: AsyncIterable<{ state?: MatchState; line?: MarketLine }>;
}

export interface RunAgentParams {
  strategy: Strategy;
  cfg: AgentConfig;
  signer: TransactionSigner;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  opts?: RunAgentOptions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_PHASES = new Set<string>(["F", "FET", "FPE"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case "createMarket":
      return `createMarket fixture=${intent.fixtureId} stat=${intent.statKey}`;
    case "postOffer":
      return `postOffer market=${String(intent.market)} side=${intent.side} price=${intent.priceYesBps}bps pot=${intent.pot}`;
    case "fillOffer":
      return `fillOffer offer=${String(intent.offer.address)} fillPot=${intent.fillPot}`;
    case "cancelOffer":
      return `cancelOffer offer=${String(intent.offer.address)}`;
  }
}

/**
 * Update openExposure (and optionally realizedPnl) after a confirmed intent.
 *
 * Accounting:
 *   postOffer  → add maker stake to openExposure
 *   fillOffer  → add taker (counter) stake to openExposure
 *   cancelOffer → release maker stake from openExposure (bidirectional)
 *   settlement  → call releaseSettledPosition() instead
 */
function applyExposure(budget: RiskBudget, intent: Intent): void {
  if (intent.kind === "postOffer") {
    const stake =
      intent.side === "Yes"
        ? (intent.pot * BigInt(intent.priceYesBps)) / 10_000n
        : (intent.pot * BigInt(10_000 - intent.priceYesBps)) / 10_000n;
    budget.openExposure += stake;
  } else if (intent.kind === "fillOffer") {
    const stake =
      intent.offer.makerSide === "Yes"
        ? (intent.fillPot * BigInt(10_000 - intent.offer.priceYesBps)) / 10_000n
        : (intent.fillPot * BigInt(intent.offer.priceYesBps)) / 10_000n;
    budget.openExposure += stake;
  } else if (intent.kind === "cancelOffer") {
    // Release the maker's locked stake; keep total non-negative.
    const offerView = intent.offer;
    const release =
      offerView.makerSide === "Yes"
        ? (offerView.remainingPot * BigInt(offerView.priceYesBps)) / 10_000n
        : (offerView.remainingPot * BigInt(10_000 - offerView.priceYesBps)) / 10_000n;
    budget.openExposure = budget.openExposure > release ? budget.openExposure - release : 0n;
  }
}

/**
 * Called after a position is successfully settled.
 * Releases the agent's stake from openExposure and updates realizedPnl.
 *
 * Accounting:
 *   agentStake  = the portion the agent locked for this position
 *   If agent wins: realizedPnl += (pot - agentStake)   (gain = counterparty stake)
 *   If agent loses: realizedPnl -= agentStake           (loss = own stake)
 */
function releaseSettledPosition(
  budget: RiskBudget,
  position: PositionView,
  agentAddress: string,
  yesWon: boolean,
): void {
  // Determine agent's role and stake.
  const agentIsMaker = String(position.maker) === agentAddress;
  const agentIsYes =
    (agentIsMaker && position.makerSide === "Yes") ||
    (!agentIsMaker && position.makerSide === "No");

  const yesFraction = BigInt(position.priceYesBps);
  const noFraction = BigInt(10_000 - position.priceYesBps);
  const agentStake = agentIsYes
    ? (position.pot * yesFraction) / 10_000n
    : (position.pot * noFraction) / 10_000n;

  // Release locked stake.
  budget.openExposure = budget.openExposure > agentStake ? budget.openExposure - agentStake : 0n;

  // Update realized PnL.
  const agentWon = agentIsYes === yesWon;
  if (agentWon) {
    budget.realizedPnl += position.pot - agentStake; // gain = counterparty stake
  } else {
    budget.realizedPnl -= agentStake; // loss = own stake
  }
}

/**
 * Return the stat value for the given statKey from live MatchState.
 * Returns undefined for unknown stat keys — callers must skip settlement
 * rather than auto-settling against a fabricated 0.
 */
function statValueFromState(state: MatchState, statKey: number): number | undefined {
  if (statKey === 1) return state.p1Goals;
  if (statKey === 2) return state.p2Goals;
  return undefined; // unknown stat key — refuse to settle
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runAgent(params: RunAgentParams): Promise<void> {
  const { strategy, cfg, signer, rpc, rpcSubscriptions, opts = {} } = params;
  const { dryRun = false, maxTicks, tickMs = 5_000, stateSource } = opts;

  const executor = new Executor(rpc, rpcSubscriptions, signer, cfg);
  const keeper = new Keeper(rpc, rpcSubscriptions, signer, cfg);

  // ── Risk budget (mutated across ticks) ────────────────────────────────────
  const budget: RiskBudget = {
    openExposure: 0n,
    realizedPnl: 0n,
    feedStaleMs: 0,
    phase: "NS",
  };

  // ── Local registry ─────────────────────────────────────────────────────────
  const knownMarkets = new Map<string, MarketView>();
  const knownOffers = new Map<string, OfferView>();
  const knownPositions = new Map<string, PositionView>();

  // ── Perception state ───────────────────────────────────────────────────────
  let currentState: MatchState | undefined;
  const latestLines = new Map<string, MarketLine>(); // key = `${fixtureId}:${statKey}`
  let stateLastUpdatedMs = 0;

  // Drain the state source in the background.
  if (stateSource !== undefined) {
    void (async () => {
      try {
        for await (const event of stateSource) {
          if (event.state !== undefined) {
            currentState = event.state;
            stateLastUpdatedMs = Date.now();
          }
          if (event.line !== undefined) {
            latestLines.set(`${event.line.fixtureId}:${event.line.statKey}`, event.line);
            if (stateLastUpdatedMs === 0) stateLastUpdatedMs = Date.now();
          }
        }
      } catch (err) {
        console.error(
          "[arena] state source error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();

    // Wait up to tickMs for the first state (the background task will set it).
    if (currentState === undefined) {
      await new Promise<void>((resolve) => {
        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(cleanup, tickMs);
        const poll = setInterval(() => {
          if (currentState !== undefined) cleanup();
        }, 50);
        void timer;
        void poll;
      });
    }
  }

  // ── Tick loop ──────────────────────────────────────────────────────────────
  let tick = 0;

  while (maxTicks === undefined || tick < maxTicks) {
    const nowMs = Date.now();

    // Refresh budget phase + feed staleness.
    budget.feedStaleMs = stateLastUpdatedMs > 0 ? nowMs - stateLastUpdatedMs : 0;
    budget.phase = currentState?.phase ?? "NS";

    if (currentState === undefined) {
      console.log(`[tick ${tick}] no state yet — waiting`);
      await sleep(tickMs);
      tick++;
      continue;
    }

    const lines = [...latestLines.values()];
    const ctx: ArenaContext = {
      state: currentState,
      lines,
      markets: [...knownMarkets.values()],
      offers: [...knownOffers.values()],
      positions: [...knownPositions.values()],
      risk: { ...budget },
      nowMs,
    };

    console.log(
      `[tick ${tick}] phase=${ctx.state.phase} min=${ctx.state.minute}` +
        ` P1=${ctx.state.p1Goals} P2=${ctx.state.p2Goals}` +
        ` lines=${lines.length} markets=${ctx.markets.length}` +
        ` offers=${ctx.offers.length} positions=${ctx.positions.length}` +
        ` exposure=${budget.openExposure} pnl=${budget.realizedPnl}`,
    );

    // ── Strategy → risk filter → execute ─────────────────────────────────────
    const intents = strategy.onTick(ctx, cfg);
    console.log(`[tick ${tick}] ${strategy.name}: ${intents.length} intent(s)`);

    for (const intent of intents) {
      const check = checkIntent(intent, budget, cfg.risk);
      if (!check.ok) {
        console.log(`[tick ${tick}]   REJECTED ${intent.kind}: ${check.reason}`);
        continue;
      }

      const desc = describeIntent(intent);

      if (dryRun) {
        console.log(`[tick ${tick}]   DRY-RUN  ${desc}`);
        continue;
      }

      try {
        const result = await executor.execute(intent);
        console.log(`[tick ${tick}]   SENT     ${desc} sig=${result.sig}`);
        applyExposure(budget, intent);

        // Populate local registry so strategies and keeper see non-empty state.
        if (intent.kind === "createMarket" && result.market !== undefined) {
          const marketAddr = result.market;
          knownMarkets.set(String(marketAddr), {
            address: marketAddr,
            fixtureId: intent.fixtureId,
            statKey: intent.statKey,
            predicate: intent.predicate,
            status: "Open",
            totalPot: 0n,
            oracleProgram: cfg.oracleProgram,
          });
        } else if (intent.kind === "postOffer" && result.offer !== undefined) {
          const offerAddr = result.offer;
          knownOffers.set(String(offerAddr), {
            address: offerAddr,
            market: intent.market,
            maker: executor.signer.address,
            makerSide: intent.side,
            priceYesBps: intent.priceYesBps,
            remainingPot: intent.pot,
          });
        } else if (intent.kind === "fillOffer" && result.position !== undefined) {
          const posAddr = result.position;
          knownPositions.set(String(posAddr), {
            address: posAddr,
            market: intent.offer.market,
            maker: intent.offer.maker,
            taker: executor.signer.address,
            makerSide: intent.offer.makerSide,
            priceYesBps: intent.offer.priceYesBps,
            pot: intent.fillPot,
            settled: false,
          });
          // Decrement matched offer's remainingPot.
          const offerKey = String(intent.offer.address);
          const existing = knownOffers.get(offerKey);
          if (existing !== undefined) {
            const updated = { ...existing, remainingPot: existing.remainingPot - intent.fillPot };
            if (updated.remainingPot <= 0n) {
              knownOffers.delete(offerKey);
            } else {
              knownOffers.set(offerKey, updated);
            }
          }
        } else if (intent.kind === "cancelOffer") {
          knownOffers.delete(String(intent.offer.address));
        }
      } catch (err) {
        console.error(
          `[tick ${tick}]   ERR      ${desc}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ── Keeper: settle positions whose market is in a terminal phase ──────────
    if (!dryRun && TERMINAL_PHASES.has(ctx.state.phase)) {
      for (const [addr, position] of knownPositions) {
        if (position.settled) continue;
        const market = knownMarkets.get(String(position.market));
        if (market === undefined) continue;
        const statValue = statValueFromState(ctx.state, market.statKey);
        if (statValue === undefined) {
          // Refuse to settle with a fabricated value for unknown stat keys.
          console.log(`[tick ${tick}]   SKIP_SETTLE position=${addr}: unknown statKey=${market.statKey}`);
          continue;
        }
        try {
          const settleSig = await keeper.settle(position, market, statValue);
          console.log(`[tick ${tick}]   SETTLED  position=${addr} sig=${settleSig}`);
          const settled = { ...position, settled: true };
          knownPositions.set(addr, settled);

          // Determine YES/NO outcome and update risk budget.
          const pred = market.predicate;
          let yesWon: boolean;
          if (pred.comparison === "GreaterThan") yesWon = statValue > pred.threshold;
          else if (pred.comparison === "LessThan") yesWon = statValue < pred.threshold;
          else yesWon = statValue === pred.threshold;
          releaseSettledPosition(budget, position, String(executor.signer.address), yesWon);
        } catch (err) {
          console.error(
            `[tick ${tick}]   SETTLE_ERR position=${addr}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    tick++;
    if (maxTicks === undefined || tick < maxTicks) {
      await sleep(tickMs);
    }
  }

  console.log(`[arena] done — ${tick} tick(s) completed.`);
}
