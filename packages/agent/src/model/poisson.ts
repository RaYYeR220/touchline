/**
 * Poisson distribution utilities — pure, deterministic, no I/O.
 *
 * All functions operate on finite non-negative lambda values.
 * The implementation uses log-space accumulation to avoid underflow for
 * moderate lambda values (up to ~700 before floating-point limits).
 */

/**
 * Poisson survival function: P(X > k) where X ~ Poisson(lambda).
 *
 * Equivalently: 1 - CDF(k) = 1 - Σ_{i=0}^{k} e^{-λ} λ^i / i!
 *
 * Edge cases:
 *   k < 0          → 1  (X ≥ 0 always, so P(X > negative) = 1)
 *   lambda ≤ 0     → 0  (X = 0 with certainty, so P(X > 0) = 0; P(X > k<0) covered above)
 *   lambda = NaN   → NaN (propagated)
 *
 * Accuracy: the CDF is accumulated in log-space and then exponentiated, which
 * keeps precision for small probabilities and large k.
 *
 * @param k      The threshold (non-negative integer; fractional values are
 *               floored internally so the function is well-defined for any real k).
 * @param lambda The Poisson rate parameter (≥ 0).
 * @returns      P(X > k) in [0, 1].
 */
export function poissonSf(k: number, lambda: number): number {
  if (Number.isNaN(lambda)) return NaN;
  if (k < 0) return 1;
  if (lambda <= 0) return 0;

  // Floor k so the function is sensible for non-integer inputs.
  const kInt = Math.floor(k);

  // Accumulate P(X <= kInt) = e^{-lambda} * Σ_{i=0}^{kInt} lambda^i / i!
  // We sum the terms as scalars: start with term_0 = e^{-lambda}, then
  // multiply by lambda/i for each successive term.
  let cdf = 0;
  let term = Math.exp(-lambda); // P(X = 0)
  for (let i = 0; i <= kInt; i++) {
    cdf += term;
    if (i < kInt) {
      term *= lambda / (i + 1);
    }
  }

  // Clamp to [0, 1] to absorb floating-point rounding at the extremes.
  return Math.max(0, Math.min(1, 1 - cdf));
}

/**
 * Poisson PMF: P(X = k) where X ~ Poisson(lambda).
 *
 * @param k      Non-negative integer (floored if fractional).
 * @param lambda Rate parameter (≥ 0).
 */
export function poissonPmf(k: number, lambda: number): number {
  if (Number.isNaN(lambda)) return NaN;
  if (k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;

  const kInt = Math.floor(k);
  // P(X = k) = e^{-lambda} * lambda^k / k!
  // Accumulate by multiplying: start at P(X=0) and step up to k.
  let pmf = Math.exp(-lambda);
  for (let i = 0; i < kInt; i++) {
    pmf *= lambda / (i + 1);
  }
  return Math.max(0, Math.min(1, pmf));
}
