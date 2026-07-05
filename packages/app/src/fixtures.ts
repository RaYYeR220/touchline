/**
 * Known World Cup fixtures used by scripts/seed-arena.ts, plus the stat-key
 * and comparison vocabulary the venue program stores on a Market account.
 *
 * A fixtureId with no entry here just renders as "Fixture #<id>" — this
 * covers markets left over from earlier spike/integration runs on devnet
 * (fixture ids like 990013) as well as any future fixture the seed script
 * doesn't know about yet.
 */
export interface FixtureInfo {
  code: string;
  home: string;
  away: string;
}

export const FIXTURES: Record<number, FixtureInfo> = {
  18172280: { code: "NED–MAR", home: "Netherlands", away: "Morocco" },
  18172469: { code: "BRA–JPN", home: "Brazil", away: "Japan" },
  18175918: { code: "ARG–CPV", home: "Argentina", away: "Cape Verde" },
  18175981: { code: "FRA–SWE", home: "France", away: "Sweden" },
};

export function fixtureCode(fixtureId: number): string {
  return FIXTURES[fixtureId]?.code ?? `#${fixtureId}`;
}

export function fixtureName(fixtureId: number): { home: string; away: string } {
  const f = FIXTURES[fixtureId];
  return f ? { home: f.home, away: f.away } : { home: `Fixture #${fixtureId}`, away: "" };
}

/** Mirrors packages/agent/src/config.ts DEFAULT_BASE_RATE key naming. */
export const STAT_NAMES: Record<number, string> = {
  1: "P1 goals",
  2: "P2 goals",
  3: "P1 yellow cards",
  4: "P2 yellow cards",
  5: "P1 red cards",
  6: "P2 red cards",
  7: "P1 corners",
  8: "P2 corners",
};

export type ComparisonName = "GreaterThan" | "LessThan" | "EqualTo";

export function comparisonSymbol(c: ComparisonName): string {
  if (c === "GreaterThan") return ">";
  if (c === "LessThan") return "<";
  return "=";
}

export function marketDesc(statKey: number, threshold: number, comparison: ComparisonName): string {
  const name = STAT_NAMES[statKey] ?? `stat ${statKey}`;
  return `${name} ${comparisonSymbol(comparison)} ${threshold}`;
}

export function predicateIsYes(value: number, threshold: number, comparison: ComparisonName): boolean {
  if (comparison === "GreaterThan") return value > threshold;
  if (comparison === "LessThan") return value < threshold;
  return value === threshold;
}
