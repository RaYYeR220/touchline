/**
 * Populates devnet with a small, realistic arena so the dashboard has real
 * on-chain state to render: creates markets on real World Cup fixture ids,
 * posts offers as the wallet (AEGIS / maker), fills some as a generated
 * taker keypair (VANE), and settles a couple through the mock oracle.
 *
 * Reuses the raw-instruction / fresh-mint patterns from
 * packages/agent/integration-devnet.ts, extended to a handful of markets
 * instead of just one.
 *
 * Usage:
 *   RPC_URL="https://devnet.helius-rpc.com/?api-key=..." npx tsx scripts/seed-arena.ts
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
  type ReadonlyUint8Array,
} from "@solana/kit";
import { Comparison } from "@touchline/venue-client";
import { Executor, getAtaAddress, deriveMarketPda } from "../packages/agent/src/exec/executor.js";
import { Keeper } from "../packages/agent/src/keeper/settle.js";
import type { OfferView } from "../packages/agent/src/types.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const RPC_URL = process.env["RPC_URL"];
if (!RPC_URL) {
  console.error("RPC_URL env var is required (devnet RPC endpoint).");
  process.exit(1);
}
const WSS_URL = RPC_URL.replace(/^http/, "ws");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MOCK_ORACLE = address("7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S");

// ─── Fixtures (real World Cup ids, from the txline-sdk devnet fixture snapshot) ─
interface MarketPlan {
  label: string;
  fixtureId: number;
  statKey: number;
  threshold: number;
  comparison: Comparison;
  side: "Yes" | "No";
  priceYesBps: number;
  potUsdc: bigint;
  /** Fraction of the offer to fill (0 = leave fully open). */
  fillFraction: number;
  /** Settle after filling? If set, the stat value passed to the mock oracle. */
  settleStatValue?: number;
}

const MARKETS: MarketPlan[] = [
  {
    // NOTE: (18172280, statKey=1, threshold=1, GreaterThan) and (…, threshold=0,
    // GreaterThan) market PDAs already exist on this devnet from earlier runs
    // (smoke-devnet.ts and an earlier seed attempt), each tied to a different
    // mint (has_one = mint on postOffer), so this plan uses a fresh predicate
    // tuple rather than colliding with either leftover account.
    label: "NED–MAR  P1 goals < 3",
    fixtureId: 18172280,
    statKey: 1,
    threshold: 3,
    comparison: Comparison.LessThan,
    side: "Yes",
    priceYesBps: 4200,
    potUsdc: 2_000_000n,
    fillFraction: 0.6,
    settleStatValue: 2, // P1 scored 2, 2 < 3 -> YES wins (maker/AEGIS wins)
  },
  {
    // Same reasoning: (18172469, statKey=1, threshold=1, GreaterThan) already
    // exists from an earlier partial seed attempt — use a fresh tuple.
    label: "BRA–JPN  P1 goals < 2",
    fixtureId: 18172469,
    statKey: 1,
    threshold: 2,
    comparison: Comparison.LessThan,
    side: "Yes",
    priceYesBps: 5600,
    potUsdc: 3_000_000n,
    fillFraction: 0.5,
    settleStatValue: 2, // P1 scored 2, 2 < 2 is false -> NO wins (taker/VANE wins)
  },
  {
    label: "BRA–JPN  P2 goals > 1",
    fixtureId: 18172469,
    statKey: 2,
    threshold: 1,
    comparison: Comparison.GreaterThan,
    side: "No",
    priceYesBps: 4800,
    potUsdc: 2_000_000n,
    fillFraction: 0.5,
    // left unsettled on purpose (open position)
  },
  {
    label: "ARG–CPV  P1 goals > 1",
    fixtureId: 18175918,
    statKey: 1,
    threshold: 1,
    comparison: Comparison.GreaterThan,
    side: "Yes",
    priceYesBps: 3300,
    potUsdc: 2_000_000n,
    fillFraction: 0, // left fully open — quote only, no fill
  },
  {
    label: "FRA–SWE  P1 goals > 0",
    fixtureId: 18175981,
    statKey: 1,
    threshold: 0,
    comparison: Comparison.GreaterThan,
    side: "Yes",
    priceYesBps: 6500,
    potUsdc: 2_500_000n,
    fillFraction: 0, // left fully open — quote only, no fill
  },
];

// ─── Raw instruction helpers (mirrors integration-devnet.ts) ──────────────────
function u64LE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function concat(...parts: (Uint8Array | ReadonlyUint8Array)[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
function link(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

type AcctMeta = { address: Address; role: AccountRole; signer?: TransactionSigner };
function rawIx(programAddress: Address, accounts: AcctMeta[], data: Uint8Array) {
  return { programAddress, accounts, data };
}

function solTransferIx(from: TransactionSigner, to: Address, lamports: bigint) {
  return rawIx(
    SYSTEM_PROGRAM,
    [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: to, role: AccountRole.WRITABLE },
    ],
    concat(new Uint8Array([2, 0, 0, 0]), u64LE(lamports)),
  );
}

function createAccountIx(from: TransactionSigner, newAcct: TransactionSigner, lamports: bigint, space: number, owner: Address) {
  return rawIx(
    SYSTEM_PROGRAM,
    [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: newAcct.address, role: AccountRole.WRITABLE_SIGNER, signer: newAcct },
    ],
    concat(new Uint8Array([0, 0, 0, 0]), u64LE(lamports), u64LE(BigInt(space)), getAddressEncoder().encode(owner)),
  );
}

function initializeMint2Ix(mint: Address, decimals: number, mintAuthority: Address) {
  const data = new Uint8Array(35);
  data[0] = 20;
  data[1] = decimals;
  data.set(getAddressEncoder().encode(mintAuthority), 2);
  data[34] = 0;
  return rawIx(TOKEN_PROGRAM, [{ address: mint, role: AccountRole.WRITABLE }], data);
}

function createAtaIx(payer: TransactionSigner, ata: Address, owner: Address, mint: Address) {
  return rawIx(
    ATA_PROGRAM,
    [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    new Uint8Array([1]),
  );
}

function mintToIx(mint: Address, dest: Address, authority: TransactionSigner, amount: bigint) {
  return rawIx(
    TOKEN_PROGRAM,
    [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
    ],
    concat(new Uint8Array([7]), u64LE(amount)),
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rpc = createSolanaRpc(RPC_URL as string);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WSS_URL);
  const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function sendIxs(feePayer: TransactionSigner, ixs: any[]): Promise<string> {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let txMsg: any = pipe(
      createTransactionMessage({ version: 0 }),
      (m: any) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m: any) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    );
    for (const ix of ixs) txMsg = appendTransactionMessageInstruction(ix, txMsg);
    const signed = await signTransactionMessageWithSigners(txMsg);
    const sig = getSignatureFromTransaction(signed);
    await send(signed as any, { commitment: "confirmed" });
    return String(sig);
  }

  // ── 1. Load wallet (AEGIS / maker) ──────────────────────────────────────────
  const secretBytes = new Uint8Array(JSON.parse(readFileSync(join(homedir(), ".config", "solana", "id.json"), "utf8")));
  const wallet = await createKeyPairSignerFromBytes(secretBytes);
  console.log("Wallet (AEGIS / maker):", wallet.address);

  // ── 2. Generate one taker keypair for the whole run (VANE) ──────────────────
  const taker = await generateKeyPairSigner();
  console.log("Taker (VANE):          ", taker.address);

  // ── 3. Fresh test mint (6-decimal USDC stand-in) ─────────────────────────────
  const mintKp = await generateKeyPairSigner();
  const mintAddr = mintKp.address;
  console.log("\nTest mint:", mintAddr);

  const mintRent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const createMintSig = await sendIxs(wallet, [
    createAccountIx(wallet, mintKp, mintRent, 82, TOKEN_PROGRAM),
    initializeMint2Ix(mintAddr, 6, wallet.address),
  ]);
  console.log("createMint tx:", createMintSig, "->", link(createMintSig));

  // ── 4. ATAs for maker + taker ────────────────────────────────────────────────
  const makerAta = await getAtaAddress(mintAddr, wallet.address);
  const takerAta = await getAtaAddress(mintAddr, taker.address);
  const createAtasSig = await sendIxs(wallet, [
    createAtaIx(wallet, makerAta, wallet.address, mintAddr),
    createAtaIx(wallet, takerAta, taker.address, mintAddr),
  ]);
  console.log("createATAs tx:", createAtasSig, "->", link(createAtasSig));

  // ── 5. Fund both ATAs + give the taker some SOL for fees ────────────────────
  const totalPot = MARKETS.reduce((s, m) => s + m.potUsdc, 0n);
  const mintTokensSig = await sendIxs(wallet, [
    mintToIx(mintAddr, makerAta, wallet, totalPot * 2n),
    mintToIx(mintAddr, takerAta, wallet, totalPot * 2n),
  ]);
  console.log("mintTokens tx:", mintTokensSig, "->", link(mintTokensSig));

  const fundTakerSig = await sendIxs(wallet, [solTransferIx(wallet, taker.address, 100_000_000n)]);
  console.log("fundTaker  tx:", fundTakerSig, "->", link(fundTakerSig));

  // ── 6. Agent config pointing at the fresh mint ──────────────────────────────
  const cfg = {
    network: "devnet" as const,
    rpcUrl: RPC_URL as string,
    venueProgram: address("21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ"),
    oracleProgram: MOCK_ORACLE,
    usdcMint: mintAddr,
    walletPath: join(homedir(), ".config", "solana", "id.json"),
    risk: {} as any,
    strategy: {} as any,
  };

  const makerExec = new Executor(rpc, rpcSubscriptions, wallet, cfg);
  const takerExec = new Executor(rpc, rpcSubscriptions, taker, cfg);
  const keeper = new Keeper(rpc, rpcSubscriptions, wallet, cfg);

  console.log("\n=== Seeding markets ===");
  const created: { label: string; market: Address; positionSig?: string; settleSig?: string }[] = [];

  for (const plan of MARKETS) {
    const marketAddr = await deriveMarketPda(plan.fixtureId, plan.statKey, plan.threshold, plan.comparison);

    const { sig: createSig } = await makerExec.execute({
      kind: "createMarket",
      fixtureId: plan.fixtureId,
      statKey: plan.statKey,
      predicate: {
        threshold: plan.threshold,
        comparison:
          plan.comparison === Comparison.GreaterThan ? "GreaterThan" : plan.comparison === Comparison.LessThan ? "LessThan" : "EqualTo",
      },
    });
    console.log(`\n[${plan.label}]`);
    console.log("  createMarket tx:", createSig, "->", link(createSig));
    console.log("  market PDA:     ", marketAddr);

    const { sig: offerSig, offer: offerAddr } = await makerExec.execute({
      kind: "postOffer",
      market: marketAddr,
      side: plan.side,
      priceYesBps: plan.priceYesBps,
      pot: plan.potUsdc,
    });
    console.log("  postOffer tx:   ", offerSig, "->", link(offerSig));
    if (!offerAddr) throw new Error("postOffer did not return an offer address");

    const record: { label: string; market: Address; positionSig?: string; settleSig?: string } = { label: plan.label, market: marketAddr };

    if (plan.fillFraction > 0) {
      const fillPot = BigInt(Math.round(Number(plan.potUsdc) * plan.fillFraction));
      const offerView: OfferView = {
        address: offerAddr,
        market: marketAddr,
        maker: wallet.address,
        makerSide: plan.side,
        priceYesBps: plan.priceYesBps,
        remainingPot: plan.potUsdc,
      };
      const { sig: fillSig, position: positionAddr } = await takerExec.execute({ kind: "fillOffer", offer: offerView, fillPot });
      console.log("  fillOffer tx:   ", fillSig, "->", link(fillSig));
      record.positionSig = fillSig;
      if (!positionAddr) throw new Error("fillOffer did not return a position address");

      if (plan.settleStatValue !== undefined) {
        const posView = await keeper.fetchPositionView(positionAddr);
        const mktView = await keeper.fetchMarketView(marketAddr);
        const settleSig = await keeper.settle(posView, mktView, plan.settleStatValue);
        console.log(`  settle tx (stat=${plan.settleStatValue}):`, settleSig, "->", link(settleSig));
        record.settleSig = settleSig;
      }
    } else {
      console.log("  (left open — no fill)");
    }

    created.push(record);
  }

  console.log("\n=== Summary ===");
  for (const c of created) {
    console.log(`- ${c.label}: market=${c.market}${c.positionSig ? " filled" : " open"}${c.settleSig ? " settled" : ""}`);
  }
  console.log(`\nMint: ${mintAddr}`);
  console.log(`Maker (AEGIS): ${wallet.address}`);
  console.log(`Taker (VANE):  ${taker.address}`);
  console.log("\nDONE — devnet arena seeded.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
