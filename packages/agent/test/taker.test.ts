import { describe, it, expect } from "vitest";
import { makeTaker } from "../src/strategy/taker.js";
import type { ArenaContext, MatchState, MarketLine, MarketView, OfferView } from "../src/types.js";
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
  halfSpreadBps: 100,
  defaultPotUsdc: 2_000_000n,
  minEdgeBps: 50,        // minimum 50 bps edge to fill
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
  risk: { ...DEFAULT_RISK_LIMITS, maxStakePerPosition: 10_000_000n },
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

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  return {
    address: MARKET_ADDR,
    fixtureId: 1,
    statKey: 1,
    predicate: { threshold: 1, comparison: "GreaterThan" },
    status: "Open",
    totalPot: 0n,
    oracleProgram: ORACLE_ADDR,
    ...overrides,
  };
}

function makeOffer(priceYesBps: number, makerSide: "Yes" | "No" = "Yes"): OfferView {
  return {
    address: "77777777777777777777777777777777" as never,
    market: MARKET_ADDR,
    maker: MAKER_ADDR,
    makerSide,
    priceYesBps,
    remainingPot: 4_000_000n, // 4 USDC pot
  };
}

function makeContext(overrides: Partial<ArenaContext> = {}): ArenaContext {
  return {
    state: makeState(),
    lines: [makeLine(1, 5000)],
    markets: [makeMarket()],
    offers: [],
    positions: [],
    risk: HEALTHY_RISK,
    nowMs: FIXED_NOW_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fair value at minute=45 with line=5000 and predicate GreaterThan 1
//
// lambda_remaining = 1.4 * (90-45)/90 = 0.7
// pModel = poissonSf(1, 0.7) = 1 - e^{-0.7}*(1+0.7) ~= 0.1558
// blend (w=0.5): fair = 0.5*0.1558 + 0.5*0.5 = 0.3279 -> fairBps ~= 3279
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge threshold: fill only when edge >= minEdgeBps
// ---------------------------------------------------------------------------

describe("makeTaker — edge threshold", () => {
  const taker = makeTaker(BASE_PARAMS);

  it("fills a YES-maker offer when offer overprices YES by >= minEdgeBps", () => {
    // fairBps ~= 3279; YES maker at 4000 -> edge as NO taker = 4000 - 3279 = 721 >> 50 -> fill
    const ctx = makeContext({ offers: [makeOffer(4000, "Yes")] });
    const intents = taker.onTick(ctx, BASE_CFG);

    const fills = intents.filter((i) => i.kind === "fillOffer");
    expect(fills).toHaveLength(1);
    if (fills[0]?.kind !== "fillOffer") throw new Error("type guard");
    expect(fills[0].offer.makerSide).toBe("Yes");
  });

  it("fills a NO-maker offer when YES is underpriced by >= minEdgeBps", () => {
    // fairBps ~= 3279; NO maker at 2000 -> taker fills YES, edge = 3279 - 2000 = 1279 >> 50 -> fill
    const ctx = makeContext({ offers: [makeOffer(2000, "No")] });
    const intents = taker.onTick(ctx, BASE_CFG);

    const fills = intents.filter((i) => i.kind === "fillOffer");
    expect(fills).toHaveLength(1);
    if (fills[0]?.kind !== "fillOffer") throw new Error("type guard");
    expect(fills[0].offer.makerSide).toBe("No");
  });

  it("skips a YES-maker offer that is fairly priced (edge < minEdgeBps)", () => {
    // fairBps ~= 3279; YES maker at 3279 -> edge = 0 < 50 bps -> skip
    const ctx = makeContext({ offers: [makeOffer(3279, "Yes")] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("skips a NO-maker offer that is fairly priced (edge < minEdgeBps)", () => {
    // fairBps ~= 3279; NO maker at 3279 -> taker fills YES, edge = 3279 - 3279 = 0 < 50 -> skip
    const ctx = makeContext({ offers: [makeOffer(3279, "No")] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("skips a YES-maker offer priced below fair (wrong direction for NO taker)", () => {
    // fairBps ~= 3279; YES maker at 2000 -> edge as NO = 2000 - 3279 = -1279 < 0 -> skip
    const ctx = makeContext({ offers: [makeOffer(2000, "Yes")] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("skips a NO-maker offer priced above fair (wrong direction for YES taker)", () => {
    // fairBps ~= 3279; NO maker at 6000 -> edge as YES = 3279 - 6000 = -2721 < 0 -> skip
    const ctx = makeContext({ offers: [makeOffer(6000, "No")] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("fills multiple mispriced offers in a single tick", () => {
    // offer1: YES maker at 6500 -> edge = 6500-3279 = 3221 >> 50 -> fill
    // offer2: NO maker at 2500 -> edge = 3279-2500 = 779 >> 50 -> fill
    const offer1 = makeOffer(6500, "Yes");
    const offer2: OfferView = { ...makeOffer(2500, "No"), address: "88888888888888888888888888888888" as never };
    const ctx = makeContext({ offers: [offer1, offer2] });
    const intents = taker.onTick(ctx, BASE_CFG);
    const fills = intents.filter((i) => i.kind === "fillOffer");
    expect(fills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fill size: capped by maxStakePerPosition
// ---------------------------------------------------------------------------

describe("makeTaker — fill-pot sizing", () => {
  const taker = makeTaker(BASE_PARAMS);

  it("fills the full remaining pot when it fits within maxStakePerPosition", () => {
    // remainingPot = 4 USDC; maker YES at 4000 bps -> edge = 4000-3279 >> 50 -> fill
    // taker NO stake = 4 * (10000-4000)/10000 = 4 * 0.6 = 2.4 USDC < 10 USDC -> full pot
    const ctx = makeContext({ offers: [makeOffer(4000, "Yes")] });
    const intents = taker.onTick(ctx, BASE_CFG);

    const fill = intents.find((i) => i.kind === "fillOffer");
    if (fill?.kind !== "fillOffer") throw new Error("type guard");
    expect(fill.fillPot).toBe(4_000_000n); // full pot fits in budget
  });

  it("caps fill pot when full pot would exceed maxStakePerPosition", () => {
    // Large pot: remainingPot = 100 USDC; maker YES at 7000 bps -> edge >> 50 -> fill
    // taker NO stake fraction = (10000-7000)/10000 = 30%
    // maxFillPot = 10_000_000 * 10000 / 3000 = 33_333_333 < 100_000_000 -> capped
    const bigOffer: OfferView = {
      ...makeOffer(7000, "Yes"),
      remainingPot: 100_000_000n, // 100 USDC
    };
    const ctx = makeContext({ offers: [bigOffer] });
    const intents = taker.onTick(ctx, BASE_CFG);

    const fill = intents.find((i) => i.kind === "fillOffer");
    if (fill?.kind !== "fillOffer") throw new Error("type guard");
    // maxFillPot = 10_000_000 * 10000 / (10000 - 7000) = 10_000_000 * 10000 / 3000
    const expectedMax = (10_000_000n * 10000n) / 3000n;
    expect(fill.fillPot).toBe(expectedMax);
    expect(fill.fillPot).toBeLessThan(bigOffer.remainingPot);
  });

  it("returns the offer reference for exec layer to use", () => {
    const offer = makeOffer(7000, "Yes");
    const ctx = makeContext({ offers: [offer] });
    const intents = taker.onTick(ctx, BASE_CFG);

    const fill = intents.find((i) => i.kind === "fillOffer");
    if (fill?.kind !== "fillOffer") throw new Error("type guard");
    expect(fill.offer).toBe(offer); // same object reference
  });
});

// ---------------------------------------------------------------------------
// Skips when market or line data is missing
// ---------------------------------------------------------------------------

describe("makeTaker — skips on missing data", () => {
  const taker = makeTaker(BASE_PARAMS);

  it("skips an offer whose market is not in ctx.markets", () => {
    const orphanOffer = makeOffer(8000, "Yes"); // no matching market
    const ctx = makeContext({ markets: [], offers: [orphanOffer] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("still fills when no line is available (falls back to model-only fair)", () => {
    // With no line, fairValue uses model-only (no blend).
    // minute=45, statKey=1, GreaterThan 1, rate=1.4, lambda=0.7
    // pModel = poissonSf(1, 0.7) ~= 0.1558 -> fairBps ~= 1558
    // YES maker at 4000 -> edge = 4000 - 1558 = 2442 >> 50 -> fill
    const ctx = makeContext({
      lines: [],                        // no market line
      offers: [makeOffer(4000, "Yes")],
    });
    const intents = taker.onTick(ctx, BASE_CFG);
    const fills = intents.filter((i) => i.kind === "fillOffer");
    expect(fills.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Real value assertions (not just directional)
// ---------------------------------------------------------------------------

describe("makeTaker — real value assertions", () => {
  const taker = makeTaker(BASE_PARAMS);

  it("does not fill when edge is zero (offer at fair price)", () => {
    // fairBps ~= 3279; YES maker at 3279 -> edge = 0 bps < 50 -> skip
    const offer = makeOffer(3279, "Yes");
    const ctx = makeContext({ offers: [offer] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("fills when a YES-maker offer is at least minEdgeBps above fair", () => {
    // fairBps ~= 3279; minEdge = 50 bps; fill iff offer >= 3329
    // offer at 3400 -> edge = 121 bps > 50 -> fill
    const offer = makeOffer(3400, "Yes");
    const ctx = makeContext({ offers: [offer] });
    const intents = taker.onTick(ctx, BASE_CFG);
    const fills = intents.filter((i) => i.kind === "fillOffer");
    expect(fills.length).toBeGreaterThan(0);
  });

  it("does not fill when NO-maker offer is at fair price", () => {
    // fairBps ~= 3279; NO maker at 3279 -> edge = 3279 - 3279 = 0 < 50 -> skip
    const offer = makeOffer(3279, "No");
    const ctx = makeContext({ offers: [offer] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });

  it("fills when a NO-maker offer is at least minEdgeBps below fair", () => {
    // fairBps ~= 3279; NO maker at 3200 -> edge = 3279 - 3200 = 79 bps > 50 -> fill
    const offer = makeOffer(3200, "No");
    const ctx = makeContext({ offers: [offer] });
    const intents = taker.onTick(ctx, BASE_CFG);
    const fills = intents.filter((i) => i.kind === "fillOffer");
    expect(fills.length).toBeGreaterThan(0);
  });

  it("emits no intents when the offer list is empty", () => {
    const ctx = makeContext({ offers: [] });
    const intents = taker.onTick(ctx, BASE_CFG);
    expect(intents).toHaveLength(0);
  });
});
