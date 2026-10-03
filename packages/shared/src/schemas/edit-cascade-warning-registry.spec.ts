import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { cascadeWarningCodeSchema } from './edit-cascade'
import {
  CASCADE_WARNING_MESSAGES,
  CASCADE_WARNING_PARAMS,
  type RenderedCascadeWarningCode,
} from './edit-cascade-warning-registry'

const UK = createI18n('uk')
const EN = createI18n('en')

type Params = Record<string, string | number>

function render(i18n: typeof UK, code: RenderedCascadeWarningCode, params: Params): string {
  const d = CASCADE_WARNING_MESSAGES[code]
  return i18n._(d.id, params, { message: d.message })
}

// Independent literals: every expected sentence below is typed out by hand, not
// derived from the registry — a tautological expectation would let a blanked
// or swapped message survive.
const CASES: {
  name: string
  code: RenderedCascadeWarningCode
  params: Params
  uk: string
  en: string
}[] = [
  {
    name: 'NO_SHARE_SNAPSHOT',
    code: 'NO_SHARE_SNAPSHOT',
    params: {},
    uk: 'Для цього рядка не збережено відсоток частки — перерахувати неможливо, потрібне ручне рішення',
    en: "No share percentage is stored for this row — it can't be recalculated, a manual decision is needed",
  },
  {
    name: 'SIGNED_INVOICE',
    code: 'SIGNED_INVOICE',
    params: {},
    uk: 'За цим рядком рахунок уже підписано контрагентом — правка не відобразиться в підписаному документі',
    en: "The invoice for this row is already signed by the counterparty — the edit won't show in the signed document",
  },
  {
    name: 'OVERPAYMENT on a row that stays paid',
    code: 'OVERPAYMENT',
    params: { paid: 'yes', settledAmount: '260,00 USDT', recomputedShare: '26,00 USDT' },
    uk: 'Вже виплачено 260,00 USDT — перерахована частка 26,00 USDT менша за виплачене, рядок залишається оплаченим, різниця сама не повернеться',
    en: "260,00 USDT has already been paid out — the recalculated share of 26,00 USDT is below what was paid, the row stays paid, the difference won't come back on its own",
  },
  {
    name: 'OVERPAYMENT on a row that is still open',
    code: 'OVERPAYMENT',
    params: { paid: 'no', settledAmount: '260,00 USDT', recomputedShare: '26,00 USDT' },
    uk: 'Вже виплачено 260,00 USDT — перерахована частка 26,00 USDT менша за виплачене, сума залишиться на рівні виплаченого, різниця сама не повернеться',
    en: "260,00 USDT has already been paid out — the recalculated share of 26,00 USDT is below what was paid, the amount stays at the paid-out level, the difference won't come back on its own",
  },
  {
    name: 'NON_USDT_CURRENCY with a recorded currency',
    code: 'NON_USDT_CURRENCY',
    params: {
      settledCurrencyKnown: 'yes',
      settledAmount: '9000',
      settledCurrency: 'UAH',
      sourceCurrency: 'USDT',
    },
    uk: 'Виплату за цим рядком враховано в UAH, а не в USDT — «вже виплачено» і «нова частка» не в одній валюті',
    en: 'The payout on this row is recorded in UAH, not in USDT — “already paid out” and “new share” are not in the same currency',
  },
  {
    name: 'NON_USDT_CURRENCY with no recorded currency',
    code: 'NON_USDT_CURRENCY',
    params: {
      settledCurrencyKnown: 'no',
      settledAmount: '260',
      settledCurrency: '',
      sourceCurrency: 'USDT',
    },
    uk: 'Валюту вже виплаченої суми (260) не зафіксовано — порівняти з новою часткою в USDT неможливо',
    en: "The currency of the amount already paid out (260) isn't recorded — it can't be compared with the new share in USDT",
  },
  {
    name: 'SOURCE_SIGNED_INVOICE',
    code: 'SOURCE_SIGNED_INVOICE',
    params: {},
    uk: 'За цим рядком уже є рахунок, підписаний контрагентом — правка суми не відобразиться в підписаному документі',
    en: "This row already has an invoice signed by the counterparty — the amount edit won't show in the signed document",
  },
  {
    name: 'OBLIGATION_CURRENCY_MISMATCH',
    code: 'OBLIGATION_CURRENCY_MISMATCH',
    params: { obligationCurrency: 'EUR', sourceCurrency: 'USDT' },
    uk: 'Зобов’язання враховано в EUR, а сума джерела — в USDT: записати перераховану частку в зобов’язання іншої валюти не можна',
    en: "The obligation is recorded in EUR while the source amount is in USDT: the recalculated share can't be written into an obligation in another currency",
  },
]

describe('CASCADE_WARNING_MESSAGES — rendered text per locale', () => {
  for (const c of CASES) {
    it(`${c.name}: uk`, () => {
      expect(render(UK, c.code, c.params)).toBe(c.uk)
    })
    it(`${c.name}: en`, () => {
      expect(render(EN, c.code, c.params)).toBe(c.en)
    })
  }

  it('leaves no raw placeholder, select syntax, Russian-only letter or catalog id in any rendering', () => {
    for (const c of CASES) {
      for (const out of [render(UK, c.code, c.params), render(EN, c.code, c.params)]) {
        expect(out).not.toMatch(/[{}]|select|cascadeWarning\./)
        // Russian-only letters: the product text is uk/en.
        expect(out).not.toMatch(/[ыэъё]/i)
      }
    }
  })
})

describe('CASCADE_WARNING_MESSAGES — registry shape', () => {
  it('has unique, namespaced ids and a non-empty uk source for every code', () => {
    const all = Object.values(CASCADE_WARNING_MESSAGES)
    const ids = all.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^cascadeWarning\./)
    for (const d of all) expect(d.message.length).toBeGreaterThan(20)
  })

  it('covers every code of the wire enum except the one that is no longer emitted', () => {
    expect(Object.keys(CASCADE_WARNING_MESSAGES).sort()).toEqual(
      [...cascadeWarningCodeSchema.options]
        .filter((c) => c !== 'SOURCE_ORIGINAL_AMOUNT_SET')
        .sort(),
    )
    expect(Object.keys(CASCADE_WARNING_PARAMS).sort()).toEqual(
      Object.keys(CASCADE_WARNING_MESSAGES).sort(),
    )
  })

  it('every placeholder in a message is a declared param of its code, and every declared param is read', () => {
    for (const code of Object.keys(CASCADE_WARNING_MESSAGES) as RenderedCascadeWarningCode[]) {
      const message = CASCADE_WARNING_MESSAGES[code].message
      // Placeholder names: `{name}` and the argument of `{name, select, ...}`.
      const used = new Set([...message.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1]))
      const declared = new Set<string>(CASCADE_WARNING_PARAMS[code])
      // `currency` is read by the client formatter, never by the text.
      declared.delete('currency')
      // `settledCurrency` is read only on the «known» branch — still read.
      expect([...used].sort()).toEqual([...declared].sort())
    }
  })
})
