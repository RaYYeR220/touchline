/**
 * Builders for the `txoracle` predicate/operator enums. Anchor encodes Rust
 * enum variants as single-key objects in lower camelCase, e.g. `GreaterThan`
 * -> `{ greaterThan: {} }`.
 */

export type Comparison =
  | { greaterThan: Record<string, never> }
  | { lessThan: Record<string, never> }
  | { equalTo: Record<string, never> };

export type BinaryExpression =
  | { add: Record<string, never> }
  | { subtract: Record<string, never> };

/** Mirrors on-chain `TraderPredicate { threshold: i32, comparison }`. */
export interface TraderPredicate {
  threshold: number;
  comparison: Comparison;
}

export const Comparisons = {
  greaterThan: (): Comparison => ({ greaterThan: {} }),
  lessThan: (): Comparison => ({ lessThan: {} }),
  equalTo: (): Comparison => ({ equalTo: {} }),
} as const;

export const BinaryExpressions = {
  add: (): BinaryExpression => ({ add: {} }),
  subtract: (): BinaryExpression => ({ subtract: {} }),
} as const;

export function predicate(
  threshold: number,
  comparison: Comparison,
): TraderPredicate {
  if (!Number.isInteger(threshold)) {
    throw new TypeError(`predicate threshold must be an integer: ${threshold}`);
  }
  return { threshold, comparison };
}

/** `stat > threshold` */
export const gt = (threshold: number): TraderPredicate =>
  predicate(threshold, Comparisons.greaterThan());
/** `stat < threshold` */
export const lt = (threshold: number): TraderPredicate =>
  predicate(threshold, Comparisons.lessThan());
/** `stat == threshold` */
export const eq = (threshold: number): TraderPredicate =>
  predicate(threshold, Comparisons.equalTo());
