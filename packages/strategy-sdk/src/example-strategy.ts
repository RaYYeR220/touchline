/**
 * Example strategy: "fade the line"
 *
 * Scans every open offer and fills any whose implied YES price diverges by more
 * than `edgeThresholdBps` from a fixed prior probability.  The prior is a
 * static per-stat-key belief; the strategy bets that the market line has
 * drifted away from fair value and will revert.
 *
 * This is intentionally simple — it ignores live match state — so it serves as
 * a clear example of the Strategy interface rather than a production alpha.
 *
 * To run with the built-in agent loop:
 *
 *   import { fadeTheLineStrategy, buildConfig, runAgent } from "@touchline/strategy-sdk";
 *   import { createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes } from "@solana/kit";
 *   import { readFileSync } from "node:fs";
 *
 *   const cfg = buildConfig();
 *   const signer = await createKeyPairSignerFromBytes(
 *     new Uint8Array(JSON.parse(readFileSync(cfg.walletPath, "utf8")))
 *   );
 *   const rpc = createSolanaRpc(cfg.rpcUrl);
 *   const rpcSubscriptions = createSolanaRpcSubscriptions(cfg.rpcUrl.replace(/^http/, "ws"));
 *
 *   await runAgent({ strategy: fadeTheLineStrategy, cfg, signer, rpc, rpcSubscriptions });
 */

import type { Strategy, ArenaContext, AgentConfig, Intent, OfferView, MarketView } from "@touchline/agent/api";

// ---------------------------------------------------------------------------
// Strategy parameters
// ---------------------------------------------------------------------------

/**
 * Fixed prior: the strategy's belief about the true YES probability for each
 * stat key, expressed as a fraction in [0, 1].
 *
 * Example: { 1: 0.45 } means "P1 scores >1 goal with probability 45%".
 * Adjust these priors to reflect your own research.
 */
const PRIOR: Record<number, number> = {
  1: 0.45, // P1 total goals > threshold
  2: 0.45, // P2 total goals > threshold
};

/**
 * Minimum edge (as a fraction) required to fill an offer.
 * 0.05 = we need at least 500 bps edge before placing a bet.
 */
const EDGE_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function findMarket(markets: MarketView[], address: string): MarketView | undefined {
  return markets.find((m) => String(m.address) === address);
}

/**
 * "Fade the line" strategy.
 *
 * Each tick it looks at every open offer and fills any where the implied YES
 * price is far enough from a fixed prior — i.e., the market looks wrong.
 *
 * This implements the {@link Strategy} interface directly.  Pass it to
 * {@link runAgent} as the `strategy` parameter.
 */
export const fadeTheLineStrategy: Strategy = {
  name: "fade-the-line",

  onTick(ctx: ArenaContext, cfg: AgentConfig): Intent[] {
    const intents: Intent[] = [];
    const { offers, markets } = ctx;

    for (const offer of offers) {
      const market = findMarket(markets, String(offer.address));
      if (market === undefined) continue;

      // Look up the prior for this stat key.
      const prior = PRIOR[market.statKey];
      if (prior === undefined) continue;

      const impliedYes = offer.priceYesBps / 10_000;

      // For a YES-maker offer: taker goes NO.
      //   Edge = implied - prior  (positive when market over-prices YES)
      // For a NO-maker offer: taker goes YES.
      //   Edge = prior - implied  (positive when market under-prices YES)
      const edge =
        offer.makerSide === "Yes"
          ? impliedYes - prior
          : prior - impliedYes;

      if (edge < EDGE_THRESHOLD) continue;

      // Size: fill the full remaining pot, capped by the per-position limit.
      const stakeFractionBps =
        offer.makerSide === "Yes"
          ? BigInt(10_000 - offer.priceYesBps)
          : BigInt(offer.priceYesBps);

      if (stakeFractionBps === 0n) continue;

      const maxFillPot =
        (cfg.risk.maxStakePerPosition * 10_000n) / stakeFractionBps;

      const fillPot =
        offer.remainingPot < maxFillPot ? offer.remainingPot : maxFillPot;

      if (fillPot <= 0n) continue;

      intents.push({ kind: "fillOffer", offer, fillPot });
    }

    return intents;
  },
};
