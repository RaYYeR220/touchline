/**
 * Touchline MCP server — exposes arena observation and trading tools so an LLM
 * agent (or any MCP client) can participate in the market.
 *
 * Read-only by default.  Set TOUCHLINE_MCP_ALLOW_WRITES=1 to enable
 * create_market, post_offer, fill_offer, cancel_offer, and settle.
 *
 * Environment variables:
 *   RPC_URL                    Solana RPC endpoint
 *   WALLET_PATH                Path to Solana keypair JSON (write tools only)
 *   TOUCHLINE_MCP_ALLOW_WRITES Set to "1" to enable write tools
 *   NETWORK                    devnet | mainnet (default: devnet)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fetchMarket,
  fetchOffer,
  fetchPosition,
  fetchAllMaybeMarket,
  Side,
  Comparison,
  MarketStatus,
  TOUCHLINE_PROGRAM_ADDRESS,
} from "@touchline/venue-client";
import {
  fairValue,
  buildConfig,
  Executor,
  Keeper,
  DEVNET_ADDRESSES,
} from "@touchline/agent/api";
import type { MarketView, OfferView, PositionView } from "@touchline/agent/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEVNET_EXPLORER = "https://explorer.solana.com/tx";
const MAINNET_EXPLORER = "https://explorer.solana.com/tx";

function explorerLink(sig: string, network: string): string {
  const cluster = network === "mainnet" ? "" : "?cluster=devnet";
  return `${DEVNET_EXPLORER}/${sig}${cluster}`;
}

function writes(): boolean {
  return process.env["TOUCHLINE_MCP_ALLOW_WRITES"] === "1";
}

function writesError(): { content: [{ type: "text"; text: string }] } {
  return {
    content: [
      {
        type: "text" as const,
        text: "Write tools are disabled. Set TOUCHLINE_MCP_ALLOW_WRITES=1 to enable them.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// RPC + signer (lazily initialised, shared across write calls)
// ---------------------------------------------------------------------------

let _rpc: Rpc<SolanaRpcApi> | undefined;
let _rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi> | undefined;
let _signer: TransactionSigner | undefined;
let _executor: Executor | undefined;
let _keeper: Keeper | undefined;
let _network: string = "devnet";

async function getWriteClient(): Promise<{
  executor: Executor;
  keeper: Keeper;
  network: string;
}> {
  if (_executor !== undefined && _keeper !== undefined) {
    return { executor: _executor, keeper: _keeper, network: _network };
  }

  const cfg = buildConfig();
  _network = cfg.network;

  _rpc = createSolanaRpc(cfg.rpcUrl);
  _rpcSubscriptions = createSolanaRpcSubscriptions(cfg.rpcUrl.replace(/^http/, "ws"));

  const walletPath =
    process.env["WALLET_PATH"] ??
    join(homedir(), ".config", "solana", "id.json");
  const raw = readFileSync(walletPath, "utf8");
  const bytes = new Uint8Array(JSON.parse(raw) as number[]);
  _signer = await createKeyPairSignerFromBytes(bytes);

  _executor = new Executor(_rpc, _rpcSubscriptions, _signer, cfg);
  _keeper = new Keeper(_rpc, _rpcSubscriptions, _signer, cfg);

  return { executor: _executor, keeper: _keeper, network: _network };
}

function getRpc(): Rpc<SolanaRpcApi> {
  if (_rpc === undefined) {
    const rpcUrl =
      process.env["RPC_URL"] ?? "https://api.devnet.solana.com";
    _rpc = createSolanaRpc(rpcUrl);
    _network = process.env["NETWORK"] ?? "devnet";
  }
  return _rpc;
}

// ---------------------------------------------------------------------------
// Account projection helpers
// ---------------------------------------------------------------------------

function projectMarket(addr: Address, d: Awaited<ReturnType<typeof fetchMarket>>["data"]): MarketView {
  const comparison =
    d.predicate.comparison === Comparison.GreaterThan
      ? ("GreaterThan" as const)
      : d.predicate.comparison === Comparison.LessThan
        ? ("LessThan" as const)
        : ("EqualTo" as const);
  return {
    address: addr,
    fixtureId: Number(d.fixtureId),
    statKey: d.statKey,
    predicate: { threshold: d.predicate.threshold, comparison },
    status: d.status === MarketStatus.Open ? "Open" : "Settled",
    totalPot: d.totalPot,
    oracleProgram: d.oracleProgram,
  };
}

function projectOffer(addr: Address, d: Awaited<ReturnType<typeof fetchOffer>>["data"]): OfferView {
  return {
    address: addr,
    market: d.market,
    maker: d.maker,
    makerSide: d.makerSide === Side.Yes ? "Yes" : "No",
    priceYesBps: d.priceYesBps,
    remainingPot: d.remainingPot,
  };
}

function projectPosition(addr: Address, d: Awaited<ReturnType<typeof fetchPosition>>["data"]): PositionView {
  return {
    address: addr,
    market: d.market,
    maker: d.maker,
    taker: d.taker,
    makerSide: d.makerSide === Side.Yes ? "Yes" : "No",
    priceYesBps: d.priceYesBps,
    pot: d.pot,
    settled: d.settled,
  };
}

// ---------------------------------------------------------------------------
// Registered tool names (exported for smoke tests)
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  "list_markets",
  "get_market",
  "fair_value",
  "create_market",
  "post_offer",
  "fill_offer",
  "cancel_offer",
  "settle",
] as const;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "touchline",
    version: "0.1.0",
  });

  // ── list_markets ───────────────────────────────────────────────────────────

  server.tool(
    "list_markets",
    "Fetch one or more market accounts by their on-chain addresses. Pass an array of base58 market addresses to inspect. Returns the decoded market state for each address.",
    {
      addresses: z
        .array(z.string())
        .describe("Base58 market account addresses to fetch"),
    },
    async ({ addresses }) => {
      const rpc = getRpc();
      const markets: MarketView[] = [];
      const errors: string[] = [];

      for (const addrStr of addresses) {
        try {
          const addr = addrStr as Address;
          const acct = await fetchMarket(rpc, addr);
          markets.push(projectMarket(addr, acct.data));
        } catch (err) {
          errors.push(`${addrStr}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                markets: markets.map((m) => ({
                  ...m,
                  address: String(m.address),
                  oracleProgram: String(m.oracleProgram),
                  totalPot: m.totalPot.toString(),
                })),
                errors,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── get_market ─────────────────────────────────────────────────────────────

  server.tool(
    "get_market",
    "Fetch a market account plus associated offers and positions. Provide the market address and optional lists of offer/position addresses to decode. Returns market state, offer book, and positions.",
    {
      market: z.string().describe("Base58 market account address"),
      offerAddresses: z
        .array(z.string())
        .optional()
        .describe("Base58 offer account addresses to fetch (optional)"),
      positionAddresses: z
        .array(z.string())
        .optional()
        .describe("Base58 position account addresses to fetch (optional)"),
    },
    async ({ market: marketStr, offerAddresses = [], positionAddresses = [] }) => {
      const rpc = getRpc();
      const marketAddr = marketStr as Address;

      const acct = await fetchMarket(rpc, marketAddr);
      const marketView = projectMarket(marketAddr, acct.data);

      const offers: OfferView[] = [];
      for (const addrStr of offerAddresses) {
        try {
          const oa = await fetchOffer(rpc, addrStr as Address);
          offers.push(projectOffer(addrStr as Address, oa.data));
        } catch {
          // skip missing / invalid accounts
        }
      }

      const positions: PositionView[] = [];
      for (const addrStr of positionAddresses) {
        try {
          const pa = await fetchPosition(rpc, addrStr as Address);
          positions.push(projectPosition(addrStr as Address, pa.data));
        } catch {
          // skip missing / invalid accounts
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                market: {
                  ...marketView,
                  address: String(marketView.address),
                  oracleProgram: String(marketView.oracleProgram),
                  totalPot: marketView.totalPot.toString(),
                },
                offers: offers.map((o) => ({
                  ...o,
                  address: String(o.address),
                  market: String(o.market),
                  maker: String(o.maker),
                  remainingPot: o.remainingPot.toString(),
                })),
                positions: positions.map((p) => ({
                  ...p,
                  address: String(p.address),
                  market: String(p.market),
                  maker: String(p.maker),
                  taker: String(p.taker),
                  pot: p.pot.toString(),
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── fair_value ─────────────────────────────────────────────────────────────

  server.tool(
    "fair_value",
    "Run the deterministic Poisson fair-value model for a binary stat market. Returns the estimated YES probability given the current match state. No network call needed.",
    {
      statKey: z.number().int().describe("Stat key (1=P1 goals, 2=P2 goals, …)"),
      threshold: z.number().int().describe("Predicate threshold value"),
      comparison: z
        .enum(["GreaterThan", "LessThan", "EqualTo"])
        .describe("Predicate comparison operator"),
      p1Goals: z.number().int().default(0).describe("Current P1 goal count"),
      p2Goals: z.number().int().default(0).describe("Current P2 goal count"),
      minute: z.number().default(0).describe("Match minute (0–90)"),
      marketLineBps: z
        .number()
        .int()
        .optional()
        .describe("Optional market line in bps (1–9999) to blend with the model"),
      modelWeight: z
        .number()
        .optional()
        .default(0.5)
        .describe("Model vs market-line blend weight (0–1, default 0.5)"),
    },
    async ({
      statKey,
      threshold,
      comparison,
      p1Goals,
      p2Goals,
      minute,
      marketLineBps,
      modelWeight,
    }) => {
      const state = {
        fixtureId: 0,
        phase: "H1" as const,
        minute,
        p1Goals,
        p2Goals,
        updatedMs: Date.now(),
      };

      const line =
        marketLineBps !== undefined
          ? { fixtureId: 0, statKey, impliedYesBps: marketLineBps, updatedMs: Date.now() }
          : undefined;

      const baseRate: Record<number, number> = {
        1: 1.4,
        2: 1.4,
        3: 2.5,
        4: 2.5,
        5: 0.3,
        6: 0.3,
        7: 5.0,
        8: 5.0,
      };

      const prob = fairValue(
        { statKey, predicate: { threshold, comparison } },
        state,
        line,
        { baseRate, modelWeight: modelWeight ?? 0.5 },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                probability: prob,
                probabilityBps: Math.round(prob * 10_000),
                inputs: { statKey, threshold, comparison, p1Goals, p2Goals, minute, marketLineBps, modelWeight },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── create_market (write) ──────────────────────────────────────────────────

  server.tool(
    "create_market",
    "Create a new binary stat market on-chain. Requires TOUCHLINE_MCP_ALLOW_WRITES=1.",
    {
      fixtureId: z.number().int().describe("TxLINE fixture ID"),
      statKey: z.number().int().describe("Stat key (1=P1 goals, 2=P2 goals, …)"),
      threshold: z.number().int().describe("Predicate threshold value"),
      comparison: z
        .enum(["GreaterThan", "LessThan", "EqualTo"])
        .describe("Predicate comparison operator"),
    },
    async ({ fixtureId, statKey, threshold, comparison }) => {
      if (!writes()) return writesError();
      try {
        const { executor, network } = await getWriteClient();
        const sig = await executor.execute({
          kind: "createMarket",
          fixtureId,
          statKey,
          predicate: { threshold, comparison },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                signature: sig,
                explorer: explorerLink(sig, network),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── post_offer (write) ─────────────────────────────────────────────────────

  server.tool(
    "post_offer",
    "Post a maker offer on an existing market. Requires TOUCHLINE_MCP_ALLOW_WRITES=1.",
    {
      market: z.string().describe("Base58 market account address"),
      side: z.enum(["Yes", "No"]).describe("Maker side"),
      priceYesBps: z
        .number()
        .int()
        .min(1)
        .max(9999)
        .describe("Implied YES price in bps (1–9999)"),
      pot: z
        .string()
        .describe("Total pot in USDC base units (6 decimals), as a string integer"),
    },
    async ({ market, side, priceYesBps, pot }) => {
      if (!writes()) return writesError();
      try {
        const { executor, network } = await getWriteClient();
        const sig = await executor.execute({
          kind: "postOffer",
          market: market as Address,
          side,
          priceYesBps,
          pot: BigInt(pot),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                signature: sig,
                explorer: explorerLink(sig, network),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── fill_offer (write) ─────────────────────────────────────────────────────

  server.tool(
    "fill_offer",
    "Fill an existing offer (take the opposite side). Requires TOUCHLINE_MCP_ALLOW_WRITES=1.",
    {
      offerAddress: z.string().describe("Base58 offer account address"),
      marketAddress: z.string().describe("Base58 market account address"),
      makerAddress: z.string().describe("Base58 maker wallet address"),
      makerSide: z.enum(["Yes", "No"]).describe("The maker's side on this offer"),
      priceYesBps: z.number().int().min(1).max(9999).describe("Offer price in bps"),
      remainingPot: z.string().describe("Remaining pot in USDC base units (string integer)"),
      fillPot: z.string().describe("Amount to fill in USDC base units (string integer)"),
    },
    async ({ offerAddress, marketAddress, makerAddress, makerSide, priceYesBps, remainingPot, fillPot }) => {
      if (!writes()) return writesError();
      try {
        const { executor, network } = await getWriteClient();
        const offerView: OfferView = {
          address: offerAddress as Address,
          market: marketAddress as Address,
          maker: makerAddress as Address,
          makerSide,
          priceYesBps,
          remainingPot: BigInt(remainingPot),
        };
        const sig = await executor.execute({
          kind: "fillOffer",
          offer: offerView,
          fillPot: BigInt(fillPot),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                signature: sig,
                explorer: explorerLink(sig, network),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── cancel_offer (write) ───────────────────────────────────────────────────

  server.tool(
    "cancel_offer",
    "Cancel a maker offer and return the locked stake. Requires TOUCHLINE_MCP_ALLOW_WRITES=1.",
    {
      offerAddress: z.string().describe("Base58 offer account address"),
      marketAddress: z.string().describe("Base58 market account address"),
      makerAddress: z.string().describe("Base58 maker wallet address"),
      makerSide: z.enum(["Yes", "No"]).describe("The maker's side on this offer"),
      priceYesBps: z.number().int().min(1).max(9999).describe("Offer price in bps"),
      remainingPot: z.string().describe("Remaining pot in USDC base units (string integer)"),
    },
    async ({ offerAddress, marketAddress, makerAddress, makerSide, priceYesBps, remainingPot }) => {
      if (!writes()) return writesError();
      try {
        const { executor, network } = await getWriteClient();
        const offerView: OfferView = {
          address: offerAddress as Address,
          market: marketAddress as Address,
          maker: makerAddress as Address,
          makerSide,
          priceYesBps,
          remainingPot: BigInt(remainingPot),
        };
        const sig = await executor.execute({
          kind: "cancelOffer",
          offer: offerView,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                signature: sig,
                explorer: explorerLink(sig, network),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── settle (write) ─────────────────────────────────────────────────────────

  server.tool(
    "settle",
    "Settle a position using the venue oracle. Provide the position and market addresses plus the actual stat outcome. Requires TOUCHLINE_MCP_ALLOW_WRITES=1.",
    {
      positionAddress: z.string().describe("Base58 position account address"),
      marketAddress: z.string().describe("Base58 market account address"),
      statValue: z.number().int().describe("Actual stat outcome value (e.g. number of goals scored)"),
    },
    async ({ positionAddress, marketAddress, statValue }) => {
      if (!writes()) return writesError();
      try {
        const { keeper, network } = await getWriteClient();
        const posView = await keeper.fetchPositionView(positionAddress as Address);
        const mktView = await keeper.fetchMarketView(marketAddress as Address);
        const sig = await keeper.settle(posView, mktView, statValue);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                signature: sig,
                explorer: explorerLink(sig, network),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  return server;
}
