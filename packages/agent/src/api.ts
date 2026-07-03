/**
 * Public API barrel for @touchline/agent.
 * Import from "@touchline/agent/api" to get all public types and functions
 * without pulling in the CLI entry-point.
 */

// Core types
export type {
  Phase,
  MatchState,
  MarketLine,
  Predicate,
  MarketView,
  OfferView,
  PositionView,
  ArenaContext,
  Intent,
} from "./types.js";

// Strategy interface
export type { Strategy } from "./strategy/types.js";

// Built-in strategy factories
export { makeMarketMaker } from "./strategy/mm.js";
export { makeTaker } from "./strategy/taker.js";

// Fair-value model
export { fairValue } from "./model/fairValue.js";
export type { ModelParams } from "./model/fairValue.js";

// Risk
export { checkIntent } from "./risk/guards.js";
export type { RiskBudget, RiskLimits, CheckResult } from "./risk/guards.js";

// Execution
export { Executor, getAtaAddress, deriveMarketPda } from "./exec/executor.js";

// Keeper (settlement)
export { Keeper } from "./keeper/settle.js";

// Agent config
export type { AgentConfig, StrategyParams } from "./config.js";
export {
  buildConfig,
  DEFAULT_RISK_LIMITS,
  DEFAULT_STRATEGY_PARAMS,
  DEVNET_ADDRESSES,
} from "./config.js";

// Arena runner
export { runAgent } from "./arena.js";
export type { RunAgentParams, RunAgentOptions } from "./arena.js";
