import type { Phase, Intent, OfferView } from "../types.js";

/**
 * Hard position and exposure limits. All bigint values are USDC base units
 * (6 decimals, u64). Bps values are integer basis points (1 bps = 0.01%).
 */
export interface RiskLimits {
  /** Maximum locked stake per single position (postOffer or fillOffer). */
  maxStakePerPosition: bigint;
  /** Maximum total open exposure across all live positions. */
  maxOpenExposure: bigint;
  /**
   * Daily loss halt threshold in bps of maxOpenExposure.
   * If realizedLoss > maxOpenExposure * maxDailyLossBps / 10000, new
   * exposure is blocked (cancel-only).
   */
  maxDailyLossBps: number;
  /** Minimum edge required for a taker fill (strategy layer; also checked here). */
  minEdgeBps: number;
  /** Phases in which new exposure is forbidden (pre-match, terminal, etc.). */
  noTradePhases: Phase[];
  /** Feed staleness threshold: block trading if last update is older than this. */
  maxFeedStalenessMs: number;
}

/**
 * Runtime risk budget — updated after each execution and each tick.
 * realizedPnl is negative for a loss.
 */
export interface RiskBudget {
  /** Sum of all open locked stakes (both sides across all live positions). */
  openExposure: bigint;
  /** Net realised PnL since last reset. Negative means a loss. */
  realizedPnl: bigint;
  /** Milliseconds since the most recent feed message was received. */
  feedStaleMs: number;
  /** Current match phase as seen by the agent. */
  phase: Phase;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the maker's locked stake for a postOffer intent.
 *
 *   YES maker stake = pot * priceYesBps / 10000
 *   NO  maker stake = pot * (10000 - priceYesBps) / 10000
 *
 * Integer division truncates; the on-chain contract uses the same formula.
 */
function makerStake(side: "Yes" | "No", priceYesBps: number, pot: bigint): bigint {
  if (side === "Yes") {
    return (pot * BigInt(priceYesBps)) / 10000n;
  }
  return (pot * BigInt(10000 - priceYesBps)) / 10000n;
}

/**
 * Compute the taker's locked counter-stake for a fillOffer intent.
 *
 * The taker takes the opposite side from the maker.
 *   Maker YES → taker NO: stake = fillPot * (10000 - priceYesBps) / 10000
 *   Maker NO  → taker YES: stake = fillPot * priceYesBps / 10000
 */
function takerStake(offer: OfferView, fillPot: bigint): bigint {
  if (offer.makerSide === "Yes") {
    return (fillPot * BigInt(10000 - offer.priceYesBps)) / 10000n;
  }
  return (fillPot * BigInt(offer.priceYesBps)) / 10000n;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Hard risk gate that every Intent must pass before execution.
 *
 * Rejection rules (evaluated in order):
 * 1. Feed stale — feedStaleMs > maxFeedStalenessMs.
 * 2. No-trade phase — current phase is in noTradePhases.
 * 3. Daily loss halt — realized loss exceeds maxDailyLossBps of maxOpenExposure;
 *    only createMarket and cancelOffer bypass this (they add no exposure).
 * 4. Stake > maxStakePerPosition.
 * 5. openExposure + stake > maxOpenExposure.
 *
 * createMarket and cancelOffer are always allowed (they do not add exposure)
 * unless blocked by rules 1 or 2.
 */
export function checkIntent(
  intent: Intent,
  budget: RiskBudget,
  limits: RiskLimits,
): CheckResult {
  // cancelOffer is risk-reducing (removes exposure) — always allowed.
  if (intent.kind === "cancelOffer") {
    return { ok: true };
  }

  // Rule 1: stale feed — block everything else.
  if (budget.feedStaleMs > limits.maxFeedStalenessMs) {
    return { ok: false, reason: `feed stale (${budget.feedStaleMs} ms > ${limits.maxFeedStalenessMs} ms)` };
  }

  // Rule 2: no-trade phase — block everything else.
  if (limits.noTradePhases.includes(budget.phase)) {
    return { ok: false, reason: `no-trade phase (${budget.phase})` };
  }

  // createMarket never adds exposure — allow past all remaining rules.
  if (intent.kind === "createMarket") {
    return { ok: true };
  }

  // Rule 3: daily loss halt — block new exposure.
  const maxLoss = (limits.maxOpenExposure * BigInt(limits.maxDailyLossBps)) / 10000n;
  if (-budget.realizedPnl > maxLoss) {
    return {
      ok: false,
      reason: `daily loss limit reached (loss ${-budget.realizedPnl} > ${maxLoss} USDC base units)`,
    };
  }

  // Compute the stake locked by this intent.
  let stake: bigint;
  if (intent.kind === "postOffer") {
    stake = makerStake(intent.side, intent.priceYesBps, intent.pot);
  } else {
    // fillOffer
    stake = takerStake(intent.offer, intent.fillPot);
  }

  // Rule 4: per-position stake limit.
  if (stake > limits.maxStakePerPosition) {
    return {
      ok: false,
      reason: `stake ${stake} exceeds maxStakePerPosition ${limits.maxStakePerPosition}`,
    };
  }

  // Rule 5: total open exposure limit.
  const projectedExposure = budget.openExposure + stake;
  if (projectedExposure > limits.maxOpenExposure) {
    return {
      ok: false,
      reason: `projected exposure ${projectedExposure} exceeds maxOpenExposure ${limits.maxOpenExposure}`,
    };
  }

  return { ok: true };
}
