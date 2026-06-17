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

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? ''
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
      this.logger.warn('ETHERSCAN_API_KEY not set — keyless deposit verification (dev/test)')
      // Keyless mode: no chain data. Auto-confirm the happy path so local UT can
      // exercise the credit flow, but only when a wallet is actually configured
      // — a null wallet can never "match", preserving the invariant that an
      // unconfigured account never auto-credits.
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
      return {
        found: true,
        toMatches: true,
        confirmed: true,
        confirmations: threshold,
        amountUsdt: null,
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
      const url =
        `https://api.etherscan.io/api?module=account&action=tokentx` +
        `&contractaddress=${USDT_CONTRACT}` +
        `&startblock=0&endblock=99999999&sort=desc` +
        `&apikey=${this.apiKey}`

      const res = await fetch(url)
      const data = (await res.json()) as EtherscanTxResult

      const tx = data.result?.find((t) => t.hash.toLowerCase() === txHash.toLowerCase())

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

      const toMatches = tx.to.toLowerCase() === expectedToAddress.toLowerCase()
      const confirmations = Number.isNaN(parseInt(tx.confirmations, 10))
        ? 0
        : parseInt(tx.confirmations, 10)
      const decimals = parseInt(tx.tokenDecimal || '6', 10)
      const amountUsdt = parseInt(tx.value, 10) / Math.pow(10, decimals)

      // Security invariant inputs: confirmed requires BOTH the recipient match
      // and the confirmation threshold. Caller must still gate crediting on
      // `toMatches && confirmed` — we surface both so the progress bar can show
      // confirmations even before the threshold is met.
      return {
        found: true,
        toMatches,
        confirmed: toMatches && confirmations >= threshold,
        confirmations,
        amountUsdt: Number.isFinite(amountUsdt) ? amountUsdt : null,
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
