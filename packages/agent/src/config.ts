import type { Address } from "@solana/kit";
import type { RiskLimits } from "./risk/guards.js";
import type { Phase } from "./types.js";

// ---------------------------------------------------------------------------
// Strategy parameters
// ---------------------------------------------------------------------------

/**
 * Parameters that control the two reference strategies.
 * All values are defaults; they can be overridden per-run.
 */
export interface StrategyParams {
  /**
   * Half-spread in bps applied around the fair-value price.
   * MM quotes YES at fair - halfSpreadBps, NO at fair + halfSpreadBps.
   */
  halfSpreadBps: number;
  /**
   * Default pot size for new offers, in USDC base units (6 decimals).
   * Subject to risk-budget constraints at quote time.
   */
  defaultPotUsdc: bigint;
  /**
   * Minimum edge (bps) required for the taker strategy to fill an offer.
   * Duplicated here for convenience; guards.ts enforces it independently.
   */
  minEdgeBps: number;
  /**
   * Model parameters for the Poisson fair-value model.
   * Record<statKey, expectedGoalsPerRegulation>.
   */
  baseRate: Record<number, number>;
  /** Weight of the model vs the market line in the blend. Default 0.5. */
  modelWeight: number;
}

// ---------------------------------------------------------------------------
// Top-level agent config
// ---------------------------------------------------------------------------

export interface AgentConfig {
  network: "devnet" | "mainnet";
  rpcUrl: string;
  /** Touchline venue program address. */
  venueProgram: Address;
  /** Oracle program address (mock or real txoracle). */
  oracleProgram: Address;
  /** USDC mint used by the venue. */
  usdcMint: Address;
  /** Path to the wallet keypair JSON (Solana file-based keypair). */
  walletPath: string;
  risk: RiskLimits;
  strategy: StrategyParams;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/** Phases that should never be traded (pre-match and all terminal phases). */
const DEFAULT_NO_TRADE_PHASES: Phase[] = ["NS", "F", "FET", "FPE", "I", "A", "C", "TXCC", "TXCS", "P"];

/** Default risk limits — conservative devnet defaults. */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  /** 10 USDC per position. */
  maxStakePerPosition: 10_000_000n,
  /** 200 USDC total open at once. */
  maxOpenExposure: 200_000_000n,
  /** Halt after a 20% drawdown relative to max open exposure. */
  maxDailyLossBps: 2000,
  /** Strategy minEdge mirrored here for guard checks. */
  minEdgeBps: 50,
  noTradePhases: DEFAULT_NO_TRADE_PHASES,
  /** Halt trading if the feed hasn't sent a message in 60 seconds. */
  maxFeedStalenessMs: 60_000,
};

/** Default Poisson base rates: ~1.4 goals per team per regulation match. */
const DEFAULT_BASE_RATE: Record<number, number> = {
  1: 1.4, // P1 goals per 90 min
  2: 1.4, // P2 goals per 90 min
  3: 2.5, // P1 yellow cards per 90 min
  4: 2.5, // P2 yellow cards per 90 min
  5: 0.3, // P1 red cards per 90 min
  6: 0.3, // P2 red cards per 90 min
  7: 5.0, // P1 corners per 90 min
  8: 5.0, // P2 corners per 90 min
};

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  halfSpreadBps: 75,
  defaultPotUsdc: 2_000_000n, // 2 USDC
  minEdgeBps: 50,
  baseRate: DEFAULT_BASE_RATE,
  modelWeight: 0.5,
};

/** Devnet program addresses (from plan + conventions.md). */
export const DEVNET_ADDRESSES = {
  venueProgram: "21zXPvXZYPnPu8sCSQ5b8Ly76DXNjWUS2MX8jQwgesLJ" as Address,
  oracleProgram: "7uQHgENc27tcpP1svYShb6XUgxdzQTEX8xXrWDKUk57S" as Address, // mock
  usdcMint: "ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh" as Address,
} as const;

/**
 * Build an AgentConfig from env-variable overrides and the supplied defaults.
 * Missing env vars fall back to devnet defaults.
 */
export function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    network: (process.env["NETWORK"] as "devnet" | "mainnet" | undefined) ?? "devnet",
    rpcUrl: process.env["RPC_URL"] ?? "https://api.devnet.solana.com",
    venueProgram: DEVNET_ADDRESSES.venueProgram,
    oracleProgram: DEVNET_ADDRESSES.oracleProgram,
    usdcMint: DEVNET_ADDRESSES.usdcMint,
    walletPath: process.env["WALLET_PATH"] ?? `${process.env["HOME"] ?? "~"}/.config/solana/id.json`,
    risk: DEFAULT_RISK_LIMITS,
    strategy: DEFAULT_STRATEGY_PARAMS,
    ...overrides,
  };
}
