import { type Program } from "@coral-xyz/anchor";
import { type Signer } from "@solana/web3.js";
import type { Txoracle } from "../onchain/idl/txoracle.js";
import type { TxlineConfig } from "../config.js";
import { type ServiceLevel } from "../config.js";
import { startGuestSession } from "./guest.js";
import { subscribeFreeTier } from "./subscribe.js";
import { activateApiToken, signActivationMessage } from "./activate.js";

export interface TxlineSessionTokens {
  jwt: string;
  apiToken: string;
}

export interface CreateSessionParams {
  config: TxlineConfig;
  program: Program<Txoracle>;
  /** Wallet keypair (needs `secretKey` to sign the activation message). */
  payer: Signer;
  serviceLevel?: ServiceLevel | number;
  durationWeeks?: number;
  /** Empty for the standard bundle. */
  leagues?: number[];
  /** Provide if you already subscribed on-chain and want to skip re-subscribing. */
  existingTxSig?: string;
}

/**
 * Holds TxLINE credentials and produces the dual auth headers required by data
 * endpoints. The JWT can be refreshed on a 401 without re-subscribing; the
 * long-lived API token remains valid.
 */
export class TxlineSession {
  jwt: string;
  apiToken: string;
  readonly config: TxlineConfig;

  constructor(config: TxlineConfig, tokens: TxlineSessionTokens) {
    this.config = config;
    this.jwt = tokens.jwt;
    this.apiToken = tokens.apiToken;
  }

  /** Build a session from credentials you already hold. */
  static fromTokens(
    config: TxlineConfig,
    tokens: TxlineSessionTokens,
  ): TxlineSession {
    return new TxlineSession(config, tokens);
  }

  /** Run the full free-tier flow: guest → subscribe → sign → activate. */
  static async create(params: CreateSessionParams): Promise<TxlineSession> {
    const {
      config,
      program,
      payer,
      serviceLevel = 1,
      durationWeeks = 4,
      leagues = [],
      existingTxSig,
    } = params;

    const jwt = await startGuestSession(config.apiBaseUrl);

    const txSig =
      existingTxSig ??
      (await subscribeFreeTier({ program, config, payer, serviceLevel, durationWeeks }));

    const walletSignature = signActivationMessage(
      txSig,
      leagues,
      jwt,
      payer.secretKey,
    );

    const apiToken = await activateApiToken({
      apiBaseUrl: config.apiBaseUrl,
      jwt,
      txSig,
      walletSignature,
      leagues,
    });

    return new TxlineSession(config, { jwt, apiToken });
  }

  /** Headers required by all authed data endpoints. */
  authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.jwt}`,
      "X-Api-Token": this.apiToken,
    };
  }

  /** Reacquire a fresh guest JWT (e.g. after a 401). API token is unchanged. */
  async refreshJwt(): Promise<void> {
    this.jwt = await startGuestSession(this.config.apiBaseUrl);
  }
}
