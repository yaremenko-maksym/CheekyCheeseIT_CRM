import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

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
 */
export interface DepositVerification {
  // tx exists on-chain as a USDT transfer.
  found: boolean
  // on-chain `to` equals the expected company wallet (case-insensitive).
  toMatches: boolean
  // confirmations >= threshold.
  confirmed: boolean
  // live confirmation count (for the progress bar). 0 when unknown.
  confirmations: number
  // USDT amount transferred (null when not yet resolvable).
  amountUsdt: number | null
  error?: string
}

// USDT ERC-20 contract on Ethereum mainnet. Single source of truth.
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

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

      const res = await fetch(url)
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
   * task-company-account-backend — verify a USDT deposit onto the company
   * wallet. Returns recipient-match + live confirmation count so the caller can
   * enforce the security invariant: credit ONLY when `toMatches && confirmed`.
   *
   * Threshold default 12 (mirrors company_account.confirmationThreshold).
   *
   * Dev/test (no API key): auto-confirm so the flow is testable without a real
   * key, BUT return deterministic, invariant-honouring values — `toMatches`
   * still reflects the expected address (so a mismatch test stays meaningful is
   * impossible here because no chain data exists; in keyless mode we assume the
   * submitter's link is for the company wallet and return toMatches=true,
   * confirmations=threshold). The REAL recipient/confirmation enforcement lives
   * in the keyed path; the keyless path exists only for local UT of the happy
   * flow. Integration tests inject a mock EtherscanService to exercise the
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
      // security (H2): Etherscan `account/tokentx` REQUIRES `&address=` — it
      // lists the ERC-20 transfers of THAT account. Without it the endpoint
      // returns an empty/error result, so `verifyDeposit` would ALWAYS report
      // "tx not found" in production (fail-closed but non-functional — the
      // on-chain path could never confirm). `address` + `contractaddress`
      // together scope the result to USDT transfers touching the company
      // wallet; we then match the exact txHash and re-assert `tx.to` below.
      // `expectedToAddress` is guaranteed non-null here (checked at line ~177).
      const url =
        `https://api.etherscan.io/api?module=account&action=tokentx` +
        `&address=${expectedToAddress}` +
        `&contractaddress=${USDT_CONTRACT}` +
        `&startblock=0&endblock=99999999&sort=desc` +
        `&apikey=${this.apiKey}`

      const res = await fetch(url)
      const data = (await res.json()) as EtherscanTxResult

      const rows = data.result ?? []
      // Audit 2026-06-28 (#12): a single on-chain tx can emit MORE THAN ONE USDT
      // Transfer event to the same recipient (batched / split transfers all share
      // the tx hash). Previously only the FIRST matching row was counted, so a
      // multi-transfer deposit was UNDER-credited. Collect EVERY row for this hash
      // and SUM the transfers that landed on the company wallet via the USDT
      // contract; `toMatches` is true when at least one such incoming transfer
      // exists. `&address=`+`&contractaddress=` already scope the result, but we
      // re-assert `to` + the USDT contract per row for defence-in-depth.
      const hashRows = rows.filter((t) => t.hash.toLowerCase() === txHash.toLowerCase())

      if (hashRows.length === 0) {
        return {
          found: false,
          toMatches: false,
          confirmed: false,
          confirmations: 0,
          amountUsdt: null,
          error: 'Транзакция не найдена в блокчейне',
        }
      }

      const incomingRows = hashRows.filter(
        (t) =>
          t.to.toLowerCase() === expectedToAddress.toLowerCase() &&
          // contractAddress is empty on some Etherscan rows; when present it must
          // be the USDT contract (the query already scopes by it, this re-asserts).
          (!t.contractAddress || t.contractAddress.toLowerCase() === USDT_CONTRACT.toLowerCase()),
      )

      const toMatches = incomingRows.length > 0
      // confirmations are identical across rows of the same tx — read from the
      // first hash row (a matched incoming row when present, else any hash row).
      const confSource = incomingRows[0] ?? hashRows[0]!
      const confirmations = Number.isNaN(parseInt(confSource.confirmations, 10))
        ? 0
        : parseInt(confSource.confirmations, 10)

      // Sum every matching incoming USDT transfer for this hash.
      const amountUsdt = incomingRows.reduce((sum, t) => {
        const decimals = parseInt(t.tokenDecimal || '6', 10)
        return sum + parseInt(t.value, 10) / Math.pow(10, decimals)
      }, 0)

      // Security invariant inputs: confirmed requires BOTH the recipient match
      // and the confirmation threshold. Caller must still gate crediting on
      // `toMatches && confirmed` — we surface both so the progress bar can show
      // confirmations even before the threshold is met.
      // M4: only surface a sane, positive amount. A negative / NaN / absurdly
      // large value (malformed `value` field) → null, so the caller never
      // credits a bogus figure. 1e12 USDT is far above any real deposit.
      const amountValid = Number.isFinite(amountUsdt) && amountUsdt > 0 && amountUsdt < 1e12

      return {
        found: true,
        toMatches,
        confirmed: toMatches && confirmations >= threshold,
        confirmations,
        amountUsdt: amountValid ? amountUsdt : null,
      }
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
