/**
 * Kit-send GO/NO-GO smoke: create a market on the deployed devnet venue using
 * the Codama-generated @solana/kit client. Proves the full encode→sign→send path.
 *
 *   RPC_URL="https://devnet.helius-rpc.com/?api-key=..." npx tsx packages/venue-client/smoke-devnet.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  getProgramDerivedAddress,
  getAddressEncoder,
  getBytesEncoder,
  getU64Encoder,
  getU32Encoder,
  getI32Encoder,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  pipe,
  address,
} from "@solana/kit";
import {
  TOUCHLINE_PROGRAM_ADDRESS,
  getCreateMarketInstructionAsync,
  findVaultPda,
  fetchMarket,
  Comparison,
} from "./src/index.js";

const RPC_URL = process.env.RPC_URL!;
const WSS_URL = RPC_URL.replace(/^http/, "ws");
const USDC_DEVNET = address("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh");
const MOCK_ORACLE = address("7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S");

async function main() {
  const secret = new Uint8Array(
    JSON.parse(readFileSync(join(homedir(), ".config", "solana", "id.json"), "utf8")),
  );
  const signer = await createKeyPairSignerFromBytes(secret);
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WSS_URL);

  const fixtureId = 18172280n; // Netherlands–Morocco (devnet WC fixture)
  const statKey = 1; // P1 total goals
  const threshold = 1; // "> 1 goal"
  const comparison = Comparison.GreaterThan;

  const [market] = await getProgramDerivedAddress({
    programAddress: TOUCHLINE_PROGRAM_ADDRESS,
    seeds: [
      getBytesEncoder().encode(new Uint8Array([109, 97, 114, 107, 101, 116])), // "market"
      getU64Encoder().encode(fixtureId),
      getU32Encoder().encode(statKey),
      getI32Encoder().encode(threshold),
      new Uint8Array([comparison]),
    ],
  });
  const [vault] = await findVaultPda({ market });
  console.log("market PDA:", market);
  console.log("vault  PDA:", vault);

  const ix = await getCreateMarketInstructionAsync({
    authority: signer,
    mint: USDC_DEVNET,
    market,
    vault,
    fixtureId,
    statKey,
    predicate: { threshold, comparison },
    oracleProgram: MOCK_ORACLE,
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
  await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(signed, {
    commitment: "confirmed",
  });
  console.log("\nCreated market. tx:", sig);
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const m = await fetchMarket(rpc, market);
  console.log("\nMarket on-chain:", {
    fixtureId: m.data.fixtureId.toString(),
    statKey: m.data.statKey,
    status: m.data.status,
    oracleProgram: m.data.oracleProgram,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
