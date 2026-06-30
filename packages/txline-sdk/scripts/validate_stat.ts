/**
 * Full-flow trustless verification: fetch a 3-stage Merkle proof for a score
 * stat and validate it on-chain against the published root.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/validate_stat.ts <fixtureId> <seq> <statKey> [statKey2]
 */
import * as anchor from "@coral-xyz/anchor";
import { resolveConfig } from "../src/config.js";
import { getTxoracleProgram } from "../src/onchain/program.js";
import { TxlineSession } from "../src/auth/session.js";
import { TxlineRestClient } from "../src/rest/client.js";
import { fetchStatValidation } from "../src/verify/proofs.js";
import { buildValidateStatInputs } from "../src/verify/args.js";
import { runValidateStatView } from "../src/verify/validate.js";
import { lt, BinaryExpressions } from "../src/verify/predicate.js";

async function main() {
  const network = (process.env.TXLINE_NETWORK as "devnet" | "mainnet") ?? "devnet";
  const config = resolveConfig(network);

  const [fixtureId, seq, statKey, statKey2] = process.argv.slice(2).map(Number);
  if (!fixtureId || !seq || !statKey) {
    throw new Error("usage: validate_stat <fixtureId> <seq> <statKey> [statKey2]");
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = getTxoracleProgram(config, provider);
  const payer = (provider.wallet as anchor.Wallet).payer;

  const session = await TxlineSession.create({ config, program, payer });
  const client = new TxlineRestClient(session);

  const validation = await fetchStatValidation(client, {
    fixtureId,
    seq,
    statKey,
    statKey2: Number.isNaN(statKey2) ? undefined : statKey2,
  });
  const inputs = buildValidateStatInputs(validation);

  // Example settlement predicate: stat (difference, if two stats) < 5.
  const predicate = lt(5);
  const op = inputs.stat2 ? BinaryExpressions.subtract() : null;

  const ok = await runValidateStatView(program, config, inputs, predicate, op);
  console.log(`[validate_stat] on-chain predicate holds: ${ok}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
