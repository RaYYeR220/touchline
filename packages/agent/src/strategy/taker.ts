import type { ArenaContext, Intent, OfferView } from "../types.js";
import type { AgentConfig, StrategyParams } from "../config.js";
import type { Strategy } from "./types.js";
import { fairValue } from "../model/fairValue.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Taker (price-taking) strategy factory.
 *
 * Each tick, scans every open OfferView in the context and fills offers where
 * the agent has a measurable edge against the posted price.
 *
 * Edge calculation:
 *   ownFair = blended fair value (Poisson model + market line) for the offer's
 *             market, expressed as a YES probability in [0, 1].
 *   offerImpliedYes = offer.priceYesBps / 10000
 *
 *   For a YES-maker offer (we would fill as NO taker):
 *     edge = offerImpliedYes − ownFair
 *     (positive when the offer over-prices YES → NO is cheap)
 *
 *   For a NO-maker offer (we would fill as YES taker):
 *     edge = ownFair − offerImpliedYes
 *     (positive when the offer under-prices YES → YES is cheap)
 *
 *   Fill iff edge × 10000 ≥ params.minEdgeBps.
 *
 * Fill-pot sizing:
 *   Try to fill the full offer.remainingPot, but cap so the taker stake does
 *   not exceed cfg.risk.maxStakePerPosition.
 *
 *   Taker stake formulas (mirrors guards.ts takerStake):
 *     Maker YES → taker NO stake = fillPot × (10000 − priceYesBps) / 10000
 *     Maker NO  → taker YES stake = fillPot × priceYesBps / 10000
 *
 *   maxFillPot = maxStakePerPosition × 10000 / stakeFractionBps
 *
 * Offers are skipped when:
 *   - No matching market is found in ctx.markets (can't determine predicate).
 *   - No matching line is found in ctx.lines (can't compute fair value).
 *   - Edge is below the minimum threshold.
 *   - The computed fillPot is 0 (budget exhausted).
 */
export function makeTaker(params: StrategyParams): Strategy {
  return {
    name: "taker",

    onTick(ctx: ArenaContext, cfg: AgentConfig): Intent[] {
      const intents: Intent[] = [];
      const { state, lines, markets, offers } = ctx;

      for (const offer of offers) {
        // Look up the on-chain market for this offer.
        const market = markets.find((m) => m.address === offer.market);
        if (market === undefined) continue;

        // Find the matching market line (same fixtureId + statKey).
        const line = lines.find(
          (l) => l.fixtureId === market.fixtureId && l.statKey === market.statKey,
        );
        // No line → model-only fair value (line = undefined is fine for fairValue).

        // Compute our fair-value estimate for this market's predicate.
        const ownFair = fairValue(
          { statKey: market.statKey, predicate: market.predicate },
          state,
          line,
          { baseRate: params.baseRate, modelWeight: params.modelWeight },
        );

        const offerImpliedYes = offer.priceYesBps / 10000;

        // Edge signed so that positive = profitable fill for the taker.
        const edge =
          offer.makerSide === "Yes"
            ? offerImpliedYes - ownFair   // take NO when YES is overpriced
            : ownFair - offerImpliedYes;  // take YES when YES is underpriced

        // Skip if the edge is below the minimum threshold.
        if (edge * 10000 < params.minEdgeBps) continue;

        // Compute the fill-pot size: full offer, but capped by per-position stake.
        // stakeFractionBps is the taker's stake as a fraction of the total pot.
        const stakeFractionBps =
          offer.makerSide === "Yes"
            ? BigInt(10000 - offer.priceYesBps)  // taker is NO: stake = pot × (1−P)
            : BigInt(offer.priceYesBps);          // taker is YES: stake = pot × P

        // Avoid division by zero (should never happen with valid bps range).
        if (stakeFractionBps === 0n) continue;

        const maxFillPot =
          (cfg.risk.maxStakePerPosition * 10000n) / stakeFractionBps;

        const fillPot =
          offer.remainingPot < maxFillPot ? offer.remainingPot : maxFillPot;

        if (fillPot <= 0n) continue;

        intents.push({ kind: "fillOffer", offer, fillPot });
      }

      return intents;
    },
  };
}
