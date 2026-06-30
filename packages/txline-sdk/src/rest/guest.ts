import { getJson } from "./http.js";
import type { ApiOddsUpdate } from "../types/api.js";

/**
 * LEGACY (oracle.txodds.com era). Free guest odds with only a JWT.
 *
 * NOTE: the current `txline.txodds.com` / `txline-dev.txodds.com` deployment
 * returns HTTP 403 "Missing API token" here — every data endpoint now requires
 * an activated `X-Api-Token` (i.e. subscribe + activate, funded wallet). Kept
 * for the legacy host only; prefer {@link TxlineRestClient}.
 */
export function guestOddsSnapshot(
  apiBaseUrl: string,
  jwt: string,
  query: Record<string, string | number | undefined> = {},
): Promise<ApiOddsUpdate[]> {
  return getJson<ApiOddsUpdate[]>(
    `${apiBaseUrl}/api/guest/odds/snapshot`,
    { Authorization: `Bearer ${jwt}` },
    query,
  );
}

/** URL for the guest odds SSE stream (consume via the stream module). */
export function guestOddsStreamUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl}/api/guest/odds/stream`;
}
