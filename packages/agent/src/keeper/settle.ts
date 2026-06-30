/**
 * Keeper settles Touchline positions using the venue's settle instruction.
 *
 * For mock-oracle markets (7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S):
 *   pass zeroed Merkle proofs — the mock oracle evaluates the predicate
 *   directly against stat1.value without verifying any Merkle tree.
 *
 * Note I1: Against the REAL txoracle a false predicate may revert with
 * PredicateFailed. Callers should catch that error and skip the position.
 * For the mock oracle it always returns the predicate boolean.
 */
import {
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  pipe,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSettleInstructionAsync,
  fetchPosition,
  fetchMarket,
  Side,
  Comparison,
  MarketStatus,
} from "@touchline/venue-client";
import { getAtaAddress } from "../exec/executor.js";
import type { MarketView, PositionView } from "../types.js";
import type { AgentConfig } from "../config.js";

/** Read a position account and project it into the agent PositionView shape. */
async function loadPositionView(
  rpc: Rpc<SolanaRpcApi>,
  positionAddr: Address,
): Promise<PositionView> {
  const { data: d } = await fetchPosition(rpc, positionAddr);
  return {
    address: positionAddr,
    market: d.market,
    maker: d.maker,
    taker: d.taker,
    makerSide: d.makerSide === Side.Yes ? "Yes" : "No",
    priceYesBps: d.priceYesBps,
    pot: d.pot,
    settled: d.settled,
  };
}

/** Read a market account and project it into the agent MarketView shape. */
async function loadMarketView(
  rpc: Rpc<SolanaRpcApi>,
  marketAddr: Address,
): Promise<MarketView> {
  const { data: d } = await fetchMarket(rpc, marketAddr);
  const comparison =
    d.predicate.comparison === Comparison.GreaterThan ? ("GreaterThan" as const)
    : d.predicate.comparison === Comparison.LessThan ? ("LessThan" as const)
    : ("EqualTo" as const);
  return {
    address: marketAddr,
    fixtureId: Number(d.fixtureId),
    statKey: d.statKey,
    predicate: { threshold: d.predicate.threshold, comparison },
    status: d.status === MarketStatus.Open ? "Open" : "Settled",
    totalPot: d.totalPot,
    oracleProgram: d.oracleProgram,
  };
}

export class Keeper {
  constructor(
    private rpc: Rpc<SolanaRpcApi>,
    private rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    private signer: TransactionSigner,
    private cfg: AgentConfig,
  ) {}

  /** Fetch a position account by its on-chain address. */
  fetchPositionView(positionAddr: Address): Promise<PositionView> {
    return loadPositionView(this.rpc, positionAddr);
  }

  /** Fetch a market account by its on-chain address. */
  fetchMarketView(marketAddr: Address): Promise<MarketView> {
    return loadMarketView(this.rpc, marketAddr);
  }

  /**
   * Settle a position.
   *
   * `statValue` is the actual stat outcome (e.g. 3 for "P1 scored 3 goals").
   * For mock-oracle markets, pass zeroed proofs — the mock oracle accepts them
   * and evaluates the predicate against statValue directly.
   *
   * cfg.usdcMint must match the market's mint.
   */
  async settle(position: PositionView, market: MarketView, statValue: number): Promise<string> {
    const { rpc, rpcSubscriptions, signer, cfg } = this;

    const makerAta = await getAtaAddress(cfg.usdcMint, position.maker);
    const takerAta = await getAtaAddress(cfg.usdcMint, position.taker);

    const ix = await getSettleInstructionAsync({
      settler: signer,
      market: market.address,
      position: position.address,
      mint: cfg.usdcMint,
      makerAta,
      takerAta,
      // Mock oracle ignores this account; reuse the oracle program address as a valid placeholder
      dailyScoresMerkleRoots: market.oracleProgram,
      oracleProgram: market.oracleProgram,
      // Zeroed Merkle proof fields — mock oracle evaluates the predicate against stat1.value
      ts: 0n,
      fixtureId: BigInt(market.fixtureId),
      updateStats: { updateCount: 0, minTimestamp: 0n, maxTimestamp: 0n },
      eventsSubTreeRoot: new Uint8Array(32),
      fixtureProof: [],
      mainTreeProof: [],
      stat1: {
        statToProve: { key: market.statKey, value: statValue, period: 0 },
        eventStatRoot: new Uint8Array(32),
        statProof: [],
      },
      stat2: null,
      op: null,
    });

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
}
