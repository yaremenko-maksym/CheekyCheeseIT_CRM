import type { MessageDescriptor } from '@lingui/core'
import type { CascadeWarningCode } from './edit-cascade'

/**
 * i18n (finance wave, deferred from stage 6A). The text of every paid-transaction
 * edit-cascade warning, as `/* i18n *\/`-marked explicit-id descriptors.
 *
 * Division of labour — the resolver (`resolveEditCascade`, pure, server-side)
 * answers WHICH warning fired and WITH WHAT FACTS (`code` + `params`); the CLIENT
 * renders the sentence from this catalog in the viewer's locale. No Russian (or any
 * other) prose crosses the wire, so a plan cached or logged in one locale never
 * pins a text in it.
 *
 * Params (wire contract, see `CASCADE_WARNING_PARAMS`):
 *   - amounts are NUMBERS on the wire; the client formats them for the locale and
 *     the currency before substituting (`{settledAmount}` arrives as «50,00 USDT»);
 *   - currencies are codes (`USDT`, `UAH`), locale-neutral;
 *   - a text that has two outcomes is ONE descriptor with an ICU `select` over an
 *     explicit flag param, not two codes — consumers key off `code`.
 * Every substituted value is nominative or a code: no case agreement to compute.
 *
 * `SOURCE_ORIGINAL_AMOUNT_SET` is deliberately absent: it is no longer emitted (a
 * salary's triplet follows the edit; see `resolveSourceWarnings`) and kept in the
 * code enum for wire compatibility only. A reader that meets it gets the generic
 * fallback, not a text nobody reviewed.
 *
 * Source text is `uk`; `en` is a second original in the `.po`, not a calque.
 * Glossary (`CONTEXT.md`): «частка», «зобов’язання», «рахунок» (invoice),
 * «контрагент».
 */
export type RenderedCascadeWarningCode = Exclude<CascadeWarningCode, 'SOURCE_ORIGINAL_AMOUNT_SET'>

export const CASCADE_WARNING_MESSAGES = {
  NO_SHARE_SNAPSHOT: /* i18n */ {
    id: 'cascadeWarning.NO_SHARE_SNAPSHOT',
    message:
      'Для цього рядка не збережено відсоток частки — перерахувати неможливо, потрібне ручне рішення',
  },
  SIGNED_INVOICE: /* i18n */ {
    id: 'cascadeWarning.SIGNED_INVOICE',
    message:
      'За цим рядком рахунок уже підписано контрагентом — правка не відобразиться в підписаному документі',
  },
  // `paid` = `yes` for a PAID obligation that stays PAID (nothing is written);
  // anything else is a row reverted to PENDING earlier and still open — its amount
  // is held at the accumulator and nothing more is owed (QA-H-1, second layer: one
  // text was describing two outcomes and was false for the second).
  OVERPAYMENT: /* i18n */ {
    id: 'cascadeWarning.OVERPAYMENT',
    message:
      '{paid, select, yes {Вже виплачено {settledAmount} — перерахована частка {recomputedShare} менша за виплачене, рядок залишається оплаченим, різниця сама не повернеться} other {Вже виплачено {settledAmount} — перерахована частка {recomputedShare} менша за виплачене, сума залишиться на рівні виплаченого, різниця сама не повернеться}}',
  },
  // `settledCurrencyKnown` = `no` when the currency of the paid sum was never
  // recorded: «unknown» is not «assume it matches».
  NON_USDT_CURRENCY: /* i18n */ {
    id: 'cascadeWarning.NON_USDT_CURRENCY',
    message:
      '{settledCurrencyKnown, select, no {Валюту вже виплаченої суми ({settledAmount}) не зафіксовано — порівняти з новою часткою в {sourceCurrency} неможливо} other {Виплату за цим рядком враховано в {settledCurrency}, а не в {sourceCurrency} — «вже виплачено» і «нова частка» не в одній валюті}}',
  },
  SOURCE_SIGNED_INVOICE: /* i18n */ {
    id: 'cascadeWarning.SOURCE_SIGNED_INVOICE',
    message:
      'За цим рядком уже є рахунок, підписаний контрагентом — правка суми не відобразиться в підписаному документі',
  },
  OBLIGATION_CURRENCY_MISMATCH: /* i18n */ {
    id: 'cascadeWarning.OBLIGATION_CURRENCY_MISMATCH',
    message:
      'Зобов’язання враховано в {obligationCurrency}, а сума джерела — в {sourceCurrency}: записати перераховану частку в зобов’язання іншої валюти не можна',
  },
} satisfies Record<RenderedCascadeWarningCode, MessageDescriptor>

/**
 * Names of the params each warning carries on the wire — the contract between the
 * resolver (producer) and the client renderer (consumer). A spec renders every
 * message in both locales with exactly these names, so a placeholder added to a
 * text without a producer (or vice versa) fails a test instead of printing
 * `{recomputedShare}` on a money screen.
 */
export const CASCADE_WARNING_PARAMS = {
  NO_SHARE_SNAPSHOT: [],
  SIGNED_INVOICE: [],
  OVERPAYMENT: ['paid', 'settledAmount', 'recomputedShare', 'currency'],
  NON_USDT_CURRENCY: ['settledCurrencyKnown', 'settledAmount', 'settledCurrency', 'sourceCurrency'],
  SOURCE_SIGNED_INVOICE: [],
  OBLIGATION_CURRENCY_MISMATCH: ['obligationCurrency', 'sourceCurrency'],
} as const satisfies Record<RenderedCascadeWarningCode, readonly string[]>
