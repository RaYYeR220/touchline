/**
 * Raw on-chain reads for the venue program: getProgramAccounts (filtered by
 * Anchor account discriminator) + Codama-generated decoders. No wallet
 * needed — everything here is a read-only RPC call.
 */
import {
  createSolanaRpc,
  getBase64Decoder,
  getBase64Encoder,
  getBase58Encoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type Base64EncodedBytes,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  TOUCHLINE_PROGRAM_ADDRESS,
  MARKET_DISCRIMINATOR,
  OFFER_DISCRIMINATOR,
  POSITION_DISCRIMINATOR,
  SETTLE_DISCRIMINATOR,
  getMarketDecoder,
  getOfferDecoder,
  getPositionDecoder,
  getSettleInstructionDataDecoder,
  identifyTouchlineInstruction,
  TouchlineInstruction,
  type Market,
  type Offer,
  type Position,
} from "@touchline/venue-client";

export interface WithAddress {
  address: Address;
}
export type ChainMarket = Market & WithAddress;
export type ChainOffer = Offer & WithAddress;
export type ChainPosition = Position & WithAddress;

async function fetchByDiscriminator<T>(
  rpc: Rpc<SolanaRpcApi>,
  discriminator: ReadonlyUint8Array,
  decode: (bytes: ReadonlyUint8Array) => T,
): Promise<Array<T & WithAddress>> {
  const bytes = getBase64Decoder().decode(discriminator) as Base64EncodedBytes;
  const accounts = await rpc
    .getProgramAccounts(TOUCHLINE_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [{ memcmp: { offset: 0n, bytes, encoding: "base64" } }],
    })
    .send();
  return accounts.map((acct) => {
    const raw = getBase64Encoder().encode(acct.account.data[0]);
    return { ...decode(raw), address: acct.pubkey };
  });
}

export interface ArenaAccounts {
  markets: ChainMarket[];
  offers: ChainOffer[];
  positions: ChainPosition[];
}

export async function fetchArenaAccounts(rpc: Rpc<SolanaRpcApi>): Promise<ArenaAccounts> {
  const [markets, offers, positions] = await Promise.all([
    fetchByDiscriminator<Market>(rpc, MARKET_DISCRIMINATOR, (b) => getMarketDecoder().decode(b)),
    fetchByDiscriminator<Offer>(rpc, OFFER_DISCRIMINATOR, (b) => getOfferDecoder().decode(b)),
    fetchByDiscriminator<Position>(rpc, POSITION_DISCRIMINATOR, (b) => getPositionDecoder().decode(b)),
  ]);
  return { markets, offers, positions };
}

export function makeRpc(rpcUrl: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(rpcUrl);
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once.
 * The dashboard fans out one or two RPC calls per offer/position to sort the
 * fill tape and to recover settlement outcomes (see below) — for a busy arena
 * that's easily 20-40 small calls per refresh, which trips free-tier RPC rate
 * limits (429) if fired all at once.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Retries once on an HTTP 429 (rate limit) after a short delay. */
async function withRetry429<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("429")) throw err;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fn();
  }
}

/** Most recent slot touching this account — used to sort the fill tape "newest first". */
export async function latestSlot(rpc: Rpc<SolanaRpcApi>, addr: Address): Promise<number> {
  try {
    const sigs = await withRetry429(() => rpc.getSignaturesForAddress(addr, { limit: 1 }).send());
    const first = sigs[0];
    return first ? Number(first.slot) : 0;
  } catch {
    return 0;
  }
}

/**
 * A settled Position doesn't store which side won — the venue program only
 * flips `settled: true` and pays the winner. The actual stat value is an
 * argument of the Settle instruction, so we recover it by finding the settle
 * transaction for this position and decoding its instruction data. Falls
 * back to `undefined` (caller renders a generic "SETTLED" label + a link to
 * the position account itself) if the tx can't be found/decoded — e.g. an
 * RPC that has already pruned old transaction history.
 */
export async function findSettleOutcome(
  rpc: Rpc<SolanaRpcApi>,
  positionAddr: Address,
): Promise<{ statValue: number; signature: string } | undefined> {
  try {
    const sigs = await withRetry429(() => rpc.getSignaturesForAddress(positionAddr, { limit: 5 }).send());
    for (const sigInfo of sigs) {
      const tx = await withRetry429(() =>
        rpc.getTransaction(sigInfo.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }).send(),
      );
      if (!tx) continue;
      const { accountKeys, instructions } = tx.transaction.message;
      for (const ix of instructions) {
        if (accountKeys[ix.programIdIndex] !== TOUCHLINE_PROGRAM_ADDRESS) continue;
        const raw = getBase58Encoder().encode(ix.data);
        let kind: TouchlineInstruction;
        try {
          kind = identifyTouchlineInstruction(raw);
        } catch {
          continue;
        }
        if (kind !== TouchlineInstruction.Settle) continue;
        const decoded = getSettleInstructionDataDecoder().decode(raw);
        void SETTLE_DISCRIMINATOR; // discriminator check already happened inside identifyTouchlineInstruction
        return { statValue: decoded.stat1.statToProve.value, signature: String(sigInfo.signature) };
      }
    }
  } catch {
    // ignore — caller falls back to a generic settled label
  }
  return undefined;
}
