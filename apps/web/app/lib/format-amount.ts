import { formatMoney, resolveLocale } from '@crm/shared'
import { i18n } from '@/lib/i18n'

/**
 * formatAmount — single source of truth for currency amount formatting.
 *
 * UT round 1 feedback: notification body used to print raw transaction
 * `amount` like `1500.000000 USDT` (Postgres NUMERIC trailing zeros).
 * This helper normalises it with a hard cap of 2 decimals.
 *
 * Accepts either string (DB NUMERIC → ts string) or number. Non-finite
 * inputs fall back to a raw `"${value} ${currency}"` so we still display
 * something meaningful instead of `NaN`.
 *
 * Reused by every consumer that shows an amount: invoice cards / dialog /
 * notifications bell / public verify page.
 *
 * task-i18n-stage3a (Task 2) — was hardcoded `ru-RU` `toLocaleString`; now
 * routes through the shared `formatMoney` (Intl-based) using the CURRENT
 * locale off the global `i18n` singleton (`@/lib/i18n` — the same one
 * `activateLocale()` updates) rather than an added `locale` parameter.
 * The signature stays identical on purpose: `finance/constants.ts`'s
 * `fmtAmount` wrapper alone has ~45 call sites across
 * `routes/_authenticated/finance/**` (wave d — actively worked by a
 * parallel task right now, see task file "Граница с параллельными
 * задачами") plus `components/invoices/**` (wave d) and
 * `components/user-profile/tabs/FinanceTab.tsx` (wave b, not started).
 * Forcing a required `locale` argument here would cascade a breaking
 * signature change through every one of them — the same hazard class as
 * `ROLE_LABELS`/`SORT_OPTIONS`/`getInvoiceTypeLabel` elsewhere in this
 * plan (see the plan's "Опасность" sections and the task file's
 * "Допущения"). None of those call sites subscribe to locale changes
 * today either (their surrounding text is still 100% Russian, unmigrated),
 * so reading the singleton is not a regression relative to the current
 * hardcoded-`ru-RU` behavior — it becomes locale-correct the moment the
 * consuming wave switches its own text to `<Trans>`/`useLingui()` and
 * starts re-rendering on locale change. The wave that migrates those
 * callers switches to `formatMoney` directly with an explicit `locale`
 * from `useLocale()`, same as `ArchivePendingTransactionsList.tsx` (PR1)
 * already does.
 */
export function formatAmount(value: string | number, currency: string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(num)) return `${value} ${currency}`
  const locale = resolveLocale([i18n.locale])
  return formatMoney(num, currency as Parameters<typeof formatMoney>[1], locale)
}

/**
 * Variant of `formatAmount` that prepends a `$`. Output shape:
 * `$3,500.00 USDT` (en) / `$3 500,00 USDT` (uk).
 *
 * Introduced for Phase 4-B round 2 — the FinanceTab pending-company-income
 * list and the pending-cash card on /finance both surface drop incomes in
 * this shape. We keep the original `formatAmount` untouched so existing
 * invoice / notification surfaces don't change. Non-finite inputs fall back
 * to a raw `"${value} ${currency}"` for parity with `formatAmount`.
 *
 * task-i18n-stage3a (Task 2) — same locale-singleton reasoning as
 * `formatAmount` above; this variant currently has zero callers (verified
 * `git grep -n 'formatAmountUsd('`), so there is no external signature to
 * preserve either way.
 */
export function formatAmountUsd(value: string | number, currency: string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(num)) return `${value} ${currency}`
  const locale = resolveLocale([i18n.locale])
  return `$${formatMoney(num, currency as Parameters<typeof formatMoney>[1], locale)}`
}
