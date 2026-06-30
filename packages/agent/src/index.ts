#!/usr/bin/env node
/**
 * Touchline agent CLI.
 *
 * Usage:
 *   tsx src/index.ts --strategy mm|taker [--dry-run] [--ticks N] [--tick-ms M]
 *
 * Environment variables:
 *   RPC_URL       Solana RPC endpoint (default: https://api.devnet.solana.com)
 *   WALLET_PATH   Path to Solana keypair JSON (default: ~/.config/solana/id.json)
 *   NETWORK       devnet | mainnet (default: devnet)
 */
import { readFileSync } from "node:fs";
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from "@solana/kit";
import { buildConfig } from "./config.js";
import { makeMarketMaker } from "./strategy/mm.js";
import { makeTaker } from "./strategy/taker.js";
import { runAgent } from "./arena.js";
import type { MatchState, MarketLine } from "./types.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  strategy: "mm" | "taker";
  dryRun: boolean;
  ticks: number | undefined;
  tickMs: number | undefined;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let strategy: "mm" | "taker" = "mm";
  let dryRun = false;
  let ticks: number | undefined;
  let tickMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--strategy") {
      const val = argv[i + 1];
      if (val === "taker") strategy = "taker";
      else strategy = "mm";
      i++;
    } else if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--ticks") {
      const val = argv[i + 1];
      if (val !== undefined) { ticks = parseInt(val, 10); i++; }
    } else if (flag === "--tick-ms") {
      const val = argv[i + 1];
      if (val !== undefined) { tickMs = parseInt(val, 10); i++; }
    }
  }

  return { strategy, dryRun, ticks, tickMs };
}

// ---------------------------------------------------------------------------
// Synthetic state source — used when no live TxLINE session is available
// ---------------------------------------------------------------------------

const SYNTHETIC_FIXTURE_ID = 99999;

async function* makeSyntheticSource(): AsyncIterable<{ state?: MatchState; line?: MarketLine }> {
  const now = Date.now();
  // Active first-half state so the MM strategy enters the quoting branch.
  yield {
    state: {
      fixtureId: SYNTHETIC_FIXTURE_ID,
      phase: "H1",
      minute: 30,
      p1Goals: 0,
      p2Goals: 0,
      updatedMs: now,
    },
  };
  // One market line: P1 Goals (statKey=1) at 32% implied YES.
  yield {
    line: {
      fixtureId: SYNTHETIC_FIXTURE_ID,
      statKey: 1,
      impliedYesBps: 3200,
      updatedMs: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { strategy: strategyName, dryRun, ticks, tickMs: tickMsArg } = parseArgs();
  // Dry-run default is 100 ms (fast demo); live default is 5 000 ms.
  const tickMs = tickMsArg ?? (dryRun ? 100 : 5_000);

  const cfg = buildConfig();

  console.log(
    `[arena] strategy=${strategyName} dryRun=${String(dryRun)}` +
      ` ticks=${ticks ?? "∞"} tickMs=${tickMs}ms`,
  );
  console.log(`[arena] rpc=${cfg.rpcUrl}`);

  // Load wallet — required for live, optional for dry-run.
  let signer;
  try {
    const raw = readFileSync(cfg.walletPath, "utf8");
    const bytes = new Uint8Array(JSON.parse(raw) as number[]);
    signer = await createKeyPairSignerFromBytes(bytes);
    console.log(`[arena] wallet=${String(signer.address)}`);
  } catch {
    if (dryRun) {
      signer = await generateKeyPairSigner();
      console.log(
        `[arena] [dry-run] no wallet found at ${cfg.walletPath}` +
          ` — using ephemeral key ${String(signer.address)}`,
      );
    } else {
      console.error(
        `[arena] ERROR: wallet required for live mode.` +
          ` Set WALLET_PATH or create ${cfg.walletPath}`,
      );
      process.exit(1);
    }
  }

  const wssUrl = cfg.rpcUrl.replace(/^http/, "ws");
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wssUrl);

  const strategy =
    strategyName === "taker" ? makeTaker(cfg.strategy) : makeMarketMaker(cfg.strategy);

  let stateSource: AsyncIterable<{ state?: MatchState; line?: MarketLine }> | undefined;
  if (dryRun) {
    console.log(
      `[arena] [dry-run] no live TxLINE session —` +
        ` seeding synthetic MatchState fixture=${SYNTHETIC_FIXTURE_ID} phase=H1 min=30`,
    );
    stateSource = makeSyntheticSource();
  }

  await runAgent({
    strategy,
    cfg,
    signer,
    rpc,
    rpcSubscriptions,
    opts: { dryRun, maxTicks: ticks, tickMs, stateSource },
  });

  // Exit explicitly so any open handles (RPC WebSocket) don't keep the process alive.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[arena] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
