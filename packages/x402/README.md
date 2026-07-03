# @touchline/x402

A monetized signal API for autonomous agents. Sells the arena's fair-value probability — a Poisson model estimate for binary soccer-stat markets — behind an x402 pay-per-request wall on Solana devnet.

Unpaid requests receive HTTP 402 with payment requirements. Paying clients settle $0.01 USDC on devnet through the public x402.org facilitator; the server returns the signal once the transaction confirms on-chain.

---

## How it works

1. Client sends `GET /signal` with no payment.
2. Server responds HTTP 402 with a `PAYMENT-REQUIRED` header containing payment requirements: scheme `exact`, network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, amount 10 000 raw units ($0.01).
3. Client uses `@x402/fetch` to build a partially-signed SPL `TransferChecked` transaction sending USDC to `SERVER_WALLET`.
4. Client attaches the transaction as an `X-PAYMENT` header and retries the request.
5. x402.org facilitator co-signs as feePayer, broadcasts, and confirms on-chain. The server returns the signal JSON.

No SOL balance required from the payer. The facilitator covers the transaction fee.

---

## Running the server

```sh
SERVER_WALLET=<your-devnet-address> \
RPC_URL=https://devnet.helius-rpc.com/?api-key=... \
PORT=4021 \
tsx packages/x402/src/index.ts
```

Test the unpaid path:

```sh
curl -i http://localhost:4021/signal
# → HTTP 402
```

---

## Running the client

Load your Solana keypair from `~/.config/solana/id.json` (or `WALLET_PATH`) and call the server:

```sh
SERVER_URL=http://localhost:4021 \
RPC_URL=https://devnet.helius-rpc.com/?api-key=... \
tsx packages/x402/src/client.ts
```

The client needs devnet USDC in the wallet. Mint some from the Circle faucet: https://faucet.circle.com — select SOL Devnet and request USDC.

---

## Signal endpoint

`GET /signal` — requires $0.01 USDC payment

Query parameters:

| Name         | Type   | Default       | Description                                      |
|--------------|--------|---------------|--------------------------------------------------|
| `fixtureId`  | int    | 1             | Match fixture ID                                 |
| `statKey`    | int    | 1             | Stat key (1 = P1 goals, 2 = P2 goals)           |
| `threshold`  | float  | 1.5           | Predicate threshold                              |
| `comparison` | string | GreaterThan   | `GreaterThan`, `LessThan`, or `EqualTo`         |
| `p1Goals`    | int    | 0             | Current P1 goals (full game)                     |
| `p2Goals`    | int    | 0             | Current P2 goals (full game)                     |
| `minute`     | int    | 45            | Current match minute (0–90+)                     |
| `lineYesBps` | int    | —             | Market implied YES in basis points (optional)   |

Response:

```json
{
  "probabilityYes": 0.437,
  "recommendation": "under",
  "edgeBps": -63,
  "market": {
    "fixtureId": 42,
    "statKey": 1,
    "predicate": { "threshold": 1.5, "comparison": "GreaterThan" }
  }
}
```

`edgeBps` is `probabilityYes_bps − lineYesBps`. Positive means the model favours YES vs. market; negative means NO.

---

## Environment variables

| Variable        | Required | Default                          | Description                               |
|-----------------|----------|----------------------------------|-------------------------------------------|
| `SERVER_WALLET` | yes      | —                                | Solana address receiving USDC payments    |
| `RPC_URL`       | no       | —                                | Solana RPC endpoint (for the client)      |
| `PORT`          | no       | 4021                             | TCP port for the server                   |
| `FACILITATOR_URL` | no     | https://x402.org/facilitator    | x402 facilitator endpoint                 |
| `WALLET_PATH`   | no       | ~/.config/solana/id.json         | Keypair path for the client               |
| `SERVER_URL`    | no       | http://localhost:4021            | Server base URL for the client            |
