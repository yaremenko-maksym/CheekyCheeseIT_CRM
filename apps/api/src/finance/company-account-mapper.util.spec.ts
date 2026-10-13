import { describe, expect, it } from 'vitest'
import type { transactions } from '../database/schema'
import { toDepositDto } from './company-account-mapper.util'

type Tx = typeof transactions.$inferSelect

function makeTx(over: Partial<Tx>): Tx {
  return {
    id: 'tx-1',
    txHash: '0xabc',
    amount: '12.5',
    status: 'PENDING',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    ...over,
  } as Tx
}

describe('toDepositDto', () => {
  it('PENDING without verification: 0 confirmations, toMatches false', () => {
    expect(toDepositDto(makeTx({}), 12)).toEqual({
      id: 'tx-1',
      txHash: '0xabc',
      amountUsdt: 12.5,
      status: 'PENDING',
      confirmations: 0,
      threshold: 12,
      toMatches: false,
      createdAt: '2026-01-02T03:04:05.000Z',
    })
  })

  it('PAID without verification: confirmations = threshold, toMatches true', () => {
    expect(toDepositDto(makeTx({ status: 'PAID' }), 12)).toEqual({
      id: 'tx-1',
      txHash: '0xabc',
      amountUsdt: 12.5,
      status: 'PAID',
      confirmations: 12,
      threshold: 12,
      toMatches: true,
      createdAt: '2026-01-02T03:04:05.000Z',
    })
  })

  it('any non-PAID status maps to PENDING', () => {
    expect(toDepositDto(makeTx({ status: 'FAILED' as Tx['status'] }), 5).status).toBe('PENDING')
  })

  it('verification overrides confirmations and toMatches (PENDING row)', () => {
    const dto = toDepositDto(makeTx({}), 12, {
      toMatches: true,
      confirmations: 7,
      amountUsdt: 99,
    })
    expect(dto.confirmations).toBe(7)
    expect(dto.toMatches).toBe(true)
    expect(dto.amountUsdt).toBe(12.5)
  })

  it('verification overrides a PAID row, including zero/false values', () => {
    const dto = toDepositDto(makeTx({ status: 'PAID' }), 12, {
      toMatches: false,
      confirmations: 0,
      amountUsdt: null,
    })
    expect(dto.confirmations).toBe(0)
    expect(dto.toMatches).toBe(false)
    expect(dto.status).toBe('PAID')
  })

  it('null txHash becomes empty string', () => {
    expect(toDepositDto(makeTx({ txHash: null }), 1).txHash).toBe('')
  })

  it('non-numeric amount becomes null', () => {
    expect(toDepositDto(makeTx({ amount: 'abc' }), 1).amountUsdt).toBeNull()
  })

  it('zero amount stays 0', () => {
    expect(toDepositDto(makeTx({ amount: '0' }), 1).amountUsdt).toBe(0)
  })
})
