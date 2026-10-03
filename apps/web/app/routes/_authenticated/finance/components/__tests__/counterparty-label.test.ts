import { describe, expect, it } from 'vitest'
import type { TransactionDto } from '@crm/shared'
import { displayCounterpartyLabel, withLocalizedCompanyLabels } from '../counterparty-label'

const LOCALIZED = 'Рахунок компанії'

describe('displayCounterpartyLabel', () => {
  it('maps the COMPANY code to the localized text', () => {
    expect(displayCounterpartyLabel('COMPANY', LOCALIZED)).toBe(LOCALIZED)
  })

  it.each(['CheekyCheeseIT', 'Максим Яремко', 'Acme Corp', 'company'])(
    'passes %s through unchanged (only the exact code maps)',
    (label) => {
      expect(displayCounterpartyLabel(label, LOCALIZED)).toBe(label)
    },
  )

  it('keeps null / undefined as null so callers keep their own fallback', () => {
    expect(displayCounterpartyLabel(null, LOCALIZED)).toBeNull()
    expect(displayCounterpartyLabel(undefined, LOCALIZED)).toBeNull()
  })
})

describe('withLocalizedCompanyLabels', () => {
  const base = { senderLabel: 'COMPANY', receiverLabel: 'COMPANY' }

  it('localizes both sides of a counterparty row', () => {
    const out = withLocalizedCompanyLabels(
      { ...base, type: 'DIVIDEND_TO_ADMIN' } as TransactionDto,
      LOCALIZED,
    )
    expect(out.senderLabel).toBe(LOCALIZED)
    expect(out.receiverLabel).toBe(LOCALIZED)
  })

  it('never rewrites an EXPENSE category (free text), but still localizes its sender', () => {
    const out = withLocalizedCompanyLabels(
      { ...base, type: 'EXPENSE' } as TransactionDto,
      LOCALIZED,
    )
    expect(out.senderLabel).toBe(LOCALIZED)
    expect(out.receiverLabel).toBe('COMPANY')
  })
})
