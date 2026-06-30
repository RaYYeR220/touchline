import { describe, it, expect } from "vitest";
import { makeMarketMaker } from "../src/strategy/mm.js";
import type { ArenaContext, MatchState, MarketLine, MarketView, OfferView, PositionView } from "../src/types.js";
import type { AgentConfig, StrategyParams } from "../src/config.js";
import { DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_PARAMS } from "../src/config.js";
import type { RiskBudget } from "../src/risk/guards.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW_MS = 1_700_000_000_000;

const MARKET_ADDR = "11111111111111111111111111111111" as never;
const MAKER_ADDR  = "22222222222222222222222222222222" as never;
const ORACLE_ADDR = "33333333333333333333333333333333" as never;

const BASE_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  halfSpreadBps: 100,      // 1% each side
  defaultPotUsdc: 2_000_000n,
  minEdgeBps: 50,
  baseRate: { 1: 1.4, 2: 1.4 },
  modelWeight: 0.5,
};

const BASE_CFG: AgentConfig = {
  network: "devnet",
  rpcUrl: "http://localhost",
  venueProgram: "44444444444444444444444444444444" as never,
  oracleProgram: ORACLE_ADDR,
  usdcMint: "55555555555555555555555555555555" as never,
  walletPath: "~/.config/solana/id.json",
  risk: { ...DEFAULT_RISK_LIMITS, noTradePhases: ["NS", "F", "FET", "FPE", "I", "A", "C", "TXCC", "TXCS", "P"] },
  strategy: BASE_PARAMS,
};

const HEALTHY_RISK: RiskBudget = {
  openExposure: 0n,
  realizedPnl: 0n,
  feedStaleMs: 0,
  phase: "H1",
};

function makeState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    fixtureId: 1,
    phase: "H1",
    minute: 45,
    p1Goals: 0,
    p2Goals: 0,
    updatedMs: FIXED_NOW_MS,
    ...overrides,
  };
}

function makeLine(statKey: number, impliedYesBps: number): MarketLine {
  return { fixtureId: 1, statKey, impliedYesBps, updatedMs: FIXED_NOW_MS };
}

function makeMarket(statKey: number, overrides: Partial<MarketView> = {}): MarketView {
  return {
    address: MARKET_ADDR,
    fixtureId: 1,
    statKey,
    predicate: { threshold: 1, comparison: "GreaterThan" },
    status: "Open",
    totalPot: 0n,
    oracleProgram: ORACLE_ADDR,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ArenaContext> = {}): ArenaContext {
  return {
    state: makeState(),
    lines: [makeLine(1, 5000)],
    markets: [makeMarket(1)],
    offers: [],
    positions: [],
    risk: HEALTHY_RISK,
    nowMs: FIXED_NOW_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Two-sided quoting
// ---------------------------------------------------------------------------

describe("makeMarketMaker — two-sided quotes", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  it("emits exactly one YES and one NO offer per open market", () => {
    const ctx = makeContext();
    const intents = mm.onTick(ctx, BASE_CFG);

    const posts = intents.filter((i) => i.kind === "postOffer");
    expect(posts).toHaveLength(2);

    const yesOffer = posts.find((i) => i.kind === "postOffer" && i.side === "Yes");
    const noOffer  = posts.find((i) => i.kind === "postOffer" && i.side === "No");
    expect(yesOffer).toBeDefined();
    expect(noOffer).toBeDefined();
  });

  it("YES price is strictly below NO price (spread exists)", () => {
    const ctx = makeContext();
    const intents = mm.onTick(ctx, BASE_CFG);

    const yesPrice = intents.find((i) => i.kind === "postOffer" && i.side === "Yes");
    const noPrice  = intents.find((i) => i.kind === "postOffer" && i.side === "No");

    if (yesPrice?.kind !== "postOffer" || noPrice?.kind !== "postOffer") throw new Error("type guard");
    expect(yesPrice.priceYesBps).toBeLessThan(noPrice.priceYesBps);
  });

  it("prices are within the valid 1..9999 range", () => {
    const ctx = makeContext();
    const intents = mm.onTick(ctx, BASE_CFG);

    for (const intent of intents) {
      if (intent.kind === "postOffer") {
        expect(intent.priceYesBps).toBeGreaterThanOrEqual(1);
        expect(intent.priceYesBps).toBeLessThanOrEqual(9999);
      }
    }
  });

  it("YES price is approximately fair − halfSpread", () => {
    // At minute=45, statKey=1 (GreaterThan 1), λ_remaining = 1.4 * 0.5 = 0.7
    // pModel = poissonSf(1, 0.7) ≈ 0.1558; blend(line=5000, w=0.5) → fair ≈ 0.3279
    // fairBps ≈ 3279; YES should be near 3279 - 100 = 3179
    const ctx = makeContext({ lines: [makeLine(1, 5000)] });
    const intents = mm.onTick(ctx, BASE_CFG);

    const yes = intents.find((i) => i.kind === "postOffer" && i.side === "Yes");
    if (yes?.kind !== "postOffer") throw new Error("type guard");
    expect(yes.priceYesBps).toBeLessThan(3279); // below fair
    expect(yes.priceYesBps).toBeGreaterThan(2900); // within ±300 of expected
  });

  it("NO price is approximately fair + halfSpread", () => {
    // Fair ≈ 3279; NO should be near 3279 + 100 = 3379
    const ctx = makeContext({ lines: [makeLine(1, 5000)] });
    const intents = mm.onTick(ctx, BASE_CFG);

    const no = intents.find((i) => i.kind === "postOffer" && i.side === "No");
    if (no?.kind !== "postOffer") throw new Error("type guard");
    expect(no.priceYesBps).toBeGreaterThan(3279); // above fair
    expect(no.priceYesBps).toBeLessThan(3600); // within ±300 of expected
  });

  it("uses defaultPotUsdc for pot size when budget is comfortable", () => {
    const ctx = makeContext();
    const intents = mm.onTick(ctx, BASE_CFG);

    for (const intent of intents) {
      if (intent.kind === "postOffer") {
        expect(intent.pot).toBe(BASE_PARAMS.defaultPotUsdc);
      }
    }
  });

  it("emits two offers per market across multiple stat keys", () => {
    const ctx = makeContext({
      lines: [makeLine(1, 5000), makeLine(2, 4000)],
      markets: [
        makeMarket(1),
        makeMarket(2, { address: "66666666666666666666666666666666" as never }),
      ],
    });
    const intents = mm.onTick(ctx, BASE_CFG);
    const posts = intents.filter((i) => i.kind === "postOffer");
    expect(posts).toHaveLength(4); // 2 per market
  });
});

// ---------------------------------------------------------------------------
// createMarket when missing
// ---------------------------------------------------------------------------

describe("makeMarketMaker — createMarket when market is absent", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  it("emits createMarket when no open market exists for the line", () => {
    const ctx = makeContext({ markets: [] }); // no markets at all
    const intents = mm.onTick(ctx, BASE_CFG);

    const creates = intents.filter((i) => i.kind === "createMarket");
    expect(creates).toHaveLength(1);
    if (creates[0]?.kind !== "createMarket") throw new Error("type guard");
    expect(creates[0].fixtureId).toBe(1);
    expect(creates[0].statKey).toBe(1);
    expect(creates[0].predicate).toEqual({ threshold: 1, comparison: "GreaterThan" });
  });

  it("does NOT emit postOffer when market is missing (wait for creation)", () => {
    const ctx = makeContext({ markets: [] });
    const intents = mm.onTick(ctx, BASE_CFG);
    const posts = intents.filter((i) => i.kind === "postOffer");
    expect(posts).toHaveLength(0);
  });

  it("emits postOffer (not createMarket) when the market already exists", () => {
    const ctx = makeContext({ markets: [makeMarket(1)] });
    const intents = mm.onTick(ctx, BASE_CFG);
    const creates = intents.filter((i) => i.kind === "createMarket");
    const posts   = intents.filter((i) => i.kind === "postOffer");
    expect(creates).toHaveLength(0);
    expect(posts).toHaveLength(2);
  });

  it("ignores Settled markets and emits createMarket", () => {
    // Settled markets should not be quoted; MM should treat them as absent.
    const settledMarket = makeMarket(1, { status: "Settled" });
    const ctx = makeContext({ markets: [settledMarket] });
    const intents = mm.onTick(ctx, BASE_CFG);
    const creates = intents.filter((i) => i.kind === "createMarket");
    expect(creates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Terminal phase: pull all offers
// ---------------------------------------------------------------------------

describe("makeMarketMaker — pull on terminal phase", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  const terminalPhases = ["F", "FET", "FPE"] as const;

  for (const phase of terminalPhases) {
    it(`cancels all open offers in phase ${phase}`, () => {
      const offer: OfferView = {
        address: "77777777777777777777777777777777" as never,
        market: MARKET_ADDR,
        maker: MAKER_ADDR,
        makerSide: "Yes",
        priceYesBps: 5000,
        remainingPot: 2_000_000n,
      };
      const ctx = makeContext({
        state: makeState({ phase }),
        offers: [offer],
      });
      const intents = mm.onTick(ctx, BASE_CFG);
      const cancels = intents.filter((i) => i.kind === "cancelOffer");
      expect(cancels).toHaveLength(1);
      if (cancels[0]?.kind !== "cancelOffer") throw new Error("type guard");
      expect(cancels[0].offer).toBe(offer);
    });
  }

  it("cancels multiple open offers on terminal phase", () => {
    const offerA: OfferView = {
      address: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
      market: MARKET_ADDR,
      maker: MAKER_ADDR,
      makerSide: "Yes",
      priceYesBps: 4900,
      remainingPot: 2_000_000n,
    };
    const offerB: OfferView = {
      address: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as never,
      market: MARKET_ADDR,
      maker: MAKER_ADDR,
      makerSide: "No",
      priceYesBps: 5100,
      remainingPot: 2_000_000n,
    };
    const ctx = makeContext({
      state: makeState({ phase: "F" }),
      offers: [offerA, offerB],
    });
    const intents = mm.onTick(ctx, BASE_CFG);
    const cancels = intents.filter((i) => i.kind === "cancelOffer");
    expect(cancels).toHaveLength(2);
  });

  it("emits ONLY cancels in terminal phase (no new offers)", () => {
    const offer: OfferView = {
      address: "cccccccccccccccccccccccccccccccccc" as never,
      market: MARKET_ADDR,
      maker: MAKER_ADDR,
      makerSide: "Yes",
      priceYesBps: 5000,
      remainingPot: 2_000_000n,
    };
    const ctx = makeContext({
      state: makeState({ phase: "F" }),
      offers: [offer],
    });
    const intents = mm.onTick(ctx, BASE_CFG);
    const posts = intents.filter((i) => i.kind === "postOffer");
    const creates = intents.filter((i) => i.kind === "createMarket");
    expect(posts).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No-trade phase: stand down
// ---------------------------------------------------------------------------

describe("makeMarketMaker — no-trade phase", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  it("emits nothing in NS phase", () => {
    const ctx = makeContext({ state: makeState({ phase: "NS" }) });
    const intents = mm.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("emits nothing in I (interrupted) phase", () => {
    const ctx = makeContext({ state: makeState({ phase: "I" }) });
    const intents = mm.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// High-certainty pull: fair near 0 or 1
// ---------------------------------------------------------------------------

describe("makeMarketMaker — high-certainty pull", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  it("cancels offers for a market where fair > 0.99 (near-certain YES)", () => {
    // game finished: terminal = fair 1 after the pull threshold
    // Use a live phase but trick fair high: minute=0, p1Goals already >> threshold
    // predicate GreaterThan 1, statKey 1, p1Goals=5 → fair near 1 in H1 minute 0
    const market = makeMarket(1, { predicate: { threshold: 1, comparison: "GreaterThan" } });
    const offer: OfferView = {
      address: "dddddddddddddddddddddddddddddddddd" as never,
      market: market.address,
      maker: MAKER_ADDR,
      makerSide: "Yes",
      priceYesBps: 9800,
      remainingPot: 2_000_000n,
    };
    const ctx = makeContext({
      state: makeState({ phase: "H1", minute: 0, p1Goals: 5 }),
      lines: [makeLine(1, 9900)],   // line also very high
      markets: [market],
      offers: [offer],
    });
    const intents = mm.onTick(ctx, BASE_CFG);
    const cancels = intents.filter((i) => i.kind === "cancelOffer");
    // Fair should be > 0.99 → pull
    expect(cancels).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Inventory skew
// ---------------------------------------------------------------------------

describe("makeMarketMaker — inventory skew", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  it("shifts quotes up when YES positions > NO positions (long YES bias)", () => {
    // 2 YES positions, 0 NO → imbalance = 2 → skewBps = 2 * floor(100/2) = 100
    const position: PositionView = {
      address: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as never,
      market: MARKET_ADDR,
      maker: MAKER_ADDR,
      taker: "ffffffffffffffffffffffffffffffff" as never,
      makerSide: "Yes",
      priceYesBps: 4900,
      pot: 2_000_000n,
      settled: false,
    };

    const ctxBase = makeContext({ positions: [] });
    const ctxSkewed = makeContext({ positions: [position, { ...position, address: "gg" as never }] });

    const baseIntents = mm.onTick(ctxBase, BASE_CFG);
    const skewedIntents = mm.onTick(ctxSkewed, BASE_CFG);

    const baseYes    = baseIntents.find((i) => i.kind === "postOffer" && i.side === "Yes");
    const skewedYes  = skewedIntents.find((i) => i.kind === "postOffer" && i.side === "Yes");
    const baseNo     = baseIntents.find((i) => i.kind === "postOffer" && i.side === "No");
    const skewedNo   = skewedIntents.find((i) => i.kind === "postOffer" && i.side === "No");

    if (
      baseYes?.kind !== "postOffer" || skewedYes?.kind !== "postOffer" ||
      baseNo?.kind  !== "postOffer" || skewedNo?.kind  !== "postOffer"
    ) throw new Error("type guard");

    // Skew shifts both quotes UP when long YES → skewedYes > baseYes
    expect(skewedYes.priceYesBps).toBeGreaterThan(baseYes.priceYesBps);
    expect(skewedNo.priceYesBps).toBeGreaterThan(baseNo.priceYesBps);
  });
});

// ---------------------------------------------------------------------------
// Budget capping
// ---------------------------------------------------------------------------

describe("makeMarketMaker — budget capping", () => {
  const mm = makeMarketMaker(BASE_PARAMS);

  it("reduces pot when remaining budget < defaultPotUsdc", () => {
    // maxOpenExposure = 200 USDC, openExposure = 199.5 USDC → remaining = 0.5 USDC
    const tightRisk: RiskBudget = {
      ...HEALTHY_RISK,
      openExposure: 199_500_000n, // 199.5 USDC
    };
    const ctx = makeContext({ risk: tightRisk });
    const intents = mm.onTick(ctx, BASE_CFG);

    for (const intent of intents) {
      if (intent.kind === "postOffer") {
        // Remaining = 500_000; potSize = 500_000 / 2 = 250_000
        expect(intent.pot).toBeLessThan(BASE_PARAMS.defaultPotUsdc);
      }
    }
  });

  it("emits nothing when budget is exhausted (remaining = 0)", () => {
    const exhaustedRisk: RiskBudget = {
      ...HEALTHY_RISK,
      openExposure: 200_000_000n, // exactly at limit
    };
    const ctx = makeContext({ risk: exhaustedRisk });
    const intents = mm.onTick(ctx, BASE_CFG);
    const posts = intents.filter((i) => i.kind === "postOffer");
    expect(posts).toHaveLength(0);
  });
});
