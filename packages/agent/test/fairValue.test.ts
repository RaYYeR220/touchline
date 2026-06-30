import { describe, it, expect } from "vitest";
import { fairValue } from "../src/model/fairValue.js";
import type { MatchState, MarketLine } from "../src/types.js";
import type { ModelParams } from "../src/model/fairValue.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_PARAMS: ModelParams = {
  baseRate: { 1: 1.4, 2: 1.4 },
  modelWeight: 0.5,
};

const FIXED_NOW_MS = 1_700_000_000_000; // constant — keeps helpers deterministic

function makeState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    fixtureId: 1,
    phase: "H1",
    minute: 0,
    p1Goals: 0,
    p2Goals: 0,
    updatedMs: FIXED_NOW_MS,
    ...overrides,
  };
}

function makeLine(impliedYesBps: number): MarketLine {
  return { fixtureId: 1, statKey: 1, impliedYesBps, updatedMs: FIXED_NOW_MS };
}

// ---------------------------------------------------------------------------
// Terminal phases → remainingFraction = 0
// ---------------------------------------------------------------------------

describe("fairValue — terminal phases (no more goals possible)", () => {
  it("phase F + c > threshold → 1.0 (already YES, no blend with 0-rate model)", () => {
    const state = makeState({ phase: "F", minute: 90, p1Goals: 3 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(1, 5);
  });

  it("phase FET + c < threshold → 0.0 (cannot score more in ET, lambda=0)", () => {
    const state = makeState({ phase: "FET", minute: 120, p1Goals: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 1, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0, 5);
  });

  it("phase FPE terminates correctly", () => {
    const state = makeState({ phase: "FPE", minute: 130, p1Goals: 1 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(1, 5); // c=1 > threshold=0
  });
});

// ---------------------------------------------------------------------------
// GreaterThan predicate
// ---------------------------------------------------------------------------

describe("fairValue — GreaterThan predicate", () => {
  it("c already > threshold → 1 regardless of time left", () => {
    const state = makeState({ phase: "H1", minute: 20, p1Goals: 3 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(1, 5);
  });

  it("minute 0, threshold 0 → very high probability (just need ≥1 goal)", () => {
    // P(X > 0) = 1 - e^{-1.4} ≈ 0.7534 for full game
    const state = makeState({ phase: "H1", minute: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeGreaterThan(0.7);
  });

  it("minute 90 (but non-terminal phase), threshold 0, c=0 → near 0 (lambda ≈ 0)", () => {
    // remainingFraction = (90-90)/90 = 0 → lambda = 0 → sf(0, 0) = 0
    const state = makeState({ phase: "H2", minute: 90 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0, 4);
  });

  it("high threshold with full game remaining → low probability", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 9, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeLessThan(0.01);
  });

  it("probability decreases as threshold increases", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const probs = [0, 1, 2, 3].map(
      (t) => fairValue({ statKey: 1, predicate: { threshold: t, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS),
    );
    for (let i = 0; i < probs.length - 1; i++) {
      expect(probs[i]).toBeGreaterThan(probs[i + 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// LessThan predicate
// ---------------------------------------------------------------------------

describe("fairValue — LessThan predicate", () => {
  it("c already >= threshold → 0 (impossible to be less)", () => {
    const state = makeState({ phase: "H1", minute: 20, p1Goals: 2 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "LessThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0, 5);
  });

  it("c = 0, threshold = 1, minute = 0 → probability of 0 goals in full game (small)", () => {
    // P(final < 1) = P(X = 0 | λ=1.4) = e^{-1.4} ≈ 0.2466
    const state = makeState({ phase: "H1", minute: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 1, comparison: "LessThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0.2466, 3);
  });

  it("c=0, threshold high → near 1 (very unlikely to reach the threshold)", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 20, comparison: "LessThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeGreaterThan(0.99);
  });

  it("GreaterThan and LessThan with same threshold sum to < 1 (EqualTo occupies some probability)", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const gt = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    const lt = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "LessThan" } }, state, undefined, BASE_PARAMS);
    expect(gt + lt).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// EqualTo predicate
// ---------------------------------------------------------------------------

describe("fairValue — EqualTo predicate", () => {
  it("c > threshold → 0 (already past target)", () => {
    const state = makeState({ phase: "H1", minute: 20, p1Goals: 3 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "EqualTo" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0, 5);
  });

  it("c = 0, threshold = 0, minute = 0 → e^{-1.4} ≈ 0.2466 (exact score of 0)", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "EqualTo" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0.2466, 3);
  });

  it("terminal phase, c === threshold → 1", () => {
    // Game finished, c already equals threshold → exactly YES
    const state = makeState({ phase: "F", minute: 90, p1Goals: 2 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "EqualTo" } }, state, undefined, BASE_PARAMS);
    // lambda=0, need=0 → pmf(0,0) = 1 → fv = 1
    expect(fv).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// Market-line blending
// ---------------------------------------------------------------------------

describe("fairValue — line blending", () => {
  it("blends 50/50 with the market line by default (modelWeight = 0.5)", () => {
    // pModel = poissonSf(0, 0) = 0 (terminal phase, can't score)
    const state = makeState({ phase: "F", minute: 90, p1Goals: 0 });
    const line = makeLine(8000); // market line says 80%
    const fv = fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "GreaterThan" } }, state, line, BASE_PARAMS);
    // pModel = 0 (c=0, not > 0), lambda = 0 → sf = 0
    // fv = 0.5 * 0 + 0.5 * 0.8 = 0.4
    expect(fv).toBeCloseTo(0.4, 4);
  });

  it("no line → returns pModel directly", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const fvWithLine = fairValue(
      { statKey: 1, predicate: { threshold: 1, comparison: "GreaterThan" } },
      state,
      makeLine(5000),
      { ...BASE_PARAMS, modelWeight: 1.0 }, // full model weight → no blending
    );
    const fvNoLine = fairValue(
      { statKey: 1, predicate: { threshold: 1, comparison: "GreaterThan" } },
      state,
      undefined,
      { ...BASE_PARAMS, modelWeight: 1.0 },
    );
    expect(fvWithLine).toBeCloseTo(fvNoLine, 6);
  });

  it("modelWeight = 0 → returns line probability exactly", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    const line = makeLine(3000); // 30%
    const fv = fairValue(
      { statKey: 1, predicate: { threshold: 2, comparison: "GreaterThan" } },
      state,
      line,
      { ...BASE_PARAMS, modelWeight: 0 },
    );
    expect(fv).toBeCloseTo(0.3, 5);
  });

  it("result is always in [0, 1]", () => {
    for (const modelWeight of [0, 0.3, 0.5, 1]) {
      for (const bps of [1, 5000, 9999]) {
        const fv = fairValue(
          { statKey: 1, predicate: { threshold: 1, comparison: "GreaterThan" } },
          makeState({ phase: "H1", minute: 45 }),
          makeLine(bps),
          { ...BASE_PARAMS, modelWeight },
        );
        expect(fv).toBeGreaterThanOrEqual(0);
        expect(fv).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Stat key mapping
// ---------------------------------------------------------------------------

describe("fairValue — stat key mapping", () => {
  it("statKey 1 reads p1Goals", () => {
    const state = makeState({ phase: "F", minute: 90, p1Goals: 3, p2Goals: 1 });
    // p1Goals=3 > threshold=2 → fv should be 1
    const fv = fairValue({ statKey: 1, predicate: { threshold: 2, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(1, 5);
  });

  it("statKey 2 reads p2Goals", () => {
    const state = makeState({ phase: "F", minute: 90, p1Goals: 3, p2Goals: 1 });
    // p2Goals=1 < threshold=2 → LessThan is satisfied at full time → fv = 1
    const fv = fairValue({ statKey: 2, predicate: { threshold: 2, comparison: "LessThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(1, 5);
  });

  it("unknown statKey → treated as c=0, uses baseRate 0 (no occurrence expected)", () => {
    const state = makeState({ phase: "H1", minute: 0 });
    // statKey 99 not in baseRate → lambda = 0 → sf(0,0) = 0
    const fv = fairValue(
      { statKey: 99, predicate: { threshold: 0, comparison: "GreaterThan" } },
      state,
      undefined,
      BASE_PARAMS,
    );
    expect(fv).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Time-decay
// ---------------------------------------------------------------------------

describe("fairValue — time-decay of lambda", () => {
  it("probability decreases for GreaterThan as minute increases (less time left)", () => {
    const probs = [0, 30, 60, 85].map((minute) => {
      const state = makeState({ phase: "H1", minute });
      return fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    });
    for (let i = 0; i < probs.length - 1; i++) {
      expect(probs[i]).toBeGreaterThan(probs[i + 1]!);
    }
  });

  it("minute > 90 clamps remainingFraction to 0 (lambda = 0)", () => {
    const state = makeState({ phase: "H2", minute: 95, p1Goals: 0 });
    const fv = fairValue({ statKey: 1, predicate: { threshold: 0, comparison: "GreaterThan" } }, state, undefined, BASE_PARAMS);
    expect(fv).toBeCloseTo(0, 5);
  });
});
