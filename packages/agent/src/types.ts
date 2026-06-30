import type { Address } from "@solana/kit";

// ---------------------------------------------------------------------------
// Game phase — mirrors the TxLINE soccer feed phase encoding.
// NS=1 H1=2 HT=3 H2=4 F=5 WET=6 ET1=7 HTET=8 ET2=9 FET=10
// WPE=11 PE=12 FPE=13 I=14 A=15 C=16 TXCC=17 TXCS=18 P=19
// ---------------------------------------------------------------------------
export type Phase =
  | "NS"   // Not started
  | "H1"   // First half
  | "HT"   // Half time
  | "H2"   // Second half
  | "F"    // Finished (regulation)
  | "WET"  // Waiting for extra time
  | "ET1"  // Extra time first half
  | "HTET" // Extra time half time
  | "ET2"  // Extra time second half
  | "FET"  // Finished after extra time
  | "WPE"  // Waiting for penalty shootout
  | "PE"   // Penalty shootout
  | "FPE"  // Finished after penalties
  | "I"    // Interrupted
  | "A"    // Abandoned
  | "C"    // Cancelled
  | "TXCC" // TX Coverage Cancelled
  | "TXCS" // TX Coverage Suspended
  | "P";   // Postponed

// ---------------------------------------------------------------------------
// Core feed state types
// ---------------------------------------------------------------------------

/**
 * Reduced match state derived from the TxLINE scores stream.
 * All fields are from the most recent message for the fixture.
 */
export interface MatchState {
  fixtureId: number;
  phase: Phase;
  /** Match minute (0–90+). Best-effort from feed; may lag slightly. */
  minute: number;
  /** Full-game participant-1 goals (stat key 1). */
  p1Goals: number;
  /** Full-game participant-2 goals (stat key 2). */
  p2Goals: number;
  /** Wall-clock time (ms) of the last update that produced this state. */
  updatedMs: number;
}

/**
 * Implied-YES price for a single (fixture, statKey) market from the odds stream.
 * Price is in basis points: 1..=9999 (1 = 0.01%, 9999 = 99.99%).
 */
export interface MarketLine {
  fixtureId: number;
  statKey: number;
  impliedYesBps: number;
  updatedMs: number;
}

/**
 * A settlement predicate for a binary stat market.
 * The predicate resolves YES when: statValue <comparison> threshold.
 */
export interface Predicate {
  threshold: number;
  comparison: "GreaterThan" | "LessThan" | "EqualTo";
}

// ---------------------------------------------------------------------------
// On-chain account views (read via venue-client decoders)
// ---------------------------------------------------------------------------

export interface MarketView {
  address: Address;
  fixtureId: number;
  statKey: number;
  predicate: Predicate;
  /** Open or Settled. */
  status: "Open" | "Settled";
  totalPot: bigint;
  oracleProgram: Address;
}

export interface OfferView {
  address: Address;
  market: Address;
  maker: Address;
  makerSide: "Yes" | "No";
  /** Implied-YES price in bps: 1..=9999. */
  priceYesBps: number;
  remainingPot: bigint;
}

export interface PositionView {
  address: Address;
  market: Address;
  maker: Address;
  taker: Address;
  makerSide: "Yes" | "No";
  priceYesBps: number;
  pot: bigint;
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Agent context — snapshot fed to strategies each tick
// ---------------------------------------------------------------------------

export interface ArenaContext {
  state: MatchState;
  lines: MarketLine[];
  markets: MarketView[];
  offers: OfferView[];
  positions: PositionView[];
  risk: import("./risk/guards.js").RiskBudget;
  nowMs: number;
}

// ---------------------------------------------------------------------------
// Intent union — what a strategy wants to do; passes risk guards before exec
// ---------------------------------------------------------------------------

export type Intent =
  | {
      kind: "createMarket";
      fixtureId: number;
      statKey: number;
      predicate: Predicate;
    }
  | {
      kind: "postOffer";
      market: Address;
      side: "Yes" | "No";
      priceYesBps: number;
      pot: bigint;
    }
  | {
      kind: "fillOffer";
      offer: OfferView;
      fillPot: bigint;
    }
  | {
      kind: "cancelOffer";
      offer: OfferView;
    };
