import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { epochDayFromTs } from "./encodings.js";

/** Encode a number as a 2-byte little-endian buffer (matches `u16` PDA seeds). */
export function u16le(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new RangeError(`u16le: value out of range: ${n}`);
  }
  return Buffer.from([n & 0xff, (n >> 8) & 0xff]);
}

export function pricingMatrixPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    programId,
  );
}

export function tokenTreasuryPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    programId,
  );
}

export function usdtTreasuryPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("usdt_treasury")],
    programId,
  );
}

/** ATA holding collected TxL subscription tokens (owned by the treasury PDA). */
export function tokenTreasuryVault(
  programId: PublicKey,
  txlMint: PublicKey,
): PublicKey {
  const [treasury] = tokenTreasuryPda(programId);
  return getAssociatedTokenAddressSync(
    txlMint,
    treasury,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
}

export function usdtTreasuryVault(
  programId: PublicKey,
  usdtMint: PublicKey,
): PublicKey {
  const [treasury] = usdtTreasuryPda(programId);
  return getAssociatedTokenAddressSync(
    usdtMint,
    treasury,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
}

/** Daily scores Merkle roots account — the `validate_stat` anchor. */
export function dailyScoresRootsPda(
  programId: PublicKey,
  epochDay: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), u16le(epochDay)],
    programId,
  );
}

/** Daily batch (odds) Merkle roots account — the `validate_odds` anchor. */
export function dailyBatchRootsPda(
  programId: PublicKey,
  epochDay: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_batch_roots"), u16le(epochDay)],
    programId,
  );
}

/** Fixtures roots are grouped in 10-day windows (epochDay floored to /10). */
export function tenDailyFixturesRootsPda(
  programId: PublicKey,
  epochDay: number,
): [PublicKey, number] {
  const aligned = Math.floor(epochDay / 10) * 10;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ten_daily_fixtures_roots"), u16le(aligned)],
    programId,
  );
}

/** Convenience: derive the scores-roots PDA directly from a millisecond timestamp. */
export function dailyScoresRootsPdaForTs(
  programId: PublicKey,
  timestampMs: number,
): [PublicKey, number] {
  return dailyScoresRootsPda(programId, epochDayFromTs(timestampMs));
}
