import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import {
  CASCADE_LEDGER_FACT_MESSAGES,
  DEFAULT_LOCALE,
  formatDate,
  formatNumber,
  type CascadeEditPreviewBlockedReason,
  type TransactionType,
  type TransactionStatus,
  type Locale,
} from '@crm/shared'
import { formatAmount } from '@/lib/format-amount'
import { translateApiError } from '@/lib/axios-utils'

/** Active catalog locale, read through the `@lingui/core` singleton — the
 * same pattern `axios-utils.ts`'s `getUserFacingErrorMessage` and
 * `project-approval-caption.ts` use for a plain (non-component) function
 * that needs the active locale. `fmtDate`/`fmtMonth`/`fmtUsd` below keep
 * their existing signatures (many call sites across PR2–PR4 and the
 * cross-slice `InProgressPanel.tsx` are not migrated yet) — this is how
 * they become locale-aware without a breaking signature change. */
function activeLocale(): Locale {
  return (i18n.locale as Locale) ?? DEFAULT_LOCALE
}

/**
 * task-cascade-preview-ui (task 5) — why the amount on THIS row cannot be
 * edited, in the operator's language.
 *
 * Four of the six come straight from `@crm/shared`: the write path's 400 body
 * and the preview's blocked reason are two renderings of ONE sentence, and this
 * screen is the third — restating them here would be a second description of a
 * refusal, which is exactly the drift the shared constant exists to prevent.
 *
 * Two are written here because they have no server-side counterpart to reuse:
 * `PAYOUT_FAMILY` and `LINKED_TO_PAYOUT_REQUEST` are decided by
 * `getEditCascadePreview` before a plan is built. They follow the register of
 * the four above deliberately — name the CARRIER of the number, then name the
 * remedy, one sentence, no closing period — because they are rendered in the
 * same banner, one after another, and a register change reads as a different
 * system talking.
 */
export const CASCADE_BLOCKED_REASON_MESSAGES: Record<
  Exclude<
    CascadeEditPreviewBlockedReason,
    'PAYMENT_FACT_RECORDED' | 'SALARY_OBLIGATION_OUT_OF_RANGE'
  >,
  string
> = {
  ...CASCADE_LEDGER_FACT_MESSAGES,
  PAYOUT_FAMILY:
    'Это строка выплаты — сумма подтверждена исполненным переводом, она не редактируется, правьте сторнирующей транзакцией',
  LINKED_TO_PAYOUT_REQUEST:
    'Строка включена в оформленную заявку на выплату — сумма уже вошла в расчёт перевода, правьте сторнирующей транзакцией',
}

/**
 * Shown when `editable` is false but `blockedReason` is not one of the six —
 * impossible by the contract, and therefore exactly the case where a
 * `Record` lookup would render `undefined` into the DOM instead of saying
 * anything. An honest short sentence beats a blank refusal.
 */
export const CASCADE_BLOCKED_FALLBACK_MESSAGE = 'Правка суммы для этой строки недоступна'

/**
 * task-paid-salary-amount-edit — the ONE way to render a blocked reason.
 *
 * `PAYMENT_FACT_RECORDED` is translated through the api-error catalog
 * (`FINANCE_PAYMENT_FACT_AMOUNT_LOCKED`, uk/en) — the SAME entry the write
 * path's 400 carries, so the banner and the refusal cannot drift. Resolved at
 * call time, not stored in the table above, because a catalog lookup depends
 * on the active locale. The rest keep their existing texts until finance
 * migrates to the catalog.
 */
export function cascadeBlockedReasonMessage(
  reason: CascadeEditPreviewBlockedReason | null | undefined,
): string {
  if (!reason) return CASCADE_BLOCKED_FALLBACK_MESSAGE
  if (reason === 'PAYMENT_FACT_RECORDED') {
    return translateApiError('FINANCE_PAYMENT_FACT_AMOUNT_LOCKED', undefined)
  }
  // CR-M-1 — «перевірте суму», never a reversing transaction: the salary is
  // editable, only not to this figure.
  if (reason === 'SALARY_OBLIGATION_OUT_OF_RANGE') {
    return translateApiError('FINANCE_SALARY_OBLIGATION_OUT_OF_RANGE', undefined)
  }
  return CASCADE_BLOCKED_REASON_MESSAGES[reason]
}

/**
 * task-i18n-stage3d-pr1 (Task 1, Step 3, template G). `msg` (module level,
 * `@lingui/core/macro`) fixes each entry's SOURCE (`uk`) text as a
 * `MessageDescriptor` — resolved against the ACTIVE catalog at the render
 * site via `i18n._(TYPE_LABEL_MESSAGES[type])`, never called at module
 * level with `t`. `satisfies` WITHOUT `as const` — an `as const` here would
 * make Stryker report 0 mutants for the whole block (урок #707).
 *
 * Terms follow the wave (d) canon (`CONTEXT.md` → «Волна d»): `PAYOUT` is
 * always «Виплата» (the senior pays the company); the `SENIOR_*`/`DROP_*`
 * settlement family uses «розрахунок», never «виплата» (COPY-H-fin-1).
 * `ADMIN_INCOME*`/`DIVIDEND_TO_ADMIN` stay in Ukrainian throughout — no
 * Latin "Admin" leaking into the label (COPY-M-fin-11).
 */
export const TYPE_LABEL_MESSAGES = {
  ADMIN_INCOME: msg`Прихід адміна`, // en: Admin income
  SENIOR_INCOME: msg`Прихід сеньйора`, // en: Senior income
  EXPENSE: msg`Витрата`, // en: Expense
  SALARY: msg`Зарплата`, // en: Salary
  ADMIN_TRANSFER: msg`Переказ`, // en: Transfer
  PAYOUT: msg`Виплата`, // en: Payout
  PAYOUT_ADMIN: msg`Частка партнера`, // en: Partner share
  DROP_INCOME: msg`Прихід дропа`, // en: Drop income
  PAYOUT_DROP: msg`Частка дропа`, // en: Drop share
  PAYOUT_CONFIRMED: msg`Підтверджений розрахунок`, // en: Confirmed settlement
  TOV_INCOME: msg`Прихід (архів)`, // en: Income (archived)
  SENIOR_PENDING_PAYOUT: msg`Очікуваний розрахунок із сеньйором`, // en: Pending senior settlement
  SENIOR_PAID: msg`Розрахунок із сеньйором`, // en: Senior settlement
  ADMIN_INCOME_CASH: msg`Прихід адміна (готівка)`, // en: Admin income (cash)
  ADMIN_INCOME_CRYPTO: msg`Прихід адміна (USDT)`, // en: Admin income (USDT)
  SENIOR_INCOME_CRYPTO: msg`Прихід сеньйора (USDT)`, // en: Senior income (USDT)
  DIVIDEND_TO_ADMIN: msg`Дивіденди адміну`, // en: Dividend to admin
  DIVIDEND_TAX: msg`Податок на дивіденди`, // en: Dividend tax
  COMPANY_DEPOSIT: msg`Поповнення рахунку компанії`, // en: Company account deposit
  DROP_PENDING_PAYOUT: msg`Очікуваний розрахунок із дропом`, // en: Pending drop settlement
} satisfies Record<TransactionType, MessageDescriptor>

/**
 * task-i18n-stage3d-pr1 (Task 1, Step 3, COPY-M-fin-13): `PENDING`/
 * `PENDING_CASH_CONFIRM` name WHAT is being awaited instead of a bare
 * «Очікує» — an object-less wait reads as ambiguous next to the other five
 * statuses, which all name a concrete state.
 */
export const STATUS_LABEL_MESSAGES = {
  PENDING: msg`Очікує валідації`, // en: Awaiting validation
  VALIDATED: msg`Підтверджено`, // en: Validated
  PENDING_PAYMENT: msg`Очікує виплати`, // en: Awaiting payout
  REJECTED: msg`Відхилено`, // en: Rejected
  PAID: msg`Оплачено`, // en: Paid
  LOCKED: msg`Заблоковано`, // en: Locked
  PENDING_CASH_CONFIRM: msg`Очікує підтвердження бухгалтером (готівка)`, // en: Awaiting accountant confirmation (cash)
} satisfies Record<TransactionStatus, MessageDescriptor>

/**
 * @deprecated task-i18n-stage3d-pr1. Superseded by `TYPE_LABEL_MESSAGES`
 * (`i18n._(TYPE_LABEL_MESSAGES[type])`). Kept — not deleted — because
 * `PR2`/`PR3`/`PR4` files and the cross-slice `InProgressPanel.tsx` still
 * import this string map; it is removed in PR4 once every consumer has
 * migrated (`git grep -nP '\bTYPE_LABELS\b' -- apps/web/app` returns only
 * this definition + `PR4`'s removal comment at that point).
 */
export const TYPE_LABELS: Record<TransactionType, string> = {
  ADMIN_INCOME: 'Приход Admin',
  SENIOR_INCOME: 'Приход синьора',
  EXPENSE: 'Расход',
  SALARY: 'Зарплата',
  ADMIN_TRANSFER: 'Перевод',
  PAYOUT: 'Выплата',
  PAYOUT_ADMIN: 'Доля партнёра',
  DROP_INCOME: 'Приход дропа',
  PAYOUT_DROP: 'Доля дропа',
  PAYOUT_CONFIRMED: 'Подтверждённая выплата',
  TOV_INCOME: 'Приход ТОВ',
  SENIOR_PENDING_PAYOUT: 'Ожидаемая выплата синьору',
  SENIOR_PAID: 'Выплата синьору',
  ADMIN_INCOME_CASH: 'Приход Admin (наличные)',
  ADMIN_INCOME_CRYPTO: 'Приход Admin (крипто)',
  SENIOR_INCOME_CRYPTO: 'Приход синьора (крипто)',
  DIVIDEND_TO_ADMIN: 'Дивиденды Admin',
  DIVIDEND_TAX: 'Налог на дивиденды',
  COMPANY_DEPOSIT: 'Пополнение счёта компании',
  DROP_PENDING_PAYOUT: 'Ожидаемая выплата дропу',
}

/**
 * @deprecated task-i18n-stage3d-pr1. Superseded by `STATUS_LABEL_MESSAGES`.
 * Kept until PR4 migrates the last consumer — see `TYPE_LABELS`'s own note.
 */
export const STATUS_LABELS: Record<TransactionStatus, string> = {
  PENDING: 'Ожидает',
  VALIDATED: 'Подтверждено',
  PENDING_PAYMENT: 'Ожидает выплаты',
  REJECTED: 'Отклонено',
  PAID: 'Оплачено',
  LOCKED: 'Заблокировано',
  PENDING_CASH_CONFIRM: 'Ожидает подтверждения нала',
}

export const STATUS_COLORS: Record<TransactionStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  // PR #56 final UT (AC2): SENIOR_INCOME flips to VALIDATED on validate (was
  // PENDING_PAYMENT). User asked for a green «Подтверждено» badge so the
  // terminal income status reads as a positive completion, not an in-flight
  // intermediate. PAID remains a brighter emerald.
  VALIDATED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  PENDING_PAYMENT: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  REJECTED: 'bg-red-500/15 text-red-400 border-red-500/30',
  PAID: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  LOCKED: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  PENDING_CASH_CONFIRM: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
}

export const TYPE_COLORS: Record<TransactionType, string> = {
  ADMIN_INCOME: 'bg-green-500/15 text-green-400 border-green-500/30',
  SENIOR_INCOME: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  EXPENSE: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  SALARY: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  ADMIN_TRANSFER: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  PAYOUT: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  PAYOUT_ADMIN: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  // Drop role - phase 2. Distinct tone (teal) so drop rows are visually
  // separable from PAYOUT/PAYOUT_ADMIN in mixed lists. Frontend task will
  // refine if needed.
  DROP_INCOME: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  PAYOUT_DROP: 'bg-teal-500/20 text-teal-200 border-teal-500/40',
  // Drop role - phase 3. Lime accent — visually distinct from indigo
  // (PAYOUT_ADMIN auto-split) so manual confirmations stand out in mixed lists
  // when both phases produce rows for the same payout cluster.
  PAYOUT_CONFIRMED: 'bg-lime-500/15 text-lime-300 border-lime-500/30',
  // Drop role - phase 4-A. Placeholder palettes until Phase 4-B finalizes
  // the UI. Reuses tones from the closest semantic neighbours so any early
  // surfacing in lists stays legible.
  TOV_INCOME: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  SENIOR_PENDING_PAYOUT: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SENIOR_PAID: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
  ADMIN_INCOME_CASH: 'bg-green-500/15 text-green-300 border-green-500/30',
  ADMIN_INCOME_CRYPTO: 'bg-green-500/20 text-green-200 border-green-500/40',
  SENIOR_INCOME_CRYPTO: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  DIVIDEND_TO_ADMIN: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/40',
  DIVIDEND_TAX: 'bg-red-500/15 text-red-300 border-red-500/30',
  // task-company-account-backend. Placeholder palette (USDT-green tone) until
  // the company-account frontend task finalizes the UI. See TYPE_LABELS note.
  COMPANY_DEPOSIT: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  // task-drop-share-override-and-receiver (D4). Teal drop palette (matches
  // DROP_INCOME) so drop-obligation rows are visually grouped with other drop
  // flows. Placeholder until the frontend task polishes the UI.
  DROP_PENDING_PAYOUT: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
}

export const EXPENSE_CATEGORIES = ['Оплата сервиса', 'Комиссия', 'Прочее']

/**
 * Original-currency amount for detail dialogs («7 777,00 USDT», «5 000,00 EUR»).
 *
 * AC3 (finance money strategy): detail views show the *source* currency +
 * amount so the user sees what was actually entered, while the transaction
 * table shows the USD-converted figure via `fmtUsd`. This delegates to the
 * shared `formatAmount` (lib/format-amount.ts) — the same helper invoices /
 * notifications use — so every "original amount" in the app is formatted
 * identically (ru-RU thin-space thousands, currency suffix). This is what
 * removed the ad-hoc Tugrik «₮» symbol that previously stood in for USDT.
 */
export function fmtAmount(amount: string | number, currency: string) {
  return formatAmount(amount, currency)
}

export type ExchangeRates = {
  usdUah: string
  usdtUah: string
  eurUah: string
  date: string
  // task-drop-payout-currency (owner addendum, 2026-08): the date the
  // numbers ACTUALLY came from, when known — see the extended comment on
  // `ExchangeRateResult.rateDate` in nbu-currency.service.ts. Optional and
  // unused by every function in this file — added so a caller (the DROP
  // settle dialog) can show "курс за <rateDate>" when it differs from the
  // date it asked for, without a second, shadow copy of this type.
  rateDate?: string
}

export function toUsd(amount: string | number, currency: string, rates: ExchangeRates): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (currency === 'USD' || currency === 'USDT') return n
  if (currency === 'EUR') return n * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return n / parseFloat(rates.usdUah)
  return n
}

/**
 * Inverse of `toUsd` — a USD figure expressed in `currency`. Private: callers
 * want `convertAmount` below, which is the round-trip and therefore the only
 * direction-safe way to move between two non-USD currencies.
 */
function fromUsd(usd: number, currency: string, rates: ExchangeRates): number {
  if (currency === 'USD' || currency === 'USDT') return usd
  if (currency === 'EUR') return usd * (parseFloat(rates.usdUah) / parseFloat(rates.eurUah))
  if (currency === 'UAH') return usd * parseFloat(rates.usdUah)
  return usd
}

/**
 * task-salary-pay-amount — `amount` denominated in `from`, re-expressed in `to`
 * at the NBU rates, via USD (the pivot every rate in `ExchangeRates` is quoted
 * against). Returns `null` when the conversion cannot be trusted — missing /
 * unparseable / non-positive rates, or a non-finite amount — so a caller can
 * render "—" instead of a confident wrong number.
 *
 * Lives here, next to `toUsd` / `fmtUsd` / `fmtRate`, rather than in a new
 * module: this file is already the one place that owns NBU conversion for the
 * web app, and a second implementation is exactly what would drift.
 */
export function convertAmount(
  amount: string | number,
  from: string,
  to: string,
  rates: ExchangeRates | undefined,
): number | null {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return null
  if (from === to) return n
  // USDT is pegged 1:1 to USD, so a USD↔USDT pair is a relabel, not a
  // conversion — answerable before the NBU rates have loaded (and the reason
  // this check sits ABOVE the `!rates` guard).
  const isUsdPegged = (c: string) => c === 'USD' || c === 'USDT'
  if (isUsdPegged(from) && isUsdPegged(to)) return n
  if (!rates) return null
  // A zero/NaN rate would silently produce Infinity/NaN downstream (and a
  // "converted" amount of Infinity would sail through a `> 0` check).
  const usdUah = parseFloat(rates.usdUah)
  const eurUah = parseFloat(rates.eurUah)
  const needsUah = from === 'UAH' || to === 'UAH' || from === 'EUR' || to === 'EUR'
  const needsEur = from === 'EUR' || to === 'EUR'
  if (needsUah && (!Number.isFinite(usdUah) || usdUah <= 0)) return null
  if (needsEur && (!Number.isFinite(eurUah) || eurUah <= 0)) return null
  const converted = fromUsd(toUsd(n, from, rates), to, rates)
  return Number.isFinite(converted) ? converted : null
}

/**
 * USD-converted amount for the transaction table («$7 777,00»). USDT is
 * pegged 1:1 to USD so it passes through. Non-USD currencies convert via the
 * NBU rates; without rates loaded we fall back to the original-currency
 * format so the cell never renders a bare number.
 */
export function fmtUsd(
  amount: string | number,
  currency: string,
  rates: ExchangeRates | undefined,
): string {
  if (!rates) return fmtAmount(amount, currency)
  const usd = toUsd(amount, currency, rates)
  // task-i18n-stage3d-pr1 (template L-fin). Signature unchanged — `$projectId`
  // (web-projects) calls this too and is out of this wave's file list. Kept
  // the `$` prefix (not `formatMoney`'s "<amount> USD" suffix form) precisely
  // so that external caller's rendered text does not change without its own
  // fidelity review; only the digit grouping/decimal separator becomes
  // locale-aware via `formatNumber` instead of the hardcoded `en-US`.
  return `$${formatNumber(usd, activeLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Human-readable conversion-rate line for detail dialogs, e.g.
 * «1 EUR = 1.0800 USD» or «1 USD = 41.50 UAH». Returns null for USD/USDT
 * (no conversion happens) or when rates haven't loaded yet, so callers can
 * conditionally render the rate row.
 */
export function fmtRate(currency: string, rates: ExchangeRates | undefined): string | null {
  if (!rates) return null
  if (currency === 'EUR') {
    const eurUsd = parseFloat(rates.eurUah) / parseFloat(rates.usdUah)
    return `1 EUR = ${eurUsd.toFixed(4)} USD`
  }
  if (currency === 'UAH') {
    return `1 USD = ${parseFloat(rates.usdUah).toFixed(2)} UAH`
  }
  return null
}

/**
 * task-drop-payout-currency (owner addendum, 2026-08): the NBU API's own date
 * shape ("YYYYMMDD", no separators — see nbu-currency.service.ts) formatted
 * the same human-readable way as `fmtDate`. Used to show the operator WHICH
 * day's rate was actually applied (`ExchangeRates.rateDate`) when it differs
 * from the requested date (a holiday/weekend fallback).
 */
export function fmtYyyymmdd(yyyymmdd: string) {
  return fmtDate(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`)
}

const FMT_DATE_INTL_TAG: Record<Locale, string> = { uk: 'uk-UA', en: 'en-GB' }

/**
 * @deprecated task-i18n-stage3d-pr1 (template L-fin). Signature unchanged —
 * many PR2–PR4 files and the cross-slice `InProgressPanel.tsx` call this
 * without a locale argument — but the body now reads the active catalog
 * locale through `activeLocale()` (the `@lingui/core` singleton, same
 * pattern `project-approval-caption.ts` uses) instead of the hardcoded
 * `uk-UA`. Deliberately NOT delegated to `@crm/shared`'s `formatDate` —
 * that helper's `'short'` style has no explicit `day`/`month`/`year`
 * options, so `Intl` falls back to a 4-digit year (`31.07.2026`) instead of
 * this function's existing 2-digit shape (`31.07.26`), which
 * `SettleSeniorPayoutDialog.test.tsx` (PR4, not yet migrated at this PR)
 * pins verbatim — only the LANGUAGE the digits are grouped in changes here,
 * not the shape, so that not-yet-touched test keeps passing unmodified.
 * Removed in PR4 alongside `TYPE_LABELS`/`STATUS_LABELS` once the last
 * caller reads locale-aware `formatDate` directly.
 */
export function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(FMT_DATE_INTL_TAG[activeLocale()], {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

/**
 * @deprecated task-i18n-stage3d-pr1 (template L-fin, COPY-M-fin-9). Same
 * deprecation note as `fmtDate` above — the hardcoded `ru-RU` is replaced by
 * `activeLocale()`, signature unchanged. Delegates to the shared
 * `formatDate`'s `'monthYear'` style (full month name + year, no day) —
 * unlike `fmtDate` above, no existing deprecated-consumer test pins this
 * one's exact digit shape, so the shared helper is safe to use as-is.
 */
export function fmtMonth(ym: string | null | undefined): string {
  if (!ym) return '—'
  const [year, month] = ym.split('-').map(Number)
  if (!year || !month) return ym
  return formatDate(new Date(year, month - 1, 1), activeLocale(), 'monthYear')
}
