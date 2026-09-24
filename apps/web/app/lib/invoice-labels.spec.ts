/**
 * invoice-labels.spec.ts — task-i18n-stage3a (Task 2), Step 5 (fix-round 1,
 * SPEC-H-1). `useInvoiceTypeLabel` is the new canon for consumers inside
 * this wave's perimeter; the legacy `getInvoiceTypeLabel` stays a plain
 * Russian string map for `components/invoices/**` (wave d, not started —
 * see the file's own doc for why it is left untouched).
 *
 * Catalog access is through `loadCatalog`/`I18nTestProvider` (SPEC-H-1) —
 * the ONLY working path in this repo's Vitest config, same as
 * `role-select.locale.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { useInvoiceTypeLabel, getInvoiceTypeLabel } from './invoice-labels'

describe('useInvoiceTypeLabel', () => {
  it('translates SENIOR_INCOME per active locale', async () => {
    await loadCatalog('uk')
    const { result: uk } = renderHook(() => useInvoiceTypeLabel('SENIOR_INCOME'), {
      wrapper: I18nTestProvider,
    })
    expect(uk.current).toBe('Дохід сеньйора')
    await loadCatalog('en')
    const { result: en } = renderHook(() => useInvoiceTypeLabel('SENIOR_INCOME'), {
      wrapper: I18nTestProvider,
    })
    expect(en.current).toBe('Senior income')
  })

  it('translates SALARY per active locale', async () => {
    await loadCatalog('uk')
    const { result: uk } = renderHook(() => useInvoiceTypeLabel('SALARY'), {
      wrapper: I18nTestProvider,
    })
    expect(uk.current).toBe('Зарплата')
    await loadCatalog('en')
    const { result: en } = renderHook(() => useInvoiceTypeLabel('SALARY'), {
      wrapper: I18nTestProvider,
    })
    expect(en.current).toBe('Salary')
  })

  it('leaves the legacy getInvoiceTypeLabel export untouched (Russian, plain string) for not-yet-migrated consumers', () => {
    expect(getInvoiceTypeLabel('SENIOR_INCOME')).toBe('Выплата синьора')
    expect(getInvoiceTypeLabel('SALARY')).toBe('Зарплата')
  })
})
