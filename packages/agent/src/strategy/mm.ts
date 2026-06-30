import type { ArenaContext, Intent } from "../types.js";
import type { AgentConfig, StrategyParams } from "../config.js";
import type { Strategy } from "./types.js";
import { fairValue } from "../model/fairValue.js";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Phases where the game is definitively over.
 * All open quotes must be pulled immediately on entry to these phases.
 */
const TERMINAL_PHASES = new Set<string>(["F", "FET", "FPE"]);

/**
 * Pull all quotes when the blended fair value is this close to 0 or 1.
 * At extreme certainty the effective spread collapses and the market is nearly
 * settled, so market-making has near-zero expected value.
 */
const HIGH_CERTAINTY_THRESHOLD = 0.99;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampBps(v: number): number {
  return Math.max(1, Math.min(9999, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Market-maker strategy factory.
 *
 * Returns a Strategy that, each tick:
 *
 * 1. Terminal phase (F / FET / FPE):
 *    Cancel every open offer in the context — the game is over and all
 *    outstanding positions will settle shortly.
 *
 * 2. No-trade phase (NS, I, A, C, …):
 *    Stand down — emit nothing.
 *
 * 3. For each MarketLine (fixtureId, statKey) with a tradeable phase:
 *    a. If no on-chain market exists for this (fixtureId, statKey):
 *       Emit createMarket with the canonical predicate "GreaterThan 1"
 *       (resolves YES if the stat count exceeds 1 by full time).
 *    b. For each open market matching (fixtureId, statKey):
 *       - Compute blended fair value from Poisson model + market line.
 *       - High-certainty pull: if fair > HIGH_CERTAINTY_THRESHOLD or
 *         fair < 1 - HIGH_CERTAINTY_THRESHOLD, cancel all offers for the
 *         market and skip quoting (spread is meaningless near resolution).
 *       - Otherwise emit two-sided offers:
 *           YES offer: priceYesBps = clamp(fairBps − halfSpread + skewBps, 1, 9999)
 *           NO  offer: priceYesBps = clamp(fairBps + halfSpread + skewBps, 1, 9999)
 *
 * Inventory skew:
 *   Count YES-side vs NO-side positions held for the market.
 *   imbalance = yesCount − noCount
 *   skewBps = clamp(imbalance × floor(halfSpread / 2), −halfSpread, +halfSpread)
 *   Positive imbalance (long YES) → shift both quotes up, cooling YES demand
 *   and accelerating NO filling to rebalance the book.
 *
 * Pot sizing:
 *   Use params.defaultPotUsdc.  When the remaining budget
 *   (maxOpenExposure − openExposure) falls below defaultPotUsdc, halve it to
 *   avoid breaching the global exposure limit on a single tick.
 *
 * Note: the exec layer re-checks every Intent through checkIntent() before
 * execution, so this strategy does not need to enforce the exact per-position
 * limits — only a best-effort size reduction to avoid obviously oversized Intents.
 */
export function makeMarketMaker(params: StrategyParams): Strategy {
  return {
    name: "mm",

    onTick(ctx: ArenaContext, cfg: AgentConfig): Intent[] {
      const intents: Intent[] = [];
      const { state, lines, markets, offers, positions, risk } = ctx;
      const { noTradePhases, maxOpenExposure } = cfg.risk;

      // --- 1. Terminal phase: pull every open offer immediately ---
      if (TERMINAL_PHASES.has(state.phase)) {
        for (const offer of offers) {
          intents.push({ kind: "cancelOffer", offer });
        }
        return intents;
      }

      // --- 2. No-trade phase: stand down ---
      if (noTradePhases.includes(state.phase)) {
        return intents;
      }

      // --- 3. Quote each tradeable line ---
      for (const line of lines) {
        const { fixtureId, statKey } = line;

        // Find open on-chain markets for this (fixtureId, statKey).
        const openMarkets = markets.filter(
          (m) => m.fixtureId === fixtureId && m.statKey === statKey && m.status === "Open",
        );

        if (openMarkets.length === 0) {
          // No market yet — create one with the canonical GreaterThan-1 predicate.
          intents.push({
            kind: "createMarket",
            fixtureId,
            statKey,
            predicate: { threshold: 1, comparison: "GreaterThan" },
          });
          continue; // can't post offers until the market is live
        }

        for (const market of openMarkets) {
          // Blended fair value: Poisson model + market line.
          const fair = fairValue(
            { statKey, predicate: market.predicate },
            state,
            line,
            { baseRate: params.baseRate, modelWeight: params.modelWeight },
          );

          // High-certainty pull: cancel quotes when the market is nearly settled.
          if (fair > HIGH_CERTAINTY_THRESHOLD || fair < 1 - HIGH_CERTAINTY_THRESHOLD) {
            const marketOffers = offers.filter((o) => o.market === market.address);
            for (const offer of marketOffers) {
              intents.push({ kind: "cancelOffer", offer });
            }
            continue;
          }

          // --- Inventory skew ---
          // Count YES-side vs NO-side positions held for this market.
          // Positive imbalance (more YES held) → shift both quotes up to slow
          // YES accumulation. Negative imbalance → shift down to slow NO accumulation.
          // Skew is bounded to ±halfSpreadBps so it never crosses or flips the spread.
          const yesCount = positions.filter(
            (p) => p.market === market.address && p.makerSide === "Yes",
          ).length;
          const noCount = positions.filter(
            (p) => p.market === market.address && p.makerSide === "No",
          ).length;
          const imbalance = yesCount - noCount;
          const halfStep = Math.floor(params.halfSpreadBps / 2);
          const skewBps = Math.max(
            -params.halfSpreadBps,
            Math.min(params.halfSpreadBps, imbalance * halfStep),
          );

          const fairBps = Math.round(fair * 10000);

          // YES offer (maker bets YES): quoted below fair to earn the spread.
          // A taker filling NO gets YES-priced-low, which is attractive to
          // those who think YES probability < yesPriceBps.
          const yesPriceBps = clampBps(fairBps - params.halfSpreadBps + skewBps);

          // NO offer (maker bets NO): equivalent YES price quoted above fair.
          // A taker filling YES gets NO-priced-low, attractive to those who
          // think YES probability > noPriceBps.
          const noPriceBps = clampBps(fairBps + params.halfSpreadBps + skewBps);

          // --- Pot sizing ---
          // Back off to half the remaining budget when close to the exposure cap.
          const remaining = maxOpenExposure - risk.openExposure;
          const potSize =
            remaining < params.defaultPotUsdc
              ? remaining / 2n
              : params.defaultPotUsdc;

          if (potSize <= 0n) continue;

          intents.push({
            kind: "postOffer",
            market: market.address,
            side: "Yes",
            priceYesBps: yesPriceBps,
            pot: potSize,
          });

          intents.push({
            kind: "postOffer",
            market: market.address,
            side: "No",
            priceYesBps: noPriceBps,
            pot: potSize,
          });
        }
      }

      return intents;
    },
  };
}
