/**
 * Full-flow integration: guest -> on-chain subscribe -> activate -> snapshots.
 * Requires a funded wallet:
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/session_snapshot.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { resolveConfig, SERVICE_LEVEL } from "../src/config.js";
import { getTxoracleProgram } from "../src/onchain/program.js";
import { TxlineSession } from "../src/auth/session.js";
import { TxlineRestClient } from "../src/rest/client.js";

async function main() {
  const network = (process.env.TXLINE_NETWORK as "devnet" | "mainnet") ?? "devnet";
  const config = resolveConfig(network);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = getTxoracleProgram(config, provider);
  const payer = (provider.wallet as anchor.Wallet).payer;

  console.log(`[session] network=${network} wallet=${payer.publicKey.toBase58()}`);
  const session = await TxlineSession.create({
    config,
    program,
    payer,
    serviceLevel: SERVICE_LEVEL.DELAYED_60S,
    durationWeeks: 4,
  });
  console.log("[session] activated. apiToken acquired.");

  const client = new TxlineRestClient(session);
  const fixtures = await client.fixturesSnapshot();
  console.log(`[session] fixtures: ${fixtures.length}`);
  console.log(JSON.stringify(fixtures.slice(0, 3), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
