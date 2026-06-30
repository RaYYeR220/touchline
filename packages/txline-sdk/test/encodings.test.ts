import { describe, it, expect } from "vitest";
import {
  epochDayFromTs,
  soccerStatKey,
  SoccerStat,
  SoccerStatPeriod,
  footballStatKey,
  FootballStat,
} from "../src/onchain/encodings.js";

describe("epochDayFromTs", () => {
  it("floors ms to whole days", () => {
    expect(epochDayFromTs(0)).toBe(0);
    expect(epochDayFromTs(86_400_000 - 1)).toBe(0);
    expect(epochDayFromTs(86_400_000)).toBe(1);
    // 2026-06-29 ~ epoch day 20633
    expect(epochDayFromTs(Date.UTC(2026, 5, 29))).toBe(20633);
  });
});

describe("soccerStatKey", () => {
  it("encodes full-game keys as the base", () => {
    expect(soccerStatKey(SoccerStat.P1Goals)).toBe(1);
    expect(soccerStatKey(SoccerStat.P2Corners)).toBe(8);
  });

  it("adds the period multiplier (period * 1000)", () => {
    expect(soccerStatKey(SoccerStat.P1Goals, SoccerStatPeriod.FirstHalf)).toBe(1001);
    expect(soccerStatKey(SoccerStat.P2Goals, SoccerStatPeriod.SecondHalf)).toBe(2002);
    expect(soccerStatKey(SoccerStat.P1Goals, SoccerStatPeriod.PenaltyShootout)).toBe(5001);
  });
});

describe("footballStatKey", () => {
  it("uses 1000 for halves and 10000 for quarters", () => {
    expect(footballStatKey(FootballStat.P1TotalScore, "FirstHalf")).toBe(1001);
    expect(footballStatKey(FootballStat.P1Touchdowns, "Quarter2")).toBe(20003);
    expect(footballStatKey(FootballStat.P2TotalScore)).toBe(2);
  });
});
