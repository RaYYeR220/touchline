import { describe, it, expect } from "vitest";
import {
  gt,
  lt,
  eq,
  Comparisons,
  BinaryExpressions,
  predicate,
} from "../src/verify/predicate.js";

describe("predicate builders", () => {
  it("produce Anchor enum-shaped comparisons", () => {
    expect(gt(11)).toEqual({ threshold: 11, comparison: { greaterThan: {} } });
    expect(lt(5)).toEqual({ threshold: 5, comparison: { lessThan: {} } });
    expect(eq(0)).toEqual({ threshold: 0, comparison: { equalTo: {} } });
  });

  it("rejects non-integer thresholds", () => {
    expect(() => predicate(1.5, Comparisons.greaterThan())).toThrow();
  });

  it("builds binary expression enums", () => {
    expect(BinaryExpressions.add()).toEqual({ add: {} });
    expect(BinaryExpressions.subtract()).toEqual({ subtract: {} });
  });
});
