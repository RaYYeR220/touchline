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

/** Apply locked-stake delta to budget after a confirmed execution. */
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
  }
  // cancelOffer reduces exposure; not tracked precisely in v1
}

/** Best-effort stat value from the current MatchState for keeper settlement. */
function statValueFromState(state: MatchState, statKey: number): number {
  if (statKey === 1) return state.p1Goals;
  if (statKey === 2) return state.p2Goals;
  return 0;
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
        const sig = await executor.execute(intent);
        console.log(`[tick ${tick}]   SENT     ${desc} sig=${sig}`);
        applyExposure(budget, intent);
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
        try {
          const settleSig = await keeper.settle(position, market, statValue);
          console.log(`[tick ${tick}]   SETTLED  position=${addr} sig=${settleSig}`);
          knownPositions.set(addr, { ...position, settled: true });
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
