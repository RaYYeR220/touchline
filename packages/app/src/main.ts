import { makeRpc } from "./chain.js";
import { buildSnapshot } from "./aggregate.js";
import { SEED_SNAPSHOT } from "./seed.js";
import { render } from "./render.js";
import type { ArenaSnapshot } from "./types.js";

const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
const POLL_MS = 10_000;

async function refresh(): Promise<void> {
  let snapshot: ArenaSnapshot;
  try {
    const rpc = makeRpc(RPC_URL);
    snapshot = await buildSnapshot(rpc);
  } catch (err) {
    console.warn("[touchline] live chain read failed, falling back to demo data:", err);
    snapshot = SEED_SNAPSHOT;
  }
  render(snapshot);
}

// Staggered "deal-in" load animation, identical to the approved mockup.
function playDealIn(): void {
  document.querySelectorAll<HTMLElement>(".deal").forEach((el, i) => {
    el.style.animationDelay = `${i * 68}ms`;
  });
}

async function main(): Promise<void> {
  playDealIn();
  await refresh();
  setInterval(() => {
    void refresh();
  }, POLL_MS);
}

void main();
