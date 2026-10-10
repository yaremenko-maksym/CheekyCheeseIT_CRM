import { HttpStatus } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import * as schema from '../database/schema'
import { transactions, type Transaction } from '../database/schema'
import { mapTx, type TxWithRelations } from './transaction-mapper.util'
import {
  assertTransactionReadAccess,
  assertTransactionVisible,
} from './transaction-visibility.util'

/**
 * Loads one transaction (with relations) for a viewer: NOT_FOUND -> visibility
 * guard -> read-access guard -> payoutRequest enrichment -> counterparty masking
 * (via mapTx). Extracted verbatim from `TransactionsService.findOne`
 * (giant decomposition WC-L4); the guard ORDER is security-relevant and must not
 * change: visibility BEFORE read-access BEFORE masking.
 */
export async function loadTransactionForViewer(
  db: NodePgDatabase<typeof schema>,
  id: string,
  currentUser: SessionUser,
) {
  const tx = (await db.query.transactions.findFirst({
    where: eq(transactions.id, id),
    with: {
      // task-counterparty-role-masking: `role` drives ADMIN-party masking in mapTx.
      sender: { columns: { displayName: true, role: true } },
      receiver: { columns: { displayName: true, role: true } },
      project: { columns: { name: true } },
      payoutRequest: {
        columns: { seniorId: true, incomeAmount: true, payableAmount: true },
      },
    },
  })) as TxWithRelations | undefined

  if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
  // AC2: hidden from every non-ADMIN/ACCOUNTANT viewer, regardless of
  // ownership — MUST run before assertTransactionReadAccess (see that guard's doc).
  assertTransactionVisible(tx, currentUser)
  assertTransactionReadAccess(tx, currentUser)
  // (masking of the internal counterparty happens in mapTx below via `currentUser`)

  // Enrich payoutRequest with seniorSharePercent snapshot from first linked income tx
  if (tx.payoutRequest && tx.payoutRequestId) {
    const firstIncome = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.payoutRequestId, tx.payoutRequestId),
        eq(transactions.type, 'SENIOR_INCOME'),
      ),
    })
    if (firstIncome) {
      const firstIncomeSource = (
        firstIncome as Transaction & {
          seniorSharePercentSource?: string | null
        }
      ).seniorSharePercentSource
      tx.payoutRequest = {
        ...tx.payoutRequest,
        seniorSharePercent: firstIncome.seniorSharePercent,
        // task-team-senior-share-override. Propagate the source from the
        // originating SENIOR_INCOME so PayoutContent renders the badge.
        seniorSharePercentSource: (firstIncomeSource ?? null) as
          'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null,
      }
    }
  }

  return mapTx(tx, currentUser)
}
