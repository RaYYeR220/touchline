/**
 * Dev-only: create/load ./wallet.json and airdrop devnet SOL so the funded
 * integration scripts can run. NOT part of the SDK surface.
 *
 *   npx tsx scripts/devnet_bootstrap.ts
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const WALLET_PATH = new URL("../wallet.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function main() {
  let kp: Keypair;
  if (existsSync(WALLET_PATH)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8"))));
    console.log(`[bootstrap] loaded ${WALLET_PATH}`);
  } else {
    kp = Keypair.generate();
    writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`[bootstrap] created ${WALLET_PATH}`);
  }
  console.log(`[bootstrap] pubkey ${kp.publicKey.toBase58()}`);

  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  let bal = await conn.getBalance(kp.publicKey);
  console.log(`[bootstrap] balance ${bal / LAMPORTS_PER_SOL} SOL`);

  if (bal < 1 * LAMPORTS_PER_SOL) {
    console.log("[bootstrap] requesting airdrop of 2 SOL...");
    const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    bal = await conn.getBalance(kp.publicKey);
    console.log(`[bootstrap] balance after airdrop ${bal / LAMPORTS_PER_SOL} SOL`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
