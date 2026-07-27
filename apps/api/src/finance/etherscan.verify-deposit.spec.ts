import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from '@nestjs/config'
import { EtherscanService } from './etherscan.service'

/**
 * task-company-account-backend — unit tests for EtherscanService.verifyDeposit.
 *
 * This is the SECURITY-CRITICAL layer (invariant #1): a deposit may only be
 * credited when the on-chain recipient is the company wallet AND confirmations
 * reach the threshold. We mock global `fetch` to drive deterministic chain
 * responses and assert each branch.
 *
 * BIZ-08 migration note: verifyDeposit was refactored to use direct JSON-RPC
 * lookup (eth_getTransactionByHash + eth_getTransactionReceipt + eth_getLogs +
 * eth_blockNumber) instead of the tokentx listing endpoint. Mocks updated
 * accordingly to match the 4-call sequential JSON-RPC pattern.
 */

const COMPANY_WALLET = '0x1111111111111111111111111111111111111111'
const OTHER_WALLET = '0x2222222222222222222222222222222222222222'
/** Registered wallet of the payer/submitter — the default `from` of the fixtures. */
const SENDER_WALLET = '0x9999999999999999999999999999999999999999'
/** A THIRD party's wallet — the attacker scenario (someone else's transfer). */
const STRANGER_WALLET = '0x3333333333333333333333333333333333333333'
const TX_HASH = '0xabc1230000000000000000000000000000000000000000000000000000000def'
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function makeService(apiKey: string, nodeEnv: string | undefined = 'test'): EtherscanService {
  // Per-key config stub: ETHERSCAN_API_KEY → apiKey; NODE_ENV → nodeEnv. The
  // keyless dev/test auto-confirm branch (audit 2026-06-28 #13) keys off NODE_ENV,
  // so the stub must distinguish the two settings instead of returning apiKey for
  // everything. nodeEnv=undefined simulates an UNSET NODE_ENV (fail-closed).
  const config = {
    get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : apiKey),
  } as unknown as ConfigService
  return new EtherscanService(config)
}

/**
 * Build a Transfer log entry in eth_getLogs JSON-RPC format.
 * `to` address is padded as per ABI encoding (right-aligned in 32-byte topic).
 * `value` is USDT units (e.g. 500 = 500 USDT) converted to raw uint256 (6 decimals).
 */
function makeTransferLog(opts: { to: string; value: number; blockNumber?: string; from?: string }) {
  const from = opts.from ?? SENDER_WALLET
  return {
    transactionHash: TX_HASH,
    blockNumber: opts.blockNumber ?? '0x7b', // block 123
    address: USDT_CONTRACT,
    topics: [
      TRANSFER_TOPIC,
      `0x000000000000000000000000${from.replace('0x', '').toLowerCase()}`, // from (padded)
      `0x000000000000000000000000${opts.to.replace('0x', '').toLowerCase()}`, // to (padded)
    ],
    data: `0x${BigInt(Math.round(opts.value * 1_000_000))
      .toString(16)
      .padStart(64, '0')}`,
  }
}

/**
 * Set up fetch mock sequence for the direct-lookup path.
 * verifyDeposit makes 4 sequential JSON-RPC calls:
 *   1. eth_getTransactionByHash
 *   2. eth_getTransactionReceipt
 *   3. eth_getLogs
 *   4. eth_blockNumber
 */
function mockDirectLookup(opts: {
  txFound?: boolean
  txBlockHex?: string
  receiptFound?: boolean
  receiptStatus?: '0x0' | '0x1'
  logs?: Array<{ to: string; value: number; from?: string }>
  currentBlock?: number
  /** tx-level `from` (eth_getTransactionByHash) — defaults to SENDER_WALLET. */
  txFrom?: string
}) {
  const {
    txFound = true,
    txBlockHex = '0x7b', // block 123
    receiptFound = true,
    receiptStatus = '0x1',
    logs = [{ to: COMPANY_WALLET, value: 500 }],
    currentBlock = 135, // 12 confirmations above block 123
    txFrom = SENDER_WALLET,
  } = opts

  const txResponse = txFound
    ? {
        jsonrpc: '2.0',
        result: {
          hash: TX_HASH,
          blockNumber: txBlockHex,
          from: txFrom,
          to: USDT_CONTRACT,
        },
      }
    : { jsonrpc: '2.0', result: null }

  const receiptResponse = receiptFound
    ? {
        jsonrpc: '2.0',
        result: {
          transactionHash: TX_HASH,
          blockNumber: txBlockHex,
          status: receiptStatus,
        },
      }
    : { jsonrpc: '2.0', result: null }

  const logsResponse = {
    jsonrpc: '2.0',
    result: logs.map((l) => makeTransferLog({ ...l, blockNumber: txBlockHex })),
  }

  const blockNumberResponse = {
    jsonrpc: '2.0',
    result: `0x${currentBlock.toString(16)}`,
  }

  const responses = [txResponse, receiptResponse, logsResponse, blockNumberResponse]
  let idx = 0

  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const body = responses[idx++] ?? { jsonrpc: '2.0', result: null }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  })
}

describe('EtherscanService.verifyDeposit (keyed — real verification branch)', () => {
  let svc: EtherscanService

  beforeEach(() => {
    svc = makeService('TEST_API_KEY')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('SECURITY: recipient mismatch → toMatches=false, NOT confirmed (no credit)', async () => {
    // Transfer log goes to OTHER_WALLET, not COMPANY_WALLET
    mockDirectLookup({ logs: [{ to: OTHER_WALLET, value: 500 }] })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.found).toBe(true)
    expect(r.toMatches).toBe(false)
    // Even with 12 confirmations, a non-matching recipient must NEVER be confirmed.
    expect(r.confirmed).toBe(false)
  })

  // ── H2: the keyed request MUST use direct txHash lookup (JSON-RPC proxy) ──
  // New BIZ-08 path uses eth_getTransactionByHash, NOT tokentx listing.
  // Assert the first fetch URL carries the correct JSON-RPC action and txhash.
  it('H2: keyed request uses eth_getTransactionByHash with the tx hash', async () => {
    mockDirectLookup({})
    await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    // At least 1 call
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    const firstUrl = String(fetchMock.mock.calls[0]![0])
    expect(firstUrl).toContain('action=eth_getTransactionByHash')
    expect(firstUrl).toContain(`txhash=${TX_HASH}`)
    // Should NOT use the old tokentx listing endpoint
    expect(firstUrl).not.toContain('action=tokentx')
  })

  it('SECURITY: recipient match but below threshold → pending (confirmed=false)', async () => {
    // block 123, currentBlock 129 → 6 confirmations
    mockDirectLookup({ txBlockHex: '0x7b', currentBlock: 129 })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmations).toBe(6)
    expect(r.confirmed).toBe(false)
  })

  it('recipient match AND confirmations >= threshold → confirmed=true + amount', async () => {
    mockDirectLookup({ logs: [{ to: COMPANY_WALLET, value: 750 }], currentBlock: 135 })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
    expect(r.confirmations).toBe(12)
    expect(r.amountUsdt).toBe(750)
  })

  it('case-insensitive recipient match', async () => {
    // Transfer log has uppercase wallet address (minus 0x prefix which is lowercase)
    const upperWallet = COMPANY_WALLET.toUpperCase().replace('0X', '0x')
    mockDirectLookup({ logs: [{ to: upperWallet, value: 300 }], currentBlock: 135 })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
  })

  it('tx not found on-chain → found=false, not confirmed', async () => {
    mockDirectLookup({ txFound: false })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.found).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('fetch error → graceful found=false (does not throw / hang)', async () => {
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.found).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('null company wallet → never matches / never confirmed (invariant)', async () => {
    mockDirectLookup({})
    const r = await svc.verifyDeposit(TX_HASH, null, SENDER_WALLET, 12)
    expect(r.toMatches).toBe(false)
    expect(r.confirmed).toBe(false)
  })

  it('confirmations not parseable → treated as 0, not confirmed', async () => {
    // Simulate eth_blockNumber returning a non-parseable value
    const responses = [
      {
        jsonrpc: '2.0',
        result: {
          hash: TX_HASH,
          blockNumber: '0x7b',
          from: '0x9999999999999999999999999999999999999999',
          to: USDT_CONTRACT,
        },
      },
      { jsonrpc: '2.0', result: { transactionHash: TX_HASH, blockNumber: '0x7b', status: '0x1' } },
      {
        jsonrpc: '2.0',
        result: [makeTransferLog({ to: COMPANY_WALLET, value: 500, blockNumber: '0x7b' })],
      },
      { jsonrpc: '2.0', result: 'not-a-hex' }, // unparseable block number
    ]
    let idx = 0
    // @ts-expect-error — test stub for global fetch
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const body = responses[idx++] ?? { jsonrpc: '2.0', result: null }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    // NaN - NaN = NaN → Math.max(0, NaN) = 0
    expect(r.confirmations).toBe(0)
    expect(r.confirmed).toBe(false)
  })

  // Audit 2026-06-28 (#12): a single on-chain tx can emit MULTIPLE USDT transfers
  // to the wallet under the same hash — sum ALL of them, not just the first.
  it('two USDT transfers with the same hash to the wallet → amount summed', async () => {
    mockDirectLookup({
      logs: [
        { to: COMPANY_WALLET, value: 500 },
        { to: COMPANY_WALLET, value: 250 },
      ],
      currentBlock: 135,
    })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.found).toBe(true)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
    expect(r.amountUsdt).toBe(750) // 500 + 250 summed, not just the first
  })

  // Only transfers TO the company wallet are summed; a same-hash transfer to a
  // different recipient must NOT inflate the credited amount.
  it('same-hash transfer to a different wallet is excluded from the sum', async () => {
    mockDirectLookup({
      logs: [
        { to: COMPANY_WALLET, value: 500 }, // company wallet — counts
        { to: OTHER_WALLET, value: 999 }, // different wallet — must be ignored
      ],
      currentBlock: 135,
    })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.amountUsdt).toBe(500) // only the company-wallet transfer
  })

  // ── HOLE 1 (task-onchain-payment-integrity): the SENDER must be verified ───
  // Before this, `from` was fetched and never read: any third party's transfer
  // into the company wallet could be claimed as "my payment".
  describe('SECURITY: on-chain sender (topics[1])', () => {
    it("a STRANGER's transfer into the company wallet → fromMatches=false, NOT confirmed", async () => {
      // Fully valid deposit — right recipient, right amount, 12 confirmations —
      // but sent by somebody else. This is the exploit: the payer finds it in a
      // public explorer and submits it as their own payment.
      mockDirectLookup({
        logs: [{ to: COMPANY_WALLET, value: 500, from: STRANGER_WALLET }],
        txFrom: STRANGER_WALLET,
        currentBlock: 135,
      })
      const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
      expect(r.toMatches).toBe(true) // money DID arrive…
      expect(r.fromMatches).toBe(false) // …but not from this payer
      expect(r.fromAddress).toBe(STRANGER_WALLET.toLowerCase())
      expect(r.confirmed).toBe(false) // never creditable
    })

    it('own transfer → fromMatches=true + confirmed (happy path unchanged)', async () => {
      mockDirectLookup({
        logs: [{ to: COMPANY_WALLET, value: 500, from: SENDER_WALLET }],
        currentBlock: 135,
      })
      const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
      expect(r.fromMatches).toBe(true)
      expect(r.fromAddress).toBe(SENDER_WALLET.toLowerCase())
      expect(r.confirmed).toBe(true)
      expect(r.amountUsdt).toBe(500)
    })

    it('case-insensitive sender match (explorer/EIP-55 casing)', async () => {
      const upperSender = SENDER_WALLET.toUpperCase().replace('0X', '0x')
      mockDirectLookup({
        logs: [{ to: COMPANY_WALLET, value: 500, from: SENDER_WALLET }],
        currentBlock: 135,
      })
      const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, upperSender, 12)
      expect(r.fromMatches).toBe(true)
      expect(r.confirmed).toBe(true)
    })

    it('null expected sender (no registered wallet) → fail-closed, never confirmed', async () => {
      mockDirectLookup({ logs: [{ to: COMPANY_WALLET, value: 500 }], currentBlock: 135 })
      const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, null, 12)
      expect(r.fromMatches).toBe(false)
      expect(r.confirmed).toBe(false)
      // sender is still reported for diagnostics
      expect(r.fromAddress).toBe(SENDER_WALLET.toLowerCase())
    })

    it("a stranger's transfer in the SAME tx does not top up the payer's amount", async () => {
      // Payer sent 100; a stranger sent 400 to the same wallet in the same tx.
      // Only the payer's 100 may count toward the payer's obligation.
      mockDirectLookup({
        logs: [
          { to: COMPANY_WALLET, value: 100, from: SENDER_WALLET },
          { to: COMPANY_WALLET, value: 400, from: STRANGER_WALLET },
        ],
        currentBlock: 135,
      })
      const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
      expect(r.fromMatches).toBe(true)
      expect(r.amountUsdt).toBe(100)
    })
  })
})

describe('EtherscanService.verifyDeposit (keyless — dev/test branch)', () => {
  it('keyless + wallet configured → auto-confirm deterministic (confirmations=threshold)', async () => {
    const svc = makeService('') // no API key
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
    expect(r.confirmations).toBe(12)
  })

  it('keyless + NULL wallet → never auto-confirms (invariant preserved)', async () => {
    const svc = makeService('')
    const r = await svc.verifyDeposit(TX_HASH, null, SENDER_WALLET, 12)
    expect(r.toMatches).toBe(false)
    expect(r.confirmed).toBe(false)
  })

  // HOLE 1: the same fail-closed rule for the PAYER wallet — dev/test must not
  // keep exercising a flow production rejects.
  it('keyless + NULL sender wallet → never auto-confirms (fail-closed)', async () => {
    const svc = makeService('')
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, null, 12)
    expect(r.fromMatches).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.error).toBeDefined()
  })

  // Audit 2026-06-28 (#13): FAIL-CLOSED when NODE_ENV is NOT explicitly dev/test.
  // A non-dev/test NODE_ENV (e.g. 'staging') OR an UNSET NODE_ENV with no API key
  // must be treated as production → the keyless auto-confirm path must NOT mint a
  // credit. The config stub returns 'staging' directly (no process.env fallback,
  // so the assertion is deterministic regardless of the test runner's env).
  it("keyless + NODE_ENV='staging' + wallet configured → does NOT auto-confirm (fail-closed)", async () => {
    mockDirectLookup({})
    const svc = makeService('', 'staging')
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.confirmed).toBe(false)
    expect(r.amountUsdt).toBeNull()
    expect(r.error).toBeDefined()
  })

  // 'production' NODE_ENV → fail-closed (the canonical prod case). Pins that the
  // keyless branch never auto-credits in a real deployment.
  it("keyless + NODE_ENV='production' + wallet configured → does NOT auto-confirm (fail-closed)", async () => {
    mockDirectLookup({})
    const svc = makeService('', 'production')
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)
    expect(r.confirmed).toBe(false)
    expect(r.amountUsdt).toBeNull()
    expect(r.error).toBeDefined()
  })
})
