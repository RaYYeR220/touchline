import type { MatchState, MarketLine, Predicate, Phase } from "../types.js";
import { poissonSf, poissonPmf } from "./poisson.js";

// ---------------------------------------------------------------------------
// Model parameters
// ---------------------------------------------------------------------------

/**
 * Parameters for the Poisson fair-value model.
 *
 * baseRate maps a full-game stat key to the expected total count per regulation
 * (90 minutes).  E.g. { 1: 1.4, 2: 1.4 } → each team scores ~1.4 goals/game.
 */
export interface ModelParams {
  /** Expected occurrences per 90-minute regulation for each stat key. */
  baseRate: Record<number, number>;
  /**
   * Blend weight for the Poisson model vs the market line.
   * fair = w * pModel + (1-w) * lineProb
   * Default: 0.5 (equal weight when a market line is available).
   */
  modelWeight: number;
}

/** Regulation length in minutes used for time-decay. */
const REGULATION_MINUTES = 90;

/** Phases that represent a terminal state — no goals can be scored. */
const TERMINAL_PHASES: Phase[] = ["F", "FET", "FPE"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Retrieve the current accumulated stat value from MatchState by stat key.
 *
 * Full-game keys (period = 0):
 *   1 → p1Goals   2 → p2Goals
 *
 * Period-specific keys are not yet carried in MatchState (they require
 * per-period accumulators that the perception layer doesn't emit today).
 * For now any unrecognised key returns 0 — extend this function as new stat
 * categories are added to MatchState.
 */
function statValue(state: MatchState, statKey: number): number {
  switch (statKey) {
    case 1: return state.p1Goals;
    case 2: return state.p2Goals;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic Poisson fair-value estimate.
 *
 * Model spec (implements the plan exactly):
 *
 * 1. Current stat value c = statValue(state, statKey).
 *
 * 2. remainingFraction = clamp((REGULATION_MINUTES - state.minute) /
 *      REGULATION_MINUTES, 0, 1).
 *    Terminal phases (F, FET, FPE) → remainingFraction = 0.
 *
 * 3. lambdaRemaining = params.baseRate[statKey] * remainingFraction.
 *
 * 4. pModel by predicate type:
 *    GreaterThan threshold:
 *      c > threshold → 1 (already true at full time regardless of added goals)
 *      else          → poissonSf(threshold - c, lambdaRemaining)
 *                        (probability that X > threshold-c additional goals score)
 *
 *    LessThan threshold:
 *      1 - P(final >= threshold)
 *      = 1 - poissonSf(threshold - c - 1, lambdaRemaining)
 *      (if c >= threshold → 0, naturally handled since sf(-1)=1 → 1-1=0)
 *
 *    EqualTo threshold:
 *      threshold - c < 0 → 0
 *      else              → poissonPmf(threshold - c, lambdaRemaining)
 *
 * 5. Blend:
 *    line present: fair = w * pModel + (1-w) * (line.impliedYesBps / 10000)
 *    no line:      fair = pModel
 *
 * @param market  { statKey, predicate } — identifies which stat and condition.
 * @param state   Current accumulated MatchState.
 * @param line    Optional market line from the odds stream.
 * @param params  Model parameters (rates + blend weight).
 * @returns       Probability in [0, 1] that the predicate is YES at full time.
 */
export function fairValue(
  market: { statKey: number; predicate: Predicate },
  state: MatchState,
  line: MarketLine | undefined,
  params: ModelParams,
): number {
  const { statKey, predicate } = market;
  const { threshold, comparison } = predicate;

  // Step 1: current stat count.
  const c = statValue(state, statKey);

  // Step 2: remaining time fraction.
  const isTerminal = TERMINAL_PHASES.includes(state.phase);
  const remainingFraction = isTerminal
    ? 0
    : clamp((REGULATION_MINUTES - state.minute) / REGULATION_MINUTES, 0, 1);

  // Step 3: expected additional occurrences.
  const baseRate = params.baseRate[statKey] ?? 0;
  const lambdaRemaining = baseRate * remainingFraction;

  // Step 4: model probability.
  let pModel: number;

  switch (comparison) {
    case "GreaterThan":
      // P(final > threshold) = P(c + X > threshold) = P(X > threshold - c)
      if (c > threshold) {
        pModel = 1;
      } else {
        pModel = poissonSf(threshold - c, lambdaRemaining);
      }
      break;

    case "LessThan":
      // P(final < threshold) = 1 - P(final >= threshold)
      //                      = 1 - P(X >= threshold - c)
      //                      = 1 - poissonSf(threshold - c - 1, lambdaRemaining)
      // When c >= threshold: poissonSf(negative, λ) = 1 → result = 0. ✓
      pModel = 1 - poissonSf(threshold - c - 1, lambdaRemaining);
      break;

    case "EqualTo": {
      const need = threshold - c;
      pModel = need < 0 ? 0 : poissonPmf(need, lambdaRemaining);
      break;
    }
  }

  // Clamp pModel to [0, 1] (floating-point safety).
  pModel = clamp(pModel, 0, 1);

  // Step 5: blend with market line.
  if (line !== undefined) {
    const lineProb = line.impliedYesBps / 10000;
    const w = params.modelWeight;
    return clamp(w * pModel + (1 - w) * lineProb, 0, 1);
  }

  return pModel;
}
