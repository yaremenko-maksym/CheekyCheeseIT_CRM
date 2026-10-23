import type { TransactionDto } from '@crm/shared'

/**
 * The `salaryMonth` to put in an admin-edit payload, or `undefined` = leave it
 * out ("unchanged" server-side).
 *
 * A legacy row can store a month the stricter `salaryMonthSchema` rejects
 * (e.g. `2026-13`); the form pre-fills it, so resending it untouched would 400
 * an edit of an unrelated field (SR-M-1, PR #1093). Only a SALARY row has the
 * field, and only a non-empty value that differs from the stored one is sent.
 */
export function changedSalaryMonth(
  tx: Pick<TransactionDto, 'type' | 'salaryMonth'> | null | undefined,
  salaryMonth: string,
): string | undefined {
  if (tx?.type !== 'SALARY') return undefined
  if (!salaryMonth) return undefined
  return salaryMonth !== tx.salaryMonth ? salaryMonth : undefined
}
