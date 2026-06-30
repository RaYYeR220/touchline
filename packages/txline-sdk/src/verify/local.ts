/**
 * EXPERIMENTAL local Merkle verification — DO NOT use for settlement.
 *
 * The on-chain `txoracle` program is the source of truth for proof validation
 * (use {@link runValidateStatView}). TxLINE's exact leaf encoding and node
 * hashing scheme are NOT documented publicly, so a faithful off-chain re-verify
 * cannot be guaranteed correct without the program source. This helper provides
 * the generic Merkle-branch fold so that, once the scheme is confirmed in the
 * build session, it can be completed and used for cheap pre-checks.
 *
 * Until then it is wired to throw, to prevent accidental reliance.
 */
import type { ApiProofNode } from "../types/api.js";

export type HashFn = (left: Uint8Array, right: Uint8Array) => Uint8Array;
export type LeafHashFn = (leaf: unknown) => Uint8Array;

/**
 * Fold a proof branch from a leaf hash up to a root, honoring each node's
 * `isRightSibling` orientation. The `combine` hash function is intentionally a
 * required parameter — the canonical TxLINE scheme is unconfirmed.
 */
export function foldMerkleBranch(
  leafHash: Uint8Array,
  proof: ApiProofNode[],
  combine: HashFn,
): Uint8Array {
  let acc = leafHash;
  for (const node of proof) {
    const sibling = Uint8Array.from(node.hash);
    acc = node.isRightSibling ? combine(acc, sibling) : combine(sibling, acc);
  }
  return acc;
}

/** Guard: local verification is not yet trustworthy. */
export function localVerifyUnavailable(): never {
  throw new Error(
    "Local Merkle verification is experimental and unconfirmed. Use runValidateStatView (on-chain) for settlement.",
  );
}
