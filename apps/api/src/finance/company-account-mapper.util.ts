import type { CompanyDepositDto } from '@crm/shared'
import type { transactions } from '../database/schema'

/**
 * Pure DTO shaping for the company USDT account (extracted from
 * `CompanyAccountService`). No db access, no balance math, no gates — inputs
 * in, DTO out.
 */
export function toDepositDto(
  tx: typeof transactions.$inferSelect,
  threshold: number,
  verification?: {
    toMatches: boolean
    confirmations: number
    amountUsdt: number | null
  },
): CompanyDepositDto {
  const amountUsdt = parseFloat(tx.amount)
  return {
    id: tx.id,
    txHash: tx.txHash ?? '',
    amountUsdt: Number.isFinite(amountUsdt) ? amountUsdt : null,
    status: (tx.status === 'PAID' ? 'PAID' : 'PENDING') as CompanyDepositDto['status'],
    confirmations: verification?.confirmations ?? (tx.status === 'PAID' ? threshold : 0),
    threshold,
    toMatches: verification?.toMatches ?? tx.status === 'PAID',
    createdAt: tx.createdAt.toISOString(),
  }
}
