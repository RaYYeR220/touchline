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
  requestAnimationFrame(fitPanels);
}

// Size the Matches & Settlements panels to show EXACTLY 3 whole tickets, so
// scroll-snap moves one ticket at a time and nothing is ever clipped. Measured
// from the real item height (robust to font load / content), gap = 22px.
function fitThree(id: string, visible = 3, gap = 22, vPad = 18): void {
  const box = document.getElementById(id);
  const first = box?.firstElementChild as HTMLElement | null;
  if (!box || !first) return;
  const itemH = first.getBoundingClientRect().height;
  if (itemH > 4) box.style.height = `${Math.round(itemH * visible + gap * (visible - 1) + vPad)}px`;
}
function fitPanels(): void {
  fitThree("matches-list");
  fitThree("settlements-list");
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
  // Re-fit once webfonts settle (they change ticket height slightly) and on resize.
  document.fonts?.ready.then(fitPanels).catch(() => {});
  window.addEventListener("resize", fitPanels);
  setInterval(() => {
    void refresh();
  }, POLL_MS);
}

void main();
