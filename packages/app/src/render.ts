import type { ArenaSnapshot, MarketRow, TapeRow } from "./types.js";

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el;
}

function setText(id: string, text: string): void {
  byId(id).textContent = text;
}

/**
 * Defense in depth: every value rendered below is either a fixed local
 * constant (fixture/stat-name maps) or a formatted number, never a free-text
 * field from an account (the venue program's Market/Offer/Position accounts
 * only hold pubkeys, enums and integers). Still, since it's a permissionless
 * on-chain program, escape anything interpolated into innerHTML rather than
 * assume that stays true forever.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sparkSvg(points: number[], color: string): string {
  const w = 112;
  const h = 26;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - 3 - ((v - min) / range) * (h - 6);
    return [x, y] as const;
  });
  const poly = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1] ?? [w, h / 2];
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${color}"/>` +
    `</svg>`
  );
}

function renderStats(s: ArenaSnapshot): void {
  setText("stat-volume", s.stats.volume);
  setText("stat-oi", s.stats.openInterest);
  setText("stat-active", s.stats.activeMarkets);
  setText("stat-agents", s.stats.agentsOnline);
  setText("stat-settled", s.stats.totalSettled);
}

function renderMatches(s: ArenaSnapshot): void {
  setText("matches-count", String(s.matches.length));
  const container = byId("matches-list");
  container.innerHTML = s.matches
    .map((m) => {
      const [homeCode, awayCode] = m.code.split("–");
      return `
      <div class="ticket match-ticket deal">
        <div class="notch-top"></div><div class="notch-bottom"></div>
        <div class="match-top"><span class="half-stamp">${esc(m.statusLabel)}</span><span class="minute">${esc(m.sub)}</span></div>
        <div class="teams"><span>${esc(homeCode ?? m.code)}</span><span class="score">${esc(m.scoreLike)}</span><span>${esc(awayCode ?? "")}</span></div>
        <div class="team-names"><span>${esc(m.home)}</span><span>${esc(m.away)}</span></div>
      </div>`;
    })
    .join("");
}

function renderSettlements(s: ArenaSnapshot): void {
  const container = byId("settlements-list");
  if (s.settlements.length === 0) {
    container.innerHTML = `<div class="ticket settle-ticket deal"><div class="notch-top"></div><div class="notch-bottom"></div>
      <div class="settle-top"><div><div class="settle-fixture">—</div><div class="settle-market">No settlements yet</div></div></div></div>`;
    return;
  }
  container.innerHTML = s.settlements
    .map(
      (st) => `
      <div class="ticket settle-ticket deal">
        <div class="notch-top"></div><div class="notch-bottom"></div>
        <div class="settle-top">
          <div>
            <div class="settle-fixture">${esc(st.fixtureCode)}</div>
            <div class="settle-market">${esc(st.marketDesc)} &rarr; <span class="won">${esc(st.wonLabel)}</span></div>
          </div>
          <div class="stamp">SETTLED</div>
        </div>
        <div class="settle-bottom">
          <span class="settle-paid">${esc(st.paid)}</span>
          <a class="settle-tx" href="${esc(st.txUrl)}" target="_blank" rel="noopener">${esc(st.txLabel)}</a>
        </div>
      </div>`,
    )
    .join("");
}

function renderMarketRow(m: MarketRow): string {
  const color = m.fairPct >= 50 ? "#1c4c73" : "#8f1d3a";
  const linePct = m.linePct === null ? "—" : `${m.linePct}%`;
  return `
    <div class="mkt-row">
      <span class="fixture-code">${esc(m.fixtureCode)}</span>
      <span class="market-desc">${esc(m.desc)}</span>
      <span class="pct fair">${m.fairPct}%</span>
      <span class="pct line">${esc(linePct)}</span>
      <span class="spark-cell">${sparkSvg(m.spark, color)}</span>
    </div>`;
}

function renderMarkets(s: ArenaSnapshot): void {
  const container = byId("markets-rows");
  container.innerHTML =
    s.markets.length === 0
      ? `<div class="mkt-row"><span class="market-desc">No open markets right now.</span></div>`
      : s.markets.map(renderMarketRow).join("");
}

function renderDuel(s: ArenaSnapshot): void {
  setText("aegis-pnl", s.aegis.pnl);
  byId("aegis-pnl").classList.toggle("pnl-pos", s.aegis.pnlPositive);
  setText("aegis-exposure", s.aegis.exposure);
  setText("aegis-stat-label", s.aegis.statLabel);
  setText("aegis-stat-value", s.aegis.statValue);
  setText("aegis-risk-label", s.aegis.riskLabel);
  (byId("aegis-risk-fill") as HTMLDivElement).style.width = `${s.aegis.riskPct}%`;

  setText("vane-pnl", s.vane.pnl);
  byId("vane-pnl").classList.toggle("pnl-pos", s.vane.pnlPositive);
  setText("vane-stat-label", s.vane.statLabel);
  setText("vane-stat-value", s.vane.statValue);
  setText("vane-extra-label", s.vane.extraLabel ?? "");
  setText("vane-extra-value", s.vane.extraValue ?? "");
  setText("vane-risk-label", s.vane.riskLabel);
  (byId("vane-risk-fill") as HTMLDivElement).style.width = `${s.vane.riskPct}%`;
}

function renderTapeRow(t: TapeRow): string {
  const agentClass = t.agent === "AEGIS" ? "a-aegis" : "a-vane";
  return `
    <div class="tape-row">
      <span class="tape-agent ${agentClass}">${esc(t.agent)}</span>
      <span class="tape-action ${t.action}">${esc(t.action)}</span>
      <span class="tape-detail">${esc(t.detail)}</span>
      <span class="tape-amt">${esc(t.amount)}</span>
    </div>`;
}

function renderTape(s: ArenaSnapshot): void {
  const container = byId("tape-rows");
  container.innerHTML =
    s.tape.length === 0
      ? `<div class="tape-row"><span class="tape-detail">No activity yet.</span></div>`
      : s.tape.map(renderTapeRow).join("");
}

function renderExposure(s: ArenaSnapshot): void {
  const container = byId("expo-rows");
  container.innerHTML =
    s.exposure.length === 0
      ? `<div class="expo-row"><span class="k">—</span><span class="v">$0</span></div>`
      : s.exposure
          .map((e) => `<div class="expo-row"><span class="k">${esc(e.fixtureCode)}</span><span class="v">${esc(e.amount)}</span></div>`)
          .join("");
}

function renderRisk(s: ArenaSnapshot): void {
  setText("risk-aegis-exp-label", s.risk.aegis.exposureLabel);
  (byId("risk-aegis-exp-fill") as HTMLDivElement).style.width = `${s.risk.aegis.exposurePct}%`;
  setText("risk-aegis-headroom-label", s.risk.aegis.headroomLabel);
  (byId("risk-aegis-headroom-fill") as HTMLDivElement).style.width = `${s.risk.aegis.headroomPct}%`;

  setText("risk-vane-exp-label", s.risk.vane.exposureLabel);
  (byId("risk-vane-exp-fill") as HTMLDivElement).style.width = `${s.risk.vane.exposurePct}%`;
  setText("risk-vane-headroom-label", s.risk.vane.headroomLabel);
  (byId("risk-vane-headroom-fill") as HTMLDivElement).style.width = `${s.risk.vane.headroomPct}%`;
}

function renderSourceIndicator(s: ArenaSnapshot): void {
  const el = byId("source-indicator");
  el.textContent = s.sourceLabel;
  el.style.color = s.live ? "var(--stamp-green)" : "var(--stamp-red)";
  el.style.borderColor = s.live ? "var(--stamp-green)" : "var(--stamp-red)";
}

export function render(snapshot: ArenaSnapshot): void {
  renderSourceIndicator(snapshot);
  renderStats(snapshot);
  renderMatches(snapshot);
  renderSettlements(snapshot);
  renderMarkets(snapshot);
  renderDuel(snapshot);
  renderTape(snapshot);
  renderExposure(snapshot);
  renderRisk(snapshot);
}
