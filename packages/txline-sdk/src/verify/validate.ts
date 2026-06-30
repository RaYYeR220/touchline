import { type Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Txoracle } from "../onchain/idl/txoracle.js";
import type { TxlineConfig } from "../config.js";
import { dailyScoresRootsPda } from "../onchain/pdas.js";
import { epochDayFromTs } from "../onchain/encodings.js";
import type { ValidateStatInputs } from "./args.js";
import type { BinaryExpression, TraderPredicate } from "./predicate.js";

const VALIDATE_CU_LIMIT = 1_400_000;

/** Derive the `daily_scores_roots` account that anchors a validation's batch. */
export function scoresRootsAccountForValidation(
  config: TxlineConfig,
  tsMs: number,
): PublicKey {
  const [pda] = dailyScoresRootsPda(config.programId, epochDayFromTs(tsMs));
  return pda;
}

function methodBuilder(
  program: Program<Txoracle>,
  config: TxlineConfig,
  inputs: ValidateStatInputs,
  predicate: TraderPredicate,
  op: BinaryExpression | null,
) {
  const dailyScoresMerkleRoots = scoresRootsAccountForValidation(
    config,
    inputs.ts.toNumber(),
  );
  return program.methods
    .validateStat(
      inputs.ts,
      inputs.fixtureSummary as never,
      inputs.fixtureProof as never,
      inputs.mainTreeProof as never,
      predicate as never,
      inputs.stat1 as never,
      inputs.stat2 as never,
      op as never,
    )
    .accounts({ dailyScoresMerkleRoots });
}

/**
 * Run `validate_stat` as a read-only view, returning whether the predicate
 * holds against the on-chain Merkle root. This is the trustless settlement
 * oracle check — Arbiter gates escrow release on this result.
 */
export async function runValidateStatView(
  program: Program<Txoracle>,
  config: TxlineConfig,
  inputs: ValidateStatInputs,
  predicate: TraderPredicate,
  op: BinaryExpression | null = null,
): Promise<boolean> {
  const result = await methodBuilder(program, config, inputs, predicate, op)
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: VALIDATE_CU_LIMIT }),
    ])
    .view();
  return Boolean(result);
}

/**
 * Build the `validate_stat` instruction for composition (e.g. CPI from the
 * Arbiter settlement program, or manual transaction assembly).
 */
export function buildValidateStatIx(
  program: Program<Txoracle>,
  config: TxlineConfig,
  inputs: ValidateStatInputs,
  predicate: TraderPredicate,
  op: BinaryExpression | null = null,
): Promise<TransactionInstruction> {
  return methodBuilder(program, config, inputs, predicate, op).instruction();
}
