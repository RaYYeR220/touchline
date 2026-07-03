#!/usr/bin/env node
/**
 * Touchline MCP server — stdio transport entry-point.
 *
 * Register with an MCP client:
 *
 *   {
 *     "mcpServers": {
 *       "touchline": {
 *         "command": "npx",
 *         "args": ["tsx", "packages/mcp/src/index.ts"],
 *         "env": {
 *           "RPC_URL": "https://api.devnet.solana.com",
 *           "WALLET_PATH": "/path/to/solana/id.json",
 *           "TOUCHLINE_MCP_ALLOW_WRITES": "1"
 *         }
 *       }
 *     }
 *   }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const server = createMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);
