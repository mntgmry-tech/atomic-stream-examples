import 'dotenv/config'
import WebSocket from 'ws'

import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
import { ExactSvmScheme, SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2, SOLANA_TESTNET_CAIP2 } from '@x402/svm'
import { ExactSvmSchemeV1 } from '@x402/svm/v1'
import { createKeyPairSignerFromBytes } from '@solana/kit'
import bs58 from 'bs58'

// =============================================================================
// Configuration
// =============================================================================

const HTTP_BASE = process.env.PUBLIC_HTTP_BASE_URL ?? 'https://x402.atomicstream.net'
const X402_SCHEMA_PATH = process.env.X402_SCHEMA_PATH ?? '/v1/schema/stream/mempool-sniff'
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY
const RENEW_METHOD = parseRenewMethod(process.env.RENEW_METHOD)

// Stream options
const WATCH_ACCOUNTS = parseList(process.env.WATCH_ACCOUNTS)
const WATCH_PROGRAMS = parseList(process.env.WATCH_PROGRAMS)
const INCLUDE_ACCOUNTS = parseBoolean(process.env.INCLUDE_ACCOUNTS, true)
const INCLUDE_TOKEN_BALANCE_CHANGES = parseBoolean(process.env.INCLUDE_TOKEN_BALANCE_CHANGES, true)
const INCLUDE_LOGS = parseBoolean(process.env.INCLUDE_LOGS, false)
const INCLUDE_INSTRUCTIONS = parseBoolean(process.env.INCLUDE_INSTRUCTIONS, false)
const FILTER_TOKEN_BALANCES = parseBoolean(process.env.FILTER_TOKEN_BALANCES, false)
const EVENT_FORMAT = parseEventFormat(process.env.EVENT_FORMAT) ?? 'enhanced'
const TX_LOG_MODE = parseTxLogMode(process.env.LOG_TRANSACTIONS)

// =============================================================================
// Types
// =============================================================================

type RenewMethod = 'http' | 'inband'
type X402SchemaVersion = 'v1' | 'v2'
type EventFormat = 'raw' | 'enhanced'
type TxLogMode = 'summary' | 'full'
type CommitmentLabel = 'processed' | 'confirmed'
type UnknownRecord = Record<string, unknown>

type RenewResponse = { token: string; expiresAt: string; sliceSeconds: number }

type Ws402StreamInfo = {
  id: string
  title: string
  description: string
}

type Ws402StreamSchema = {
  protocol: 'ws402'
  version: '1'
  websocketEndpoint: string
  pricing: {
    pricePerSecond: number
    currency: string
    estimatedDuration: number
  }
  paymentDetails: {
    scheme: 'exact'
    network: string
    asset: string
    payTo: string
    maxAmountRequired: string
    maxTimeoutSeconds: number
  }
  stream: Ws402StreamInfo
}

type NativeTransfer = {
  fromUserAccount: string
  toUserAccount: string
  amount: number
}

type TokenTransfer = {
  fromTokenAccount: string
  toTokenAccount: string
  fromUserAccount: string
  toUserAccount: string
  tokenAmount: number
  mint: string
  tokenStandard: string
}

type RawTokenAmount = {
  tokenAmount: string
  decimals: number
}

type TokenBalanceChange = {
  userAccount: string
  tokenAccount: string
  rawTokenAmount: RawTokenAmount
  mint: string
}

type AccountData = {
  account: string
  nativeBalanceChange: number
  tokenBalanceChanges: TokenBalanceChange[]
}

type YellowstoneTokenBalanceChange = {
  account: string
  mint: string
  owner?: string
  decimals: number
  preAmount: string
  preAmountUi: string
  postAmount: string
  postAmountUi: string
  delta: string
  deltaUi: string
}

type EnhancedTransactionEvent = {
  type: 'transaction'
  commitment: CommitmentLabel
  slot: number
  signature: string
  timestamp: number | null
  isVote: boolean
  index: number
  err: object | null
  fee: number
  feePayer: string
  accounts?: string[]
  nativeTransfers: NativeTransfer[]
  tokenTransfers: TokenTransfer[]
  accountData: AccountData[]
  computeUnitsConsumed: number
  logs?: string[]
}

type RawTransactionEvent = {
  type: 'transaction'
  commitment: CommitmentLabel
  slot: number
  signature: string
  isVote: boolean
  index: number
  err: object | null
  accounts?: string[]
  tokenBalanceChanges?: YellowstoneTokenBalanceChange[]
  logs?: string[]
  computeUnitsConsumed: number
}

type WsStatusEvent = {
  type: 'status'
  clientId?: string
  now: string
  grpcConnected: boolean
  nodeHealthy: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  watchedAccounts: number
  watchedMints: number
}

type WsTransactionEvent = EnhancedTransactionEvent | RawTransactionEvent

type WsAccountEvent = {
  type: 'account'
  stream: string
  pubkey: string
  owner: string
  lamports: string
  executable: boolean
  rentEpoch: string
  data: string
  dataEncoding: 'base64' | 'hex'
  writeVersion: string
  slot: number
  txnSignature?: string
}

type WsSlotEvent = {
  type: 'slot'
  stream: 'infrastructure-pulse'
  slot: number
  parent?: number
  status: string
  tps?: number
  samplePeriodSeconds?: number
  sampleTransactions?: number
  sampleSlots?: number
  sampleSlot?: number
}

type WsTickerEvent = {
  type: 'ticker'
  baseMint: string
  quoteMint: string
  price: number
  dex: string
  slot: number
  signature: string
}

type WsLeaderboardEvent = {
  type: 'leaderboard'
  windowSeconds: number
  intervalSeconds: number
  asOf: string
  items: Array<{ mint: string; volumeUsd: number }>
}

type RenewHints = {
  http: { endpoint: string; method: 'POST'; priceHint: string }
  inband: { challengeEndpoint: string; method: 'POST'; priceHint: string }
}

type WsX402Event =
  | { op: 'hello'; clientId: string; expiresAt: string; sliceSeconds: number }
  | { op: 'renewal_reminder'; expiresAt: string; msUntilExpiry: number; renew: RenewHints }
  | { op: 'payment_required'; reason: 'expired'; renew: RenewHints }
  | { op: 'renewed'; expiresAt: string; method: 'http' | 'inband' }
  | { op: 'error'; message: string }

// =============================================================================
// Logging
// =============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const configuredLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
const minLevel = levelOrder[configuredLevel] ?? levelOrder.info

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= minLevel
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return ''
  try {
    return JSON.stringify(meta)
  } catch {
    return '"[unserializable]"'
  }
}

function log(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog(level)) return
  const ts = new Date().toISOString()
  const metaText = formatMeta(meta)
  const line = `[${ts}] [${scope}] [${level}] ${message}${metaText ? ` ${metaText}` : ''}`

  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

function logInfo(scope: string, message: string, meta?: Record<string, unknown>) {
  log('info', scope, message, meta)
}

function logWarn(scope: string, message: string, meta?: Record<string, unknown>) {
  log('warn', scope, message, meta)
}

function logError(scope: string, message: string, meta?: Record<string, unknown>) {
  log('error', scope, message, meta)
}

// =============================================================================
// Parsing Utilities
// =============================================================================

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRenewMethod(value: string | undefined): RenewMethod {
  return value === 'inband' ? 'inband' : 'http'
}

function parseSchemaVersion(schemaPath: string): X402SchemaVersion {
  const rawPath = (() => {
    if (!schemaPath.startsWith('http://') && !schemaPath.startsWith('https://')) {
      return schemaPath
    }
    try {
      return new URL(schemaPath).pathname
    } catch {
      return schemaPath
    }
  })()
  const match = rawPath.match(/^\/(v1|v2)\//)
  return match ? (match[1] as X402SchemaVersion) : 'v1'
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return fallback
}

function parseEventFormat(value: string | undefined): EventFormat | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase()
  return normalized === 'raw' || normalized === 'enhanced' ? normalized : undefined
}

function parseTxLogMode(value: string | undefined): TxLogMode {
  if (!value) return 'full'
  const normalized = value.toLowerCase()
  if (normalized === 'full' || normalized === 'summary') {
    return normalized
  }
  return 'full'
}

// =============================================================================
// Type Guards
// =============================================================================

function isWsStatusEvent(value: unknown): value is WsStatusEvent {
  if (!isRecord(value)) return false
  return value.type === 'status' && typeof value.now === 'string'
}

function isWsTransactionEvent(value: unknown): value is WsTransactionEvent {
  if (!isRecord(value)) return false
  return value.type === 'transaction' && typeof value.signature === 'string'
}

function isWsAccountEvent(value: unknown): value is WsAccountEvent {
  if (!isRecord(value)) return false
  return value.type === 'account' && typeof value.pubkey === 'string'
}

function isWsSlotEvent(value: unknown): value is WsSlotEvent {
  if (!isRecord(value)) return false
  return value.type === 'slot' && typeof value.slot === 'number'
}

function isWsTickerEvent(value: unknown): value is WsTickerEvent {
  if (!isRecord(value)) return false
  return value.type === 'ticker' && typeof value.baseMint === 'string'
}

function isWsLeaderboardEvent(value: unknown): value is WsLeaderboardEvent {
  if (!isRecord(value)) return false
  return value.type === 'leaderboard' && Array.isArray(value.items)
}

function isEnhancedTransactionEvent(value: WsTransactionEvent): value is EnhancedTransactionEvent {
  return 'nativeTransfers' in value
}

function isWsX402Event(value: unknown): value is WsX402Event {
  if (!isRecord(value)) return false
  if (typeof value.op !== 'string') return false
  return ['hello', 'renewal_reminder', 'payment_required', 'renewed', 'error'].includes(value.op)
}

function isRenewResponse(value: unknown): value is RenewResponse {
  if (!isRecord(value)) return false
  return typeof value.token === 'string' && typeof value.expiresAt === 'string' && typeof value.sliceSeconds === 'number'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isWs402StreamSchema(value: unknown): value is Ws402StreamSchema {
  if (!isRecord(value)) return false
  if (value.protocol !== 'ws402') return false
  if (value.version !== '1') return false
  if (!isString(value.websocketEndpoint)) return false
  if (!isRecord(value.pricing) || !isRecord(value.paymentDetails)) return false

  const pricing = value.pricing as Record<string, unknown>
  if (
    !isNumber(pricing.pricePerSecond) ||
    !isString(pricing.currency) ||
    !isNumber(pricing.estimatedDuration)
  ) {
    return false
  }

  const details = value.paymentDetails as Record<string, unknown>
  if (
    details.scheme !== 'exact' ||
    !isString(details.network) ||
    !isString(details.asset) ||
    !isString(details.payTo) ||
    !isString(details.maxAmountRequired) ||
    !isNumber(details.maxTimeoutSeconds)
  ) {
    return false
  }

  if (!isRecord(value.stream)) return false
  const stream = value.stream as Record<string, unknown>
  return isString(stream.id) && isString(stream.title) && isString(stream.description)
}

function isPaymentRequired(value: unknown): value is { accepts: unknown[] } {
  if (!isRecord(value)) return false
  return Array.isArray(value.accepts) && value.accepts.length > 0
}

// =============================================================================
// Transaction Summarizers
// =============================================================================

function summarizeRawTransaction(event: RawTransactionEvent): UnknownRecord {
  const mints = new Set<string>()
  for (const change of event.tokenBalanceChanges ?? []) {
    if (change.mint) mints.add(change.mint)
  }
  return {
    signature: event.signature,
    slot: event.slot,
    commitment: event.commitment,
    tokenBalanceChanges: event.tokenBalanceChanges?.length ?? 0,
    mints: [...mints].slice(0, 5)
  }
}

function summarizeEnhancedTransaction(event: EnhancedTransactionEvent): UnknownRecord {
  const mints = new Set<string>()
  for (const transfer of event.tokenTransfers) {
    if (transfer.mint) mints.add(transfer.mint)
  }
  for (const change of event.accountData) {
    for (const tokenChange of change.tokenBalanceChanges) {
      if (tokenChange.mint) mints.add(tokenChange.mint)
    }
  }
  return {
    signature: event.signature,
    slot: event.slot,
    commitment: event.commitment,
    tokenTransfers: event.tokenTransfers.length,
    mints: [...mints].slice(0, 5)
  }
}

// =============================================================================
// URL Helpers
// =============================================================================

function parseTokenFromWsUrl(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl)
    return parsed.searchParams.get('t') ?? ''
  } catch {
    return ''
  }
}

function buildRenewUrl(httpBase: string, streamId: string, version: X402SchemaVersion): string {
  return new URL(`/${version}/renew/stream/${streamId}`, httpBase).toString()
}

// =============================================================================
// Client Setup
// =============================================================================

async function createClient() {
  if (!SVM_PRIVATE_KEY) {
    throw new Error('Missing SVM_PRIVATE_KEY environment variable')
  }

  const signer = await createKeyPairSignerFromBytes(bs58.decode(SVM_PRIVATE_KEY))
  const client = new x402Client()
  const schemeV1 = new ExactSvmSchemeV1(signer)
  const schemeV2 = new ExactSvmScheme(signer)
  const v2Networks = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2] as const
  const v1Networks = new Set<string>(['solana', 'solana-devnet', 'solana-testnet', ...v2Networks])
  for (const network of v1Networks) {
    client.registerV1(network, schemeV1)
  }
  for (const network of v2Networks) {
    client.register(network, schemeV2)
  }
  logInfo('client', 'svm signer ready')
  return client
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// =============================================================================
// x402 Schema & Renewal
// =============================================================================

async function requestWs402Schema(
  fetchWithPayment: typeof fetch,
  httpBase: string
): Promise<{ wsUrl: string; token: string; streamId: string }> {
  const url = new URL(X402_SCHEMA_PATH, httpBase).toString()
  logInfo('client', 'requesting x402 schema', { url })
  const resp = await fetchWithPayment(url, { method: 'GET' })
  if (!resp.ok) throw new Error(`x402 schema failed: ${resp.status}`)
  const data = await resp.json()
  if (!isWs402StreamSchema(data)) {
    throw new Error('x402 schema response shape invalid')
  }
  const wsUrl = data.websocketEndpoint
  const token = parseTokenFromWsUrl(wsUrl)
  if (!token) {
    throw new Error('x402 schema missing token')
  }
  logInfo('client', 'x402 schema acquired', { wsUrl, streamId: data.stream.id })
  return { wsUrl, token, streamId: data.stream.id }
}

async function httpRenew(
  fetchWithPayment: typeof fetch,
  renewUrl: string,
  oldToken: string
): Promise<RenewResponse> {
  logInfo('client', 'requesting http renew', { url: renewUrl })
  const resp = await fetchWithPayment(renewUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: oldToken })
  })
  if (!resp.ok) throw new Error(`renew failed: ${resp.status}`)
  const data = await resp.json()
  if (!isRenewResponse(data)) {
    throw new Error('renew response shape invalid')
  }
  logInfo('client', 'http renew ok', { expiresAt: data.expiresAt, sliceSeconds: data.sliceSeconds })
  return data
}

async function inbandRenewChallenge(renewUrl: string, oldToken: string, httpClient: x402HTTPClient) {
  const resp = await fetch(renewUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: oldToken })
  })

  if (resp.status !== 402) throw new Error(`expected 402 challenge, got ${resp.status}`)

  const decoded = await resp.json().catch(() => undefined)
  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => resp.headers.get(name), decoded)
  if (!isPaymentRequired(paymentRequired)) {
    throw new Error('payment-required response shape invalid')
  }
  logInfo('client', 'received inband challenge', { accepts: paymentRequired.accepts.length })
  return paymentRequired
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main() {
  logInfo('client', 'starting', { httpBase: HTTP_BASE, renewMethod: RENEW_METHOD, schemaPath: X402_SCHEMA_PATH })
  const client = await createClient()
  const fetchWithPayment = wrapFetchWithPayment(fetch, client)
  const httpClient = new x402HTTPClient(client)
  const schemaVersion = parseSchemaVersion(X402_SCHEMA_PATH)

  const schema = await requestWs402Schema(fetchWithPayment, HTTP_BASE)
  let currentToken = schema.token
  const renewUrl = buildRenewUrl(HTTP_BASE, schema.streamId, schemaVersion)

  logInfo('client', 'connecting websocket', { wsUrl: schema.wsUrl, streamId: schema.streamId })
  const ws = new WebSocket(schema.wsUrl)

  ws.on('open', () => {
    logInfo('client', 'ws open')
    logInfo('client', 'setting options', {
      includeAccounts: INCLUDE_ACCOUNTS,
      includeTokenBalanceChanges: INCLUDE_TOKEN_BALANCE_CHANGES,
      includeLogs: INCLUDE_LOGS,
      includeInstructions: INCLUDE_INSTRUCTIONS,
      eventFormat: EVENT_FORMAT,
      filterTokenBalances: FILTER_TOKEN_BALANCES
    })
    ws.send(
      JSON.stringify({
        op: 'setOptions',
        includeAccounts: INCLUDE_ACCOUNTS,
        includeTokenBalanceChanges: INCLUDE_TOKEN_BALANCE_CHANGES,
        includeLogs: INCLUDE_LOGS,
        includeInstructions: INCLUDE_INSTRUCTIONS,
        eventFormat: EVENT_FORMAT,
        filterTokenBalances: FILTER_TOKEN_BALANCES
      })
    )
    if (WATCH_ACCOUNTS.length) {
      logInfo('client', 'setting watch accounts', { count: WATCH_ACCOUNTS.length })
      ws.send(JSON.stringify({ op: 'setAccounts', accounts: WATCH_ACCOUNTS }))
    }
    if (WATCH_PROGRAMS.length) {
      logInfo('client', 'setting watch programs', { count: WATCH_PROGRAMS.length })
      ws.send(JSON.stringify({ op: 'setPrograms', programs: WATCH_PROGRAMS }))
    }
    if (!WATCH_ACCOUNTS.length && !WATCH_PROGRAMS.length) {
      logWarn('client', 'no watchlists configured (WATCH_ACCOUNTS/WATCH_PROGRAMS empty)')
    }
    ws.send(JSON.stringify({ op: 'getState' }))
  })

  ws.on('message', async (buf) => {
    const decoded = safeJsonParse(buf.toString('utf8'))
    if (isWsStatusEvent(decoded)) {
      logInfo('client', 'status', {
        clientId: decoded.clientId,
        grpcConnected: decoded.grpcConnected,
        nodeHealthy: decoded.nodeHealthy,
        watchedAccounts: decoded.watchedAccounts,
        watchedMints: decoded.watchedMints
      })
      return
    }

    if (isWsTransactionEvent(decoded)) {
      if (TX_LOG_MODE === 'full') {
        logInfo('client', 'transaction', { event: decoded })
        return
      }
      const summary = isEnhancedTransactionEvent(decoded)
        ? summarizeEnhancedTransaction(decoded)
        : summarizeRawTransaction(decoded)
      logInfo('client', 'transaction', summary)
      return
    }

    if (isWsAccountEvent(decoded)) {
      logInfo('client', 'account', {
        pubkey: decoded.pubkey,
        owner: decoded.owner,
        slot: decoded.slot,
        encoding: decoded.dataEncoding
      })
      return
    }

    if (isWsSlotEvent(decoded)) {
      logInfo('client', 'slot', { slot: decoded.slot, parent: decoded.parent, status: decoded.status })
      return
    }

    if (isWsTickerEvent(decoded)) {
      logInfo('client', 'ticker', {
        baseMint: decoded.baseMint,
        quoteMint: decoded.quoteMint,
        price: decoded.price,
        dex: decoded.dex,
        slot: decoded.slot
      })
      return
    }

    if (isWsLeaderboardEvent(decoded)) {
      logInfo('client', 'leaderboard', { items: decoded.items.length, asOf: decoded.asOf })
      return
    }

    if (!isWsX402Event(decoded)) {
      logWarn('client', 'ws event ignored: invalid shape')
      return
    }

    logInfo('client', 'ws event', { op: decoded.op })

    if (decoded.op === 'renewal_reminder' || decoded.op === 'payment_required') {
      try {
        if (RENEW_METHOD === 'http') {
          const renewed = await httpRenew(fetchWithPayment, renewUrl, currentToken)
          currentToken = renewed.token
          logInfo('client', 'sending renew token')
          ws.send(JSON.stringify({ op: 'renew_token', token: currentToken }))
          return
        }

        const paymentRequired = await inbandRenewChallenge(renewUrl, currentToken, httpClient)
        logInfo('client', 'creating inband payment payload')
        const paymentPayload = await client.createPaymentPayload(paymentRequired)
        const [selectedRequirements] = paymentRequired.accepts
        if (!selectedRequirements) {
          throw new Error('payment-required missing accepts')
        }

        ws.send(
          JSON.stringify({
            op: 'renew_inband',
            paymentRequirements: selectedRequirements,
            paymentPayload
          })
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logWarn('client', 'renew error', { message })
        await sleep(1000)
      }
    }
  })

  ws.on('close', (code, reason) => {
    logInfo('client', 'ws closed', { code, reason: reason.toString() })
  })

  ws.on('error', (err) => {
    logWarn('client', 'ws error', { message: err.message })
  })
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  logError('client', 'fatal error', { message })
  process.exit(1)
})
