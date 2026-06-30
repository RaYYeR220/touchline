import type { ApiFixture, ApiOddsUpdate, ApiScoresUpdate } from "./api.js";

/** Normalized fixture shape used across the codebase. */
export interface Fixture {
  fixtureId: number;
  participant1: string;
  participant2: string;
  startTimeMs: number;
  competitionId?: number;
  competition?: string;
  raw: ApiFixture;
}

export function normalizeFixture(raw: ApiFixture): Fixture {
  return {
    fixtureId: raw.FixtureId,
    participant1: raw.Participant1,
    participant2: raw.Participant2,
    startTimeMs: raw.StartTime,
    competitionId: raw.CompetitionId,
    competition: raw.Competition,
    raw,
  };
}

/** A single SSE/REST stream message after envelope parsing. */
export interface StreamMessage<T> {
  /** Raw SSE id, format `timestamp:index`. */
  id?: string;
  /** Parsed timestamp (ms) from the id, if present. */
  timestampMs?: number;
  /** Index within the timestamp bucket, if present. */
  index?: number;
  data: T;
}

export type OddsMessage = StreamMessage<ApiOddsUpdate>;
export type ScoresMessage = StreamMessage<ApiScoresUpdate>;

/** Parse an SSE id of the form `timestamp:index`. */
export function parseStreamId(id: string | undefined): {
  timestampMs?: number;
  index?: number;
} {
  if (!id) return {};
  const [tsStr, idxStr] = id.split(":");
  const timestampMs = tsStr !== undefined ? Number(tsStr) : undefined;
  const index = idxStr !== undefined ? Number(idxStr) : undefined;
  return {
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
    index: Number.isFinite(index) ? index : undefined,
  };
}
