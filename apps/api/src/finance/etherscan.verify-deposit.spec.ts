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
 */

const COMPANY_WALLET = '0x1111111111111111111111111111111111111111'
const OTHER_WALLET = '0x2222222222222222222222222222222222222222'
const TX_HASH = '0xabc1230000000000000000000000000000000000000000000000000000000def'

function makeService(apiKey: string): EtherscanService {
  const config = { get: () => apiKey } as unknown as ConfigService
  return new EtherscanService(config)
}

function mockChainTx(opts: {
  to: string
  confirmations: string
  value?: string
  tokenDecimal?: string
}) {
  const body = {
    status: '1',
    result: [
      {
        hash: TX_HASH,
        from: '0x9999999999999999999999999999999999999999',
        to: opts.to,
        value: opts.value ?? '500000000', // 500 USDT @ 6 decimals
        contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        tokenSymbol: 'USDT',
        tokenDecimal: opts.tokenDecimal ?? '6',
        blockNumber: '123',
        confirmations: opts.confirmations,
      },
    ],
  }
  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(body) })
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
    mockChainTx({ to: OTHER_WALLET, confirmations: '50' })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.found).toBe(true)
    expect(r.toMatches).toBe(false)
    // Even with 50 confirmations, a non-matching recipient must NEVER be confirmed.
    expect(r.confirmed).toBe(false)
  })

  // ── H2: the keyed tokentx request MUST carry &address= (the company wallet) ──
  // Etherscan `account/tokentx` REQUIRES `address`; without it the API returns an
  // empty/error result and verifyDeposit would ALWAYS report "tx not found" in
  // prod (fail-closed but non-functional). Assert the URL includes both the
  // wallet `address` and the USDT `contractaddress` filter.
  it('H2: keyed request URL includes &address=<wallet> and &contractaddress=USDT', async () => {
    mockChainTx({ to: COMPANY_WALLET, confirmations: '12' })
    await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calledUrl = String(fetchMock.mock.calls[0]![0])
    expect(calledUrl).toContain(`&address=${COMPANY_WALLET}`)
    expect(calledUrl).toContain('&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7')
    expect(calledUrl).toContain('action=tokentx')
  })

  it('SECURITY: recipient match but below threshold → pending (confirmed=false)', async () => {
    mockChainTx({ to: COMPANY_WALLET, confirmations: '5' })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmations).toBe(5)
    expect(r.confirmed).toBe(false)
  })

  it('recipient match AND confirmations >= threshold → confirmed=true + amount', async () => {
    mockChainTx({ to: COMPANY_WALLET, confirmations: '12', value: '750000000' })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
    expect(r.confirmations).toBe(12)
    expect(r.amountUsdt).toBe(750)
  })

  it('case-insensitive recipient match', async () => {
    mockChainTx({ to: COMPANY_WALLET.toUpperCase().replace('0X', '0x'), confirmations: '30' })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
  })

  it('tx not found on-chain → found=false, not confirmed', async () => {
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: '1', result: [] }),
    })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.found).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('fetch error → graceful found=false (does not throw / hang)', async () => {
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.found).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('null company wallet → never matches / never confirmed (invariant)', async () => {
    mockChainTx({ to: COMPANY_WALLET, confirmations: '50' })
    const r = await svc.verifyDeposit(TX_HASH, null, 12)
    expect(r.toMatches).toBe(false)
    expect(r.confirmed).toBe(false)
  })

  it('confirmations not parseable → treated as 0, not confirmed', async () => {
    mockChainTx({ to: COMPANY_WALLET, confirmations: 'not-a-number' })
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.confirmations).toBe(0)
    expect(r.confirmed).toBe(false)
  })
})

describe('EtherscanService.verifyDeposit (keyless — dev/test branch)', () => {
  it('keyless + wallet configured → auto-confirm deterministic (confirmations=threshold)', async () => {
    const svc = makeService('') // no API key
    const r = await svc.verifyDeposit(TX_HASH, COMPANY_WALLET, 12)
    expect(r.toMatches).toBe(true)
    expect(r.confirmed).toBe(true)
    expect(r.confirmations).toBe(12)
  })

  it('keyless + NULL wallet → never auto-confirms (invariant preserved)', async () => {
    const svc = makeService('')
    const r = await svc.verifyDeposit(TX_HASH, null, 12)
    expect(r.toMatches).toBe(false)
    expect(r.confirmed).toBe(false)
  })
})
