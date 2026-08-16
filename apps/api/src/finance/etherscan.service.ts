import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

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

/**
 * MED-2 (security-review PR #438) — Etherscan does NOT always answer with the
 * documented shape. On a rate limit / API error it returns a STRING in
 * `result` ("Max rate limit reached"), which is truthy: the old
 * `as RpcResponse<T>` cast sailed past it, `receipt.status === '0x1'` came out
 * false, and the operator was told «Транзакция отменена на блокчейне
 * (reverted)» — a confidently WRONG diagnosis handed out exactly when the money
 * path is degraded. Behaviour was fail-closed (no credit), the DIAGNOSIS was
 * the bug.
 *
 * These guards narrow `unknown` before any field is read, so an unexpected
 * shape produces an honest "verifier unavailable" instead of a fake chain fact.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `result` of a well-formed JSON-RPC reply, or `UNAVAILABLE`. */
const RPC_UNAVAILABLE = Symbol('etherscan-rpc-unavailable')

/**
 * Extract `result` from a raw JSON body.
 *   • `null` result (tx not mined / no receipt) → `null` — a real chain answer.
 *   • object / array result → returned for the caller to narrow.
 *   • anything else (string error, missing key, non-object body) →
 *     `RPC_UNAVAILABLE` — the verifier could not answer.
 */
function rpcResult(body: unknown): unknown | typeof RPC_UNAVAILABLE {
  if (!isObject(body) || !('result' in body)) return RPC_UNAVAILABLE
  const result = body['result']
  if (result === null) return null
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    // eth_blockNumber legitimately returns a hex STRING; every other call in
    // this flow returns an object/array, so callers decide per call site.
    return result
  }
  if (isObject(result) || Array.isArray(result)) return result
  return RPC_UNAVAILABLE
}

// ── Public result types ───────────────────────────────────────────────────────

/**
 * task-company-account-backend. Result of verifying a USDT deposit against the
 * company wallet. Asserts the on-chain RECIPIENT and the CONFIRMATION COUNT —
 * the two checks the company-account
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
  // task-onchain-payment-integrity. On-chain SENDER of the credited USDT
  // transfer: `topics[1]` (the ERC-20 `from`) of the first Transfer log that
  // credited the company wallet, falling back to the tx-level `from` when no
  // such log resolved. Lowercase; null when unresolvable / on the keyless dev
  // path.
  //
  // OBSERVED, NOT ENFORCED (owner decision): staff frequently withdraw USDT
  // straight from an exchange, so `from` is the EXCHANGE's hot wallet rather
  // than their registered address — gating on it would reject honest payments.
  // It is therefore recorded on the payout / deposit row and surfaced to
  // ADMIN/ACCOUNTANT for investigation, while the enforcement barriers are:
  // the RECIPIENT match (`toMatches`), the EXACT amount match (caller-side,
  // `amountUsdtMinor`), and the cross-path consumed-hash registry.
  fromAddress: string | null
  // Safe-to-credit gate: recipient match AND confirmations >= threshold AND
  // on-chain receipt status = success.
  confirmed: boolean
  // live confirmation count (for the progress bar). 0 when unknown.
  confirmations: number
  // USDT amount transferred (null when not yet resolvable). FLOAT — for display
  // and for the deposit ledger amount. NEVER compare it against a declared
  // obligation: use `amountUsdtMinor`.
  amountUsdt: number | null
  // task-onchain-payment-integrity. The SAME amount as exact integer minor
  // units (USDT has 6 decimals), decimal-string encoded (`BigInt` is not
  // JSON-safe). This is the raw uint256 sum straight out of the Transfer logs —
  // no float ever touches it — so a caller can assert BYTE-EXACT equality with
  // a declared payable amount. `payPayoutRequest` does exactly that.
  amountUsdtMinor: string | null
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
   * MED-2 (security-review PR #438) — honest "the verifier could not answer".
   *
   * Returned whenever an RPC reply does not have the documented shape (rate
   * limit → `result` is the STRING "Max rate limit reached", API error, garbage
   * body). Fail-closed exactly like every other negative path — nothing is ever
   * credited — but the operator now gets a TRUE diagnosis. Before this, a
   * rate-limited reply flowed on and surfaced as «Транзакция отменена на
   * блокчейне (reverted)»: a confident, wrong statement about the chain,
   * delivered precisely when the money path was degraded.
   */
  private verifierUnavailable(raw: unknown): DepositVerification {
    this.logger.error(
      `Etherscan returned an unexpected RPC payload (verification unavailable): ${
        typeof raw === 'string' ? raw : String(raw)
      }`,
    )
    return {
      found: false,
      toMatches: false,
      fromAddress: null,
      confirmed: false,
      confirmations: 0,
      amountUsdt: null,
      amountUsdtMinor: null,
      error: 'Верификация недоступна: блокчейн-провайдер не ответил корректно, попробуйте позже',
    }
  }

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
    const txResult = rpcResult(await txRes.json())
    // MED-2: a string/garbage `result` means the VERIFIER failed (rate limit,
    // API error) — say so, instead of inventing a chain fact.
    if (txResult === RPC_UNAVAILABLE || typeof txResult === 'string') {
      return this.verifierUnavailable(txResult)
    }
    const tx = isObject(txResult) ? (txResult as unknown as EtherscanRpcTx) : null

    if (!tx) {
      return {
        found: false,
        toMatches: false,
        fromAddress: null,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        amountUsdtMinor: null,
        error: 'Транзакция не найдена в блокчейне',
      }
    }

    // tx exists (possibly still in mempool if blockNumber is null)
    const txBlockHex = tx.blockNumber

    // ── Step 2: eth_getTransactionReceipt (AC2 — on-chain success) ───────────
    const receiptRes = await this.fetchWithTimeout(
      `${base}&action=eth_getTransactionReceipt&txhash=${txHash}`,
    )
    const receiptResult = rpcResult(await receiptRes.json())
    if (receiptResult === RPC_UNAVAILABLE || typeof receiptResult === 'string') {
      return this.verifierUnavailable(receiptResult)
    }
    const receipt = isObject(receiptResult)
      ? (receiptResult as unknown as EtherscanRpcReceipt)
      : null

    // receipt is null if tx hasn't been mined yet
    const onChainSuccess = receipt !== null ? receipt.status === '0x1' : false

    if (!onChainSuccess) {
      // Pending (no receipt) or reverted — cannot credit. Surface confirmations=0.
      // Distinguish "pending mempool" (no receipt) vs "reverted" for the caller.
      // Use conditional spread to satisfy exactOptionalPropertyTypes (no explicit undefined).
      return {
        found: true,
        toMatches: false,
        // tx-level sender is already known here (recorded for audit); no
        // Transfer log was read yet, and nothing can be credited anyway.
        fromAddress: tx.from?.toLowerCase() ?? null,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        amountUsdtMinor: null,
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
    // WHERE THE SENDER IS HANDLED NOW (task-onchain-payment-integrity):
    //   The note above concerns the RPC-LEVEL filter only — it stays true, we
    //   still must not narrow the eth_getLogs request by topic1. What was
    //   missing for years is that NOTHING downstream read `from` either, so the
    //   sender was neither filtered nor recorded. It is now READ a few lines
    //   below (`fromAddress`, from `topics[1]` of the crediting Transfer log,
    //   tx-level `from` as fallback) and PERSISTED by the callers on the payout
    //   / deposit row (`tx_from_address`), surfaced to ADMIN/ACCOUNTANT.
    //   It is deliberately NOT a gate: staff often withdraw straight from an
    //   exchange, whose hot wallet is the `from` — gating would reject honest
    //   payments (owner decision). The enforcing barriers are the RECIPIENT
    //   match here, the EXACT amount equality in
    //   `TransactionsService.payPayoutRequest` (`amountUsdtMinor`), and the
    //   cross-path `consumed_tx_hashes` registry.
    const logsRes = await this.fetchWithTimeout(
      `${base}&action=eth_getLogs` +
        `&fromBlock=${txBlockHex}&toBlock=${txBlockHex}` +
        `&address=${USDT_CONTRACT}` +
        `&topic0=${ERC20_TRANSFER_TOPIC}`,
    )
    // Etherscan eth_getLogs returns ALL Transfer events in the block for this
    // contract, not just for our tx — filter by transactionHash.
    const logsResult = rpcResult(await logsRes.json())
    // MED-2: an error string here would otherwise silently degrade to "no logs"
    // → toMatches=false → a misleading "recipient mismatch" for the payer.
    if (logsResult === RPC_UNAVAILABLE || typeof logsResult === 'string') {
      return this.verifierUnavailable(logsResult)
    }
    // LOW (review): eth_getLogs MUST answer with an array. A non-array `result`
    // is a degraded verifier, not "no transfers" — degrading it to `[]` would
    // report «получатель не совпал», blaming the payer for our provider.
    if (!Array.isArray(logsResult)) {
      return this.verifierUnavailable(logsResult)
    }
    const allLogs = logsResult as EtherscanRpcLog[]
    const txLogs = allLogs.filter(
      (log) =>
        typeof log?.transactionHash === 'string' &&
        log.transactionHash.toLowerCase() === txHash.toLowerCase() &&
        // ── CONDITION 2 of the owner's verification spec: CURRENCY.
        // The transfer must be REAL USDT — the log's emitting contract is the
        // USDT contract. Enforced HERE in code, not merely delegated to the
        // remote `&address=${USDT_CONTRACT}` filter on the request above.
        //
        // This is what stops the fake-token attack: deploy a worthless token,
        // emit `Transfer(…, companyWallet, 740_000000)`, and every other check
        // passes — recipient matches, amount matches to the minor unit — so
        // without a currency check we would credit 740 REAL USDT. Today the
        // logs come from a contract-filtered `eth_getLogs` (NOT from the tx
        // receipt, which would carry every token's events), so the attack does
        // not work; asserting it in code removes the dependency on that remote
        // filter — and on nobody ever refactoring the lookup to be receipt-based.
        typeof log?.address === 'string' &&
        log.address.toLowerCase() === USDT_CONTRACT.toLowerCase(),
    )

    // Find incoming transfers to the company wallet (topics[2] = padded `to` address).
    const incomingLogs = txLogs.filter(
      (log) => addressFromTopic(log.topics?.[2]) === expectedToAddress.toLowerCase(),
    )

    const toMatches = incomingLogs.length > 0

    // ── SENDER, RECORDED (task-onchain-payment-integrity) ────────────────────
    // The ERC-20 `from` (topics[1]) of the first crediting Transfer log — the
    // TOKEN-level sender, which is what "who paid" means for a USDT transfer
    // (the tx-level `from` may be a router/relayer contract). Falls back to the
    // tx-level `from` below when no crediting log resolved. Callers persist it
    // on the payout / deposit row; it is observable, not enforced.
    const fromAddress =
      incomingLogs.length > 0 ? addressFromTopic(incomingLogs[0]?.topics[1]) : null

    // ── AMOUNT — summed EXACTLY, in minor units ──────────────────────────────
    // The Transfer `data` field is a uint256 raw amount ALREADY in minor units
    // (USDT: 6 decimals), so summing as BigInt is exact by construction: no
    // rounding, no binary-float representation error, whatever the magnitude.
    // `amountUsdtMinor` is what `payPayoutRequest` compares byte-for-byte with
    // the declared payable; `amountUsdt` is the float DERIVED from it, for
    // display and for the deposit ledger amount only.
    const amountMinor = incomingLogs.reduce((sum, log) => sum + BigInt(log.data), 0n)
    const amountUsdt = Number(amountMinor) / Math.pow(10, USDT_DECIMALS)

    // LOW (review): the sanity gate is applied to the EXACT integer, not to the
    // derived float. `Number(amountMinor)` silently loses precision above 2^53
    // minor units (~9.007e9 USDT) while the old `< 1e12` float bound let such
    // values through — so the bound is now the largest amount the float mirror
    // can represent faithfully. `amountUsdtMinor` stays exact regardless.
    const amountValid = amountMinor > 0n && amountMinor <= BigInt(Number.MAX_SAFE_INTEGER)

    // ── Step 4: eth_blockNumber — live confirmation count ────────────────────
    let confirmations = 0
    if (txBlockHex) {
      const headRes = await this.fetchWithTimeout(`${base}&action=eth_blockNumber`)
      // eth_blockNumber legitimately returns a hex STRING; anything else means
      // the verifier is degraded (MED-2). A bad head block would understate
      // confirmations, which is fail-closed — but report it honestly instead.
      const headResult = rpcResult(await headRes.json())
      if (headResult === RPC_UNAVAILABLE) return this.verifierUnavailable(headResult)
      const headHex = typeof headResult === 'string' ? headResult : '0x0'
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
      fromAddress: fromAddress ?? tx.from?.toLowerCase() ?? null,
      // confirmed requires: recipient match + threshold + on-chain success (AC2).
      confirmed: toMatches && onChainSuccess && confirmations >= threshold,
      confirmations,
      amountUsdt: amountValid ? amountUsdt : null,
      amountUsdtMinor: amountValid ? amountMinor.toString() : null,
      onChainSuccess,
    }
  }

  // ── Public methods ──────────────────────────────────────────────────────────

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
   * task-onchain-payment-integrity — SENDER + EXACT AMOUNT:
   *   `fromAddress` reports WHO sent the USDT (`topics[1]`, tx `from` as
   *   fallback) so callers can persist it for audit. It is NOT a gate — staff
   *   often withdraw from an exchange, whose hot wallet would be the sender.
   *   `amountUsdtMinor` reports the transferred amount as exact integer minor
   *   units, so a caller can demand BYTE-EXACT equality with the amount the
   *   payer owes instead of a percentage band.
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
          fromAddress: null,
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          amountUsdtMinor: null,
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
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          amountUsdtMinor: null,
          error: 'Кошелёк компании не настроен',
        }
      }
      // Dev stub amount so the keyless happy-path actually credits (the M4 gate
      // requires a positive amount; without it a keyless deposit would sit at
      // N/N "confirming" forever). Real amounts come from the keyed path in
      // prod; this only affects local dev/test where no chain data exists.
      // NOTE: with the exact-amount rule, this stub can only ever settle a
      // payout whose payable is exactly 1000 USDT — dev payout rehearsals use
      // the `simulateResult` toggle instead, which bypasses verification.
      return {
        found: true,
        toMatches: true,
        fromAddress: null,
        confirmed: true,
        confirmations: threshold,
        amountUsdt: 1000,
        amountUsdtMinor: (1000n * 10n ** BigInt(USDT_DECIMALS)).toString(),
      }
    }

    if (!expectedToAddress) {
      return {
        found: false,
        toMatches: false,
        fromAddress: null,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        amountUsdtMinor: null,
        error: 'Кошелёк компании не настроен',
      }
    }

    try {
      // BIZ-08 (AC1): use direct txHash lookup — no 10k-window dependency.
      return await this.verifyDepositDirect(txHash, expectedToAddress, threshold)
    } catch (err) {
      // Graceful on fetch error so the progress bar does not hang: caller
      // treats `found:false` as "still pending / retry".
      this.logger.error(`Etherscan deposit-verify error: ${String(err)}`)
      return {
        found: false,
        toMatches: false,
        fromAddress: null,
        confirmed: false,
        confirmations: 0,
        amountUsdt: null,
        amountUsdtMinor: null,
        error: 'Ошибка проверки блокчейна',
      }
    }
  }
}
