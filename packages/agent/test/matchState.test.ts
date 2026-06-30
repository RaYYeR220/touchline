import { describe, it, expect } from "vitest";
import {
  phaseFromGameState,
  reduceScore,
  lineFromOdds,
} from "../src/perception/matchState.js";
import type { MatchState } from "../src/types.js";
import type { ScoresMessage, OddsMessage } from "@touchline/txline-sdk";

// ---------------------------------------------------------------------------
// phaseFromGameState
// ---------------------------------------------------------------------------

describe("phaseFromGameState — string inputs", () => {
  it("maps 'scheduled' to NS (real captured sample value)", () => {
    expect(phaseFromGameState("scheduled")).toBe("NS");
  });

  it("is case-insensitive", () => {
    expect(phaseFromGameState("SCHEDULED")).toBe("NS");
    expect(phaseFromGameState("Scheduled")).toBe("NS");
  });

  it("maps common live-phase strings", () => {
    expect(phaseFromGameState("first_half")).toBe("H1");
    expect(phaseFromGameState("halftime")).toBe("HT");
    expect(phaseFromGameState("half_time")).toBe("HT");
    expect(phaseFromGameState("second_half")).toBe("H2");
    expect(phaseFromGameState("finished")).toBe("F");
    expect(phaseFromGameState("ended")).toBe("F");
  });

  it("maps extra-time phases", () => {
    expect(phaseFromGameState("extra_time_first_half")).toBe("ET1");
    expect(phaseFromGameState("extra_time_second_half")).toBe("ET2");
    expect(phaseFromGameState("finished_after_extra_time")).toBe("FET");
  });

  it("maps penalty phases", () => {
    expect(phaseFromGameState("penalty_shootout")).toBe("PE");
    expect(phaseFromGameState("finished_after_penalties")).toBe("FPE");
    expect(phaseFromGameState("waiting_for_penalties")).toBe("WPE");
  });

  it("maps cancellation/interruption phases", () => {
    expect(phaseFromGameState("interrupted")).toBe("I");
    expect(phaseFromGameState("abandoned")).toBe("A");
    expect(phaseFromGameState("cancelled")).toBe("C");
    expect(phaseFromGameState("postponed")).toBe("P");
    expect(phaseFromGameState("txcc")).toBe("TXCC");
    expect(phaseFromGameState("txcs")).toBe("TXCS");
  });

  it("falls back to NS for unknown strings", () => {
    expect(phaseFromGameState("unknown_state")).toBe("NS");
    expect(phaseFromGameState("")).toBe("NS");
  });
});

describe("phaseFromGameState — numeric inputs (SoccerPhase IDs)", () => {
  it("maps numeric IDs 1–19 to the correct phase abbreviations", () => {
    const expected = [
      [1, "NS"], [2, "H1"], [3, "HT"], [4, "H2"], [5, "F"],
      [6, "WET"], [7, "ET1"], [8, "HTET"], [9, "ET2"], [10, "FET"],
      [11, "WPE"], [12, "PE"], [13, "FPE"], [14, "I"], [15, "A"],
      [16, "C"], [17, "TXCC"], [18, "TXCS"], [19, "P"],
    ] as const;

    for (const [id, phase] of expected) {
      expect(phaseFromGameState(id), `id ${id}`).toBe(phase);
    }
  });

  it("falls back to NS for unknown numeric IDs", () => {
    expect(phaseFromGameState(0)).toBe("NS");
    expect(phaseFromGameState(99)).toBe("NS");
  });
});

// ---------------------------------------------------------------------------
// reduceScore
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function scoreMsg(overrides: Record<string, unknown>): ScoresMessage {
  return {
    data: { FixtureId: 18172280, GameState: "scheduled", Stats: {}, Data: {}, ...overrides },
  };
}

describe("reduceScore — from undefined (first message)", () => {
  it("matches the real captured sample (scheduled, no stats)", () => {
    // Real devnet message shape:
    // { FixtureId:18172280, GameState:"scheduled", Action:"comment",
    //   Id:1, Ts:1782482168962, Seq:1, Data:{}, Stats:{} }
    const msg = scoreMsg({ Action: "comment", Id: 1, Ts: 1782482168962, Seq: 1 });
    const state = reduceScore(undefined, msg, NOW);

    expect(state.fixtureId).toBe(18172280);
    expect(state.phase).toBe("NS");
    expect(state.minute).toBe(0);
    expect(state.p1Goals).toBe(0);
    expect(state.p2Goals).toBe(0);
    expect(state.updatedMs).toBe(NOW);
  });
});

describe("reduceScore — in-play synthetic messages", () => {
  it("accumulates goals from Stats field (string keys = numeric stat keys)", () => {
    // Synthetic in-play shape: Stats: { "1": 2, "2": 1 } = P1=2 goals, P2=1 goal
    const msg = scoreMsg({
      GameState: "second_half",
      Minute: 67,
      Stats: { "1": 2, "2": 1 },
    });
    const state = reduceScore(undefined, msg, NOW);

    expect(state.phase).toBe("H2");
    expect(state.minute).toBe(67);
    expect(state.p1Goals).toBe(2);
    expect(state.p2Goals).toBe(1);
  });

  it("carries forward previous stats when a comment-only message has empty Stats", () => {
    const firstMsg = scoreMsg({
      GameState: "first_half",
      Minute: 30,
      Stats: { "1": 1, "2": 0 },
    });
    const prev: MatchState = reduceScore(undefined, firstMsg, NOW);

    // Comment message — no new stats
    const commentMsg = scoreMsg({ GameState: "first_half", Minute: 31, Stats: {} });
    const next = reduceScore(prev, commentMsg, NOW + 5000);

    expect(next.p1Goals).toBe(1); // carried forward
    expect(next.p2Goals).toBe(0); // carried forward
    expect(next.minute).toBe(31);
  });

  it("maps GameState numeric phase ID in a message", () => {
    const msg = scoreMsg({ GameState: 2 }); // 2 = H1
    const state = reduceScore(undefined, msg, NOW);
    expect(state.phase).toBe("H1");
  });

  it("uses fixtureId from lowercase field if uppercase missing", () => {
    const msg: ScoresMessage = {
      data: { fixtureId: 99999, GameState: "first_half", Stats: {} },
    };
    const state = reduceScore(undefined, msg, NOW);
    expect(state.fixtureId).toBe(99999);
  });

  it("preserves fixtureId from prev when missing in message", () => {
    const prev: MatchState = {
      fixtureId: 42,
      phase: "NS",
      minute: 0,
      p1Goals: 0,
      p2Goals: 0,
      updatedMs: NOW - 1000,
    };
    const msg: ScoresMessage = { data: { GameState: "first_half", Stats: {} } };
    const state = reduceScore(prev, msg, NOW);
    expect(state.fixtureId).toBe(42);
  });
});

describe("reduceScore — phase transitions", () => {
  it("detects terminal phase F correctly", () => {
    const msg = scoreMsg({ GameState: "finished", Stats: { "1": 2, "2": 2 } });
    const state = reduceScore(undefined, msg, NOW);
    expect(state.phase).toBe("F");
    expect(state.p1Goals).toBe(2);
    expect(state.p2Goals).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// lineFromOdds
// ---------------------------------------------------------------------------

function oddsMsg(overrides: Record<string, unknown>): OddsMessage {
  return { data: { FixtureId: 18172280, StatKey: 1, ...overrides } };
}

describe("lineFromOdds — YesPriceBps field", () => {
  it("extracts the bps price directly", () => {
    const line = lineFromOdds(oddsMsg({ YesPriceBps: 6500 }), NOW);
    expect(line).not.toBeUndefined();
    expect(line!.fixtureId).toBe(18172280);
    expect(line!.statKey).toBe(1);
    expect(line!.impliedYesBps).toBe(6500);
    expect(line!.updatedMs).toBe(NOW);
  });

  it("clamps price to 1..9999", () => {
    expect(lineFromOdds(oddsMsg({ YesPriceBps: 0 }), NOW)!.impliedYesBps).toBe(1);
    expect(lineFromOdds(oddsMsg({ YesPriceBps: 10001 }), NOW)!.impliedYesBps).toBe(9999);
  });
});

describe("lineFromOdds — YesProb field (probability 0..1)", () => {
  it("converts probability to bps", () => {
    const line = lineFromOdds(oddsMsg({ YesPriceBps: undefined, YesProb: 0.65 }), NOW);
    expect(line).not.toBeUndefined();
    expect(line!.impliedYesBps).toBe(6500);
  });

  it("handles 0.5 exactly", () => {
    const line = lineFromOdds(oddsMsg({ YesPriceBps: undefined, YesProb: 0.5 }), NOW);
    expect(line!.impliedYesBps).toBe(5000);
  });
});

describe("lineFromOdds — YesOdds field (European decimal odds)", () => {
  it("converts 2.0 odds to 5000 bps (50%)", () => {
    const line = lineFromOdds(oddsMsg({ YesPriceBps: undefined, YesOdds: 2.0 }), NOW);
    expect(line!.impliedYesBps).toBe(5000);
  });

  it("converts 1.5 odds to ~6667 bps", () => {
    const line = lineFromOdds(oddsMsg({ YesPriceBps: undefined, YesOdds: 1.5 }), NOW);
    expect(line!.impliedYesBps).toBe(6667);
  });
});

describe("lineFromOdds — field precedence", () => {
  it("prefers YesPriceBps over YesProb over YesOdds", () => {
    // All three present — YesPriceBps wins.
    const line = lineFromOdds(oddsMsg({ YesPriceBps: 7000, YesProb: 0.5, YesOdds: 2.0 }), NOW);
    expect(line!.impliedYesBps).toBe(7000);
  });
});

describe("lineFromOdds — missing required fields", () => {
  it("returns undefined when FixtureId is absent", () => {
    const msg: OddsMessage = { data: { StatKey: 1, YesPriceBps: 5000 } };
    expect(lineFromOdds(msg, NOW)).toBeUndefined();
  });

  it("returns undefined when StatKey is absent", () => {
    const msg: OddsMessage = { data: { FixtureId: 123, YesPriceBps: 5000 } };
    expect(lineFromOdds(msg, NOW)).toBeUndefined();
  });

  it("returns undefined when no price field is present", () => {
    const msg: OddsMessage = { data: { FixtureId: 123, StatKey: 1 } };
    expect(lineFromOdds(msg, NOW)).toBeUndefined();
  });
});

describe("lineFromOdds — lowercase field names", () => {
  it("accepts fixtureId (camelCase)", () => {
    const msg: OddsMessage = { data: { fixtureId: 42, statKey: 2, YesPriceBps: 3500 } };
    const line = lineFromOdds(msg, NOW);
    expect(line!.fixtureId).toBe(42);
    expect(line!.statKey).toBe(2);
    expect(line!.impliedYesBps).toBe(3500);
  });
});
