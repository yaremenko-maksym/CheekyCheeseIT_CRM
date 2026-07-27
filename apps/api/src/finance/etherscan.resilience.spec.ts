import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from '@nestjs/config'
import { EtherscanService } from './etherscan.service'

/**
 * BIZ-08 + BIZ-16 resilience tests for EtherscanService.verifyDeposit
 *
 * AC1 — tokentx 10k-window: a tx older than 10 000 recent transfers must still
 *   verify correctly via the direct eth_getTransactionByHash / eth_getTransactionReceipt
 *   + eth_getLogs lookup path, which does NOT depend on the listing window.
 *
 * AC2 — on-chain success check: a tx that is reverted / failed on-chain (isError=1
 *   or status=0x0) must NOT credit the deposit.
 */

const COMPANY_WALLET = '0x1111111111111111111111111111111111111111'
/**
 * task-onchain-payment-integrity: the payer's registered wallet. Every fixture
 * here emits `from = 0x9999…` (both at tx level and in the Transfer topic), so
 * passing this as the expected sender keeps these resilience cases on the happy
 * sender path — they assert network/receipt behaviour, not the sender gate
 * (that lives in etherscan.verify-deposit.spec.ts).
 */
const SENDER_WALLET = '0x9999999999999999999999999999999999999999'
const TX_HASH = '0xdeadbeef000000000000000000000000000000000000000000000000000000aa'
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
// keccak256("Transfer(address,address,uint256)") — ERC-20 Transfer topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function makeService(apiKey = 'TEST_KEY', nodeEnv = 'test'): EtherscanService {
  const config = {
    get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : apiKey),
  } as unknown as ConfigService
  return new EtherscanService(config)
}

/** Build the mock response for eth_getTransactionByHash */
function mockTxByHash(opts: {
  found: boolean
  blockNumber?: string // hex, e.g. '0x12c' = 300
  isError?: '0' | '1' // 0 = success in Etherscan tx api
}) {
  if (!opts.found) return { jsonrpc: '2.0', result: null }
  return {
    jsonrpc: '2.0',
    result: {
      hash: TX_HASH,
      blockNumber: opts.blockNumber ?? '0x12c', // block 300
      from: '0x9999999999999999999999999999999999999999',
      to: USDT_CONTRACT, // contract call
      isError: opts.isError ?? '0',
    },
  }
}

/** Build the mock response for eth_getTransactionReceipt */
function mockTxReceipt(opts: {
  found: boolean
  status?: '0x0' | '0x1' // 0x1 = success
}) {
  if (!opts.found) return { jsonrpc: '2.0', result: null }
  return {
    jsonrpc: '2.0',
    result: {
      transactionHash: TX_HASH,
      blockNumber: '0x12c',
      status: opts.status ?? '0x1',
    },
  }
}

/** Build the mock response for eth_getLogs (Transfer events for the tx) */
function mockTransferLogs(opts: {
  transfers: Array<{ to: string; value: string }>
  blockNumber?: string
}) {
  return {
    jsonrpc: '2.0',
    result: opts.transfers.map((t) => ({
      transactionHash: TX_HASH,
      blockNumber: opts.blockNumber ?? '0x12c',
      address: USDT_CONTRACT,
      topics: [
        TRANSFER_TOPIC,
        '0x0000000000000000000000009999999999999999999999999999999999999999', // from
        `0x000000000000000000000000${t.to.replace('0x', '').toLowerCase()}`, // to
      ],
      data: `0x${BigInt(Math.round(parseFloat(t.value) * 1_000_000))
        .toString(16)
        .padStart(64, '0')}`,
    })),
  }
}

/** eth_blockNumber response — current head block */
function mockBlockNumber(current: number) {
  return {
    jsonrpc: '2.0',
    result: `0x${current.toString(16)}`,
  }
}

/**
 * Set up fetch mock sequence for the direct-lookup path.
 * The implementation calls in ORDER:
 *   1. eth_getTransactionByHash
 *   2. eth_getTransactionReceipt
 *   3. eth_getLogs
 *   4. eth_blockNumber (for confirmation count)
 */
function mockDirectLookup(opts: {
  txFound?: boolean
  txBlockNumber?: string // hex
  receiptFound?: boolean
  receiptStatus?: '0x0' | '0x1'
  transfers?: Array<{ to: string; value: string }>
  currentBlock?: number
  isError?: '0' | '1'
}) {
  const {
    txFound = true,
    txBlockNumber = '0x12c', // 300
    receiptFound = true,
    receiptStatus = '0x1',
    transfers = [{ to: COMPANY_WALLET, value: '500' }], // 500 USDT
    currentBlock = 312, // 12 confirmations above block 300
    isError = '0',
  } = opts

  const responses = [
    mockTxByHash({ found: txFound, blockNumber: txBlockNumber, isError }),
    mockTxReceipt({ found: receiptFound, status: receiptStatus }),
    mockTransferLogs({ transfers, blockNumber: txBlockNumber }),
    mockBlockNumber(currentBlock),
  ]

  let idx = 0
  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const body = responses[idx++] ?? { jsonrpc: '2.0', result: null }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  })
}

// ─── AC1: tokentx 10k-window ────────────────────────────────────────────────
describe('AC1: verifyDeposit — direct txHash lookup (no 10k-window dependency)', () => {
  let svc: EtherscanService

  beforeEach(() => {
    svc = makeService()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('verifies a tx outside the tokentx 10k window via direct lookup', async () => {
    // Simulate: tokentx would return empty (tx too old), but direct lookup finds it
    mockDirectLookup({
      txFound: true,
      receiptStatus: '0x1',
      transfers: [{ to: COMPANY_WALLET, value: '750' }],
      currentBlock: 312,
      txBlockNumber: '0x12c', // block 300 → 12 confirmations
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    expect(result.toMatches).toBe(true)
    expect(result.confirmed).toBe(true)
    expect(result.amountUsdt).toBe(750)
    expect(result.confirmations).toBe(12)
  })

  it('tx not found on-chain via direct lookup → found=false', async () => {
    mockDirectLookup({ txFound: false })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(false)
    expect(result.confirmed).toBe(false)
  })

  it('USDT amount summed from Transfer logs for the tx', async () => {
    // Two Transfer events to the company wallet in one tx
    mockDirectLookup({
      transfers: [
        { to: COMPANY_WALLET, value: '300' },
        { to: COMPANY_WALLET, value: '200' },
      ],
      currentBlock: 312,
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    expect(result.amountUsdt).toBe(500) // 300 + 200 summed
  })

  it('Transfer log to a different wallet is excluded from amount', async () => {
    mockDirectLookup({
      transfers: [
        { to: COMPANY_WALLET, value: '400' },
        { to: '0x2222222222222222222222222222222222222222', value: '999' }, // different wallet
      ],
      currentBlock: 312,
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.amountUsdt).toBe(400) // only company wallet transfer
  })

  it('below confirmation threshold → confirmed=false', async () => {
    mockDirectLookup({
      txBlockNumber: '0x130', // block 304
      currentBlock: 310, // only 6 confirmations
      transfers: [{ to: COMPANY_WALLET, value: '100' }],
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    expect(result.toMatches).toBe(true)
    expect(result.confirmations).toBe(6)
    expect(result.confirmed).toBe(false)
  })

  it('no Transfer logs to company wallet → toMatches=false', async () => {
    mockDirectLookup({
      transfers: [
        { to: '0x2222222222222222222222222222222222222222', value: '500' }, // different wallet
      ],
      currentBlock: 312,
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    expect(result.toMatches).toBe(false)
    expect(result.confirmed).toBe(false)
  })

  it('eth_getLogs URL: no topic1 filter (assert URL has no topic1 and has correct address)', async () => {
    // REGRESSION TEST for HIGH finding: topic1=0x000...000 would filter
    // only mint events, blocking all real deposits (non-zero from).
    // This test captures the actual eth_getLogs URL and asserts:
    //   (a) no topic1 parameter present
    //   (b) address= equals the USDT contract (not the company wallet)
    const capturedUrls: string[] = []
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrls.push(url as string)
      const idx = capturedUrls.length - 1
      const responses = [
        // eth_getTransactionByHash
        {
          jsonrpc: '2.0',
          result: {
            hash: TX_HASH,
            blockNumber: '0x12c',
            from: '0x9999999999999999999999999999999999999999',
            to: USDT_CONTRACT,
          },
        },
        // eth_getTransactionReceipt
        {
          jsonrpc: '2.0',
          result: { transactionHash: TX_HASH, blockNumber: '0x12c', status: '0x1' },
        },
        // eth_getLogs
        {
          jsonrpc: '2.0',
          result: [
            {
              transactionHash: TX_HASH,
              blockNumber: '0x12c',
              address: USDT_CONTRACT,
              topics: [
                TRANSFER_TOPIC,
                '0x0000000000000000000000009999999999999999999999999999999999999999',
                `0x000000000000000000000000${COMPANY_WALLET.replace('0x', '').toLowerCase()}`,
              ],
              data: `0x${BigInt(500 * 1_000_000)
                .toString(16)
                .padStart(64, '0')}`,
            },
          ],
        },
        // eth_blockNumber
        { jsonrpc: '2.0', result: '0x138' },
      ]
      const body = responses[idx] ?? { jsonrpc: '2.0', result: null }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    // Find the eth_getLogs call (3rd call, index 2)
    const logsUrl = capturedUrls.find((u) => u.includes('eth_getLogs'))
    expect(logsUrl).toBeDefined()
    // MUST NOT have topic1 — topic1=zero-address filters mint-only, blocking real deposits
    expect(logsUrl).not.toContain('topic1')
    expect(logsUrl).not.toContain('topic0_1_opr')
    // MUST filter by USDT contract address
    expect(logsUrl?.toLowerCase()).toContain(USDT_CONTRACT.toLowerCase())
    // Result must confirm the deposit (from is non-zero sender 0x9999...)
    expect(result.confirmed).toBe(true)
    expect(result.toMatches).toBe(true)
    expect(result.amountUsdt).toBe(500)
  })

  it('real deposit with non-zero from address → toMatches=true, confirmed=true', async () => {
    // Explicit test: the depositor (from) is a non-zero address (0x9999...).
    // If topic1 filtering were present this tx would be invisible to eth_getLogs
    // and toMatches would be false. With correct topic0-only filtering it works.
    mockDirectLookup({
      txFound: true,
      receiptStatus: '0x1',
      transfers: [{ to: COMPANY_WALLET, value: '1000' }],
      currentBlock: 312, // 12 confirmations
    })
    // The from address in mockTransferLogs is always 0x9999... (non-zero)

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    expect(result.toMatches).toBe(true)
    expect(result.confirmed).toBe(true)
    expect(result.amountUsdt).toBe(1000)
    // Sanity: receipt success
    expect((result as { onChainSuccess?: boolean }).onChainSuccess).toBe(true)
  })

  it('AbortController timeout — fetch times out → graceful found=false', async () => {
    // @ts-expect-error — test stub
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(false)
    expect(result.confirmed).toBe(false)
    expect(result.error).toBeDefined()
  })
})

// ─── AC2: on-chain success check ────────────────────────────────────────────
describe('AC2: verifyDeposit — on-chain success (reverted tx must NOT credit)', () => {
  let svc: EtherscanService

  beforeEach(() => {
    svc = makeService()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('receipt status=0x0 (reverted) → onChainSuccess=false, NOT confirmed, no credit', async () => {
    mockDirectLookup({
      receiptStatus: '0x0', // reverted
      transfers: [{ to: COMPANY_WALLET, value: '500' }],
      currentBlock: 312,
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    // A reverted tx MUST NOT credit — confirmed=false even if recipient matches and threshold met
    expect(result.confirmed).toBe(false)
    // onChainSuccess flag surfaced so caller can distinguish reverted vs pending
    expect((result as { onChainSuccess?: boolean }).onChainSuccess).toBe(false)
  })

  it('receipt not found (pending mempool tx) → confirmed=false', async () => {
    mockDirectLookup({
      receiptFound: false,
      txFound: true,
      transfers: [{ to: COMPANY_WALLET, value: '500' }],
      currentBlock: 312,
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    // tx seen in mempool (found=true) but no receipt yet → still pending
    expect(result.found).toBe(true)
    expect(result.confirmed).toBe(false)
    expect(result.confirmations).toBe(0)
  })

  it('receipt status=0x1 (success) + threshold met → confirmed=true', async () => {
    mockDirectLookup({
      receiptStatus: '0x1',
      transfers: [{ to: COMPANY_WALLET, value: '250' }],
      currentBlock: 312,
    })

    const result = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, SENDER_WALLET, 12)

    expect(result.found).toBe(true)
    expect(result.toMatches).toBe(true)
    expect(result.confirmed).toBe(true)
    expect(result.amountUsdt).toBe(250)
    expect((result as { onChainSuccess?: boolean }).onChainSuccess).toBe(true)
  })
})
