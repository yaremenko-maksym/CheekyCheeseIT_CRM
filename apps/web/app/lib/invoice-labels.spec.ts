/**
 * invoice-labels.spec.ts — task-i18n-stage3a (Task 2), Step 5 (fix-round 1,
 * SPEC-H-1) introduced `useInvoiceTypeLabel` as the catalog-backed canon
 * while a legacy `getInvoiceTypeLabel` (plain Russian string map) kept
 * serving `components/invoices/**` until that slice's own wave migrated.
 * task-i18n-stage3d-pr4 is that wave — `getInvoiceTypeLabel` is deleted, its
 * two consumers (`invoice-card.tsx`, `invoice-detail-dialog.tsx`) now call
 * this hook, and this file's own pin of the legacy export goes with it.
 *
 * Catalog access is through `loadCatalog`/`I18nTestProvider` (SPEC-H-1) —
 * the ONLY working path in this repo's Vitest config, same as
 * `role-select.locale.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { useInvoiceTypeLabel } from './invoice-labels'

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
})
