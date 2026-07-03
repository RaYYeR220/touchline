/**
 * Entrypoint — starts the Touchline signal server.
 *
 * Environment:
 *   SERVER_WALLET   Solana address receiving payments (required)
 *   PORT            TCP port (default: 4021)
 *   FACILITATOR_URL x402 facilitator URL (default: https://x402.org/facilitator)
 *   RPC_URL         Solana RPC endpoint (not used by server; clients may need it)
 */
import { buildServer } from "./server.js";

const port = parseInt(process.env["PORT"] ?? "4021", 10);

const app = buildServer();

app.listen(port, () => {
  console.log(`[x402] signal server listening on http://localhost:${port}`);
  console.log(`[x402] payTo = ${process.env["SERVER_WALLET"] ?? "(unset)"}`);
  console.log(
    `[x402] facilitator = ${process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator"}`,
  );
  console.log("[x402] GET /health  — free");
  console.log("[x402] GET /signal  — $0.01 USDC (Solana devnet, exact scheme)");
});
