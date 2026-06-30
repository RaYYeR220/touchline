import nacl from "tweetnacl";
import { postJson } from "../rest/http.js";

/**
 * Build the activation message and sign it with the wallet's secret key.
 * The message strictly binds the on-chain payment (txSig), the requested
 * leagues, and the guest session (jwt): `${txSig}:${leagues.join(",")}:${jwt}`.
 * Returns the base64 NaCl detached signature.
 */
export function signActivationMessage(
  txSig: string,
  leagues: number[],
  jwt: string,
  secretKey: Uint8Array,
): string {
  const messageString = `${txSig}:${leagues.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signature = nacl.sign.detached(message, secretKey);
  return Buffer.from(signature).toString("base64");
}

export interface ActivateParams {
  apiBaseUrl: string;
  jwt: string;
  txSig: string;
  walletSignature: string;
  leagues: number[];
}

/**
 * Activate API access: `POST /api/token/activate`. Returns the long-lived
 * API token used in the `X-Api-Token` header alongside the JWT.
 */
export async function activateApiToken(params: ActivateParams): Promise<string> {
  const { apiBaseUrl, jwt, txSig, walletSignature, leagues } = params;
  const res = await postJson<{ token?: string } | string>(
    `${apiBaseUrl}/api/token/activate`,
    { txSig, walletSignature, leagues },
    { Authorization: `Bearer ${jwt}` },
  );
  const token = typeof res === "string" ? res : res?.token;
  if (!token) throw new Error("activateApiToken: no token in response");
  return token;
}
