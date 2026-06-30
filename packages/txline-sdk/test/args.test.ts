import { describe, it, expect } from "vitest";
import { buildValidateStatInputs } from "../src/verify/args.js";
import type { StatValidationResponse } from "../src/types/api.js";

const root = (fill: number): number[] => new Array(32).fill(fill);

function baseResponse(): StatValidationResponse {
  return {
    ts: 1_785_000_000_000,
    summary: {
      fixtureId: 17271370,
      updateStats: { updateCount: 4, minTimestamp: 1_784_999_000_000, maxTimestamp: 1_785_000_000_000 },
      eventStatsSubTreeRoot: root(1),
    },
    subTreeProof: [{ hash: root(2), isRightSibling: true }],
    mainTreeProof: [{ hash: root(3), isRightSibling: false }],
    statToProve: { key: 1, value: 2, period: 5 },
    eventStatRoot: root(4),
    statProof: [{ hash: root(5), isRightSibling: true }],
  };
}

describe("buildValidateStatInputs", () => {
  it("maps the single-stat response into instruction args", () => {
    const v = baseResponse();
    const out = buildValidateStatInputs(v);

    expect(out.ts.toString()).toBe(String(v.ts));
    expect(out.fixtureSummary.fixtureId.toString()).toBe("17271370");
    expect(out.fixtureSummary.updateStats.updateCount).toBe(4);
    expect(out.fixtureSummary.updateStats.minTimestamp.toString()).toBe("1784999000000");
    expect(out.fixtureSummary.eventsSubTreeRoot).toEqual(root(1));

    expect(out.fixtureProof).toEqual([{ hash: root(2), isRightSibling: true }]);
    expect(out.mainTreeProof).toEqual([{ hash: root(3), isRightSibling: false }]);

    expect(out.stat1.statToProve).toEqual({ key: 1, value: 2, period: 5 });
    expect(out.stat1.eventStatRoot).toEqual(root(4));
    expect(out.stat1.statProof).toEqual([{ hash: root(5), isRightSibling: true }]);

    expect(out.stat2).toBeNull();
  });

  it("populates stat2 when a second stat is present", () => {
    const v = baseResponse();
    v.statToProve2 = { key: 2, value: 1, period: 5 };
    v.statProof2 = [{ hash: root(6), isRightSibling: false }];

    const out = buildValidateStatInputs(v);
    expect(out.stat2).not.toBeNull();
    expect(out.stat2?.statToProve).toEqual({ key: 2, value: 1, period: 5 });
    expect(out.stat2?.eventStatRoot).toEqual(root(4));
    expect(out.stat2?.statProof).toEqual([{ hash: root(6), isRightSibling: false }]);
  });
});
