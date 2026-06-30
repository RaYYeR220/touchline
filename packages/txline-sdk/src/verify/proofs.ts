import type { TxlineRestClient } from "../rest/client.js";
import type { StatValidationResponse } from "../types/api.js";

export interface StatValidationQuery {
  fixtureId: number;
  /** Sequence number uniquely identifying the scores update in the feed. */
  seq: number;
  /** Encoded stat key (see encodings). */
  statKey: number;
  /** Optional second stat key for two-stat predicates. */
  statKey2?: number;
}

/**
 * Fetch a three-stage Merkle proof for one or two score statistics:
 * `GET /api/scores/stat-validation`. The response feeds
 * {@link buildValidateStatInputs}.
 */
export function fetchStatValidation(
  client: TxlineRestClient,
  q: StatValidationQuery,
): Promise<StatValidationResponse> {
  return client.get<StatValidationResponse>("/api/scores/stat-validation", {
    fixtureId: q.fixtureId,
    seq: q.seq,
    statKey: q.statKey,
    statKey2: q.statKey2,
  });
}
