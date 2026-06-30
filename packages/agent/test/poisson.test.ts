import { describe, it, expect } from "vitest";
import { poissonSf, poissonPmf } from "../src/model/poisson.js";

// Helper: compare floats with a tolerance.
const tol = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

describe("poissonSf — edge cases", () => {
  it("k < 0 → 1 (always true since X ≥ 0)", () => {
    expect(poissonSf(-1, 1.0)).toBe(1);
    expect(poissonSf(-10, 0.5)).toBe(1);
  });

  it("lambda = 0 → 0 (X = 0 with certainty, never exceeds any k ≥ 0)", () => {
    expect(poissonSf(0, 0)).toBe(0);
    expect(poissonSf(5, 0)).toBe(0);
  });

  it("lambda ≤ 0 → 0", () => {
    expect(poissonSf(0, -1)).toBe(0);
  });

  it("returns a value in [0, 1]", () => {
    for (const lambda of [0.1, 1, 2, 5, 10]) {
      for (const k of [0, 1, 2, 5, 10]) {
        const sf = poissonSf(k, lambda);
        expect(sf).toBeGreaterThanOrEqual(0);
        expect(sf).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("poissonSf — known analytical values (λ = 1)", () => {
  // For Poisson(1): P(X = k) = e^-1 / k!
  // P(X = 0) = e^-1 ≈ 0.3679
  // CDF(0) = e^-1 ≈ 0.3679    → SF(0) = 1 - e^-1 ≈ 0.6321
  // CDF(1) = e^-1(1 + 1) ≈ 0.7358 → SF(1) ≈ 0.2642
  // CDF(2) = e^-1(1+1+0.5) ≈ 0.9197 → SF(2) ≈ 0.0803

  it("sf(0, 1) ≈ 1 - e^-1 ≈ 0.6321", () => {
    expect(tol(poissonSf(0, 1), 0.6321)).toBe(true);
  });

  it("sf(1, 1) ≈ 0.2642", () => {
    expect(tol(poissonSf(1, 1), 0.2642)).toBe(true);
  });

  it("sf(2, 1) ≈ 0.0803", () => {
    expect(tol(poissonSf(2, 1), 0.0803)).toBe(true);
  });
});

describe("poissonSf — known analytical values (λ = 2)", () => {
  // SF(0, 2) = 1 - e^-2 ≈ 0.8647
  // SF(1, 2) = 1 - e^-2(1+2) ≈ 1 - 0.4060 = 0.5940
  // SF(2, 2) = 1 - e^-2(1+2+2) ≈ 1 - 0.6767 = 0.3233

  it("sf(0, 2) ≈ 0.8647", () => {
    expect(tol(poissonSf(0, 2), 0.8647)).toBe(true);
  });

  it("sf(1, 2) ≈ 0.5940", () => {
    expect(tol(poissonSf(1, 2), 0.5940)).toBe(true);
  });

  it("sf(2, 2) ≈ 0.3233", () => {
    expect(tol(poissonSf(2, 2), 0.3233)).toBe(true);
  });
});

describe("poissonSf — monotonicity", () => {
  it("is non-increasing in k for fixed lambda", () => {
    for (const lambda of [0.5, 1.4, 3]) {
      let prev = poissonSf(-1, lambda); // should be 1
      for (let k = 0; k <= 10; k++) {
        const sf = poissonSf(k, lambda);
        expect(sf).toBeLessThanOrEqual(prev + 1e-12);
        prev = sf;
      }
    }
  });

  it("is non-decreasing in lambda for fixed k", () => {
    // Larger lambda → more likely to exceed k
    for (const k of [0, 1, 3]) {
      let prev = poissonSf(k, 0.01);
      for (const lambda of [0.1, 0.5, 1, 2, 5]) {
        const sf = poissonSf(k, lambda);
        expect(sf).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = sf;
      }
    }
  });
});

describe("poissonSf — fractional k is floored", () => {
  it("sf(1.9, λ) equals sf(1, λ)", () => {
    const lambda = 2;
    expect(poissonSf(1.9, lambda)).toBeCloseTo(poissonSf(1, lambda), 10);
  });
});

// ---------------------------------------------------------------------------
// poissonPmf
// ---------------------------------------------------------------------------

describe("poissonPmf", () => {
  it("k < 0 → 0", () => {
    expect(poissonPmf(-1, 1)).toBe(0);
  });

  it("lambda = 0, k = 0 → 1", () => {
    expect(poissonPmf(0, 0)).toBe(1);
  });

  it("lambda = 0, k > 0 → 0", () => {
    expect(poissonPmf(1, 0)).toBe(0);
  });

  it("pmf(0, 1) ≈ e^-1 ≈ 0.3679", () => {
    expect(tol(poissonPmf(0, 1), 0.3679)).toBe(true);
  });

  it("pmf(1, 1) ≈ e^-1 ≈ 0.3679", () => {
    expect(tol(poissonPmf(1, 1), 0.3679)).toBe(true);
  });

  it("pmf(2, 2) ≈ e^-2 * 4/2 ≈ 0.2707", () => {
    // P(X=2 | λ=2) = e^-2 * 4/2 = e^-2 * 2 ≈ 0.2707
    expect(tol(poissonPmf(2, 2), 0.2707)).toBe(true);
  });

  it("PMF sums to approximately 1 across k = 0..20 for λ = 3", () => {
    let total = 0;
    for (let k = 0; k <= 20; k++) total += poissonPmf(k, 3);
    expect(tol(total, 1, 1e-6)).toBe(true);
  });

  it("PMF is consistent with SF: sf(k) = sum pmf(i) for i > k", () => {
    const lambda = 1.5;
    const sf1 = poissonSf(1, lambda);
    let tail = 0;
    for (let i = 2; i <= 30; i++) tail += poissonPmf(i, lambda);
    expect(tol(sf1, tail, 1e-6)).toBe(true);
  });
});
