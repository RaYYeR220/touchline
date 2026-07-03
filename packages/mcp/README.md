# @touchline/mcp

An MCP (Model Context Protocol) server that lets any MCP-capable LLM agent observe and trade in the Touchline on-chain prediction market arena.

## What it exposes

| Tool | Mode | Description |
|---|---|---|
| `list_markets` | read | Fetch market accounts by address |
| `get_market` | read | Market state + associated offers and positions |
| `fair_value` | read | Poisson probability estimate (no network call) |
| `create_market` | write | Create a new binary stat market |
| `post_offer` | write | Post a maker offer |
| `fill_offer` | write | Take the opposite side of an existing offer |
| `cancel_offer` | write | Cancel a maker offer and recover stake |
| `settle` | write | Settle a position via the oracle |

Write tools are disabled by default. Set `TOUCHLINE_MCP_ALLOW_WRITES=1` to enable them. This makes it safe to list and call tools without risking accidental trades.

## Register with an MCP client

Add to your MCP client configuration (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "touchline": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/index.ts"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "WALLET_PATH": "/home/you/.config/solana/id.json",
        "TOUCHLINE_MCP_ALLOW_WRITES": "1"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `WALLET_PATH` | `~/.config/solana/id.json` | Wallet keypair JSON (write tools only) |
| `NETWORK` | `devnet` | `devnet` or `mainnet` (affects explorer links) |
| `TOUCHLINE_MCP_ALLOW_WRITES` | *(unset)* | Set to `"1"` to enable write tools |

## Read-only by default

The server starts in read-only mode. All write tools (`create_market`, `post_offer`, `fill_offer`, `cancel_offer`, `settle`) respond with an explanatory error unless `TOUCHLINE_MCP_ALLOW_WRITES=1` is set. The wallet file is not loaded until the first write call.

## Security: write mode is devnet/testing only

**IMPORTANT — never run with `TOUCHLINE_MCP_ALLOW_WRITES=1` against mainnet or a real-value mint.**

The `settle` tool calls a permissionless mock-oracle instruction that lets any caller decide the outcome of any market by supplying an arbitrary stat value. This design is intentional for devnet testing but creates an obvious critical risk on mainnet: anyone with MCP write access could drain all funds by faking outcomes.

When enabling write mode, verify:
- `RPC_URL` points to **devnet** (`https://api.devnet.solana.com` or similar)
- The collateral mint (`usdcMint` in agent config) is a throwaway test token with no real value
- The wallet keypair has no real funds on mainnet

The server logs a warning to stderr at startup whenever write mode is active.
