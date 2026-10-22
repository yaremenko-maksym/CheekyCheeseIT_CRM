import { isDeepStrictEqual } from 'node:util'
import { HttpException, HttpStatus } from '@nestjs/common'
import { apiError } from '../common/api-error'
import type { transactions } from '../database/schema'

/**
 * PR #868 (SR-795-M-2). A manual salary idempotency key identifies ONE
 * immutable request meaning, persisted in `transactions.salary_creation_intent`
 * (made immutable by the trigger in `2026-10-10_salary_creation_intent.sql`).
 * A replay is honoured only when the incoming request has the same meaning;
 * otherwise it is a 409, never a silent "success" that returns a different
 * obligation than the one the operator just submitted.
 */
export type SalaryCreationIntent = NonNullable<
  typeof transactions.$inferSelect.salaryCreationIntent
>

export function buildSalaryCreationIntent(data: {
  receiverId: string
  amount: number
  currency?: string | undefined
  salaryMonth: string
  notes?: string | null | undefined
  txDate?: string | null | undefined
}): SalaryCreationIntent {
  return {
    version: 1,
    operation: 'MANUAL_SALARY_CREATE',
    receiverId: data.receiverId.toLowerCase(),
    amount: data.amount.toFixed(6),
    currency: (data.currency ?? 'USD') as SalaryCreationIntent['currency'],
    salaryMonth: data.salaryMonth,
    notes: data.notes ?? null,
    txDate: data.txDate ?? 'AUTO',
  }
}

/**
 * Historical rows carry `NULL` intent: their original request cannot be
 * verified, so a replay against one is refused (`LEGACY_INTENT_UNKNOWN`)
 * rather than guessed at. The envelope is the registered
 * `FINANCE_SALARY_IDEMPOTENCY_CONFLICT` one (translated client-side by code);
 * `reason` and `existingTransactionId` ride along as extra fields, and the
 * legacy case gets its own English fallback `message` for logs.
 */
export function assertSalaryCreationIntent(
  existing: Pick<typeof transactions.$inferSelect, 'id' | 'salaryCreationIntent'>,
  expected: SalaryCreationIntent,
): void {
  if (isDeepStrictEqual(existing.salaryCreationIntent, expected)) return

  const legacy = existing.salaryCreationIntent === null
  const envelope = apiError('FINANCE_SALARY_IDEMPOTENCY_CONFLICT', HttpStatus.CONFLICT)
  throw new HttpException(
    {
      ...(envelope.getResponse() as Record<string, unknown>),
      ...(legacy
        ? {
            message:
              'This idempotency key belongs to a legacy salary whose original request cannot be verified',
          }
        : {}),
      reason: legacy ? 'LEGACY_INTENT_UNKNOWN' : 'INTENT_MISMATCH',
      existingTransactionId: existing.id,
    },
    HttpStatus.CONFLICT,
  )
}
