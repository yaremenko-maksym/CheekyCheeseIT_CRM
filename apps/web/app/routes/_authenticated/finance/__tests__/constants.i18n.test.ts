/**
 * task-i18n-3d-pr1-fix (mutation-gate follow-up). Pins the exact label text
 * for every `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` entry, on both uk
 * and en, plus the locale-dependent formatting helpers (`fmtUsd`, `fmtDate`,
 * `fmtMonth`) that read `activeLocale()` — resolved through the REAL
 * compiled catalog (`loadCatalog`/`i18n._`, same pattern as
 * `routes/_authenticated/projects/__tests__/constants.test.ts`), not read as
 * a plain string, so a mutated/emptied `msg` template or locale-tag literal
 * is caught rather than silently passing (mutation gate: 33 survived
 * StringLiteral/ObjectLiteral/LogicalOperator mutants in `constants.ts`
 * before this file — `satisfies` without `as const` means Stryker sees every
 * one of these literals).
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { loadCatalog } from '@/test/i18n'
import type { TransactionType, TransactionStatus } from '@crm/shared'
import { TYPE_LABEL_MESSAGES, STATUS_LABEL_MESSAGES, fmtUsd, fmtDate } from '../constants'

const TYPE_EXPECTED: Record<TransactionType, [uk: string, en: string]> = {
  ADMIN_INCOME: ['Прихід адміна', 'Admin income'],
  SENIOR_INCOME: ['Прихід сеньйора', 'Senior income'],
  EXPENSE: ['Витрата', 'Expense'],
  SALARY: ['Зарплата', 'Salary'],
  ADMIN_TRANSFER: ['Переказ', 'Transfer'],
  PAYOUT: ['Виплата', 'Payout'],
  PAYOUT_ADMIN: ['Частка партнера', 'Partner share'],
  DROP_INCOME: ['Прихід дропа', 'Drop income'],
  PAYOUT_DROP: ['Частка дропа', 'Drop’s share'],
  PAYOUT_CONFIRMED: ['Підтверджений розрахунок', 'Confirmed settlement'],
  TOV_INCOME: ['Прихід (архів)', 'Income (archived)'],
  SENIOR_PENDING_PAYOUT: ['Очікуваний розрахунок із сеньйором', 'Pending senior settlement'],
  SENIOR_PAID: ['Розрахунок із сеньйором', 'Senior settlement'],
  ADMIN_INCOME_CASH: ['Прихід адміна (готівка)', 'Admin income (cash)'],
  ADMIN_INCOME_CRYPTO: ['Прихід адміна (USDT)', 'Admin income (USDT)'],
  SENIOR_INCOME_CRYPTO: ['Прихід сеньйора (USDT)', 'Senior income (USDT)'],
  DIVIDEND_TO_ADMIN: ['Дивіденди адміну', 'Dividends to admin'],
  DIVIDEND_TAX: ['Податок на дивіденди', 'Dividend tax'],
  COMPANY_DEPOSIT: ['Поповнення рахунку компанії', 'Company account deposit'],
  DROP_PENDING_PAYOUT: ['Очікуваний розрахунок із дропом', 'Pending drop settlement'],
}

const STATUS_EXPECTED: Record<TransactionStatus, [uk: string, en: string]> = {
  PENDING: ['Очікує валідації', 'Awaiting validation'],
  VALIDATED: ['Підтверджено', 'Validated'],
  PENDING_PAYMENT: ['Очікує виплати', 'Awaiting payout'],
  REJECTED: ['Відхилено', 'Rejected'],
  PAID: ['Оплачено', 'Paid'],
  LOCKED: ['Заблоковано', 'Locked'],
  PENDING_CASH_CONFIRM: [
    'Очікує підтвердження бухгалтером (готівка)',
    'Awaiting accountant confirmation (cash)',
  ],
}

// activeLocale() reads `i18n.locale ?? DEFAULT_LOCALE` — this MUST be the
// first describe in the file: before any `loadCatalog()` call anywhere in
// this module, `i18n.locale` is `undefined` (fresh module registry per test
// file), so `fmtDate` exercises the `??` fallback to `DEFAULT_LOCALE` ('uk')
// directly. A `&&` mutant there would leave `i18n.locale` (`undefined`)
// unchanged, and `FMT_DATE_INTL_TAG[undefined]` would feed `undefined` to
// `Intl.DateTimeFormat`, producing the runtime's default locale format
// ('01/15/26', verified) instead of uk-UA's dot-separated one asserted below.
describe('activeLocale() fallback (LogicalOperator mutant)', () => {
  it('fmtDate falls back to uk-UA formatting before any locale is activated', () => {
    expect(fmtDate('2026-01-15')).toBe('15.01.26')
  })

  it('fmtDate uses en-GB formatting once en is activated (FMT_DATE_INTL_TAG en entry)', async () => {
    await loadCatalog('en')
    // en-GB pins day/month/year with '/' separators — distinct from uk-UA's
    // '.' separators above, so an emptied 'en-GB' entry (StringLiteral
    // mutant) cannot pass this assertion by falling through to uk-UA's shape.
    expect(fmtDate('2026-01-15')).toBe('15/01/26')
  })

  // `fmtMonth`'s own month-arithmetic (`new Date(year, month - 1, 1)`) and
  // its 'monthYear' style are pinned in `constants.fmtMonth.test.ts` instead,
  // via a `formatDate` spy — asserting on the real formatted STRING here is
  // host-timezone-dependent (`fmtMonth` builds a LOCAL Date then formats it
  // with an explicit `timeZone: 'UTC'`; a positive host offset rolls the
  // displayed month back by one — reproduced directly under mutation-gate:
  // "expected 'April 2026' to be 'May 2026'", even with `TZ` pinned inside
  // this very `it` block, in this file's happy-dom environment).
})

describe('TYPE_LABEL_MESSAGES — every transaction type, uk + en', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    for (const [type, [uk]] of Object.entries(TYPE_EXPECTED) as [
      TransactionType,
      [string, string],
    ][]) {
      expect(i18n._(TYPE_LABEL_MESSAGES[type])).toBe(uk)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [type, [, en]] of Object.entries(TYPE_EXPECTED) as [
      TransactionType,
      [string, string],
    ][]) {
      expect(i18n._(TYPE_LABEL_MESSAGES[type])).toBe(en)
    }
  })
})

describe('STATUS_LABEL_MESSAGES — every transaction status, uk + en', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    for (const [status, [uk]] of Object.entries(STATUS_EXPECTED) as [
      TransactionStatus,
      [string, string],
    ][]) {
      expect(i18n._(STATUS_LABEL_MESSAGES[status])).toBe(uk)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [status, [, en]] of Object.entries(STATUS_EXPECTED) as [
      TransactionStatus,
      [string, string],
    ][]) {
      expect(i18n._(STATUS_LABEL_MESSAGES[status])).toBe(en)
    }
  })
})

describe('fmtUsd — locale-aware digit grouping + fixed 2 decimals', () => {
  const rates = { usdUah: '41.5', usdtUah: '41.5', eurUah: '44.8', date: '2026-01-01' }

  it('uk: thin-space grouping, comma decimal, $ prefix, 2 fraction digits', async () => {
    await loadCatalog('uk')
    // An emptied options object (ObjectLiteral mutant) would drop the fixed
    // 2-decimal constraint and render "7 777" instead of "7 777,00"; an
    // emptied template (StringLiteral mutant covering the whole `$${...}`
    // literal) would return "" instead.
    expect(fmtUsd('7777', 'USD', rates)).toBe('$7 777,00')
  })

  it('en: comma grouping, dot decimal', async () => {
    await loadCatalog('en')
    expect(fmtUsd('7777', 'USD', rates)).toBe('$7,777.00')
  })
})
