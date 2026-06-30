import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  u16le,
  dailyScoresRootsPda,
  tenDailyFixturesRootsPda,
  pricingMatrixPda,
} from "../src/onchain/pdas.js";

const PROGRAM = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

describe("u16le", () => {
  it("encodes little-endian 2-byte", () => {
    expect([...u16le(0)]).toEqual([0, 0]);
    expect([...u16le(1)]).toEqual([1, 0]);
    expect([...u16le(258)]).toEqual([2, 1]); // 0x0102
    expect([...u16le(0xffff)]).toEqual([255, 255]);
  });

  it("rejects out-of-range values", () => {
    expect(() => u16le(-1)).toThrow();
    expect(() => u16le(0x10000)).toThrow();
    expect(() => u16le(1.5)).toThrow();
  });
});

describe("PDA derivation", () => {
  it("is deterministic and distinct per epoch day", () => {
    const [a] = dailyScoresRootsPda(PROGRAM, 20633);
    const [b] = dailyScoresRootsPda(PROGRAM, 20633);
    const [c] = dailyScoresRootsPda(PROGRAM, 20634);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("aligns fixtures roots to 10-day windows", () => {
    const [w1] = tenDailyFixturesRootsPda(PROGRAM, 20633);
    const [w2] = tenDailyFixturesRootsPda(PROGRAM, 20639); // same window (20630)
    const [w3] = tenDailyFixturesRootsPda(PROGRAM, 20640); // next window
    expect(w1.equals(w2)).toBe(true);
    expect(w1.equals(w3)).toBe(false);
  });

  it("derives a stable pricing matrix PDA", () => {
    const [p1] = pricingMatrixPda(PROGRAM);
    const [p2] = pricingMatrixPda(PROGRAM);
    expect(p1.equals(p2)).toBe(true);
  });
});
