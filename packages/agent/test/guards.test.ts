import { describe, it, expect } from "vitest";
import { checkIntent } from "../src/risk/guards.js";
import type { RiskLimits, RiskBudget } from "../src/risk/guards.js";
import type { Intent, OfferView } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LIMITS: RiskLimits = {
  maxStakePerPosition: 10_000_000n, // 10 USDC
  maxOpenExposure: 50_000_000n,     // 50 USDC
  maxDailyLossBps: 2000,            // 20% of maxOpenExposure = 10 USDC
  minEdgeBps: 50,
  noTradePhases: ["NS", "F", "FET", "FPE", "I", "A", "C"],
  maxFeedStalenessMs: 10_000,       // 10 seconds
};

const HEALTHY_BUDGET: RiskBudget = {
  openExposure: 0n,
  realizedPnl: 0n,
  feedStaleMs: 0,
  phase: "H1",
};

const MARKET_ADDR = "11111111111111111111111111111111" as const;
const MAKER_ADDR  = "22222222222222222222222222222222" as const;

function makeOffer(priceYesBps: number, makerSide: "Yes" | "No" = "Yes"): OfferView {
  return {
    address: "33333333333333333333333333333333" as never,
    market: MARKET_ADDR as never,
    maker: MAKER_ADDR as never,
    makerSide,
    priceYesBps,
    remainingPot: 20_000_000n, // 20 USDC
  };
}

const CREATE_INTENT: Intent = {
  kind: "createMarket",
  fixtureId: 1,
  statKey: 1,
  predicate: { threshold: 2, comparison: "GreaterThan" },
};

const CANCEL_INTENT: Intent = {
  kind: "cancelOffer",
  offer: makeOffer(5000),
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("checkIntent — happy path", () => {
  it("allows a small postOffer (YES side, 2 USDC pot)", () => {
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 2_000_000n, // stake = 1 USDC
    };
    expect(checkIntent(intent, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });

  it("allows a small fillOffer (maker YES, taker NO)", () => {
    const intent: Intent = {
      kind: "fillOffer",
      offer: makeOffer(5000, "Yes"),
      fillPot: 2_000_000n, // taker stake = 1 USDC
    };
    expect(checkIntent(intent, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });

  it("always allows createMarket in any healthy budget", () => {
    expect(checkIntent(CREATE_INTENT, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });

  it("always allows cancelOffer in any healthy budget", () => {
    expect(checkIntent(CANCEL_INTENT, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 1: stale feed
// ---------------------------------------------------------------------------

describe("checkIntent — Rule 1: stale feed", () => {
  it("rejects any intent when feedStaleMs exceeds limit", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, feedStaleMs: 15_000 };
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 1_000_000n,
    };
    const result = checkIntent(intent, budget, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/stale/i);
  });

  it("also rejects createMarket when feed is stale", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, feedStaleMs: 10_001 };
    const result = checkIntent(CREATE_INTENT, budget, LIMITS);
    expect(result.ok).toBe(false);
  });

  it("allows when feedStaleMs equals the limit exactly", () => {
    // strictly greater than triggers the guard
    const budget: RiskBudget = { ...HEALTHY_BUDGET, feedStaleMs: 10_000 };
    expect(checkIntent(CREATE_INTENT, budget, LIMITS)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 2: no-trade phase
// ---------------------------------------------------------------------------

describe("checkIntent — Rule 2: no-trade phase", () => {
  const NO_TRADE_PHASES: RiskBudget["phase"][] = ["NS", "F", "FET", "FPE", "I", "A", "C"];

  for (const phase of NO_TRADE_PHASES) {
    it(`rejects postOffer in phase ${phase}`, () => {
      const budget: RiskBudget = { ...HEALTHY_BUDGET, phase };
      const intent: Intent = {
        kind: "postOffer",
        market: MARKET_ADDR as never,
        side: "Yes",
        priceYesBps: 5000,
        pot: 1_000_000n,
      };
      const result = checkIntent(intent, budget, LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/phase/i);
    });
  }

  it("also rejects createMarket in no-trade phase", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, phase: "NS" };
    expect(checkIntent(CREATE_INTENT, budget, LIMITS).ok).toBe(false);
  });

  it("allows postOffer in a live phase (H2)", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, phase: "H2" };
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 1_000_000n,
    };
    expect(checkIntent(intent, budget, LIMITS)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 3: daily loss halt (cancel-only)
// ---------------------------------------------------------------------------

describe("checkIntent — Rule 3: daily loss halt", () => {
  // maxLoss = 50_000_000 * 2000 / 10000 = 10_000_000 (10 USDC)
  it("rejects postOffer when realized loss exceeds limit", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, realizedPnl: -11_000_000n };
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 1_000_000n,
    };
    const result = checkIntent(intent, budget, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/daily loss/i);
  });

  it("still allows cancelOffer when loss limit is hit (cancel reduces risk)", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, realizedPnl: -20_000_000n };
    expect(checkIntent(CANCEL_INTENT, budget, LIMITS)).toEqual({ ok: true });
  });

  it("still allows createMarket when loss limit is hit", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, realizedPnl: -20_000_000n };
    expect(checkIntent(CREATE_INTENT, budget, LIMITS)).toEqual({ ok: true });
  });

  it("allows postOffer when loss is exactly at the limit (not exceeded)", () => {
    // realizedPnl = -10_000_000 → loss = 10_000_000 = maxLoss, not strictly greater
    const budget: RiskBudget = { ...HEALTHY_BUDGET, realizedPnl: -10_000_000n };
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 2_000_000n, // stake = 1 USDC < maxStakePerPosition
    };
    expect(checkIntent(intent, budget, LIMITS)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 4: per-position stake limit
// ---------------------------------------------------------------------------

describe("checkIntent — Rule 4: per-position stake limit", () => {
  it("rejects a postOffer whose maker YES stake exceeds the limit", () => {
    // pot = 30 USDC, price = 50% → stake = 15 USDC > 10 USDC limit
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 30_000_000n,
    };
    const result = checkIntent(intent, HEALTHY_BUDGET, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/stake/i);
  });

  it("rejects a postOffer whose maker NO stake exceeds the limit", () => {
    // pot = 25 USDC, price = 20% → NO stake = 25 * 80% = 20 USDC > 10 USDC
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "No",
      priceYesBps: 2000,
      pot: 25_000_000n,
    };
    const result = checkIntent(intent, HEALTHY_BUDGET, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/stake/i);
  });

  it("rejects a fillOffer whose taker stake exceeds the limit", () => {
    // offer: maker YES, price=5000; fillPot=25 USDC → taker NO stake = 12.5 USDC
    const intent: Intent = {
      kind: "fillOffer",
      offer: makeOffer(5000, "Yes"),
      fillPot: 25_000_000n,
    };
    const result = checkIntent(intent, HEALTHY_BUDGET, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/stake/i);
  });

  it("allows when stake is exactly at the limit", () => {
    // pot = 20 USDC, price = 50% → stake = 10 USDC = limit
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 20_000_000n,
    };
    expect(checkIntent(intent, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 5: total open exposure limit
// ---------------------------------------------------------------------------

describe("checkIntent — Rule 5: total open exposure limit", () => {
  it("rejects when projected exposure exceeds maxOpenExposure", () => {
    // existing exposure = 45 USDC; new stake = 6 USDC → total = 51 USDC > 50 USDC
    const budget: RiskBudget = { ...HEALTHY_BUDGET, openExposure: 45_000_000n };
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 12_000_000n, // stake = 6 USDC
    };
    const result = checkIntent(intent, budget, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exposure/i);
  });

  it("allows when projected exposure is exactly at the limit", () => {
    // existing = 40 USDC; new stake = 10 USDC → total = 50 USDC = limit
    const budget: RiskBudget = { ...HEALTHY_BUDGET, openExposure: 40_000_000n };
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 5000,
      pot: 20_000_000n, // stake = 10 USDC
    };
    expect(checkIntent(intent, budget, LIMITS)).toEqual({ ok: true });
  });

  it("rejects fillOffer when combined exposure would breach limit", () => {
    const budget: RiskBudget = { ...HEALTHY_BUDGET, openExposure: 48_000_000n };
    const intent: Intent = {
      kind: "fillOffer",
      offer: makeOffer(5000, "Yes"),
      fillPot: 8_000_000n, // taker NO stake = 4 USDC → total = 52 USDC
    };
    const result = checkIntent(intent, budget, LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exposure/i);
  });
});

// ---------------------------------------------------------------------------
// Stake computation: YES vs NO maker side verification
// ---------------------------------------------------------------------------

describe("checkIntent — stake computation correctness", () => {
  it("YES maker at 80% price: stake = pot * 0.8", () => {
    // pot = 10 USDC, price = 8000 bps → stake = 8 USDC < 10 USDC limit ✓
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "Yes",
      priceYesBps: 8000,
      pot: 10_000_000n,
    };
    expect(checkIntent(intent, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });

  it("NO maker at 20% YES price: NO stake = pot * 0.8 = 8 USDC < 10 USDC limit ✓", () => {
    const intent: Intent = {
      kind: "postOffer",
      market: MARKET_ADDR as never,
      side: "No",
      priceYesBps: 2000, // NO stake = 80% of pot
      pot: 10_000_000n,  // stake = 8 USDC < limit
    };
    expect(checkIntent(intent, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });

  it("fillOffer taker YES (maker was NO): taker stake = fillPot * priceYesBps / 10000", () => {
    // Maker is NO at price 3000 (30% YES). Taker is YES.
    // fillPot = 20 USDC, taker YES stake = 20 * 30% = 6 USDC < 10 USDC limit ✓
    const intent: Intent = {
      kind: "fillOffer",
      offer: makeOffer(3000, "No"),
      fillPot: 20_000_000n,
    };
    expect(checkIntent(intent, HEALTHY_BUDGET, LIMITS)).toEqual({ ok: true });
  });
});
