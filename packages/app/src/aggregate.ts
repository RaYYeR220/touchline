/**
 * Turns raw decoded venue accounts into the ArenaSnapshot render model.
 *
 * Agent identity mapping (documented, since the venue program itself has no
 * concept of "AEGIS"/"VANE" — those are this dashboard's labels):
 *   AEGIS = the known devnet wallet used as `maker` by scripts/seed-arena.ts
 *           and packages/agent/integration-devnet.ts (a fixed, public key —
 *           not a secret).
 *   VANE  = any address that shows up as `taker` and is NOT that wallet.
 *           Each seeding run generates a fresh ephemeral taker keypair, so
 *           VANE is treated as a role/bucket rather than one fixed pubkey.
 */
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { Comparison, MarketStatus, Side, type Offer as VenueOffer } from "@touchline/venue-client";
import { fairValue, type MarketLine, type MatchState, type ModelParams, type Predicate } from "@touchline/agent/api";
import {
  fetchArenaAccounts,
  findSettleOutcome,
  latestSlot,
  mapWithConcurrency,
  type ChainMarket,
  type ChainPosition,
} from "./chain.js";
import { fixtureCode, fixtureName, marketDesc, predicateIsYes, type ComparisonName } from "./fixtures.js";
import type { ArenaSnapshot, ExposureRow, MarketRow, MatchCard, SettlementCard, TapeRow } from "./types.js";

/** Public key only — this is the devnet wallet address, never the secret key. */
export const WALLET_AEGIS = "4EtAFmWtCzMxyUku7NofttEPLDWniigFAEL7KmCeCYKo" as Address;

// Mirrors packages/agent/src/config.ts DEFAULT_STRATEGY_PARAMS.baseRate — that
// file isn't part of @touchline/agent's public "./api" export surface, so the
// (small, stable) table is copied here rather than reaching into src/config.ts.
const BASE_RATE: Record<number, number> = { 1: 1.4, 2: 1.4, 3: 2.5, 4: 2.5, 5: 0.3, 6: 0.3, 7: 5.0, 8: 5.0 };
const MODEL_PARAMS: ModelParams = { baseRate: BASE_RATE, modelWeight: 0.5 };

// Mirrors packages/agent/src/config.ts DEFAULT_RISK_LIMITS. These are the
// agent's own off-chain risk budget, not something the venue program stores —
// the venue only enforces the per-fill/per-market USDC caps on-chain.
const MAX_OPEN_EXPOSURE = 200_000_000n; // $200, 6-decimal USDC base units
const MAX_DAILY_LOSS_BPS = 2000; // 20%

function toComparison(c: Comparison): ComparisonName {
  if (c === Comparison.GreaterThan) return "GreaterThan";
  if (c === Comparison.LessThan) return "LessThan";
  return "EqualTo";
}
function toSide(s: Side): "Yes" | "No" {
  return s === Side.Yes ? "Yes" : "No";
}

function usd(baseUnits: bigint): string {
  const abs = baseUnits < 0n ? -baseUnits : baseUnits;
  const dollars = Math.round(Number(abs) / 1_000_000);
  return "$" + dollars.toLocaleString("en-US");
}

function yesStake(pot: bigint, priceYesBps: number): bigint {
  return (pot * BigInt(priceYesBps)) / 10_000n;
}
function makerStakeOf(pot: bigint, priceYesBps: number, makerSide: "Yes" | "No"): bigint {
  const yes = yesStake(pot, priceYesBps);
  return makerSide === "Yes" ? yes : pot - yes;
}

/** Deterministic PRNG (mulberry32) — used only to draw a decorative sparkline trend. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decorative price-history sparkline that ends exactly at the live fair-value point. */
function sparkline(seedKey: number, endValue: number): number[] {
  const rnd = mulberry32(seedKey);
  const points: number[] = [];
  for (let i = 0; i < 8; i++) points.push(Math.max(1, Math.round(endValue + (rnd() - 0.5) * 30)));
  points.push(Math.max(1, Math.round(endValue)));
  return points;
}

/**
 * The dashboard doesn't hold a live TxLINE match-state subscription in the
 * browser (that's a separate, heavier auth+SSE integration than a read-only
 * on-chain viewer needs). fairValue() is fed a neutral kickoff+45' snapshot
 * so its model component is stable/reproducible on every poll; the "Line"
 * column next to it is the real, live, on-chain quoted offer price.
 */
function syntheticMatchState(fixtureId: number): MatchState {
  return { fixtureId, phase: "H1", minute: 45, p1Goals: 0, p2Goals: 0, updatedMs: Date.now() };
}

export async function buildSnapshot(rpc: Rpc<SolanaRpcApi>): Promise<ArenaSnapshot> {
  const { markets, offers, positions } = await fetchArenaAccounts(rpc);

  if (markets.length === 0 && offers.length === 0 && positions.length === 0) {
    throw new Error("no on-chain arena accounts found");
  }

  const marketByAddr = new Map<string, ChainMarket>(markets.map((m) => [String(m.address), m]));
  const fixtureOf = (m: ChainMarket | undefined): number => (m ? Number(m.fixtureId) : 0);

  // ---------------------------------------------------------------- stats --
  const totalNotional = positions.reduce((s, p) => s + p.pot, 0n);
  const openNotional = positions.filter((p) => !p.settled).reduce((s, p) => s + p.pot, 0n);
  const settledNotional = positions.filter((p) => p.settled).reduce((s, p) => s + p.pot, 0n);
  const activeMarkets = markets.filter((m) => m.status === MarketStatus.Open).length;
  const aegisActive = offers.some((o) => o.maker === WALLET_AEGIS) || positions.some((p) => p.maker === WALLET_AEGIS);
  const vaneActive = positions.some((p) => p.taker !== WALLET_AEGIS);
  const agentsOnline = (aegisActive ? 1 : 0) + (vaneActive ? 1 : 0);

  // ------------------------------------------------------------- matches --
  // Note: the venue program never flips Market.status away from Open (settle
  // only touches the individual Position) — a market keeps accepting offers
  // indefinitely, so "open vs settled" is tracked per-position, not per-market.
  const fixtureIds = [...new Set(markets.map((m) => Number(m.fixtureId)))];
  const matches: MatchCard[] = fixtureIds.map((fid) => {
    const posForFixture = positions.filter((p) => fixtureOf(marketByAddr.get(String(p.market))) === fid);
    const openPos = posForFixture.filter((p) => !p.settled).length;
    const settledPos = posForFixture.length - openPos;
    const hasOpenOffer = offers.some((o) => o.remainingPot > 0n && fixtureOf(marketByAddr.get(String(o.market))) === fid);
    const vol = posForFixture.reduce((s, p) => s + p.pot, 0n);
    const name = fixtureName(fid);
    return {
      code: fixtureCode(fid),
      home: name.home,
      away: name.away,
      statusLabel: openPos > 0 || hasOpenOffer ? "TRADING" : "SETTLED",
      sub: `${usd(vol)} vol`,
      scoreLike: `${openPos}–${settledPos}`,
    };
  });

  // ------------------------------------------------------------- markets --
  const marketRows: MarketRow[] = markets
    .filter((m) => m.status === MarketStatus.Open)
    .map((m) => {
      const comparison = toComparison(m.predicate.comparison);
      const desc = marketDesc(m.statKey, m.predicate.threshold, comparison);
      const marketOffers = offers.filter((o) => String(o.market) === String(m.address) && o.remainingPot > 0n);
      const bestOffer = marketOffers.reduce<VenueOffer | undefined>(
        (best, o) => (!best || o.remainingPot > best.remainingPot ? o : best),
        undefined,
      );
      const linePct = bestOffer ? Math.round(bestOffer.priceYesBps / 100) : null;
      const line: MarketLine | undefined = bestOffer
        ? { fixtureId: Number(m.fixtureId), statKey: m.statKey, impliedYesBps: bestOffer.priceYesBps, updatedMs: Date.now() }
        : undefined;
      const predicate: Predicate = { threshold: m.predicate.threshold, comparison };
      const fair = fairValue({ statKey: m.statKey, predicate }, syntheticMatchState(Number(m.fixtureId)), line, MODEL_PARAMS);
      const fairPct = Math.round(fair * 100);
      return {
        fixtureCode: fixtureCode(Number(m.fixtureId)),
        desc,
        fairPct,
        linePct,
        spark: sparkline(Number(m.fixtureId) * 31 + m.statKey, fairPct),
      };
    });

  // ---------------------------------------------------------- fill tape ---
  const openOffers = offers.filter((o) => o.remainingPot > 0n);
  const [offerSlots, positionSlots] = await Promise.all([
    mapWithConcurrency(openOffers, 5, (o) => latestSlot(rpc, o.address)),
    mapWithConcurrency(positions, 5, (p) => latestSlot(rpc, p.address)),
  ]);

  const postRows = openOffers.map((o, i) => {
    const fid = fixtureOf(marketByAddr.get(String(o.market)));
    const side = toSide(o.makerSide);
    return {
      row: {
        agent: (o.maker === WALLET_AEGIS ? "AEGIS" : "VANE") as "AEGIS" | "VANE",
        action: "post" as const,
        detail: `${fixtureCode(fid)} ${side.toUpperCase()} @ ${Math.round(o.priceYesBps / 100)}%`,
        amount: usd(o.remainingPot),
      },
      slot: offerSlots[i] ?? 0,
    };
  });
  const positionsWithSlot = positions.map((p, i) => ({ p, slot: positionSlots[i] ?? 0 }));
  const fillRows = positionsWithSlot.map(({ p, slot }) => {
    const fid = fixtureOf(marketByAddr.get(String(p.market)));
    const takerSide = toSide(p.makerSide) === "Yes" ? "NO" : "YES";
    return {
      row: {
        agent: (p.taker === WALLET_AEGIS ? "AEGIS" : "VANE") as "AEGIS" | "VANE",
        action: "fill" as const,
        detail: `${fixtureCode(fid)} ${takerSide} @ ${Math.round(p.priceYesBps / 100)}%`,
        amount: usd(p.pot),
      },
      slot,
    };
  });
  const tape: TapeRow[] = [...postRows, ...fillRows]
    .sort((a, b) => b.slot - a.slot)
    .slice(0, 8)
    .map((x) => x.row);

  // -------------------------------------------------------- settlements ---
  const settledPositions = positions.filter((p) => p.settled);
  const settledWithOutcome = await mapWithConcurrency(settledPositions, 4, async (p) => ({
    position: p,
    outcome: await findSettleOutcome(rpc, p.address),
  }));

  const settlements: SettlementCard[] = settledWithOutcome.map(({ position: p, outcome }) => {
    const mkt = marketByAddr.get(String(p.market));
    const fid = fixtureOf(mkt);
    const comparison = mkt ? toComparison(mkt.predicate.comparison) : "GreaterThan";
    const threshold = mkt ? mkt.predicate.threshold : 0;
    const desc = mkt ? marketDesc(mkt.statKey, threshold, comparison) : "settled market";
    let wonLabel = "SETTLED";
    let txUrl = `https://explorer.solana.com/address/${p.address}?cluster=devnet`;
    let txLabel = "position ↗";
    if (outcome) {
      const yesWon = predicateIsYes(outcome.statValue, threshold, comparison);
      wonLabel = yesWon ? "YES won" : "NO won";
      txUrl = `https://explorer.solana.com/tx/${outcome.signature}?cluster=devnet`;
      txLabel = `tx ${outcome.signature.slice(0, 6)}…${outcome.signature.slice(-6)}`;
    }
    return { fixtureCode: fixtureCode(fid), marketDesc: desc, wonLabel, paid: `PAID ${usd(p.pot)}`, txUrl, txLabel };
  });

  // -------------------------------------------------- agent P&L (Duel) -----
  let aegisPnl = 0n;
  let vanePnl = 0n;
  for (const { position: p, outcome } of settledWithOutcome) {
    if (!outcome) continue;
    const mkt = marketByAddr.get(String(p.market));
    if (!mkt) continue;
    const comparison = toComparison(mkt.predicate.comparison);
    const yesWon = predicateIsYes(outcome.statValue, mkt.predicate.threshold, comparison);
    const stakeMaker = makerStakeOf(p.pot, p.priceYesBps, toSide(p.makerSide));
    const stakeTaker = p.pot - stakeMaker;
    const makerIsYes = toSide(p.makerSide) === "Yes";
    const makerWon = makerIsYes === yesWon;
    if (p.maker === WALLET_AEGIS) aegisPnl += makerWon ? p.pot - stakeMaker : -stakeMaker;
    if (p.taker !== WALLET_AEGIS) vanePnl += !makerWon ? p.pot - stakeTaker : -stakeTaker;
  }

  const aegisOpenOffers = offers.filter((o) => o.remainingPot > 0n && o.maker === WALLET_AEGIS);
  const aegisOfferExposure = aegisOpenOffers.reduce(
    (s, o) => s + makerStakeOf(o.remainingPot, o.priceYesBps, toSide(o.makerSide)),
    0n,
  );
  const aegisOpenPositionExposure = positions
    .filter((p) => !p.settled && p.maker === WALLET_AEGIS)
    .reduce((s, p) => s + makerStakeOf(p.pot, p.priceYesBps, toSide(p.makerSide)), 0n);
  const aegisExposure = aegisOfferExposure + aegisOpenPositionExposure;
  const aegisQuotingMarkets = new Set(aegisOpenOffers.map((o) => String(o.market))).size;

  const vaneOpenPositions = positions.filter((p) => !p.settled && p.taker !== WALLET_AEGIS);
  const vaneExposure = vaneOpenPositions.reduce((s, p) => {
    const stakeMaker = makerStakeOf(p.pot, p.priceYesBps, toSide(p.makerSide));
    return s + (p.pot - stakeMaker);
  }, 0n);

  const vaneFillsBySlot = positionsWithSlot.filter(({ p }) => p.taker !== WALLET_AEGIS).sort((a, b) => b.slot - a.slot);
  const lastVane = vaneFillsBySlot[0];
  let vaneLastFill = "—";
  if (lastVane) {
    const fid = fixtureOf(marketByAddr.get(String(lastVane.p.market)));
    const takerSide = toSide(lastVane.p.makerSide) === "Yes" ? "NO" : "YES";
    vaneLastFill = `${fixtureCode(fid)} ${takerSide} @ ${Math.round(lastVane.p.priceYesBps / 100)}%`;
  }

  function riskPct(exposure: bigint): number {
    const pct = Number((exposure * 100n) / MAX_OPEN_EXPOSURE);
    return Math.max(0, Math.min(100, pct));
  }
  function headroomPct(pnl: bigint): number {
    if (pnl >= 0n) return 100;
    const lossBudget = (MAX_OPEN_EXPOSURE * BigInt(MAX_DAILY_LOSS_BPS)) / 10_000n;
    if (lossBudget <= 0n) return 0;
    const used = Number((-pnl * 100n) / lossBudget);
    return Math.max(0, Math.min(100, 100 - used));
  }
  function pnlLabel(pnl: bigint): string {
    return (pnl < 0n ? "-" : "+") + usd(pnl);
  }

  // -------------------------------------------------------- book exposure -
  const exposureByFixture = new Map<string, bigint>();
  for (const p of positions) {
    if (p.settled) continue;
    const code = fixtureCode(fixtureOf(marketByAddr.get(String(p.market))));
    exposureByFixture.set(code, (exposureByFixture.get(code) ?? 0n) + p.pot);
  }
  const exposure: ExposureRow[] = [...exposureByFixture.entries()]
    .sort((a, b) => Number(b[1] - a[1]))
    .slice(0, 6)
    .map(([code, amt]) => ({ fixtureCode: code, amount: usd(amt) }));

  const aegisRiskPct = riskPct(aegisExposure);
  const vaneRiskPct = riskPct(vaneExposure);

  return {
    live: true,
    sourceLabel: `LIVE · ${markets.length} ON-CHAIN`,
    stats: {
      volume: usd(totalNotional),
      openInterest: usd(openNotional),
      activeMarkets: String(activeMarkets),
      agentsOnline: String(agentsOnline),
      totalSettled: usd(settledNotional),
    },
    matches,
    markets: marketRows,
    tape,
    settlements,
    aegis: {
      pnl: pnlLabel(aegisPnl),
      pnlPositive: aegisPnl >= 0n,
      exposure: usd(aegisExposure),
      statLabel: "Quoting",
      statValue: `${aegisQuotingMarkets} market${aegisQuotingMarkets === 1 ? "" : "s"}`,
      riskPct: aegisRiskPct,
      riskLabel: `Risk · ${aegisRiskPct}% of limit`,
    },
    vane: {
      pnl: pnlLabel(vanePnl),
      pnlPositive: vanePnl >= 0n,
      exposure: usd(vaneExposure),
      statLabel: "Open Positions",
      statValue: String(vaneOpenPositions.length),
      extraLabel: "Last Fill",
      extraValue: vaneLastFill,
      riskPct: vaneRiskPct,
      riskLabel: `Risk · ${vaneRiskPct}% of limit`,
    },
    exposure,
    risk: {
      aegis: {
        exposureLabel: `${usd(aegisExposure)} / ${usd(MAX_OPEN_EXPOSURE)} · ${aegisRiskPct}%`,
        exposurePct: aegisRiskPct,
        headroomLabel: `${headroomPct(aegisPnl)}% remaining`,
        headroomPct: headroomPct(aegisPnl),
      },
      vane: {
        exposureLabel: `${usd(vaneExposure)} / ${usd(MAX_OPEN_EXPOSURE)} · ${vaneRiskPct}%`,
        exposurePct: vaneRiskPct,
        headroomLabel: `${headroomPct(vanePnl)}% remaining`,
        headroomPct: headroomPct(vanePnl),
      },
    },
  };
}
