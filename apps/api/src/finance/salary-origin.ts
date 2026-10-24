/**
 * CR-795-M-7 — one definition of the two salary-origin questions the multipart
 * salary feature asks, as Drizzle SQL fragments.
 *
 * The retro review of PR #795 found the automatic-component predicate
 * (`salary_origin IS NULL OR salary_origin = 'CRON'`) re-stated in four places:
 * the cron closure in `salary-payment.service`, the gap resolver in
 * `salary.service`, the month-correction evidence query in `admin-edit.service`
 * and the SQL backfill. Its conclusion is worth keeping in one sentence: one
 * predicate in four copies is how the two defects FIXED by that task could
 * exist at all — a manual part that claimed no marker (SR-795-M-1) and a
 * month-correction that wrote MANUAL where it meant ADJUSTED (SR-795-M-3) —
 * because the copies disagreed about values added to the union later.
 *
 * Both of those are history, and neither describes the code now: since owner
 * decision D-3 the first manual part of a receiver/month DOES claim the marker,
 * and a month-correction writes ADJUSTED. Said plainly here because the
 * previous wording quoted the old behaviour in the present tense, which reads
 * as a statement about what this module does.
 *
 * Both fragments are DERIVED from the shared predicates in `@crm/shared`
 * (`isAutomaticSalaryOrigin`, `accountsForSalaryMonth`) rather than re-typing the
 * literals, so the SQL and the TypeScript can only ever answer alike. Adding a
 * value to `salaryOriginSchema` updates these fragments with it.
 */
import { inArray, isNull, or, type SQL } from 'drizzle-orm'
import {
  accountsForSalaryMonth,
  isAutomaticSalaryOrigin,
  salaryOriginSchema,
  type SalaryOrigin,
} from '@crm/shared'
import { transactions } from '../database/schema'

/** The non-NULL origins that own the automatic (cron) component. */
export const AUTOMATIC_ORIGIN_VALUES: SalaryOrigin[] =
  salaryOriginSchema.options.filter(isAutomaticSalaryOrigin)

/** The non-NULL origins whose row holds a `salary_month_initializations` marker. */
export const MONTH_ACCOUNTING_ORIGIN_VALUES: SalaryOrigin[] =
  salaryOriginSchema.options.filter(accountsForSalaryMonth)

/**
 * "This row IS the automatic monthly component for its receiver/month."
 *
 * `IS NULL` is part of the predicate and not an oversight: before this feature
 * the column did not exist and the single receiver/month unique index made ANY
 * salary row the month's automatic component, so a legacy row must keep counting
 * as one — otherwise the first post-upgrade cron run mints a second salary for
 * every historical month.
 */
export function isAutomaticSalaryComponent(): SQL {
  return or(
    isNull(transactions.salaryOrigin),
    inArray(transactions.salaryOrigin, AUTOMATIC_ORIGIN_VALUES),
  )!
}

/**
 * "This row is why a `salary_month_initializations` marker is held for its
 * receiver/month."
 *
 * Wider than `isAutomaticSalaryComponent` by exactly one value — since owner
 * decision D-3 the FIRST manual part of a month claims the marker, so a MANUAL
 * row accounts for the month too. An ADJUSTED row never does: it was
 * reclassified precisely because something else already owned that month's slot.
 */
export function accountsForSalaryMonthSql(): SQL {
  return or(
    isNull(transactions.salaryOrigin),
    inArray(transactions.salaryOrigin, MONTH_ACCOUNTING_ORIGIN_VALUES),
  )!
}
