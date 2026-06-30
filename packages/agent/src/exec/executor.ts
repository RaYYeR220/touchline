/**
 * Executor maps Intent objects to signed Solana transactions on the Touchline venue.
 * Uses the same send pattern as packages/venue-client/smoke-devnet.ts.
 */
import {
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  getProgramDerivedAddress,
  getAddressEncoder,
  getBytesEncoder,
  getU64Encoder,
  getU32Encoder,
  getI32Encoder,
  pipe,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  TOUCHLINE_PROGRAM_ADDRESS,
  getCreateMarketInstructionAsync,
  getPostOfferInstructionAsync,
  getFillOfferInstructionAsync,
  getCancelOfferInstructionAsync,
  findVaultPda,
  Comparison,
  Side,
} from "@touchline/venue-client";
import type { Intent } from "../types.js";
import type { AgentConfig } from "../config.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

/** Derive the associated token account address for a given owner and mint. */
export async function getAtaAddress(mint: Address, owner: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(TOKEN_PROGRAM),
      getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}

/** Derive the market PDA (same seed logic as smoke-devnet.ts). */
export async function deriveMarketPda(
  fixtureId: number,
  statKey: number,
  threshold: number,
  comparison: Comparison,
): Promise<Address> {
  const [market] = await getProgramDerivedAddress({
    programAddress: TOUCHLINE_PROGRAM_ADDRESS,
    seeds: [
      getBytesEncoder().encode(new Uint8Array([109, 97, 114, 107, 101, 116])), // "market"
      getU64Encoder().encode(BigInt(fixtureId)),
      getU32Encoder().encode(statKey),
      getI32Encoder().encode(threshold),
      new Uint8Array([comparison]),
    ],
  });
  return market;
}

function toComparison(c: "GreaterThan" | "LessThan" | "EqualTo"): Comparison {
  return c === "GreaterThan" ? Comparison.GreaterThan
    : c === "LessThan" ? Comparison.LessThan
    : Comparison.EqualTo;
}

/**
 * Executor turns agent Intents into signed Solana transactions.
 *
 * offerId and positionId are auto-incremented per Executor instance so retries
 * on different instances do not collide (use a persistent store for production).
 */
export class Executor {
  private _offerId = 0n;
  private _positionId = 0n;

  constructor(
    private rpc: Rpc<SolanaRpcApi>,
    private rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    public signer: TransactionSigner,
    private cfg: AgentConfig,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _send(ix: any): Promise<string> {
    const { rpc, rpcSubscriptions, signer } = this;
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const txMsg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );
    const signed = await signTransactionMessageWithSigners(txMsg);
    const sig = getSignatureFromTransaction(signed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(signed as any, {
      commitment: "confirmed",
    });
    return String(sig);
  }

  async execute(intent: Intent): Promise<string> {
    const { signer, cfg } = this;

    if (intent.kind === "createMarket") {
      const comparison = toComparison(intent.predicate.comparison);
      const market = await deriveMarketPda(
        intent.fixtureId,
        intent.statKey,
        intent.predicate.threshold,
        comparison,
      );
      const [vault] = await findVaultPda({ market });
      const ix = await getCreateMarketInstructionAsync({
        authority: signer,
        mint: cfg.usdcMint,
        market,
        vault,
        fixtureId: BigInt(intent.fixtureId),
        statKey: intent.statKey,
        predicate: { threshold: intent.predicate.threshold, comparison },
        oracleProgram: cfg.oracleProgram,
      });
      return this._send(ix);
    }

    if (intent.kind === "postOffer") {
      const offerId = this._offerId++;
      const makerAta = await getAtaAddress(cfg.usdcMint, signer.address);
      const ix = await getPostOfferInstructionAsync({
        maker: signer,
        market: intent.market,
        mint: cfg.usdcMint,
        makerAta,
        offerId,
        makerSide: intent.side === "Yes" ? Side.Yes : Side.No,
        priceYesBps: intent.priceYesBps,
        pot: intent.pot,
      });
      return this._send(ix);
    }

    if (intent.kind === "fillOffer") {
      const positionId = this._positionId++;
      const takerAta = await getAtaAddress(cfg.usdcMint, signer.address);
      const ix = await getFillOfferInstructionAsync({
        taker: signer,
        market: intent.offer.market,
        offer: intent.offer.address,
        mint: cfg.usdcMint,
        takerAta,
        positionId,
        fillPot: intent.fillPot,
      });
      return this._send(ix);
    }

    // cancelOffer
    const makerAta = await getAtaAddress(cfg.usdcMint, signer.address);
    const ix = await getCancelOfferInstructionAsync({
      maker: signer,
      market: intent.offer.market,
      offer: intent.offer.address,
      mint: cfg.usdcMint,
      makerAta,
    });
    return this._send(ix);
  }
}
