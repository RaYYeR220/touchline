import type { ScoresMessage, OddsMessage } from "@touchline/txline-sdk";
import type { MatchState, MarketLine, Phase } from "../types.js";

// ---------------------------------------------------------------------------
// Phase mapping
// ---------------------------------------------------------------------------

/**
 * Maps the numeric SoccerPhase IDs from the on-chain encoding to Phase strings.
 * Source: docs/txline-soccer-feed.md phase table.
 */
const PHASE_BY_ID: Record<number, Phase> = {
  1:  "NS",
  2:  "H1",
  3:  "HT",
  4:  "H2",
  5:  "F",
  6:  "WET",
  7:  "ET1",
  8:  "HTET",
  9:  "ET2",
  10: "FET",
  11: "WPE",
  12: "PE",
  13: "FPE",
  14: "I",
  15: "A",
  16: "C",
  17: "TXCC",
  18: "TXCS",
  19: "P",
};

/**
 * Maps lowercase string GameState values from the TxLINE SSE feed to Phase.
 *
 * Mapping rationale (explicit; no fallback guessing):
 *  - "scheduled" and "ns" → pre-match, not started
 *  - "first_half" / "h1" → live, first half
 *  - "halftime" / "half_time" / "ht" → break between halves
 *  - "second_half" / "h2" → live, second half
 *  - "finished" / "ended" / "f" → regulation end
 *  - The remainder follow the same ns/abbreviation pattern from the feed docs.
 */
const PHASE_BY_STRING: Record<string, Phase> = {
  scheduled: "NS",
  ns: "NS",
  not_started: "NS",
  first_half: "H1",
  h1: "H1",
  halftime: "HT",
  half_time: "HT",
  ht: "HT",
  second_half: "H2",
  h2: "H2",
  finished: "F",
  ended: "F",
  f: "F",
  waiting_for_extra_time: "WET",
  wet: "WET",
  extra_time_first_half: "ET1",
  et1: "ET1",
  extra_time_halftime: "HTET",
  extra_time_half_time: "HTET",
  htet: "HTET",
  extra_time_second_half: "ET2",
  et2: "ET2",
  finished_after_extra_time: "FET",
  fet: "FET",
  waiting_for_penalties: "WPE",
  wpe: "WPE",
  penalty_shootout: "PE",
  pe: "PE",
  finished_after_penalties: "FPE",
  fpe: "FPE",
  interrupted: "I",
  i: "I",
  abandoned: "A",
  a: "A",
  cancelled: "C",
  c: "C",
  txcc: "TXCC",
  txcs: "TXCS",
  postponed: "P",
  p: "P",
};

/**
 * Map a GameState value (string label or numeric phase ID) to a Phase.
 * Unknown values fall back to "NS" so the agent never crashes on an unrecognised
 * phase; callers can detect "NS" + unexpected input via logging.
 */
export function phaseFromGameState(gs: string | number): Phase {
  if (typeof gs === "number") {
    return PHASE_BY_ID[gs] ?? "NS";
  }
  return PHASE_BY_STRING[gs.toLowerCase()] ?? "NS";
}

// ---------------------------------------------------------------------------
// Stats adapter
// ---------------------------------------------------------------------------

/**
 * Extract a numeric stat value from a Stats record.
 *
 * Feed shape assumption (explicit):
 *   Stats is a Record<string, number> where keys are the numeric TxLINE stat
 *   key as a decimal string.  E.g.: { "1": 2, "2": 1 } = P1Goals=2, P2Goals=1.
 *
 *   Full-game stat keys:
 *     "1" → P1 Goals  "2" → P2 Goals
 *     "3" → P1 YC     "4" → P2 YC
 *     "5" → P1 RC     "6" → P2 RC
 *     "7" → P1 Corners "8" → P2 Corners
 *
 * Returns 0 if the key is absent or the value is not a finite number.
 */
function statFromRecord(stats: Record<string, unknown>, key: number): number {
  const v = stats[String(key)];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}

function asStatsRecord(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Score reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer: fold a single ScoresMessage into a MatchState.
 *
 * If `prev` is undefined (first message), a fresh state is created.
 * Fields not carried in a given message inherit from `prev`.
 *
 * Captured real sample (scheduled, pre-match):
 *   { FixtureId:18172280, GameState:"scheduled", Action:"comment",
 *     Id:1, Ts:1782482168962, Seq:1, Data:{}, Stats:{} }
 *
 * Synthetic in-play shape (assumed; tested with mock data):
 *   { FixtureId:18172280, GameState:"second_half", Minute:67,
 *     Stats:{"1":2,"2":1} }
 *
 * The "Ts" field carries a feed timestamp in ms.  We accept `nowMs` from
 * outside so the reducer stays deterministic.
 */
export function reduceScore(
  prev: MatchState | undefined,
  msg: ScoresMessage,
  nowMs: number,
): MatchState {
  const d = msg.data;

  const fixtureId: number =
    typeof d["FixtureId"] === "number" ? d["FixtureId"] :
    typeof d["fixtureId"] === "number" ? d["fixtureId"] :
    prev?.fixtureId ?? 0;

  const gs = d["GameState"] ?? d["gameState"];
  const phase: Phase = gs !== undefined ? phaseFromGameState(gs as string | number) : (prev?.phase ?? "NS");

  const rawMinute = d["Minute"] ?? d["minute"];
  const minute: number =
    typeof rawMinute === "number" ? rawMinute : (prev?.minute ?? 0);

  const stats = asStatsRecord(d["Stats"] ?? d["stats"]);
  // Full-game goals: stat keys 1 and 2.
  // Use the stat value if non-zero, otherwise carry forward from prev.
  const rawP1 = statFromRecord(stats, 1);
  const rawP2 = statFromRecord(stats, 2);
  const p1Goals = rawP1 !== 0 ? rawP1 : (prev?.p1Goals ?? 0);
  const p2Goals = rawP2 !== 0 ? rawP2 : (prev?.p2Goals ?? 0);

  return { fixtureId, phase, minute, p1Goals, p2Goals, updatedMs: nowMs };
}

// ---------------------------------------------------------------------------
// Odds adapter
// ---------------------------------------------------------------------------

/**
 * Extract a MarketLine from an OddsMessage.
 *
 * Odds message shape assumption (explicit):
 *   The TxLINE odds stream emits StablePrice updates with these fields:
 *     FixtureId (or fixtureId): number — the fixture
 *     StatKey   (or statKey):   number — the encoded stat key (e.g. 1 = P1Goals)
 *     YesPriceBps               number — YES price in integer bps (1..9999)
 *       OR YesOdds              number — European decimal odds (e.g. 1.67 → bps≈5988)
 *       OR YesProb              number — probability 0..1 (× 10000 → bps)
 *
 * Precedence: YesPriceBps > YesProb > YesOdds.
 * Returns undefined if the minimum fields (fixtureId + statKey + any price) are absent.
 *
 * NOTE: If the actual odds feed uses different field names, update this adapter
 * and its tests — the mapping is intentionally explicit here.
 */
export function lineFromOdds(msg: OddsMessage, nowMs: number): MarketLine | undefined {
  const d = msg.data;

  const fixtureId: number | undefined =
    typeof d["FixtureId"] === "number" ? d["FixtureId"] :
    typeof d["fixtureId"] === "number" ? d["fixtureId"] : undefined;

  const statKey: number | undefined =
    typeof d["StatKey"] === "number" ? d["StatKey"] :
    typeof d["statKey"] === "number" ? d["statKey"] : undefined;

  if (fixtureId === undefined || statKey === undefined) return undefined;

  let impliedYesBps: number | undefined;

  // Highest-fidelity field: bps directly.
  if (typeof d["YesPriceBps"] === "number") {
    impliedYesBps = Math.round(d["YesPriceBps"] as number);
  }
  // Probability 0..1 → bps.
  else if (typeof d["YesProb"] === "number") {
    impliedYesBps = Math.round((d["YesProb"] as number) * 10000);
  }
  // Decimal European odds: prob = 1/odds → bps.
  else if (typeof d["YesOdds"] === "number" && (d["YesOdds"] as number) > 0) {
    impliedYesBps = Math.round((1 / (d["YesOdds"] as number)) * 10000);
  }

  if (impliedYesBps === undefined) return undefined;

  // Clamp to the valid price range.
  impliedYesBps = Math.max(1, Math.min(9999, impliedYesBps));

  return { fixtureId, statKey, impliedYesBps, updatedMs: nowMs };
}
