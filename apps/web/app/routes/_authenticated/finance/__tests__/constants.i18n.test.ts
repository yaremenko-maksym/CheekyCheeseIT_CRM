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
import type { CascadeWarning, TransactionType, TransactionStatus } from '@crm/shared'
import {
  TYPE_LABEL_MESSAGES,
  STATUS_LABEL_MESSAGES,
  CASCADE_BLOCKED_REASON_OWN_MESSAGES,
  cascadeBlockedReasonMessage,
  cascadeWarningMessage,
  fmtUsd,
  fmtYyyymmdd,
} from '../constants'

const TYPE_EXPECTED: Record<TransactionType, [uk: string, en: string]> = {
  ADMIN_INCOME: ['Дохід адміна', 'Admin income'],
  SENIOR_INCOME: ['Дохід сеньйора', 'Senior income'],
  EXPENSE: ['Витрата', 'Expense'],
  SALARY: ['Зарплата', 'Salary'],
  ADMIN_TRANSFER: ['Переказ', 'Transfer'],
  PAYOUT: ['Виплата', 'Payout'],
  PAYOUT_ADMIN: ['Частка партнера', 'Partner share'],
  DROP_INCOME: ['Дохід дропа', 'Drop income'],
  PAYOUT_DROP: ['Частка дропа', 'Drop’s share'],
  PAYOUT_CONFIRMED: ['Підтверджений розрахунок', 'Confirmed settlement'],
  TOV_INCOME: ['Дохід (архів)', 'Income (archived)'],
  SENIOR_PENDING_PAYOUT: ['Очікуваний розрахунок із сеньйором', 'Pending senior settlement'],
  SENIOR_PAID: ['Розрахунок із сеньйором', 'Senior settlement'],
  ADMIN_INCOME_CASH: ['Дохід адміна (готівка)', 'Admin income (cash)'],
  ADMIN_INCOME_CRYPTO: ['Дохід адміна (USDT)', 'Admin income (USDT)'],
  SENIOR_INCOME_CRYPTO: ['Дохід сеньйора (USDT)', 'Senior income (USDT)'],
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

// The three ledger-fact refusals + the two locked fields are api-error catalog
// entries now (`CASCADE_LEDGER_FACT_ERROR_CODES`): the banner reads the SAME
// entry the 400 carries. Expected sentences are typed out here, not read back
// from the code table under test.
describe('cascadeBlockedReasonMessage — catalog-backed, uk + en', () => {
  const EXPECTED = {
    SETTLED_AMOUNT_RECORDED: [
      'За цим рядком уже були виплати — його суму підтверджено фактично переказаним, виправляйте сторнувальною транзакцією',
      'Payouts have already been made on this row — its amount is backed by what was actually transferred, correct it with a reversing transaction',
    ],
    CLOSES_OBLIGATION: [
      'Цим рядком закрито зобов’язання — його суму зафіксовано в розрахунку, виправляйте сторнувальною транзакцією',
      'This row closed an obligation — its amount is fixed in the settlement, correct it with a reversing transaction',
    ],
    ONCHAIN_DEPOSIT: [
      'Суму депозиту звірено з блокчейном — її не можна змінити, розбіжність оформлюйте окремою транзакцією',
      "The deposit amount has been matched against the blockchain — it can't be changed, record any discrepancy as a separate transaction",
    ],
    PAYMENT_FACT_RECORDED: [
      'Суму цього платежу зафіксовано разом із курсом переказу — тут її не змінити, виправте сторнувальною транзакцією',
      "This payment's amount is recorded together with the transfer rate — it can't be changed here, correct it with a reversing transaction",
    ],
  } as const

  it('uk', async () => {
    await loadCatalog('uk')
    for (const [reason, [uk]] of Object.entries(EXPECTED)) {
      expect(cascadeBlockedReasonMessage(reason as keyof typeof EXPECTED)).toBe(uk)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [reason, [, en]] of Object.entries(EXPECTED)) {
      expect(cascadeBlockedReasonMessage(reason as keyof typeof EXPECTED)).toBe(en)
    }
  })
})

describe('cascadeWarningMessage — code + params rendered per locale', () => {
  const overpayment: CascadeWarning = {
    code: 'OVERPAYMENT',
    params: { paid: 'no', settledAmount: 5000, recomputedShare: 100.5, currency: 'USDT' },
  }
  const unknownCurrency: CascadeWarning = {
    code: 'NON_USDT_CURRENCY',
    params: {
      settledCurrencyKnown: 'no',
      settledAmount: 1234.5,
      settledCurrency: '',
      sourceCurrency: 'USDT',
    },
  }

  it('uk — amounts formatted with the currency the param names, the OPEN-row branch chosen', async () => {
    await loadCatalog('uk')
    const text = cascadeWarningMessage(overpayment)
    // `\s`: grouping and the currency separator are no-break spaces.
    expect(text).toMatch(/^Вже виплачено 5\s000,00\sUSDT — перерахована частка 100,50\sUSDT менша/)
    expect(text).toContain('сума залишиться на рівні виплаченого')
    expect(text).not.toContain('залишається оплаченим')
  })

  it('en — same facts, second original text', async () => {
    await loadCatalog('en')
    const text = cascadeWarningMessage(overpayment)
    // `\s`: the formatter joins the amount and the code with a no-break space.
    expect(text).toMatch(
      /^5,000\.00\sUSDT has already been paid out — the recalculated share of 100\.50\sUSDT/,
    )
    expect(text).toContain('the amount stays at the paid-out level')
  })

  it('an amount with no recorded currency is a bare number in the viewer locale, never an invented unit', async () => {
    await loadCatalog('uk')
    // `\s`: uk groups thousands with a no-break space.
    expect(cascadeWarningMessage(unknownCurrency)).toMatch(
      /^Валюту вже виплаченої суми \(1\s234,5\) не зафіксовано — порівняти з новою часткою в USDT неможливо$/,
    )
    await loadCatalog('en')
    expect(cascadeWarningMessage(unknownCurrency)).toBe(
      "The currency of the amount already paid out (1,234.5) isn't recorded — it can't be compared with the new share in USDT",
    )
  })

  it('a bare amount keeps up to six decimals — money precision is not rounded to three', async () => {
    await loadCatalog('uk')
    expect(
      cascadeWarningMessage({
        code: 'NON_USDT_CURRENCY',
        params: { ...unknownCurrency.params, settledAmount: 0.123457 },
      }),
    ).toContain('(0,123457)')
  })

  it('an amount param that is not a number is substituted as-is, never run through the number formatter', async () => {
    await loadCatalog('uk')
    expect(
      cascadeWarningMessage({
        code: 'NON_USDT_CURRENCY',
        params: { ...unknownCurrency.params, settledAmount: 'n/a' },
      }),
    ).toContain('(n/a)')
  })

  it('falls back to the descriptor source text when the active catalog lacks the id', async () => {
    // The `message` option is the safety net for a drifted `i18n:extract`: a
    // catalog without the id must still print the uk source sentence, not the raw
    // id. A scratch locale is used because `i18n.load` MERGES into a locale that
    // already holds the real compiled catalog, which would hide the miss.
    i18n.load('zz-scratch', {})
    i18n.activate('zz-scratch')
    try {
      expect(cascadeWarningMessage({ code: 'SIGNED_INVOICE', params: {} })).toBe(
        'За цим рядком рахунок уже підписано контрагентом — правка не відобразиться в підписаному документі',
      )
    } finally {
      await loadCatalog('uk')
    }
  })

  it('a code with no catalog entry gets the generic fallback, not an empty line', async () => {
    await loadCatalog('uk')
    expect(cascadeWarningMessage({ code: 'SOURCE_ORIGINAL_AMOUNT_SET', params: {} })).toBe(
      'Не вдалося виконати дію. Спробуйте ще раз',
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
