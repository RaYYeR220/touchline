/**
 * Touchline signal client — demonstrates an autonomous agent paying for a signal.
 *
 * Loads a Solana keypair from ~/.config/solana/id.json (or WALLET_PATH),
 * then calls GET /signal on the running server. The x402 fetch wrapper
 * intercepts the 402, builds a partially-signed SPL TransferChecked tx,
 * and lets the public facilitator (x402.org) co-sign as feePayer and
 * broadcast — so the payer only needs devnet USDC, no SOL required.
 *
 * Devnet USDC faucet: https://faucet.circle.com
 *
 * Usage:
 *   SERVER_URL=http://localhost:4021 tsx src/client.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { toClientSvmSigner } from "@x402/svm";

const SERVER_URL = process.env["SERVER_URL"] ?? "http://localhost:4021";
const WALLET_PATH =
  process.env["WALLET_PATH"] ?? join(homedir(), ".config", "solana", "id.json");

async function main(): Promise<void> {
  // Load keypair
  let walletBytes: Uint8Array;
  try {
    const raw = readFileSync(WALLET_PATH, "utf8");
    walletBytes = new Uint8Array(JSON.parse(raw) as number[]);
  } catch (err) {
    throw new Error(
      `Cannot read wallet at ${WALLET_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const signer = await createKeyPairSignerFromBytes(walletBytes);
  console.log(`[client] wallet = ${String(signer.address)}`);

  // Build x402 client with the SVM exact scheme on devnet
  const rpcUrl = process.env["RPC_URL"];
  const svmSigner = toClientSvmSigner(signer);
  const scheme = new ExactSvmScheme(
    svmSigner,
    rpcUrl !== undefined ? { rpcUrl } : undefined,
  );

  const client = new x402Client().register(SOLANA_DEVNET_CAIP2, scheme);
  const payFetch = wrapFetchWithPayment(fetch, client);

  // Build the signal request — mid-game example: 45 minutes, score 0-0
  const params = new URLSearchParams({
    fixtureId: "42",
    statKey: "1",        // P1 goals
    threshold: "1.5",
    comparison: "GreaterThan",
    p1Goals: "0",
    p2Goals: "0",
    minute: "45",
    lineYesBps: "4200",  // market implies 42% YES
  });

  const url = `${SERVER_URL}/signal?${params.toString()}`;
  console.log(`[client] requesting ${url}`);
  console.log("[client] sending payment via x402 / devnet USDC …");

  const res = await payFetch(url);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[client] request failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const signal = (await res.json()) as {
    probabilityYes: number;
    recommendation: string;
    edgeBps: number;
    market: { fixtureId: number; statKey: number; predicate: unknown };
  };

  console.log("\n[client] signal received:");
  console.log(`  probabilityYes : ${(signal.probabilityYes * 100).toFixed(2)}%`);
  console.log(`  recommendation : ${signal.recommendation}`);
  console.log(`  edgeBps        : ${signal.edgeBps}`);
  console.log(`  market         : ${JSON.stringify(signal.market)}`);
}

main().catch((err: unknown) => {
  console.error("[client] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
