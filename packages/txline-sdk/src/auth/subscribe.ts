import { type Program } from "@coral-xyz/anchor";
import { SystemProgram, type Signer } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import type { Txoracle } from "../onchain/idl/txoracle.js";
import type { TxlineConfig } from "../config.js";
import { type ServiceLevel } from "../config.js";
import { pricingMatrixPda, tokenTreasuryPda, tokenTreasuryVault } from "../onchain/pdas.js";

export interface SubscribeParams {
  program: Program<Txoracle>;
  config: TxlineConfig;
  /** Fee payer / token-account owner. Defaults to the provider wallet's payer. */
  payer?: Signer;
  serviceLevel: ServiceLevel | number;
  durationWeeks: number;
}

/**
 * Register a free-tier subscription on-chain via `subscribe(serviceLevel,
 * durationWeeks)`. Free tiers (service level 1 or 12) charge no TxL — the tx
 * just records the subscription. Returns the transaction signature, which is
 * the `txSig` input to {@link activateApiToken}.
 */
export async function subscribeFreeTier(params: SubscribeParams): Promise<string> {
  const { program, config, serviceLevel, durationWeeks } = params;
  const provider = program.provider;
  const wallet = (provider as { wallet?: { publicKey: unknown; payer?: Signer } }).wallet;
  const payer = params.payer ?? wallet?.payer;
  if (!payer) {
    throw new Error(
      "subscribeFreeTier: a Signer payer is required (provider wallet has no payer keypair)",
    );
  }
  if (!provider.connection) {
    throw new Error("subscribeFreeTier: provider has no connection");
  }

  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    config.txlMint,
    payer.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  const [pricingMatrix] = pricingMatrixPda(config.programId);
  const [treasuryPda] = tokenTreasuryPda(config.programId);
  const treasuryVault = tokenTreasuryVault(config.programId, config.txlMint);

  return program.methods
    .subscribe(serviceLevel, durationWeeks)
    .accounts({
      user: payer.publicKey,
      pricingMatrix,
      tokenMint: config.txlMint,
      userTokenAccount: userTokenAccount.address,
      tokenTreasuryVault: treasuryVault,
      tokenTreasuryPda: treasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
