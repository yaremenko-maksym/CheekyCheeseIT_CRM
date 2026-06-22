import { z } from 'zod'
import { currencyEnumSchema } from './payment-requisites'
import { transactionStatusSchema, transactionTypeSchema } from './finance'

/**
 * ADMIN dashboard summary DTO — the data behind the «центр действий» dashboard
 * (GET /api/admin/summary, RBAC ADMIN-only).
 *
 * Two parts:
 *   - `kpis`              — four neutral counters surfaced as KPI cards.
 *   - `activeTransactions` — the actionable money pipeline (only the three
 *                            in-flight statuses), rendered in a finance-style table.
 *
 * The `activeTransactions` shape is intentionally a SLIM projection of the
 * finance transaction row: it reuses the SAME `transactionType` / `transactionStatus`
 * / `currencyEnum` shared schemas the finance `TransactionDto` uses (the web client
 * maps them to the SAME finance labels/colours via `TYPE_LABELS` / `STATUS_LABELS`
 * and formats the amount with the SAME `fmtUsd`/`fmtAmount` helpers), resolved party
 * labels, and a `canPay` flag the row uses to show the «Выплатить» action — so the
 * admin table reuses the exact finance `TransactionRow` look (incl. the real
 * transaction currency, identical to the Финансы page) without re-deriving anything
 * on the client.
 */

/**
 * One actionable transaction in the admin dashboard pipeline. `type` / `status`
 * reuse the shared finance enums (transaction_type / transaction_status) and
 * `currency` is the REAL DB transaction currency (`currencyEnumSchema` =
 * 'USDT' | 'USD' | 'EUR' | 'UAH', exactly `TransactionDto['currency']`) — NOT a
 * lossy payment-rail bucket — so the dashboard displays the same currency as the
 * Финансы page.
 */
export const adminActiveTransactionSchema = z.object({
  id: z.string().uuid(),
  type: transactionTypeSchema, // shared transaction_type enum
  status: transactionStatusSchema, // shared transaction_status enum
  // Raw party / project ids + resolved user display names sit alongside the
  // explicit labels so the web client's shared `TransactionRow` `FromTo` can
  // render a clickable participant (e.g. SENIOR_PENDING_PAYOUT / DROP_INCOME)
  // instead of «—». They map 1:1 onto `TransactionDto`'s
  // senderId/senderName/receiverId/receiverName/projectId (all uuid-or-null,
  // names resolved from the linked user) so the adapter passes them straight
  // through with no re-derivation.
  senderId: z.string().uuid().nullable(),
  senderName: z.string().nullable(), // resolved from the linked sender user
  senderLabel: z.string().nullable(),
  receiverId: z.string().uuid().nullable(),
  receiverName: z.string().nullable(), // resolved from the linked receiver user
  receiverLabel: z.string().nullable(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  amount: z.string(), // numeric string from DB
  currency: currencyEnumSchema, // real DB currency — same as TransactionDto['currency']
  txDate: z.string().datetime(), // ISO 8601
  /**
   * Linked payout_request id (PAYOUT rows). Projected so the ADMIN dashboard can
   * open the SAME finance ConfirmPayoutDialog ON the dashboard — its
   * COMPANY_ACCOUNT branch confirms off the payout REQUEST id (not the tx id),
   * exactly like the Финансы page. Null for non-payout rows.
   */
  payoutRequestId: z.string().uuid().nullable(),
  /** True when the row is ready for an admin payout action (status PENDING_PAYMENT). */
  canPay: z.boolean(),
})
export type AdminActiveTransaction = z.infer<typeof adminActiveTransactionSchema>

export const adminSummarySchema = z.object({
  kpis: z.object({
    /** Non-archived projects. */
    activeProjects: z.number().int().nonnegative(),
    /** All users, every role (incl. DROP). */
    employees: z.number().int().nonnegative(),
    /** Active projects with NO incoming transaction in the current month. */
    projectsUnpaidThisMonth: z.number().int().nonnegative(),
    /** Interviews not in a terminal stage (HIRED / REJECTED / ARCHIVED). */
    activeInterviews: z.number().int().nonnegative(),
  }),
  activeTransactions: z.array(adminActiveTransactionSchema),
})
export type AdminSummary = z.infer<typeof adminSummarySchema>
