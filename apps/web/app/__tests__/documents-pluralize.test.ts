/**
 * pluralizeInvoicesPending — ru-RU plural helper for the «У вас N инвойсов
 * ожидает подписи» banner at the top of /documents. Verifies the four
 * branches of the standard Russian plural rules (11–14 always genitive
 * plural; last digit 1 → nominative singular; 2–4 → genitive singular;
 * everything else → genitive plural).
 */
import { describe, expect, it } from 'vitest'
import { pluralizeInvoicesPending } from '../routes/_authenticated/documents'

describe('pluralizeInvoicesPending', () => {
  it('uses nominative singular for n=1', () => {
    expect(pluralizeInvoicesPending(1)).toBe('У вас 1 инвойс ожидает подписи')
  })

  it('uses genitive singular for n=2, 3, 4', () => {
    expect(pluralizeInvoicesPending(2)).toBe('У вас 2 инвойса ожидают подписи')
    expect(pluralizeInvoicesPending(3)).toBe('У вас 3 инвойса ожидают подписи')
    expect(pluralizeInvoicesPending(4)).toBe('У вас 4 инвойса ожидают подписи')
  })

  it('uses genitive plural for n=5..10', () => {
    expect(pluralizeInvoicesPending(5)).toBe('У вас 5 инвойсов ожидают подписи')
    expect(pluralizeInvoicesPending(10)).toBe('У вас 10 инвойсов ожидают подписи')
  })

  it('uses genitive plural for 11..14 regardless of last digit', () => {
    expect(pluralizeInvoicesPending(11)).toBe('У вас 11 инвойсов ожидает подписи')
    expect(pluralizeInvoicesPending(12)).toBe('У вас 12 инвойсов ожидает подписи')
    expect(pluralizeInvoicesPending(13)).toBe('У вас 13 инвойсов ожидает подписи')
    expect(pluralizeInvoicesPending(14)).toBe('У вас 14 инвойсов ожидает подписи')
  })

  it('cycles back to the standard rules for 21, 22, 25', () => {
    expect(pluralizeInvoicesPending(21)).toBe('У вас 21 инвойс ожидает подписи')
    expect(pluralizeInvoicesPending(22)).toBe('У вас 22 инвойса ожидают подписи')
    expect(pluralizeInvoicesPending(25)).toBe('У вас 25 инвойсов ожидают подписи')
  })
})
