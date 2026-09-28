/**
 * task-i18n-3d-pr1-fix (mutation-gate follow-up). Pins the exact label text
 * for every `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` entry, on both uk
 * and en, plus the locale-dependent formatting helpers (`fmtUsd`,
 * `fmtYyyymmdd`) that read `activeLocale()` — resolved through the REAL
 * compiled catalog (`loadCatalog`/`i18n._`, same pattern as
 * `routes/_authenticated/projects/__tests__/constants.test.ts`), not read as
 * a plain string, so a mutated/emptied `msg` template or locale-tag literal
 * is caught rather than silently passing (mutation gate: 33 survived
 * StringLiteral/ObjectLiteral/LogicalOperator mutants in `constants.ts`
 * before this file — `satisfies` without `as const` means Stryker sees every
 * one of these literals).
 *
 * task-i18n-stage3d-pr4: `fmtDate`/`fmtMonth` (and their own
 * `constants.fmtMonth.test.ts` file) are deleted alongside
 * `TYPE_LABELS`/`STATUS_LABELS` — the last callers now read `@crm/shared`'s
 * `formatDate`/`formatMonthLabel` directly (pinned in `packages/shared/src/
 * i18n/format.spec.ts`'s own 'shortYY'/`formatMonthLabel` tests). The
 * `activeLocale()` fallback this file used to pin THROUGH `fmtDate` is
 * re-pinned below through `fmtYyyymmdd`, the one remaining `activeLocale()`
 * consumer with the same "no locale activated yet" fallback shape.
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { loadCatalog } from '@/test/i18n'
import type { TransactionType, TransactionStatus } from '@crm/shared'
import {
  TYPE_LABEL_MESSAGES,
  STATUS_LABEL_MESSAGES,
  CASCADE_BLOCKED_REASON_OWN_MESSAGES,
  fmtUsd,
  fmtYyyymmdd,
} from '../constants'

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
// file), so `fmtYyyymmdd` exercises the `??` fallback to `DEFAULT_LOCALE`
// ('uk') directly. A `&&` mutant there would leave `i18n.locale`
// (`undefined`) unchanged, and `@crm/shared`'s `formatDate` would feed
// `undefined` to `Intl.DateTimeFormat`, producing the runtime's default
// locale format ('01/15/26', verified) instead of uk-UA's dot-separated one
// asserted below.
describe('activeLocale() fallback (LogicalOperator mutant)', () => {
  it('fmtYyyymmdd falls back to uk-UA formatting before any locale is activated', () => {
    expect(fmtYyyymmdd('20260115')).toBe('15.01.26')
  })

  it('fmtYyyymmdd uses en-GB formatting once en is activated', async () => {
    await loadCatalog('en')
    // en-GB pins day/month/year with '/' separators — distinct from uk-UA's
    // '.' separators above, so an emptied 'en-GB' entry (StringLiteral
    // mutant) cannot pass this assertion by falling through to uk-UA's shape.
    expect(fmtYyyymmdd('20260115')).toBe('15/01/26')
  })
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

// FIX-CASCADE-1 (fix-round, PR #730 mutation-gate follow-up): not yet wired
// into `cascadeBlockedReasonMessage()` (see the deprecation note on
// `CASCADE_BLOCKED_REASON_MESSAGES` in constants.ts), but the module-level
// `satisfies Record<..., MessageDescriptor>` literal is still evaluated at
// import time by every test that imports `constants.ts` — an emptied object
// or an emptied `msg` template inside it survives every test in this repo
// UNLESS something reads its actual translated text, exactly the class of
// mutant this file exists to kill for its siblings above.
describe('CASCADE_BLOCKED_REASON_OWN_MESSAGES — uk + en', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    expect(i18n._(CASCADE_BLOCKED_REASON_OWN_MESSAGES.PAYOUT_FAMILY)).toBe(
      'Це рядок виплати — сума підтверджена виконаним переказом, вона не редагується, виправляйте сторнувальною транзакцією',
    )
    expect(i18n._(CASCADE_BLOCKED_REASON_OWN_MESSAGES.LINKED_TO_PAYOUT_REQUEST)).toBe(
      'Рядок включено до оформленої заявки на виплату — сума вже увійшла до розрахунку переказу, виправляйте сторнувальною транзакцією',
    )
  })

  it('en', async () => {
    await loadCatalog('en')
    expect(i18n._(CASCADE_BLOCKED_REASON_OWN_MESSAGES.PAYOUT_FAMILY)).toBe(
      'This is a payout row — the amount is confirmed by an executed transfer and is not editable, fix it with a reversing transaction',
    )
    expect(i18n._(CASCADE_BLOCKED_REASON_OWN_MESSAGES.LINKED_TO_PAYOUT_REQUEST)).toBe(
      'The row is included in a submitted payout request — the amount is already part of the transfer calculation, fix it with a reversing transaction',
    )
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
