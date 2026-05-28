import { describe, expect, it } from 'vitest'
import {
  INVOICE_LIST_STALE_MS,
  INVOICE_DETAIL_STALE_MS,
  invoicesListQueryKey,
  invoiceDetailQueryKey,
} from '../use-invoices'

describe('use-invoices query keys', () => {
  it('list key uses a stable structure (filters spread + null defaults)', () => {
    const k = invoicesListQueryKey({})
    expect(k).toEqual(['invoices', 'list', { status: null, type: null }])
  })

  it('list key includes type filter when present', () => {
    const k = invoicesListQueryKey({ type: 'SENIOR_INCOME' })
    expect(k).toEqual([
      'invoices',
      'list',
      { status: null, type: 'SENIOR_INCOME' },
    ])
  })

  it('list key includes status filter when present', () => {
    const k = invoicesListQueryKey({ status: 'PENDING' })
    expect(k).toEqual([
      'invoices',
      'list',
      { status: 'PENDING', type: null },
    ])
  })

  it('list key is stable across calls with the same shape', () => {
    const a = invoicesListQueryKey({ status: 'SIGNED' })
    const b = invoicesListQueryKey({ status: 'SIGNED' })
    // Same JSON form ⇒ TanStack Query treats them as the same query.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('detail key includes the transactionId', () => {
    expect(invoiceDetailQueryKey('abc')).toEqual([
      'invoices',
      'detail',
      'abc',
    ])
  })

  it('list and detail keys do not collide at the top level', () => {
    // Both start with 'invoices' but the second segment differs ('list' vs
    // 'detail'), keeping invalidate({ queryKey: ['invoices'] }) effective for
    // both without spurious cross-talk.
    expect(invoicesListQueryKey({})[1]).toBe('list')
    expect(invoiceDetailQueryKey('x')[1]).toBe('detail')
  })
})

describe('use-invoices cache config', () => {
  it('list staleTime is 60s (per spec)', () => {
    expect(INVOICE_LIST_STALE_MS).toBe(60_000)
  })

  it('detail staleTime is 30s (per spec)', () => {
    expect(INVOICE_DETAIL_STALE_MS).toBe(30_000)
  })
})
