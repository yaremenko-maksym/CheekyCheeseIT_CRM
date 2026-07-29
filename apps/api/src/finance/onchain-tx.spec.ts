import { describe, expect, it, vi } from 'vitest'

import {
  consumeTxHash,
  findConsumedTxHash,
  normalizeEthAddress,
  normalizeOnChainTxHash,
  usdtToMinorUnits,
} from './onchain-tx'
import type { DrizzleTx } from '../database/types'

/**
 * task-onchain-payment-integrity — unit tests for the shared on-chain money
 * primitives. These are small pure functions, but they decide whether real USDT
 * settlements are accepted, so every branch is pinned:
 *
 *   • `usdtToMinorUnits` — the EXACT amount comparison (replaces the ±1% band).
 *   • `normalizeOnChainTxHash` — what counts as a real, consumable transfer.
 *   • `normalizeEthAddress` — how the observed sender is stored.
 *   • `consumeTxHash` / `findConsumedTxHash` — cross-path registry plumbing.
 */

describe('usdtToMinorUnits — exact decimal → integer minor units', () => {
  it('converts the numeric(18,6) strings Drizzle returns', () => {
    expect(usdtToMinorUnits('740.000000')).toBe(740_000_000n)
    expect(usdtToMinorUnits('0.000001')).toBe(1n)
  })

  it('converts plain integers and short fractions', () => {
    expect(usdtToMinorUnits('740')).toBe(740_000_000n)
    expect(usdtToMinorUnits('740.5')).toBe(740_500_000n)
  })

  it('is EXACT for values a float pipeline would corrupt', () => {
    // IEEE-754 cannot represent these decimals, so `parseFloat(v) * 1e6` lands
    // between integers: 1.005 → 1004999.9999999999, 16.08 → 16079999.999999998,
    // 8.22 → 8220000.000000001. An exact comparison built on floats would
    // reject honest payers (or need a tolerance to paper over it) — which is
    // precisely the band this task removed.
    expect(1.005 * 1e6).not.toBe(1_005_000)
    expect(16.08 * 1e6).not.toBe(16_080_000)
    expect(8.22 * 1e6).not.toBe(8_220_000)
    // String parsing: exact, every time.
    expect(usdtToMinorUnits('1.005')).toBe(1_005_000n)
    expect(usdtToMinorUnits('16.08')).toBe(16_080_000n)
    expect(usdtToMinorUnits('8.22')).toBe(8_220_000n)
  })

  it('stays exact at magnitudes beyond Number.MAX_SAFE_INTEGER', () => {
    // 10 billion USDT = 10^16 minor units — still exact as BigInt.
    expect(usdtToMinorUnits('10000000000.000000')).toBe(10_000_000_000_000_000n)
  })

  it('handles a negative sign', () => {
    expect(usdtToMinorUnits('-12.5')).toBe(-12_500_000n)
  })

  it('rejects more than 6 decimals rather than truncating', () => {
    // Silently dropping a digit would mean accepting an amount that is not the
    // declared one — exactly what this task removes.
    expect(usdtToMinorUnits('1.0000001')).toBeNull()
  })

  it('rejects non-numeric / malformed / empty input', () => {
    expect(usdtToMinorUnits('abc')).toBeNull()
    expect(usdtToMinorUnits('')).toBeNull()
    expect(usdtToMinorUnits('1e6')).toBeNull() // scientific notation is not a payable
    expect(usdtToMinorUnits(null)).toBeNull()
    expect(usdtToMinorUnits(undefined)).toBeNull()
  })

  it('rejects a trailing decimal point (review LOW)', () => {
    // "740." is malformed input, not the number 740 — a decimal point that
    // decides money must be followed by digits.
    expect(usdtToMinorUnits('740.')).toBeNull()
  })

  it('accepts numbers as well as strings', () => {
    expect(usdtToMinorUnits(740)).toBe(740_000_000n)
  })

  it('an on-chain amount 0.5% off is NOT equal (the removed tolerance)', () => {
    const payable = usdtToMinorUnits('1000.000000')
    const onChain = usdtToMinorUnits('995.000000') // −0.5%: inside the OLD ±1%
    expect(onChain).not.toBe(payable)
  })
})

describe('normalizeOnChainTxHash — what may be consumed', () => {
  const real = '0x' + 'a'.repeat(64)

  it('lowercases a real hash (mixed-case explorer links)', () => {
    expect(normalizeOnChainTxHash('0x' + 'A'.repeat(64))).toBe(real)
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeOnChainTxHash(`  ${real}  `)).toBe(real)
  })

  it('returns null for synthetic markers (nothing on-chain to consume)', () => {
    expect(normalizeOnChainTxHash('0xSIM' + 'b'.repeat(56))).toBeNull()
    expect(normalizeOnChainTxHash('0xMANUAL' + 'c'.repeat(52))).toBeNull()
  })

  it('returns null for wrong-length / non-hex / empty input', () => {
    expect(normalizeOnChainTxHash('0x' + 'a'.repeat(63))).toBeNull()
    expect(normalizeOnChainTxHash('0x' + 'z'.repeat(64))).toBeNull()
    expect(normalizeOnChainTxHash('')).toBeNull()
    expect(normalizeOnChainTxHash(null)).toBeNull()
  })

  // ── HIGH-1 (security-review PR #438) ──────────────────────────────────────
  // The registry regex used to be ANCHORED while `submitDeposit` extracted with
  // a non-anchored one — the gap let a link-shaped input credit money without a
  // claim. The registry now uses the SAME extraction as every entry path, so no
  // input format can produce a credit the registry cannot see.
  it('EXTRACTS the hash from an explorer link (was null → the HIGH-1 bypass)', () => {
    expect(normalizeOnChainTxHash(`https://etherscan.io/tx/${real}`)).toBe(real)
    expect(normalizeOnChainTxHash(`https://etherscan.io/tx/${real}#eventlog`)).toBe(real)
    expect(normalizeOnChainTxHash(`  https://etherscan.io/tx/${'0x' + 'A'.repeat(64)}  `)).toBe(
      real,
    )
  })

  it('a link and its bare hash normalise to the SAME key (they collide)', () => {
    expect(normalizeOnChainTxHash(`https://etherscan.io/tx/${real}`)).toBe(
      normalizeOnChainTxHash(real),
    )
  })
})

describe('normalizeEthAddress — how the observed sender is stored', () => {
  it('lowercases a valid address', () => {
    expect(normalizeEthAddress('0xAbC1230000000000000000000000000000000DEF')).toBe(
      '0xabc1230000000000000000000000000000000def',
    )
  })

  it('returns null for malformed / missing input', () => {
    expect(normalizeEthAddress('0x123')).toBeNull()
    expect(normalizeEthAddress('not-an-address')).toBeNull()
    expect(normalizeEthAddress(null)).toBeNull()
  })
})

describe('consumeTxHash / findConsumedTxHash — registry plumbing', () => {
  function makeTx(tombstone: { releasedAt: Date | null } | undefined = undefined) {
    const values = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn(() => ({ values }))
    // MED-J/MED-O (rounds 5-6): after the INSERT, `consumeTxHash` selects any
    // RELEASED row for this hash to detect a claim that follows a release. The
    // read runs after the insert on purpose — see the MED-O note in the source.
    const limit = vi.fn().mockResolvedValue(tombstone ? [tombstone] : [])
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
    }))
    return {
      handle: { insert, select } as unknown as DrizzleTx,
      insert,
      values,
      select,
    }
  }

  it('inserts the NORMALISED hash so case cannot bypass the unique index', async () => {
    const { handle, values } = makeTx()
    await consumeTxHash(handle, {
      txHash: '0x' + 'A'.repeat(64),
      purpose: 'PAYOUT',
      referenceId: 'ref-1',
      consumedByUserId: 'user-1',
    })
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: '0x' + 'a'.repeat(64), purpose: 'PAYOUT' }),
    )
  })

  it('HIGH-1: a LINK is claimed under its bare hash (no unregistered credit)', async () => {
    const { handle, values } = makeTx()
    await consumeTxHash(handle, {
      txHash: `https://etherscan.io/tx/${'0x' + 'A'.repeat(64)}`,
      purpose: 'PAYOUT',
      referenceId: 'ref-link',
      consumedByUserId: 'user-1',
    })
    // Before the fix this inserted NOTHING — the credit went through unclaimed.
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ txHash: '0x' + 'a'.repeat(64) }))
  })

  it('no-ops for synthetic markers (no row, no collision)', async () => {
    const { handle, insert } = makeTx()
    await consumeTxHash(handle, {
      txHash: '0xMANUAL' + 'c'.repeat(52),
      purpose: 'PAYOUT',
      referenceId: 'ref-2',
      consumedByUserId: 'user-1',
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it('MED-J: reports a claim that follows an ADMIN release', async () => {
    const { handle } = makeTx({ releasedAt: new Date('2026-07-27T00:00:00Z') })
    const result = await consumeTxHash(handle, {
      txHash: '0x' + 'a'.repeat(64),
      purpose: 'COMPANY_DEPOSIT',
      referenceId: 'ref-1',
      consumedByUserId: 'user-1',
    })
    // Legitimate (that is what a release is FOR) — but the caller must record
    // the second half of the "released → spent again" pair.
    expect(result).toEqual({ claimed: true, reclaimedAfterRelease: true })
  })

  it('a first-time claim is not reported as a re-claim', async () => {
    const { handle } = makeTx(undefined)
    const result = await consumeTxHash(handle, {
      txHash: '0x' + 'b'.repeat(64),
      purpose: 'PAYOUT',
      referenceId: 'ref-2',
      consumedByUserId: 'user-1',
    })
    expect(result).toEqual({ claimed: true, reclaimedAfterRelease: false })
  })

  it('findConsumedTxHash normalises before looking up, and skips markers', async () => {
    const findFirst = vi.fn().mockResolvedValue({ purpose: 'COMPANY_DEPOSIT' })
    const db = { query: { consumedTxHashes: { findFirst } } } as unknown as Pick<DrizzleTx, 'query'>

    await expect(findConsumedTxHash(db, '0x' + 'A'.repeat(64))).resolves.toEqual({
      purpose: 'COMPANY_DEPOSIT',
    })
    expect(findFirst).toHaveBeenCalledOnce()

    findFirst.mockClear()
    await expect(findConsumedTxHash(db, '0xSIM' + 'b'.repeat(56))).resolves.toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
