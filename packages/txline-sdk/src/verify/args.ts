import * as anchor from "@coral-xyz/anchor";
const BN = anchor.BN;
type BN = InstanceType<typeof anchor.BN>;
import type {
  ApiProofNode,
  ApiScoreStat,
  StatValidationResponse,
} from "../types/api.js";

/** On-chain `ProofNode { hash: [u8;32], is_right_sibling: bool }`. */
export interface ProofNodeArg {
  hash: number[];
  isRightSibling: boolean;
}

/** On-chain `ScoreStat { key: u32, value: i32, period: i32 }`. */
export interface ScoreStatArg {
  key: number;
  value: number;
  period: number;
}

/** On-chain `StatTerm`. */
export interface StatTermArg {
  statToProve: ScoreStatArg;
  eventStatRoot: number[];
  statProof: ProofNodeArg[];
}

/** On-chain `ScoresBatchSummary`. */
export interface ScoresBatchSummaryArg {
  fixtureId: BN;
  updateStats: {
    updateCount: number;
    minTimestamp: BN;
    maxTimestamp: BN;
  };
  eventsSubTreeRoot: number[];
}

/** All positional inputs to `validateStat` derived from the API response. */
export interface ValidateStatInputs {
  ts: BN;
  fixtureSummary: ScoresBatchSummaryArg;
  fixtureProof: ProofNodeArg[];
  mainTreeProof: ProofNodeArg[];
  stat1: StatTermArg;
  stat2: StatTermArg | null;
}

function mapProof(nodes: ApiProofNode[]): ProofNodeArg[] {
  return nodes.map((n) => ({ hash: n.hash, isRightSibling: n.isRightSibling }));
}

function mapStat(stat: ApiScoreStat): ScoreStatArg {
  return { key: stat.key, value: stat.value, period: stat.period };
}

/**
 * Pure transform of a `stat-validation` API response into the argument set the
 * on-chain `validateStat` instruction expects. The settlement `predicate` and
 * `op` are NOT derived here — they come from the market definition.
 */
export function buildValidateStatInputs(
  v: StatValidationResponse,
): ValidateStatInputs {
  const stat1: StatTermArg = {
    statToProve: mapStat(v.statToProve),
    eventStatRoot: v.eventStatRoot,
    statProof: mapProof(v.statProof),
  };

  let stat2: StatTermArg | null = null;
  if (v.statToProve2 && v.statProof2) {
    stat2 = {
      statToProve: mapStat(v.statToProve2),
      eventStatRoot: v.eventStatRoot,
      statProof: mapProof(v.statProof2),
    };
  }

  return {
    ts: new BN(v.ts),
    fixtureSummary: {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
    },
    fixtureProof: mapProof(v.subTreeProof),
    mainTreeProof: mapProof(v.mainTreeProof),
    stat1,
    stat2,
  };
}
