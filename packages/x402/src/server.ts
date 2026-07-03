/**
 * Touchline signal server — x402 pay-per-request.
 *
 * GET /health        — free liveness check
 * GET /signal?...    — fair-value signal; requires a $0.01 USDC payment on Solana devnet
 *
 * Environment:
 *   SERVER_WALLET    Solana address that receives payments (required)
 *   FACILITATOR_URL  x402 facilitator base URL (default: https://x402.org/facilitator)
 *   PORT             TCP port (default: 4021)
 */
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS } from "@x402/svm";
// Server-side scheme: parses prices, enriches requirements with feePayer
// from the facilitator. No signer needed here — verify+settle are delegated
// to the public HTTP facilitator.
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { fairValue } from "@touchline/agent/api";
import type {
  ModelParams,
  MatchState,
  MarketLine,
  Predicate,
} from "@touchline/agent/api";

// ---------------------------------------------------------------------------
// Model defaults
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS: ModelParams = {
  baseRate: { 1: 1.4, 2: 1.4 },
  modelWeight: 0.5,
};

// USDC has 6 decimals: $0.01 = 10_000 raw units
const PRICE_RAW_USDC = "10000";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function buildServer(): express.Express {
  const serverWallet = process.env["SERVER_WALLET"];
  if (!serverWallet) {
    throw new Error("SERVER_WALLET env var is required");
  }

  const facilitatorUrl =
    process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator";

  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Free endpoints
  // -------------------------------------------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "@touchline/x402" });
  });

  // -------------------------------------------------------------------------
  // x402 middleware — gates /signal behind a $0.01 USDC payment
  //
  // The public facilitator (x402.org) co-signs as feePayer and broadcasts
  // the partially-signed SPL TransferChecked transaction. Callers need only
  // hold devnet USDC — no SOL required.
  //
  // Three-layer setup:
  //   1. ExactSvmScheme (server side) — parses "$" prices, enriches accepts
  //      with the feePayer address fetched from the facilitator on startup.
  //   2. HTTPFacilitatorClient — delegates verify+settle to x402.org.
  //   3. paymentMiddlewareFromConfig — wires it all into Express.
  // -------------------------------------------------------------------------

  app.use(
    paymentMiddlewareFromConfig(
      {
        "GET /signal": {
          accepts: {
            scheme: "exact",
            network: SOLANA_DEVNET_CAIP2,
            payTo: serverWallet,
            price: {
              asset: USDC_DEVNET_ADDRESS,
              amount: PRICE_RAW_USDC,
            },
            maxTimeoutSeconds: 300,
          },
          description:
            "Poisson fair-value probability for a binary soccer-stat market",
        },
      },
      facilitator,
      [{ network: SOLANA_DEVNET_CAIP2, server: new ExactSvmScheme() }],
    ),
  );

  // -------------------------------------------------------------------------
  // Signal handler — reached only after payment verified + settled
  // -------------------------------------------------------------------------

  app.get("/signal", (req, res) => {
    const q = req.query as Record<string, string | undefined>;

    const fixtureId = parseInt(q["fixtureId"] ?? "1", 10);
    const statKey = parseInt(q["statKey"] ?? "1", 10);
    const threshold = parseFloat(q["threshold"] ?? "1.5");
    const rawCmp = q["comparison"] ?? "GreaterThan";
    const comparison = rawCmp as Predicate["comparison"];
    const p1Goals = parseInt(q["p1Goals"] ?? "0", 10);
    const p2Goals = parseInt(q["p2Goals"] ?? "0", 10);
    const minute = parseInt(q["minute"] ?? "45", 10);
    const lineYesBps =
      q["lineYesBps"] !== undefined
        ? parseInt(q["lineYesBps"], 10)
        : undefined;

    const state: MatchState = {
      fixtureId,
      phase: "H1",
      minute,
      p1Goals,
      p2Goals,
      updatedMs: Date.now(),
    };

    const line: MarketLine | undefined =
      lineYesBps !== undefined
        ? {
            fixtureId,
            statKey,
            impliedYesBps: lineYesBps,
            updatedMs: Date.now(),
          }
        : undefined;

    const predicate: Predicate = { threshold, comparison };
    const probabilityYes = fairValue(
      { statKey, predicate },
      state,
      line,
      DEFAULT_PARAMS,
    );

    const probBps = Math.round(probabilityYes * 10_000);
    const marketPriceBps = lineYesBps ?? 5_000;
    const edgeBps = probBps - marketPriceBps;

    res.json({
      probabilityYes,
      recommendation: edgeBps >= 0 ? "over" : "under",
      edgeBps,
      market: { fixtureId, statKey, predicate },
    });
  });

  return app;
}
