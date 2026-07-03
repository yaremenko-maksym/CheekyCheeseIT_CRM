import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

// ── Etherscan REST API response types ────────────────────────────────────────

interface EtherscanTxResult {
  status: string // "1" = success
  result: {
    hash: string
    from: string
    to: string
    value: string
    contractAddress: string
    tokenSymbol: string
    tokenDecimal: string
    blockNumber: string
    confirmations: string
  }[]
}

// ── Etherscan JSON-RPC response types (BIZ-08 / BIZ-16 direct lookup) ────────

/** eth_getTransactionByHash result */
interface EtherscanRpcTx {
  hash: string
  blockNumber: string | null // null when still in mempool
  from: string
  to: string | null
}

/** eth_getTransactionReceipt result — null when receipt not yet mined */
interface EtherscanRpcReceipt {
  transactionHash: string
  blockNumber: string
  status: string // '0x1' = success, '0x0' = reverted
}

/** eth_getLogs entry — one ERC-20 Transfer event */
interface EtherscanRpcLog {
  transactionHash: string
  blockNumber: string
  address: string // token contract address
  topics: string[] // [transferTopic, fromTopic, toTopic]
  data: string // hex-encoded amount
}

interface RpcResponse<T> {
  jsonrpc: string
  result: T | null
}

// ── Public result types ───────────────────────────────────────────────────────

export interface TxVerification {
  confirmed: boolean
  amountUsdt: number | null
  error?: string
}

/**
 * task-company-account-backend. Result of verifying a USDT deposit against the
 * company wallet. Unlike `verifyTransaction`, this ALSO asserts the on-chain
 * RECIPIENT and the CONFIRMATION COUNT — the two checks the company-account
 * security invariant depends on (never credit a deposit whose recipient is not
 * the company wallet, or which has not reached the confirmation threshold).
 *
 * BIZ-16 (AC2): `onChainSuccess` surfaces whether the transaction actually
 * succeeded on-chain (receipt status=0x1). A reverted tx can appear in tokentx
 * listings but MUST NOT credit the deposit. Callers should gate on
 * `toMatches && confirmed && onChainSuccess`.
 */
export interface DepositVerification {
  // tx exists on-chain as a USDT transfer.
  found: boolean
  // on-chain `to` equals the expected company wallet (case-insensitive).
  toMatches: boolean
  // confirmations >= threshold AND on-chain receipt status = success.
  confirmed: boolean
  // live confirmation count (for the progress bar). 0 when unknown.
  confirmations: number
  // USDT amount transferred (null when not yet resolvable).
  amountUsdt: number | null
  // AC2 (BIZ-16): true iff the on-chain receipt status = success (0x1).
  // false for reverted txs or when receipt not yet available (pending).
  // undefined on the keyless dev/test path (no chain call made).
  onChainSuccess?: boolean
  error?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** USDT ERC-20 contract on Ethereum mainnet. Single source of truth. */
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

/**
 * keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event
 * topic used to filter eth_getLogs for USDT transfer events in a tx.
 */
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** USDT uses 6 decimals on mainnet. */
const USDT_DECIMALS = 6

/** Fetch timeout for all Etherscan calls — 10 seconds. */
const FETCH_TIMEOUT_MS = 10_000

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class EtherscanService {
  private readonly logger = new Logger(EtherscanService.name)
  private readonly apiKey: string
  private readonly isProduction: boolean

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? ''
    // Audit 2026-06-28 (#13): FAIL-CLOSED by default. The keyless verifyDeposit
    // branch auto-credits ONLY when `!isProduction`. Treating "anything not
    // exactly 'production'" as non-prod meant an UNSET / typo'd / 'staging'
    // NODE_ENV opened the keyless auto-credit path in a real deployment. Invert
    // the default: only an explicit 'development' or 'test' is non-prod; every
    // other value (incl. unset) is treated as production → keyless fails closed.
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV
    this.isProduction = nodeEnv !== 'development' && nodeEnv !== 'test'
    // security (H1): a missing key in production is a misconfiguration that
    // would otherwise let the keyless path auto-confirm. Surface it loudly; the
    // verifyDeposit keyless branch fail-closes regardless (never auto-credits).
    if (this.isProduction && !this.apiKey) {
      this.logger.error(
        'ETHERSCAN_API_KEY is NOT set in production — deposit verification will fail-closed (no auto-credit). Configure the key.',
      )
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch a URL with an AbortController timeout guard.
   * Throws on timeout/network error (caller wraps in try/catch).
   */
  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * BIZ-08 (AC1) — Direct txHash lookup via Etherscan JSON-RPC proxy.
   *
   * The tokentx listing endpoint (action=tokentx) only returns the most recent
   * 10 000 transfers for an address. An older tx would silently return found=false
   * even though it is valid on-chain. This method bypasses the listing window by
   * querying the tx directly by hash:
   *
   *   1. eth_getTransactionByHash  — confirms the tx exists + gets its blockNumber.
   *   2. eth_getTransactionReceipt — checks AC2: on-chain success (status=0x1).
   *      A reverted tx has a receipt with status=0x0 and MUST NOT be credited.
   *   3. eth_getLogs               — finds all ERC-20 Transfer events emitted by
   *      that tx, filtered to the USDT contract. Sums transfers to the company
   *      wallet; handles multi-transfer txs correctly.
   *   4. eth_blockNumber           — computes live confirmation count from
   *      (currentHead − txBlockNumber + 1).
   *
   * Called ONLY from the keyed path (apiKey present).
   */
  private async verifyDepositDirect(
    txHash: string,
    expectedToAddress: string,
    threshold: number,
  ): Promise<DepositVerification> {
    const base = `https://api.etherscan.io/api?module=proxy&apikey=${this.apiKey}`

    // ── Step 1: eth_getTransactionByHash ──────────────────────────────────────
    const txRes = await this.fetchWithTimeout(
      `${base}&action=eth_getTransactionByHash&txhash=${txHash}`,
    )
    const txData = (await txRes.json()) as RpcResponse<EtherscanRpcTx>
    const tx = txData.result

    if (!tx) {
      return {
        found: false,
        toMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        error: 'Транзакция не найдена в блокчейне',
      }
    }

    // tx exists (possibly still in mempool if blockNumber is null)
    const txBlockHex = tx.blockNumber

    // ── Step 2: eth_getTransactionReceipt (AC2 — on-chain success) ───────────
    const receiptRes = await this.fetchWithTimeout(
      `${base}&action=eth_getTransactionReceipt&txhash=${txHash}`,
    )
    const receiptData = (await receiptRes.json()) as RpcResponse<EtherscanRpcReceipt>
    const receipt = receiptData.result

    // receipt is null if tx hasn't been mined yet
    const onChainSuccess = receipt !== null ? receipt.status === '0x1' : false

    if (!onChainSuccess) {
      // Pending (no receipt) or reverted — cannot credit. Surface confirmations=0.
      // Distinguish "pending mempool" (no receipt) vs "reverted" for the caller.
      // Use conditional spread to satisfy exactOptionalPropertyTypes (no explicit undefined).
      return {
        found: true,
        toMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        onChainSuccess,
        ...(receipt !== null && { error: 'Транзакция отменена на блокчейне (reverted)' }),
      }
    }

    // ── Step 3: eth_getLogs — USDT Transfer events for this tx ───────────────
    // Filter to the USDT contract + Transfer topic. This returns ONLY Transfer
    // events emitted by the USDT contract in this tx — no window dependency.
    const logsRes = await this.fetchWithTimeout(
      `${base}&action=eth_getLogs` +
        `&fromBlock=${txBlockHex}&toBlock=${txBlockHex}` +
        `&address=${USDT_CONTRACT}` +
        `&topic0=${ERC20_TRANSFER_TOPIC}` +
        `&topic0_1_opr=and&topic1=0x0000000000000000000000000000000000000000000000000000000000000000`,
    )
    // Etherscan eth_getLogs returns ALL Transfer events in the block for this
    // contract, not just for our tx — filter by transactionHash.
    const logsData = (await logsRes.json()) as RpcResponse<EtherscanRpcLog[]>
    const allLogs = Array.isArray(logsData.result) ? logsData.result : []
    const txLogs = allLogs.filter(
      (log) => log.transactionHash.toLowerCase() === txHash.toLowerCase(),
    )

    // Find incoming transfers to the company wallet (topics[2] = padded `to` address).
    const incomingLogs = txLogs.filter((log) => {
      const toPadded = log.topics[2] ?? ''
      // topics[2] is 0x + 64 hex chars with the address right-padded in the last 40.
      const toAddr = '0x' + toPadded.slice(-40)
      return toAddr.toLowerCase() === expectedToAddress.toLowerCase()
    })

    const toMatches = incomingLogs.length > 0

    // Sum USDT amount from Transfer event `data` field (uint256 raw amount).
    const amountUsdt = incomingLogs.reduce((sum, log) => {
      const raw = BigInt(log.data)
      return sum + Number(raw) / Math.pow(10, USDT_DECIMALS)
    }, 0)

    const amountValid = Number.isFinite(amountUsdt) && amountUsdt > 0 && amountUsdt < 1e12

    // ── Step 4: eth_blockNumber — live confirmation count ────────────────────
    let confirmations = 0
    if (txBlockHex) {
      const headRes = await this.fetchWithTimeout(`${base}&action=eth_blockNumber`)
      const headData = (await headRes.json()) as RpcResponse<string>
      const headHex = headData.result ?? '0x0'
      const txBlock = parseInt(txBlockHex, 16)
      const headBlock = parseInt(headHex, 16)
      // Ethereum confirmation count: 0 when tx is in the head block (same block),
      // 1 when the next block is mined, etc. Formula: currentHead − txBlock.
      // (Etherscan tokentx "confirmations" field uses the same formula.)
      confirmations = Number.isFinite(headBlock - txBlock) ? Math.max(0, headBlock - txBlock) : 0
    }

    return {
      found: true,
      toMatches,
      // confirmed requires: recipient match + threshold + on-chain success (AC2)
      confirmed: toMatches && onChainSuccess && confirmations >= threshold,
      confirmations,
      amountUsdt: amountValid ? amountUsdt : null,
      onChainSuccess,
    }
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /** Verify a USDT ERC-20 transaction by hash.
   *  Checks: tx exists, status = success, token = USDT.
   *  Returns confirmed + amountUsdt.
   *
   *  Unchanged legacy method — used by the payout flow. Do NOT alter its
   *  contract (see transactions.service payPayoutRequest).
   */
  async verifyTransaction(txHash: string): Promise<TxVerification> {
    if (!this.apiKey) {
      this.logger.warn('ETHERSCAN_API_KEY not set — skipping blockchain verification')
      // In dev/test, auto-confirm so flow can be tested without a real key
      return { confirmed: true, amountUsdt: null }
    }

    try {
      const url =
        `https://api.etherscan.io/api?module=account&action=tokentx` +
        `&contractaddress=${USDT_CONTRACT}` +
        `&startblock=0&endblock=99999999&sort=desc` +
        `&apikey=${this.apiKey}`

      const res = await this.fetchWithTimeout(url)
      const data = (await res.json()) as EtherscanTxResult

      const tx = data.result?.find((t) => t.hash.toLowerCase() === txHash.toLowerCase())

      if (!tx) {
        return { confirmed: false, amountUsdt: null, error: 'Транзакция не найдена в блокчейне' }
      }

      const decimals = parseInt(tx.tokenDecimal || '6', 10)
      const amountUsdt = parseInt(tx.value, 10) / Math.pow(10, decimals)

      return { confirmed: true, amountUsdt }
    } catch (err) {
      this.logger.error(`Etherscan error: ${String(err)}`)
      return { confirmed: false, amountUsdt: null, error: 'Ошибка проверки блокчейна' }
    }
  }

  /**
   * Verify a USDT deposit onto the company wallet.
   *
   * BIZ-08 (AC1) — tokentx 10k-window fix:
   *   Uses direct JSON-RPC lookup (eth_getTransactionByHash + eth_getTransactionReceipt
   *   + eth_getLogs + eth_blockNumber) instead of the `account/tokentx` listing.
   *   The listing only covers the most recent 10 000 transfers; an older valid tx
   *   would silently return found=false. The direct path has no window limitation.
   *
   * BIZ-16 (AC2) — on-chain success check:
   *   Checks eth_getTransactionReceipt.status === '0x1'. A reverted tx
   *   (status=0x0) has found=true but confirmed=false and onChainSuccess=false,
   *   so the caller's gate `toMatches && confirmed` correctly rejects it.
   *
   * Returns recipient-match + live confirmation count so the caller can enforce
   * the security invariant: credit ONLY when `toMatches && confirmed`.
   * The `confirmed` flag already embeds the onChainSuccess requirement.
   *
   * Threshold default 12 (mirrors company_account.confirmationThreshold).
   *
   * Dev/test (no API key): auto-confirm so the flow is testable without a real
   * key. Integration tests inject a mock EtherscanService to exercise the
   * mismatch / pending branches deterministically.
   */
  async verifyDeposit(
    txHash: string,
    expectedToAddress: string | null,
    threshold = 12,
  ): Promise<DepositVerification> {
    if (!this.apiKey) {
      // security (H1): in PRODUCTION the keyless path must NEVER auto-confirm —
      // otherwise any submitter could mint a fake PAID company balance without a
      // real on-chain check. Fail-closed: the deposit stays PENDING (not
      // credited) until a real key verifies it. The keyless auto-confirm exists
      // ONLY for local dev/test of the happy flow.
      if (this.isProduction) {
        this.logger.error(
          'ETHERSCAN_API_KEY not set in production — refusing to auto-confirm deposit',
        )
        return {
          found: false,
          toMatches: false,
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          error: 'Верификация недоступна: ключ Etherscan не настроен',
        }
      }
      this.logger.warn('ETHERSCAN_API_KEY not set — keyless deposit verification (dev/test only)')
      // Dev/test keyless: auto-confirm the happy path, but only when a wallet is
      // actually configured — a null wallet can never "match", preserving the
      // invariant that an unconfigured account never auto-credits.
      if (!expectedToAddress) {
        return {
          found: false,
          toMatches: false,
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          error: 'Кошелёк компании не настроен',
        }
      }
      // Dev stub amount so the keyless happy-path actually credits (the M4 gate
      // requires a positive amount; without it a keyless deposit would sit at
      // N/N "confirming" forever). Real amounts come from the keyed path in
      // prod; this only affects local dev/test where no chain data exists.
      return {
        found: true,
        toMatches: true,
        confirmed: true,
        confirmations: threshold,
        amountUsdt: 1000,
      }
    }

    if (!expectedToAddress) {
      return {
        found: false,
        toMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        error: 'Кошелёк компании не настроен',
      }
    }

    try {
      // BIZ-08 (AC1): use direct txHash lookup — no 10k-window dependency.
      return await this.verifyDepositDirect(txHash, expectedToAddress, threshold)
    } catch (err) {
      // Graceful on fetch error (same as verifyTransaction) so the progress bar
      // does not hang: caller treats `found:false` as "still pending / retry".
      this.logger.error(`Etherscan deposit-verify error: ${String(err)}`)
      return {
        found: false,
        toMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        error: 'Ошибка проверки блокчейна',
      }
    }
  }
}
