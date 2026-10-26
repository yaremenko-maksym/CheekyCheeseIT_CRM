import type React from 'react'
import { ArrowLeftRight, Coins, TrendingUp, Wallet } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TransactionType } from '@crm/shared'
import { addCalendarMonths, currencySchema, kyivDayOf, roundShareAmount } from '@crm/shared'
import { TYPE_LABEL_MESSAGES } from '../../../constants'

// UI-level transaction kind for THIS dialog. `DIVIDEND` is a synthetic option —
// it is NOT a `TransactionType` enum value (the dividend flows through the
// dedicated company-account endpoint, which books a DIVIDEND_TO_ADMIN row
// server-side). Keeping it dialog-local avoids churning the shared enum / every
// exhaustive `Record<TransactionType, …>` in the app.
//
// task-admin-income-unified (2026-08-12, supersedes task-admin-income-payment-
// type-guard): there used to be a SECOND synthetic option here, `USDT_INCOME`,
// picked by the caller to reach `declareUsdtProjectIncome`. That let a human
// choose the WRONG form for a USDT-payment project (`createAdminIncome`, which
// never books the senior/drop obligation) — a real prod incident (GamingTec,
// 4708.69 USDT, no drop share). The fix is not a sturdier guard on the choice,
// it is removing the choice: `ADMIN_INCOME` is now the only admin-income type,
// and the project's OWN `paymentType` decides the route internally (see
// `isSelectedProjectUsdt` below). `declareUsdtProjectIncome` itself is
// UNCHANGED — this dialog just calls it from a different trigger.
export type DialogTxType = TransactionType | 'DIVIDEND'

// Label / description for the synthetic DIVIDEND option (TYPE_LABEL_MESSAGES is
// keyed by the real enum and stays untouched). `satisfies` WITHOUT `as const`
// (урок #707 — `as const` here would report 0 mutants for the block).
const DIVIDEND_LABEL_MESSAGE = msg`Дивіденд` // en: Dividend
const DIVIDEND_DESCRIPTION_MESSAGE = msg`Виведення дивідендів із балансу рахунку компанії` // en: Withdraw dividends from the company account balance

export function typeLabel(t: DialogTxType, i18n: { _: (d: MessageDescriptor) => string }): string {
  if (t === 'DIVIDEND') return i18n._(DIVIDEND_LABEL_MESSAGE)
  return i18n._(TYPE_LABEL_MESSAGES[t])
}

// task-salary-company-account. UI-only funding source sentinel:
// 'legacy' = do not send fundingSource in the payload (backward-compat path).
// 'COMPANY_ACCOUNT' / 'ADMIN_PERSONAL' map directly to the DTO enum.
export type FundingSourceUI = 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' | 'legacy'

// Drop role - phase 2. Extended with `dropId` so the DROP_INCOME path can
// filter projects by `project.dropId === user.id`. Backward compatible —
// `dropId` is optional + null for legacy senior-projects.
// task-drop-share-override-and-receiver (Surface B). Extended with
// `paymentType` so USDT-payment projects can be filtered/gated. Optional +
// nullable — the backend already returns it on `GET /projects` (never
// affects the pre-existing seniorId/dropId filters when absent).
// task-admin-income-unified. Extended with the resolved senior/drop share +
// source + display names — `ProjectsService.mapProject` already returns all
// of these on `GET /projects` for a non-JUNIOR viewer (ADMIN/ACCOUNTANT here
// always are); this just declares the fields the pre-submit obligation-
// preview banner reads. Optional + nullable throughout — absence degrades to
// "no preview", never a crash.
export type ProjectOption = {
  id: string
  name: string
  seniorId: string
  seniorName?: string | null
  dropId?: string | null
  dropName?: string | null
  paymentType?: string | null
  effectiveSeniorSharePercent?: number | null
  effectiveSeniorShareSource?: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null
  effectiveDropSharePercent?: number | null
  effectiveDropShareSource?: 'PROJECT' | 'USER_DEFAULT' | null
}
export type UserOption = { id: string; displayName: string; role: string }
export type ExchangeRate = { usdUah: string; usdtUah: string; eurUah: string; date: string }

export type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'
export type SalaryPrefill = {
  receiverId: string
  salaryMonth: string
  currency?: Currency | undefined
}

export const TYPE_ICONS: Record<string, React.ReactNode> = {
  ADMIN_INCOME: <TrendingUp className="h-4 w-4" />,
  SENIOR_INCOME: <TrendingUp className="h-4 w-4" />,
  // Drop role - phase 2. DROP_INCOME reuses TrendingUp — same business
  // semantics (income), different recipient.
  DROP_INCOME: <TrendingUp className="h-4 w-4" />,
  EXPENSE: <Wallet className="h-4 w-4" />,
  SALARY: <Wallet className="h-4 w-4" />,
  ADMIN_TRANSFER: <ArrowLeftRight className="h-4 w-4" />,
  DIVIDEND: <Coins className="h-4 w-4" />,
}

// COPY-H-fin-1 (SALARY) / COPY-M-fin-11 (DROP_INCOME) — canon terms, wave (d)
// (`CONTEXT.md` → «Волна d»). Keyed by `Record<string, MessageDescriptor>`
// (a plain type annotation, not `satisfies`) — same loose-index contract the
// old `TYPE_DESCRIPTIONS: Record<string, string>` had: `DialogTxType`
// (`TransactionType | 'DIVIDEND'`) is a much wider union than the 7 keys this
// dialog actually renders (`availableTypes` never produces anything else at
// runtime), so a narrower `satisfies`-inferred literal type would reject the
// `TYPE_DESCRIPTION_MESSAGES[txType]` lookup at compile time despite it being
// safe in practice.
export const TYPE_DESCRIPTION_MESSAGES: Record<string, MessageDescriptor> = {
  ADMIN_INCOME: msg`Дохід із власного проєкту`, // en: Income from an own project
  SENIOR_INCOME: msg`Дохід сеньйора з проєкту`, // en: Senior income from a project
  DROP_INCOME: msg`Дохід дропа з проєкту`, // en: Drop income from a project
  EXPENSE: msg`Витрата компанії`, // en: Company expense
  SALARY: msg`Зарплата співробітнику`, // en: Employee salary
  ADMIN_TRANSFER: msg`Переказ між партнерами`, // en: Transfer between partners
  DIVIDEND: DIVIDEND_DESCRIPTION_MESSAGE,
}

export function needsConversion(currency: Currency) {
  return currency === 'EUR' || currency === 'UAH' || currency === 'USD'
}

export function getRate(currency: Currency, rates: ExchangeRate | undefined): number | null {
  if (!rates) return null
  if (currency === 'EUR') return parseFloat(rates.eurUah) / parseFloat(rates.usdUah)
  if (currency === 'UAH') return 1 / parseFloat(rates.usdUah)
  if (currency === 'USD') return 1
  return null
}

// Previous calendar month on the KYIV business-day clock (the same clock the
// rest of the finance forms use; the browser zone must not move the default).
// Pure calendar arithmetic anchored on day 1, so 29-31 never overflows into
// the current month (`setMonth(getMonth() - 1)` on 31 Oct gave 2026-10).
export function defaultSalaryMonth(now: Date = new Date()): string {
  return addCalendarMonths(`${kyivDayOf(now).slice(0, 7)}-01`, -1).slice(0, 7)
}

// "Add salary part" prefill: the NOMINAL currency of the source row
// (`originalCurrency`, e.g. USD) rather than the settled one (`currency`, USDT
// after a company-funded payout). Validated against the shared enum instead of
// a blind cast; undefined = leave the form default.
export function resolveSalaryPrefillCurrency(source: {
  currency: string
  originalCurrency?: string | null | undefined
}): Currency | undefined {
  const parsed = currencySchema.safeParse(source.originalCurrency ?? source.currency)
  return parsed.success ? parsed.data : undefined
}

// task-admin-income-unified (AC5/AC6). Pre-submit preview of the obligation(s)
// `TransactionsService.bookCompanyObligations` will ACTUALLY create the moment
// this USDT-project income is submitted — computed with the exact SAME
// rounding (`roundShareAmount`, imported from `@crm/shared`, not re-derived)
// and the exact same "no IOU for an ADMIN senior" exclusion the server
// applies (`senior && senior.role !== 'ADMIN'` in `bookCompanyObligations`),
// so the banner can never promise a number — or a beneficiary — the backend
// does not produce.
export type ObligationPreview = {
  role: 'SENIOR' | 'DROP'
  roleLabel: string
  name: string
  percent: number
  sourceLabel: string
  amount: number
}

// i18n-3d-pr3 (Допущення, A1): `computeObligationPreviews` нижче — ЧИСТА
// експортована функція без доступу до `useLingui()` (юніт-тест пінить кожну
// гілку напряму, без React-дерева) — тому лейбли тут HARDCODED українською,
// а не через `msg`/`i18n._`, на відміну від решти файлу. Другого оригіналу
// (`en`) для ЦІЄЇ вузької банерної підказки немає — це задокументована,
// оборотна прогалина, не мовчазний пропуск (AC1/AC5 цього PR її не вимагають
// явно; повний білінгвальний варіант вимагав би зміни сигнатури функції й
// типу `ObligationPreview`, що виходить за межі завдання).
/* eslint-disable lingui/no-unlocalized-strings -- see comment above */
const SHARE_SOURCE_LABEL: Record<string, string> = {
  PROJECT: 'проєкт',
  TEAM: 'команда',
  USER_DEFAULT: 'за замовчуванням',
}
/* eslint-enable lingui/no-unlocalized-strings */

// task-admin-income-unified §3 (AC7): "считается на лету... показывается в
// долларах — с учётом выбранной валюты и того же курса, который форма уже
// показывает строкой под полем" — `usdRate` is that SAME `getRate`/`rate`
// this component already computes for the amount field (not a second
// conversion). In PRACTICE `usdRate` is always 1 here: the only route that
// ever reaches this function (`isSelectedProjectUsdt`) hard-locks currency to
// USDT (`createUsdtIncomeSchema`: `currency: z.literal('USDT')`, an unchanged
// sibling per task scope), and USDT is pegged 1:1 to USD. The parameter keeps
// the banner correct rather than silently wrong if that invariant is ever
// relaxed, without inventing a currency table of its own.
// Exported (not just module-scope) so a dedicated unit-test file can pin
// every branch directly — this is the single function AC5/AC6/AC7 hold to
// "predicts the server's actual booking to the cent"; testing it only
// through the full dialog's rendered DOM would leave several of its
// branches (senior-is-admin exclusion, missing-share no-op, source-label
// fallback, non-positive/NaN amount and usdRate guards) exercised by at
// most one scenario each.
export function computeObligationPreviews(
  project: ProjectOption | undefined,
  amount: number,
  seniorIsAdmin: boolean,
  usdRate: number,
): ObligationPreview[] {
  if (!project || project.paymentType !== 'USDT') return []
  // Stryker disable next-line EqualityOperator: `amount <= 0 ? 0 : amount` and `amount < 0 ? 0 : amount` produce the IDENTICAL result at amount === 0 — both branches evaluate to the literal value 0 (the `? 0` branch directly, the `: amount` branch because amount itself equals 0). Mathematically equivalent, not just hard to test.
  const rawAmount = isNaN(amount) || amount <= 0 ? 0 : amount
  const safeAmount = rawAmount * (isNaN(usdRate) || usdRate <= 0 ? 1 : usdRate)
  const previews: ObligationPreview[] = []
  // Mirrors `senior && senior.role !== 'ADMIN'` in bookCompanyObligations —
  // an admin-owned USDT project (the ADMIN is their own senior) never books a
  // senior IOU; only a THIRD-PARTY senior (reachable via the merged "any USDT
  // project" pool, not just the caller's own) does.
  if (project.seniorId && !seniorIsAdmin && project.effectiveSeniorSharePercent != null) {
    previews.push({
      role: 'SENIOR',
      // eslint-disable-next-line lingui/no-unlocalized-strings -- see SHARE_SOURCE_LABEL note above
      roleLabel: 'Сеньйору',
      name: project.seniorName || '—',
      percent: project.effectiveSeniorSharePercent,
      sourceLabel: SHARE_SOURCE_LABEL[project.effectiveSeniorShareSource ?? 'USER_DEFAULT']!,
      amount: roundShareAmount(safeAmount, project.effectiveSeniorSharePercent),
    })
  }
  if (project.dropId && project.effectiveDropSharePercent != null) {
    previews.push({
      role: 'DROP',
      // eslint-disable-next-line lingui/no-unlocalized-strings -- see SHARE_SOURCE_LABEL note above
      roleLabel: 'Дропу',
      name: project.dropName || '—',
      percent: project.effectiveDropSharePercent,
      sourceLabel: SHARE_SOURCE_LABEL[project.effectiveDropShareSource ?? 'USER_DEFAULT']!,
      amount: roundShareAmount(safeAmount, project.effectiveDropSharePercent),
    })
  }
  return previews
}
