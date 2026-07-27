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
  // task-onchain-payment-integrity (HOLE 1). On-chain SENDER of the credited
  // USDT transfer: `topics[1]` (the ERC-20 `from`) of the Transfer log that
  // credited the company wallet, falling back to the tx-level `from` when no
  // such log resolved. null when unresolvable / on the keyless dev path.
  // Diagnostics only — NEVER gate on this directly, gate on `fromMatches`.
  fromAddress: string | null
  // task-onchain-payment-integrity (HOLE 1). true iff `fromAddress` equals the
  // expected PAYER wallet passed by the caller (case-insensitive).
  //
  // WHY THIS EXISTS: verification used to assert only the RECIPIENT, so ANY
  // third party's transfer into the company wallet (findable in a public
  // explorer) could be submitted as "my payment" — closing a payout / crediting
  // the company account with somebody else's money. The recipient check answers
  // "did the money arrive?"; only this one answers "did YOU send it?".
  //
  // FAIL-CLOSED: false whenever either side is unknown (no registered payer
  // wallet, unresolvable on-chain sender).
  fromMatches: boolean
  // Safe-to-credit gate: recipient match AND sender match AND confirmations >=
  // threshold AND on-chain receipt status = success. `fromMatches` is folded in
  // deliberately — a caller that forgets the explicit sender check still cannot
  // credit. Callers SHOULD still test `fromMatches` first, to return the
  // specific "wrong sender" error instead of a generic "not confirmed".
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

/**
 * Decode an address out of an indexed event topic.
 *
 * ERC-20 Transfer indexes `from` (topics[1]) and `to` (topics[2]) as 32-byte
 * words with the 20-byte address right-aligned — `0x` + 24 zero nibbles + the
 * address. Returns a lowercase `0x…40hex` string, or null for a missing /
 * malformed topic (fail-closed: an undecodable topic never matches anything).
 */
function addressFromTopic(topic: string | undefined): string | null {
  if (!topic || topic.length < 40) return null
  return ('0x' + topic.slice(-40)).toLowerCase()
}

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
    expectedFromAddress: string | null,
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
        fromAddress: null,
        fromMatches: false,
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
        // tx-level sender is already known here (diagnostics); no Transfer log
        // was read yet, and nothing can be credited anyway.
        fromAddress: tx.from ?? null,
        fromMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        onChainSuccess,
        ...(receipt !== null && { error: 'Транзакция отменена на блокчейне (reverted)' }),
      }
    }

    // ── Step 3: eth_getLogs — USDT Transfer events for this tx ───────────────
    // Filter to the USDT contract + Transfer topic (topic0 only).
    // SECURITY NOTE: Do NOT add topic1 (from-address) filter here.
    //   ERC-20 Transfer topics: topic0=event_sig, topic1=from, topic2=to.
    //   topic1 == zero address filters ONLY mint events (from == 0x0).
    //   Real deposits always have a non-zero sender — adding topic1=0x000...000
    //   would make every real deposit return an empty logs array and
    //   toMatches=false, silently blocking ALL legitimate deposits.
    //   We filter by transactionHash in code, then match topics[2] (to-address)
    //   against the expected company wallet for defence-in-depth.
    //
    // WHERE THE SENDER IS CHECKED (task-onchain-payment-integrity, HOLE 1):
    //   The note above is about the RPC-LEVEL filter only — it stays true, we
    //   still must not narrow the eth_getLogs request by topic1. For years no
    //   compensating check existed anywhere else, so the sender was never
    //   verified at all and any third party's transfer could be claimed. It is
    //   now verified IN CODE, a few lines below: `payerLogs` matches
    //   `topics[1]` (the ERC-20 `from`) of each credited Transfer log against
    //   the caller-supplied `expectedFromAddress`, and the result is surfaced
    //   as `fromMatches` (also folded into `confirmed`). Callers gate on it —
    //   `TransactionsService.payPayoutRequest` and
    //   `CompanyAccountService.submitDeposit` / `getDepositStatus`.
    const logsRes = await this.fetchWithTimeout(
      `${base}&action=eth_getLogs` +
        `&fromBlock=${txBlockHex}&toBlock=${txBlockHex}` +
        `&address=${USDT_CONTRACT}` +
        `&topic0=${ERC20_TRANSFER_TOPIC}`,
    )
    // Etherscan eth_getLogs returns ALL Transfer events in the block for this
    // contract, not just for our tx — filter by transactionHash.
    const logsData = (await logsRes.json()) as RpcResponse<EtherscanRpcLog[]>
    const allLogs = Array.isArray(logsData.result) ? logsData.result : []
    const txLogs = allLogs.filter(
      (log) => log.transactionHash.toLowerCase() === txHash.toLowerCase(),
    )

    // Find incoming transfers to the company wallet (topics[2] = padded `to` address).
    const incomingLogs = txLogs.filter(
      (log) => addressFromTopic(log.topics[2]) === expectedToAddress.toLowerCase(),
    )

    const toMatches = incomingLogs.length > 0

    // ── SENDER CHECK (task-onchain-payment-integrity, HOLE 1) ────────────────
    // Of the transfers that credited the company wallet, keep the ones actually
    // SENT BY the expected payer (topics[1] = padded ERC-20 `from`). A tx can
    // carry several Transfer events (batching contracts, routers), so this is a
    // per-log match rather than a single tx-level comparison.
    const payerLogs =
      expectedFromAddress === null
        ? []
        : incomingLogs.filter(
            (log) => addressFromTopic(log.topics[1]) === expectedFromAddress.trim().toLowerCase(),
          )
    const fromMatches = payerLogs.length > 0

    // Reported sender: the ERC-20 `from` of the first crediting Transfer log —
    // the token-level sender, which is what "who paid" means for USDT. Falls
    // back to the tx-level `from` (the EOA that submitted the tx) only when no
    // crediting log resolved. Diagnostics; the gate is `fromMatches`.
    const fromAddress =
      incomingLogs.length > 0 ? addressFromTopic(incomingLogs[0]?.topics[1]) : null

    // Sum USDT amount from Transfer event `data` field (uint256 raw amount).
    // Counted over the PAYER's transfers when a payer is expected: the amount
    // that settles an obligation is what THAT payer sent, never a stranger's
    // transfer that happens to share the tx. With no expected payer the sum
    // stays over all crediting logs (diagnostics only — `confirmed` is false in
    // that case because `fromMatches` is false).
    const creditedLogs = expectedFromAddress === null ? incomingLogs : payerLogs
    const amountUsdt = creditedLogs.reduce((sum, log) => {
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
      fromAddress: fromAddress ?? tx.from ?? null,
      fromMatches,
      // confirmed requires: recipient match + SENDER match (HOLE 1) + threshold
      // + on-chain success (AC2).
      confirmed: toMatches && fromMatches && onChainSuccess && confirmations >= threshold,
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
   * task-onchain-payment-integrity (HOLE 1) — SENDER check:
   *   `expectedFromAddress` is the wallet registered for the person claiming
   *   the transfer (`users.wallet_usdt_erc20`). The result carries
   *   `fromMatches` (and folds it into `confirmed`) so a transfer sent by
   *   SOMEBODY ELSE can no longer settle that person's obligation. It is a
   *   REQUIRED parameter on purpose: every call site had to be revisited when
   *   this landed, and a future one cannot silently skip the check.
   *   Pass `null` only when no payer wallet is known — that fails closed
   *   (`fromMatches: false`, nothing creditable).
   *
   * Returns recipient-match + sender-match + live confirmation count so the
   * caller can enforce the security invariant: credit ONLY when
   * `toMatches && fromMatches && confirmed`. The `confirmed` flag already
   * embeds the fromMatches + onChainSuccess requirements.
   *
   * Threshold default 12 (mirrors company_account.confirmationThreshold).
   *
   * Dev/test (no API key): auto-confirm so the flow is testable without a real
   * key — but ONLY when BOTH wallets are configured (an unknown company wallet
   * or an unknown payer wallet never auto-credits, mirroring the keyed path).
   * Integration tests inject a mock EtherscanService to exercise the
   * mismatch / pending branches deterministically.
   */
  async verifyDeposit(
    txHash: string,
    expectedToAddress: string | null,
    expectedFromAddress: string | null,
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
          fromAddress: null,
          fromMatches: false,
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
          fromAddress: null,
          fromMatches: false,
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          error: 'Кошелёк компании не настроен',
        }
      }
      // Same fail-closed rule for the PAYER wallet (HOLE 1): with no registered
      // sender there is nothing to compare the transfer against, so the keyless
      // dev path must not auto-confirm either — otherwise dev/test would keep
      // exercising a flow that production rejects.
      if (!expectedFromAddress) {
        return {
          found: false,
          toMatches: false,
          fromAddress: null,
          fromMatches: false,
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          error: 'Кошелёк отправителя не настроен',
        }
      }
      // Dev stub amount so the keyless happy-path actually credits (the M4 gate
      // requires a positive amount; without it a keyless deposit would sit at
      // N/N "confirming" forever). Real amounts come from the keyed path in
      // prod; this only affects local dev/test where no chain data exists.
      // The stub echoes the expected payer: dev/test has no chain data, and the
      // branch is unreachable in production (fail-closed above).
      return {
        found: true,
        toMatches: true,
        fromAddress: expectedFromAddress.trim().toLowerCase(),
        fromMatches: true,
        confirmed: true,
        confirmations: threshold,
        amountUsdt: 1000,
      }
    }

    if (!expectedToAddress) {
      return {
        found: false,
        toMatches: false,
        fromAddress: null,
        fromMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        error: 'Кошелёк компании не настроен',
      }
    }

    try {
      // BIZ-08 (AC1): use direct txHash lookup — no 10k-window dependency.
      // `expectedFromAddress` may be null here: the keyed path still reports the
      // real on-chain sender for diagnostics, but `fromMatches` stays false so
      // nothing is creditable (fail-closed).
      return await this.verifyDepositDirect(
        txHash,
        expectedToAddress,
        expectedFromAddress,
        threshold,
      )
    } catch (err) {
      // Graceful on fetch error (same as verifyTransaction) so the progress bar
      // does not hang: caller treats `found:false` as "still pending / retry".
      this.logger.error(`Etherscan deposit-verify error: ${String(err)}`)
      return {
        found: false,
        toMatches: false,
        fromAddress: null,
        fromMatches: false,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        error: 'Ошибка проверки блокчейна',
      }
    }
  }
}
