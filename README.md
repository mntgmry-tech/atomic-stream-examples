# AtomicStream x402 Client Example

A TypeScript WebSocket client for consuming real-time Solana blockchain data streams from [AtomicStream](https://x402.atomicstream.net) using the x402 payment protocol.

## What is x402?

x402 is a protocol that enables machine-to-machine payments using HTTP 402 "Payment Required" responses. When you request a paid resource, the server responds with payment requirements. Your client automatically signs a payment transaction and resubmits the request. This enables:

- **Pay-as-you-go streaming** - Pay only for the data you consume
- **No accounts or API keys** - Your Solana wallet is your identity
- **Automatic renewals** - The client handles payment renewals seamlessly

## Prerequisites

- Node.js 20+
- A Solana wallet with USDC (on mainnet) for payments
- Your wallet's private key in base58 format

## Quick Start

1. **Clone and install**
   ```bash
   git clone https://github.com/your-org/x402-client-example.git
   cd x402-client-example
   npm install
   ```

2. **Configure your environment**
   ```bash
   cp .env.example .env
   ```

3. **Edit `.env`** with your settings:
   ```env
   # Required: Your Solana wallet private key (base58)
   SVM_PRIVATE_KEY=your_base58_private_key

   # Choose a stream (see Available Streams below)
   X402_SCHEMA_PATH=/v1/schema/stream/mempool-sniff

   # For streams that require watchlists
   WATCH_ACCOUNTS=4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   ```

4. **Run the client**
   ```bash
   # Development mode
   npm run dev

   # Or build and run
   npm run build
   npm start
   ```

## Available Streams

All prices are per 5-minute time slice.

| Stream | Description | Price | Required Input |
|--------|-------------|-------|----------------|
| `mempool-sniff` | Processed transactions touching specified accounts/programs | $3.00 | `WATCH_ACCOUNTS` or `WATCH_PROGRAMS` |
| `new-mints` | New SPL/Token-2022 mint initializations | $1.50 | None |
| `whale-alert` | Large SOL/token transfers above USD threshold | $0.60 | None |
| `smart-money` | Transactions signed by watched wallets | $0.60 | `WATCH_ACCOUNTS` |
| `wallet-balance` | Account balance updates for watched wallets | $0.15 | `WATCH_ACCOUNTS` |
| `token-ticker` | Real-time DEX price ticks | $0.15 | None |
| `liquidity-changes` | Add/remove liquidity for a pool | $0.60 | `WATCH_ACCOUNTS` (pool ID) |
| `infrastructure-pulse` | Slot status with TPS metrics | $0.03 | None |
| `sniper-feed` | First swaps in newly created pools | $3.00 | None |
| `rug-detection` | Token authority revocations and burns | $3.00 | None |
| `market-depth` | Pool vault account updates | $0.60 | `WATCH_ACCOUNTS` (pool IDs) |
| `token2022-extensions` | Token-2022 extension instructions | $0.60 | None |
| `program-logs` | Transactions with logs for specified programs | $0.15 | `WATCH_ACCOUNTS` (program IDs) |
| `program-errors` | Failed transactions for specified programs | $0.15 | `WATCH_PROGRAMS` |
| `trending-leaderboard` | Top tokens by USD volume (60s rolling) | $0.15 | None |
| `account-data` | Account change notifications | $0.15 | `WATCH_ACCOUNTS` |

## Configuration Reference

### Required

| Variable | Description |
|----------|-------------|
| `SVM_PRIVATE_KEY` | Your Solana wallet private key (base58 encoded) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_HTTP_BASE_URL` | `https://x402.atomicstream.net` | AtomicStream API endpoint |
| `X402_SCHEMA_PATH` | `/v1/schema/stream/mempool-sniff` | Stream to subscribe to |
| `RENEW_METHOD` | `http` | Payment renewal method: `http` or `inband` |
| `WATCH_ACCOUNTS` | (empty) | Comma-separated accounts to watch |
| `WATCH_PROGRAMS` | (empty) | Comma-separated program IDs to watch |
| `EVENT_FORMAT` | `enhanced` | Output format: `enhanced` or `raw` |
| `INCLUDE_ACCOUNTS` | `true` | Include account keys in events |
| `INCLUDE_TOKEN_BALANCE_CHANGES` | `true` | Include token balance changes |
| `INCLUDE_LOGS` | `false` | Include transaction logs |
| `INCLUDE_INSTRUCTIONS` | `false` | Include parsed instructions |
| `FILTER_TOKEN_BALANCES` | `false` | Filter balances to specific mints |
| `LOG_TRANSACTIONS` | `full` | Logging mode: `full` or `summary` |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## How It Works

### Connection Flow

1. **Request stream schema** - GET `/v1/schema/stream/{stream-id}` triggers a 402 response
2. **Pay for access** - Client signs payment, server returns WebSocket URL with token
3. **Connect to WebSocket** - Establish connection with the provided token
4. **Configure stream** - Send `setAccounts`, `setPrograms`, `setOptions` messages
5. **Receive events** - Stream delivers real-time blockchain data
6. **Auto-renew** - Client handles renewal reminders and payments automatically

### WebSocket Messages

**Outbound (client to server):**

```typescript
// Set accounts to watch
{ "op": "setAccounts", "accounts": ["pubkey1", "pubkey2"] }

// Set programs to watch
{ "op": "setPrograms", "programs": ["programId1"] }

// Configure output options
{
  "op": "setOptions",
  "eventFormat": "enhanced",
  "includeAccounts": true,
  "includeTokenBalanceChanges": true,
  "includeLogs": false,
  "includeInstructions": false,
  "filterTokenBalances": false
}

// Get current state
{ "op": "getState" }

// Renew with new token (after HTTP renewal)
{ "op": "renew_token", "token": "new_token" }
```

**Inbound (server to client):**

```typescript
// Connection established
{ "op": "hello", "clientId": "...", "expiresAt": "...", "sliceSeconds": 300 }

// Renewal reminder (sent before expiry)
{ "op": "renewal_reminder", "expiresAt": "...", "msUntilExpiry": 30000, "renew": {...} }

// Session expired
{ "op": "payment_required", "reason": "expired", "renew": {...} }

// Renewal confirmed
{ "op": "renewed", "expiresAt": "...", "method": "http" }

// Transaction event (enhanced format)
{
  "type": "transaction",
  "commitment": "processed",
  "slot": 392892992,
  "signature": "...",
  "feePayer": "...",
  "nativeTransfers": [...],
  "tokenTransfers": [...],
  "accountData": [...]
}

// Status update
{
  "type": "status",
  "clientId": "...",
  "grpcConnected": true,
  "nodeHealthy": true,
  "watchedAccounts": 5,
  "watchedMints": 0
}
```

## Example Output

```
[2025-01-13T10:30:00.000Z] [client] [info] starting {"httpBase":"https://x402.atomicstream.net","renewMethod":"http","schemaPath":"/v1/schema/stream/mempool-sniff"}
[2025-01-13T10:30:00.100Z] [client] [info] svm signer ready
[2025-01-13T10:30:00.200Z] [client] [info] requesting x402 schema {"url":"https://x402.atomicstream.net/v1/schema/stream/mempool-sniff"}
[2025-01-13T10:30:01.500Z] [client] [info] x402 schema acquired {"wsUrl":"wss://...","streamId":"mempool-sniff"}
[2025-01-13T10:30:01.600Z] [client] [info] connecting websocket {"wsUrl":"wss://...","streamId":"mempool-sniff"}
[2025-01-13T10:30:01.800Z] [client] [info] ws open
[2025-01-13T10:30:01.900Z] [client] [info] setting watch accounts {"count":1}
[2025-01-13T10:30:02.000Z] [client] [info] ws event {"op":"hello"}
[2025-01-13T10:30:05.123Z] [client] [info] transaction {"signature":"3L3RY...","slot":392892992,"commitment":"processed","tokenTransfers":2,"mints":["EPjF..."]}
```

## Wallet Setup

### Exporting Your Private Key

**From Phantom:**
1. Settings > Security & Privacy > Export Private Key
2. Copy the base58 string

**From Solflare:**
1. Settings > Export Private Key
2. Copy the base58 string

**From a Solana CLI keypair file:**

If you have a keypair JSON file from `solana-keygen` (the standard `[u8; 64]` byte array format), use the included conversion script:

```bash
# Convert keypair.json to base58
npm run keypair-to-base58 -- ~/.config/solana/id.json
```

The script outputs the base58-encoded private key. Copy this value into your `.env` file as `SVM_PRIVATE_KEY`.

**Generate a new keypair (for testing):**
```bash
# Generate a new keypair
solana-keygen new --outfile wallet.json

# Convert to base58
npm run keypair-to-base58 -- wallet.json
```

### Funding Your Wallet

The client pays for streams using USDC on Solana mainnet. Ensure your wallet has:
- USDC for stream payments
- A small amount of SOL for transaction fees

## Troubleshooting

### "Missing SVM_PRIVATE_KEY"
Ensure your `.env` file contains a valid base58-encoded Solana private key.

### "x402 schema failed: 402"
Your wallet may not have sufficient USDC balance, or there was an issue signing the payment.

### "no watchlists configured"
Streams like `mempool-sniff` and `smart-money` require `WATCH_ACCOUNTS` or `WATCH_PROGRAMS` to be set.

### WebSocket disconnects
The client handles reconnection automatically. Check your network connection and ensure the token hasn't expired.

## License

MIT
