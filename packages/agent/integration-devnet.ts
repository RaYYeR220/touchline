/**
 * End-to-end devnet integration: createMarket → postOffer → fillOffer → settle.
 *
 * Creates a fresh test mint so we control the supply, then runs the full
 * autonomous action+settlement loop against the deployed venue and mock oracle.
 *
 * Usage:
 *   RPC_URL="https://devnet.helius-rpc.com/?api-key=..." npx tsx packages/agent/integration-devnet.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  getAddressEncoder,
  pipe,
  address,
  AccountRole,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { Comparison, findOfferPda, findPositionPda } from "@touchline/venue-client";
import { Executor, getAtaAddress, deriveMarketPda } from "./src/exec/executor.js";
import { Keeper } from "./src/keeper/settle.js";
import type { OfferView } from "./src/types.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const RPC_URL = process.env["RPC_URL"]!;
const WSS_URL = RPC_URL.replace(/^http/, "ws");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MOCK_ORACLE = address("7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S");
const VENUE_PROGRAM = address("21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ");

// ─── Test parameters ──────────────────────────────────────────────────────────
const FIXTURE_ID = Number(process.env["FIXTURE_ID"] ?? 990013); // unique per run (override via env)
const STAT_KEY   = 1;               // P1 total goals
const THRESHOLD  = 1;               // > 1 goal = YES
const COMPARISON = Comparison.GreaterThan;
const PRICE_YES_BPS = 5000;        // 50/50
const MAKER_POT    = 1_000_000n;   // 1 test-USDC (6 dec)
const TAKER_FILL   = 1_000_000n;   // 1 test-USDC
const STAT_VALUE   = 3;            // P1 scored 3 goals → YES wins → maker wins

// ─── Helpers ──────────────────────────────────────────────────────────────────
function u32LE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}
function u64LE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
}
function link(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// Raw instruction builder (compatible with signTransactionMessageWithSigners)
type AcctMeta = { address: Address; role: AccountRole; signer?: TransactionSigner };
function rawIx(programAddress: Address, accounts: AcctMeta[], data: Uint8Array) {
  return { programAddress, accounts, data };
}

// SystemProgram.transfer: send lamports from signer to destination
function solTransferIx(from: TransactionSigner, to: Address, lamports: bigint) {
  return rawIx(
    SYSTEM_PROGRAM,
    [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: to, role: AccountRole.WRITABLE },
    ],
    concat(u32LE(2), u64LE(lamports)), // instruction 2 = Transfer
  );
}

// SystemProgram.createAccount: allocate a new account
function createAccountIx(
  from: TransactionSigner,
  newAcct: TransactionSigner,
  lamports: bigint,
  space: number,
  owner: Address,
) {
  return rawIx(
    SYSTEM_PROGRAM,
    [
      { address: from.address,    role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: newAcct.address, role: AccountRole.WRITABLE_SIGNER, signer: newAcct },
    ],
    concat(u32LE(0), u64LE(lamports), u64LE(BigInt(space)), getAddressEncoder().encode(owner)),
  );
}

// Token Program InitializeMint2 (instruction 20): no rent sysvar needed
function initializeMint2Ix(mint: Address, decimals: number, mintAuthority: Address) {
  const data = new Uint8Array(35);
  data[0] = 20; // InitializeMint2
  data[1] = decimals;
  data.set(getAddressEncoder().encode(mintAuthority), 2);
  data[34] = 0; // COption::None freeze authority
  return rawIx(TOKEN_PROGRAM, [{ address: mint, role: AccountRole.WRITABLE }], data);
}

// ATA Program createAssociatedTokenAccountIdempotent (instruction 1)
function createAtaIx(payer: TransactionSigner, ata: Address, owner: Address, mint: Address) {
  return rawIx(
    ATA_PROGRAM,
    [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: ata,           role: AccountRole.WRITABLE },
      { address: owner,         role: AccountRole.READONLY },
      { address: mint,          role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM,  role: AccountRole.READONLY },
    ],
    new Uint8Array([1]), // idempotent variant
  );
}

// Token Program MintTo (instruction 7)
function mintToIx(mint: Address, dest: Address, authority: TransactionSigner, amount: bigint) {
  return rawIx(
    TOKEN_PROGRAM,
    [
      { address: mint,              role: AccountRole.WRITABLE },
      { address: dest,              role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
    ],
    concat(new Uint8Array([7]), u64LE(amount)),
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WSS_URL);
  const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  // Helper: sign+send a pre-built tx message
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function commit(txMsg: any): Promise<string> {
    const signed = await signTransactionMessageWithSigners(txMsg);
    const sig = getSignatureFromTransaction(signed);
    await send(signed as any, { commitment: "confirmed" });
    return String(sig);
  }

  // Helper: build and send a transaction with one or more instructions
  async function sendIxs(
    feePayer: TransactionSigner,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ixs: any[],
  ): Promise<string> {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let txMsg: any = pipe(
      createTransactionMessage({ version: 0 }),
      (m: any) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m: any) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    );
    for (const ix of ixs) {
      txMsg = appendTransactionMessageInstruction(ix, txMsg);
    }
    return commit(txMsg);
  }

  // ── 1. Load wallet (maker) ──────────────────────────────────────────────────
  const secretBytes = new Uint8Array(
    JSON.parse(readFileSync(join(homedir(), ".config", "solana", "id.json"), "utf8")),
  );
  const wallet = await createKeyPairSignerFromBytes(secretBytes);
  console.log("Wallet (maker):", wallet.address);

  // ── 2. Generate taker keypair ───────────────────────────────────────────────
  const taker = await generateKeyPairSigner();
  console.log("Taker:         ", taker.address);

  // ── 3. Create fresh test mint (wallet = mint authority) ─────────────────────
  const mintKp = await generateKeyPairSigner();
  const mintAddr = mintKp.address;
  console.log("\nTest mint:     ", mintAddr);

  const mintRent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const createMintSig = await sendIxs(wallet, [
    createAccountIx(wallet, mintKp, mintRent, 82, TOKEN_PROGRAM),
    initializeMint2Ix(mintAddr, 6, wallet.address),
  ]);
  console.log("createMint  tx:", createMintSig);
  console.log("            →", link(createMintSig));

  // ── 4. Create ATAs for maker and taker ──────────────────────────────────────
  const makerAta = await getAtaAddress(mintAddr, wallet.address);
  const takerAta = await getAtaAddress(mintAddr, taker.address);

  const createAtasSig = await sendIxs(wallet, [
    createAtaIx(wallet, makerAta, wallet.address, mintAddr),
    createAtaIx(wallet, takerAta, taker.address, mintAddr),
  ]);
  console.log("createATAs  tx:", createAtasSig);
  console.log("            →", link(createAtasSig));

  // ── 5. Mint tokens to both ATAs ──────────────────────────────────────────────
  const mintTokensSig = await sendIxs(wallet, [
    mintToIx(mintAddr, makerAta, wallet, 10_000_000n),
    mintToIx(mintAddr, takerAta, wallet, 10_000_000n),
  ]);
  console.log("mintTokens  tx:", mintTokensSig);
  console.log("            →", link(mintTokensSig));

  // ── 6. Fund taker with SOL for tx fees ──────────────────────────────────────
  const fundTakerSig = await sendIxs(wallet, [
    solTransferIx(wallet, taker.address, 50_000_000n), // 0.05 SOL
  ]);
  console.log("fundTaker   tx:", fundTakerSig);
  console.log("            →", link(fundTakerSig));

  // ── 7. Build per-test AgentConfig pointing at our fresh mint ────────────────
  const cfg = {
    network: "devnet" as const,
    rpcUrl: RPC_URL,
    venueProgram: VENUE_PROGRAM,
    oracleProgram: MOCK_ORACLE,
    usdcMint: mintAddr,
    walletPath: join(homedir(), ".config", "solana", "id.json"),
    risk: {} as any,
    strategy: {} as any,
  };

  // ── 8. CreateMarket ──────────────────────────────────────────────────────────
  const makerExec = new Executor(rpc, rpcSubscriptions, wallet, cfg);
  const marketAddr = await deriveMarketPda(FIXTURE_ID, STAT_KEY, THRESHOLD, COMPARISON);

  const { sig: createMarketSig } = await makerExec.execute({
    kind: "createMarket",
    fixtureId: FIXTURE_ID,
    statKey: STAT_KEY,
    predicate: { threshold: THRESHOLD, comparison: "GreaterThan" },
  });
  console.log("\n=== Venue Transactions ===");
  console.log("createMarket tx:", createMarketSig);
  console.log("             →", link(createMarketSig));
  console.log("Market PDA:    ", marketAddr);

  // ── 9. PostOffer ─────────────────────────────────────────────────────────────
  const { sig: postOfferSig } = await makerExec.execute({
    kind: "postOffer",
    market: marketAddr,
    side: "Yes",
    priceYesBps: PRICE_YES_BPS,
    pot: MAKER_POT,
  });
  console.log("postOffer    tx:", postOfferSig);
  console.log("             →", link(postOfferSig));

  // ── 10. FillOffer ────────────────────────────────────────────────────────────
  const [offerAddr] = await findOfferPda({ market: marketAddr, maker: wallet.address, offerId: 0n });
  const offerView: OfferView = {
    address: offerAddr,
    market: marketAddr,
    maker: wallet.address,
    makerSide: "Yes",
    priceYesBps: PRICE_YES_BPS,
    remainingPot: MAKER_POT,
  };

  const takerExec = new Executor(rpc, rpcSubscriptions, taker, cfg);
  const { sig: fillOfferSig } = await takerExec.execute({
    kind: "fillOffer",
    offer: offerView,
    fillPot: TAKER_FILL,
  });
  console.log("fillOffer    tx:", fillOfferSig);
  console.log("             →", link(fillOfferSig));

  // ── 11. Derive position PDA ──────────────────────────────────────────────────
  const [positionAddr] = await findPositionPda({ offer: offerAddr, positionId: 0n });
  console.log("Position PDA:  ", positionAddr);

  // ── 12. Settle ───────────────────────────────────────────────────────────────
  const keeper = new Keeper(rpc, rpcSubscriptions, wallet, cfg);
  const posView = await keeper.fetchPositionView(positionAddr);
  const mktView = await keeper.fetchMarketView(marketAddr);

  console.log(`\nSettling with statValue=${STAT_VALUE} (P1 goals = ${STAT_VALUE} > threshold ${THRESHOLD} → YES wins → maker wins)`);

  const settleSig = await keeper.settle(posView, mktView, STAT_VALUE);
  console.log("settle       tx:", settleSig);
  console.log("             →", link(settleSig));

  // ── 13. Check winner payout ──────────────────────────────────────────────────
  // Binary winner-take-all: with pot = TAKER_FILL and YES price = 5000 bps, each
  // side locks pot * 50% = 500_000. On a YES win the maker receives the FULL pot
  // (TAKER_FILL), so maker net = +taker_stake and taker net = −taker_stake.
  const START = 10_000_000; // minted to each ATA
  const yesStake = (TAKER_FILL * BigInt(PRICE_YES_BPS)) / 10_000n;
  const takerStake = TAKER_FILL - yesStake;
  const makerBalance = await rpc.getTokenAccountBalance(makerAta).send();
  const takerBalance = await rpc.getTokenAccountBalance(takerAta).send();

  console.log("\n=== Winner Payout (binary winner-take-all) ===");
  console.log(`Pot (position): ${TAKER_FILL}  | maker locked ${yesStake} | taker locked ${takerStake}`);
  console.log(`Maker (YES, winner): ${makerBalance.value.amount}  (net ${Number(makerBalance.value.amount) - START >= 0 ? "+" : ""}${Number(makerBalance.value.amount) - START})`);
  console.log(`Taker (NO,  loser):  ${takerBalance.value.amount}  (net ${Number(takerBalance.value.amount) - START})`);
  console.log(`Winner received the full pot (${TAKER_FILL}); maker net +${Number(takerStake)} = the taker's forfeited stake.`);
  console.log("\nDONE — full create→post→fill→settle loop confirmed on devnet.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
