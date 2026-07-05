import type { ArenaSnapshot } from "./types.js";

/**
 * Fallback demo values — identical to the numbers baked into the approved
 * FINAL-touchline.html mockup. Rendered whenever the live chain read comes
 * back empty or errors, so the dashboard always looks complete.
 */
export const SEED_SNAPSHOT: ArenaSnapshot = {
  live: false,
  sourceLabel: "DEMO DATA",
  stats: {
    volume: "$48,200",
    openInterest: "$12,400",
    activeMarkets: "7",
    agentsOnline: "2",
    totalSettled: "$9,180",
  },
  matches: [
    { code: "NED–MAR", home: "Netherlands", away: "Morocco", statusLabel: "2ND HALF", sub: "63'", scoreLike: "1–0" },
    { code: "BRA–JPN", home: "Brazil", away: "Japan", statusLabel: "2ND HALF", sub: "78'", scoreLike: "2–2" },
    { code: "ARG–CPV", home: "Argentina", away: "Cape Verde", statusLabel: "1ST HALF", sub: "12'", scoreLike: "0–0" },
  ],
  markets: [
    { fixtureCode: "NED–MAR", desc: "P1 goals > 1", fairPct: 41, linePct: 44, spark: [9, 11, 8, 13, 12, 16, 15, 18, 17] },
    { fixtureCode: "BRA–JPN", desc: "Total goals > 3.5", fairPct: 58, linePct: 52, spark: [18, 16, 19, 15, 17, 12, 14, 10, 8] },
    { fixtureCode: "ARG–CPV", desc: "P1 goals > 1", fairPct: 33, linePct: 35, spark: [12, 13, 11, 14, 12, 13, 11, 13, 12] },
  ],
  tape: [
    { agent: "AEGIS", action: "post", detail: "NED–MAR YES @ 42%", amount: "$200" },
    { agent: "VANE", action: "fill", detail: "NED–MAR NO @ 42%", amount: "$120" },
    { agent: "AEGIS", action: "post", detail: "BRA–JPN YES @ 56%", amount: "$300" },
    { agent: "VANE", action: "fill", detail: "BRA–JPN YES @ 52%", amount: "$150" },
    { agent: "AEGIS", action: "cancel", detail: "ARG–CPV YES @ 34%", amount: "—" },
  ],
  settlements: [
    {
      fixtureCode: "GER–PAR",
      marketDesc: "P1 goals > 1",
      wonLabel: "YES won",
      paid: "PAID $340",
      txUrl: "https://explorer.solana.com/tx/2paRGL78SGf?cluster=devnet",
      txLabel: "tx 2paRGL…78SGf",
    },
    {
      fixtureCode: "USA–BIH",
      marketDesc: "Total goals > 2",
      wonLabel: "NO won",
      paid: "PAID $210",
      txUrl: "https://explorer.solana.com/tx/4e7cUJkWdcG?cluster=devnet",
      txLabel: "tx 4e7cUJ…kWdcG",
    },
  ],
  aegis: {
    pnl: "+$312",
    pnlPositive: true,
    exposure: "$2,100",
    statLabel: "Quoting",
    statValue: "5 markets",
    riskPct: 42,
    riskLabel: "Risk · 42% of limit",
  },
  vane: {
    pnl: "+$188",
    pnlPositive: true,
    exposure: "$1,050",
    statLabel: "Open Positions",
    statValue: "3",
    extraLabel: "Last Fill",
    extraValue: "BRA–JPN o3.5 @ 52%",
    riskPct: 35,
    riskLabel: "Risk · 35% of limit",
  },
  exposure: [
    { fixtureCode: "NED–MAR", amount: "$320" },
    { fixtureCode: "BRA–JPN", amount: "$450" },
    { fixtureCode: "ARG–CPV", amount: "$180" },
  ],
  risk: {
    aegis: { exposureLabel: "$2,100 / $5,000 · 42%", exposurePct: 42, headroomLabel: "85% remaining", headroomPct: 85 },
    vane: { exposureLabel: "$1,050 / $3,000 · 35%", exposurePct: 35, headroomLabel: "86% remaining", headroomPct: 86 },
  },
};
