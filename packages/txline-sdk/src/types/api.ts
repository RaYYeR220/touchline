/**
 * Raw shapes returned by the TxLINE off-chain API. Hash/root fields are
 * 32-byte arrays already in the byte-array form Anchor expects for `[u8;32]`
 * (the reference examples pass them straight into instruction args).
 */

/** A 32-byte hash as returned by the API (byte array). */
export type Hash32 = number[];

export interface ApiProofNode {
  hash: Hash32;
  isRightSibling: boolean;
}

export interface ApiScoreStat {
  key: number;
  value: number;
  period: number;
}

export interface ApiScoresUpdateStats {
  updateCount: number;
  minTimestamp: number;
  maxTimestamp: number;
}

export interface ApiScoresSummary {
  fixtureId: number;
  updateStats: ApiScoresUpdateStats;
  /** Maps to on-chain `events_sub_tree_root`. */
  eventStatsSubTreeRoot: Hash32;
}

/**
 * Response of `GET /api/scores/stat-validation`. When `statKey2` is supplied,
 * the `*2` fields are populated for two-stat predicates.
 */
export interface StatValidationResponse {
  /** Batch timestamp (ms) — drives the `daily_scores_roots` epochDay seed. */
  ts: number;
  summary: ApiScoresSummary;
  /** Proof from the fixture sub-tree root up to (excl.) the main batch root. */
  subTreeProof: ApiProofNode[];
  /** Proof within the main batch tree. */
  mainTreeProof: ApiProofNode[];
  statToProve: ApiScoreStat;
  eventStatRoot: Hash32;
  statProof: ApiProofNode[];
  statToProve2?: ApiScoreStat;
  statProof2?: ApiProofNode[];
}

/** Fixture snapshot entry (`/api/fixtures/snapshot`). */
export interface ApiFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number;
  CompetitionId?: number;
  Competition?: string;
  [key: string]: unknown;
}

/** SSE/REST scores update (`/api/scores/*`). Field set is feed-dependent. */
export interface ApiScoresUpdate {
  FixtureId?: number;
  fixtureId?: number;
  seq?: number;
  [key: string]: unknown;
}

/** SSE/REST odds update (`/api/odds/*`). Field set is market-dependent. */
export interface ApiOddsUpdate {
  FixtureId?: number;
  fixtureId?: number;
  [key: string]: unknown;
}
