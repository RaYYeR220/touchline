/**
 * On-chain stat/phase encodings for the TxLINE scores feed.
 *
 * These encodings are required when validating score data against on-chain
 * Merkle roots and when constructing settlement predicates. Source: vendored
 * `docs/txline-soccer-feed.md` and the reference repo README (US football).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** epochDay used as the `u16` seed of the `daily_scores_roots` PDA. */
export function epochDayFromTs(timestampMs: number): number {
  return Math.floor(timestampMs / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Soccer (World Cup) — primary
// ---------------------------------------------------------------------------

/** Soccer game-phase IDs (the `period` dimension of a fixture's lifecycle). */
export const SoccerPhase = {
  NotStarted: 1,
  FirstHalf: 2,
  HalfTime: 3,
  SecondHalf: 4,
  Ended: 5,
  WaitingForExtraTime: 6,
  ExtraTimeFirstHalf: 7,
  ExtraTimeHalfTime: 8,
  ExtraTimeSecondHalf: 9,
  EndedAfterExtraTime: 10,
  WaitingForPenalties: 11,
  PenaltyShootout: 12,
  EndedAfterPenalties: 13,
  Interrupted: 14,
  Abandoned: 15,
  Cancelled: 16,
  TxCoverageCancelled: 17,
  TxCoverageSuspended: 18,
  Postponed: 19,
} as const;
export type SoccerPhase = (typeof SoccerPhase)[keyof typeof SoccerPhase];

/** Base soccer stat keys (full-game). Period offsets are added on top. */
export const SoccerStat = {
  P1Goals: 1,
  P2Goals: 2,
  P1YellowCards: 3,
  P2YellowCards: 4,
  P1RedCards: 5,
  P2RedCards: 6,
  P1Corners: 7,
  P2Corners: 8,
} as const;
export type SoccerStat = (typeof SoccerStat)[keyof typeof SoccerStat];

/**
 * Soccer stat *period* used for key encoding (distinct from the phase ID).
 * Encoded statKey = period * 1000 + baseKey. Full game = 0.
 */
export const SoccerStatPeriod = {
  FullGame: 0,
  FirstHalf: 1,
  SecondHalf: 2,
  ExtraTime1: 3,
  ExtraTime2: 4,
  PenaltyShootout: 5,
} as const;
export type SoccerStatPeriod =
  (typeof SoccerStatPeriod)[keyof typeof SoccerStatPeriod];

/**
 * Encode a soccer stat key for the `statKey` query parameter of
 * `/api/scores/stat-validation`. e.g. `soccerStatKey(SoccerStat.P1Goals,
 * SoccerStatPeriod.FirstHalf)` === 1001.
 */
export function soccerStatKey(
  base: SoccerStat | number,
  period: SoccerStatPeriod | number = SoccerStatPeriod.FullGame,
): number {
  return period * 1000 + base;
}

// ---------------------------------------------------------------------------
// US College Football — secondary (covered by the scores/trading channel)
// ---------------------------------------------------------------------------

export const FootballStat = {
  P1TotalScore: 1,
  P2TotalScore: 2,
  P1Touchdowns: 3,
  P2Touchdowns: 4,
  P1FieldGoals: 5,
  P2FieldGoals: 6,
} as const;
export type FootballStat = (typeof FootballStat)[keyof typeof FootballStat];

/** Halves use a 1000 multiplier; quarters use a 10000 multiplier. */
export const FootballStatPeriod = {
  FullGame: { mul: 0 },
  FirstHalf: { mul: 1000 },
  SecondHalf: { mul: 2000 },
  Quarter1: { mul: 10000 },
  Quarter2: { mul: 20000 },
  Quarter3: { mul: 30000 },
  Quarter4: { mul: 40000 },
} as const;
export type FootballStatPeriodKey = keyof typeof FootballStatPeriod;

/** Encode a US-football stat key: `period.mul + base`. */
export function footballStatKey(
  base: FootballStat | number,
  period: FootballStatPeriodKey = "FullGame",
): number {
  return FootballStatPeriod[period].mul + base;
}
