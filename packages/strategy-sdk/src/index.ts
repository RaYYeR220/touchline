/**
 * @touchline/strategy-sdk
 *
 * Public surface for writing and running custom strategies on the Touchline
 * arena.  Everything you need is re-exported from here.
 */

export type {
  // Context delivered to your strategy each tick
  ArenaContext,
  MatchState,
  MarketLine,
  MarketView,
  OfferView,
  PositionView,
  Predicate,
  Phase,

  // What your strategy returns
  Intent,

  // The interface your strategy must implement
  Strategy,

  // Config passed alongside the context
  AgentConfig,
  StrategyParams,

  // Risk types
  RiskBudget,
  RiskLimits,
  CheckResult,

  // Model types
  ModelParams,

  // Runner types
  RunAgentParams,
  RunAgentOptions,
} from "@touchline/agent/api";

export {
  // Built-in strategy factories (use or extend these)
  makeMarketMaker,
  makeTaker,

  // Deterministic fair-value model
  fairValue,

  // Risk guard — called by the exec layer; useful for pre-flight checks
  checkIntent,

  // Transaction executor and keeper
  Executor,
  Keeper,
  getAtaAddress,
  deriveMarketPda,

  // Config helpers
  buildConfig,
  DEFAULT_RISK_LIMITS,
  DEFAULT_STRATEGY_PARAMS,
  DEVNET_ADDRESSES,

  // Arena runner — the main loop
  runAgent,
} from "@touchline/agent/api";

// Example strategy
export { fadeTheLineStrategy } from "./example-strategy.js";
