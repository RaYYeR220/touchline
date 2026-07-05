/**
 * Render model consumed by render.ts. Both the live chain aggregator
 * (aggregate.ts) and the fallback seed data (seed.ts) produce this exact
 * shape, so the DOM-rendering code never has to know whether a number came
 * from chain or from the demo fallback.
 */

export interface MatchCard {
  code: string;
  home: string;
  away: string;
  /** e.g. "TRADING" / "SETTLED" — derived from on-chain market status, not a live score feed. */
  statusLabel: string;
  /** small mono line under the half-stamp, e.g. "$450 vol" */
  sub: string;
  /** the big score-style number, e.g. "2–1" (here: open markets–settled markets for the fixture) */
  scoreLike: string;
}

export interface MarketRow {
  fixtureCode: string;
  desc: string;
  fairPct: number;
  linePct: number | null;
  spark: number[];
}

export interface TapeRow {
  agent: "AEGIS" | "VANE";
  action: "post" | "fill" | "cancel";
  detail: string;
  amount: string;
}

export interface SettlementCard {
  fixtureCode: string;
  marketDesc: string;
  wonLabel: string;
  paid: string;
  txUrl: string;
  txLabel: string;
}

export interface AgentCard {
  pnl: string;
  pnlPositive: boolean;
  exposure: string;
  statLabel: string;
  statValue: string;
  extraLabel?: string;
  extraValue?: string;
  riskPct: number;
  riskLabel: string;
}

export interface ExposureRow {
  fixtureCode: string;
  amount: string;
}

export interface RiskCol {
  exposureLabel: string;
  exposurePct: number;
  headroomLabel: string;
  headroomPct: number;
}

export interface ArenaSnapshot {
  live: boolean;
  sourceLabel: string;
  stats: {
    volume: string;
    openInterest: string;
    activeMarkets: string;
    agentsOnline: string;
    totalSettled: string;
  };
  matches: MatchCard[];
  markets: MarketRow[];
  tape: TapeRow[];
  settlements: SettlementCard[];
  aegis: AgentCard;
  vane: AgentCard;
  exposure: ExposureRow[];
  risk: { aegis: RiskCol; vane: RiskCol };
}
