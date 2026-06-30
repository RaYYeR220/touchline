import { PublicKey } from "@solana/web3.js";

/**
 * TxLINE network selection. Default for development/demo is `devnet`
 * (the devnet deployment carries match re-runs for integration testing,
 * per the reference repo README).
 */
export type TxlineNetwork = "devnet" | "mainnet";

export interface TxlineConfig {
  network: TxlineNetwork;
  /** Off-chain API + auth base URL (no trailing slash). */
  apiBaseUrl: string;
  /** `txoracle` Anchor program id for this network. */
  programId: PublicKey;
  /** TxL utility-token mint (used by the on-chain `subscribe` instruction). */
  txlMint: PublicKey;
  /** USDT mint configured by TxLINE on this network. */
  usdtMint: PublicKey;
  /** Suggested default Solana RPC for this network. */
  defaultRpcUrl: string;
  /** Solana explorer cluster query string suffix. */
  explorerCluster: string;
}

/**
 * Canonical addresses from the live docs (`documentation/programs/addresses.md`,
 * vendored at `docs/txline-addresses.md`). Confirm `txlMint` against the live IDL
 * `TXLINE_MINT` constant before any mainnet value transfer — older docs list
 * different mints.
 */
export const NETWORKS: Record<TxlineNetwork, TxlineConfig> = {
  devnet: {
    network: "devnet",
    apiBaseUrl: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    usdtMint: new PublicKey("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh"),
    defaultRpcUrl: "https://api.devnet.solana.com",
    explorerCluster: "devnet",
  },
  mainnet: {
    network: "mainnet",
    apiBaseUrl: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    usdtMint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
    explorerCluster: "mainnet-beta",
  },
};

export function resolveConfig(
  network: TxlineNetwork = "devnet",
  overrides: Partial<TxlineConfig> = {},
): TxlineConfig {
  return { ...NETWORKS[network], ...overrides };
}

/** Free-tier service levels (no TxL charged). */
export const SERVICE_LEVEL = {
  /** World Cup & International Friendlies, 60-second delayed. */
  DELAYED_60S: 1,
  /** World Cup & International Friendlies, real-time. */
  REALTIME: 12,
} as const;

export type ServiceLevel = (typeof SERVICE_LEVEL)[keyof typeof SERVICE_LEVEL];
