/**
 * No-wallet smoke test: proves guest-session auth works against the live API.
 * Data endpoints additionally require an activated X-Api-Token (funded wallet —
 * see session_snapshot.ts). There is no wallet-less data path on the current
 * deployment.
 *
 *   TXLINE_NETWORK=mainnet npx tsx scripts/auth_check.ts
 */
import { resolveConfig } from "../src/config.js";
import { startGuestSession } from "../src/auth/guest.js";

async function main() {
  const network = (process.env.TXLINE_NETWORK as "devnet" | "mainnet") ?? "devnet";
  const config = resolveConfig(network);
  console.log(`[auth_check] network=${network} base=${config.apiBaseUrl}`);
  const jwt = await startGuestSession(config.apiBaseUrl);
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  console.log(`[auth_check] guest JWT ok (${jwt.length} chars), role=${payload.role}, exp=${new Date(payload.exp * 1000).toISOString()}`);
  console.log("[auth_check] data endpoints require subscribe+activate (funded wallet).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
