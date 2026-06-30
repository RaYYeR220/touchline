import { Program, type Provider } from "@coral-xyz/anchor";
import idlJson from "./idl/txoracle.json" with { type: "json" };
import type { Txoracle } from "./idl/txoracle.js";
import type { TxlineConfig } from "../config.js";

/**
 * The vendored IDL is the mainnet build (its `address` is the mainnet program
 * id). To target another network we clone it with the network's program id so
 * Anchor derives the correct program.
 */
export function getTxoracleIdl(config: TxlineConfig): Txoracle {
  const idl = idlJson as unknown as Txoracle;
  return {
    ...idl,
    address: config.programId.toBase58(),
  } as unknown as Txoracle;
}

/** Construct a typed `txoracle` Anchor `Program` for the given network. */
export function getTxoracleProgram(
  config: TxlineConfig,
  provider: Provider,
): Program<Txoracle> {
  return new Program<Txoracle>(getTxoracleIdl(config), provider);
}

export { idlJson as txoracleIdlJson };
