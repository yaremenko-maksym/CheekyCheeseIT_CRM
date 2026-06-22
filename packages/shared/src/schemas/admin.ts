import { z } from 'zod'

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
 * finance transaction row: it carries raw enum strings for `type` / `status`
 * (the web client maps them to the SAME finance labels/colours via the shared
 * `TYPE_LABELS` / `STATUS_LABELS`), resolved party labels, and a `canPay` flag
 * the row uses to show the «Выплатить» action — so the admin table reuses the
 * exact finance `TransactionRow` look without re-deriving any of this on the client.
 */

/**
 * Payment-method classification for an active transaction's money. Mirrors the
 * `paymentMethod` taxonomy used across requisites / payouts:
 *   - `USDT_ERC20`   — on-chain USDT (ERC-20).
 *   - `BANK_UAH_FOP` — Ukrainian bank transfer (ФОП, UAH).
 */
export const adminTransactionCurrencySchema = z.enum(['USDT_ERC20', 'BANK_UAH_FOP'])
export type AdminTransactionCurrency = z.infer<typeof adminTransactionCurrencySchema>

/**
 * One actionable transaction in the admin dashboard pipeline. `type` / `status`
 * are RAW DB enum strings (transaction_type / transaction_status) so the client
 * renders them with the existing finance label/colour maps.
 */
export const adminActiveTransactionSchema = z.object({
  id: z.string().uuid(),
  type: z.string(), // raw transaction_type enum value
  status: z.string(), // raw transaction_status enum value
  senderLabel: z.string().nullable(),
  receiverLabel: z.string().nullable(),
  projectName: z.string().nullable(),
  amount: z.string(), // numeric string from DB
  currency: adminTransactionCurrencySchema,
  txDate: z.string().datetime(), // ISO 8601
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
