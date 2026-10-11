import type { PendingObligationDto, TransactionDto } from '@crm/shared'
import type { Transaction } from '../database/schema'

/**
 * Pure row -> DTO mappers for the pending-settlement endpoints. They read only
 * their argument (plus the wall clock for the `createdAt`/`updatedAt`
 * fallback in `toTransactionDto`), so they live outside
 * `PendingSettlementService` and are unit-tested directly.
 */

export function toObligationDto(row: {
  id: string
  creditorUserId: string
  debtorType: 'DROP' | 'TOV' | 'ADMIN' | 'COMPANY'
  debtorUserId: string | null
  sourceTransactionId: string
  closingTransactionId: string | null
  amount: string
  currency: string
  status: 'PENDING' | 'PAID' | 'CANCELLED'
  // Optional on the input shape so every call site that builds the row from a
  // `pendingObligations` select without this column keeps compiling;
  // `?? null` below normalises the omitted case to the DTO's required `null`.
  payoutRequestId?: string | null
  createdAt: Date | string
  updatedAt: Date | string
}): PendingObligationDto {
  const toIso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v)
  return {
    id: row.id,
    creditorUserId: row.creditorUserId,
    debtorType: row.debtorType,
    debtorUserId: row.debtorUserId,
    sourceTransactionId: row.sourceTransactionId,
    closingTransactionId: row.closingTransactionId,
    amount: row.amount,
    currency: row.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
    status: row.status,
    payoutRequestId: row.payoutRequestId ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

export function toTransactionDto(row: Transaction): TransactionDto {
  const toIso = (v: Date | string | null | undefined): string | null => {
    if (v === null || v === undefined) return null
    if (v instanceof Date) return v.toISOString()
    return typeof v === 'string' ? v : null
  }
  const nowIso = new Date().toISOString()
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    // Surfaces the obligation snapshot a DROP settle stamps (see the
    // amount-conversion block in settleByCompany). `null` for every other
    // row — mirrors mapTx in transactions.service.ts.
    originalAmount: row.originalAmount ?? null,
    originalCurrency: row.originalCurrency ?? null,
    exchangeRate: row.exchangeRate ?? null,
    senderId: row.senderId ?? null,
    senderLabel: row.senderLabel ?? null,
    senderName: null,
    receiverId: row.receiverId ?? null,
    receiverLabel: row.receiverLabel ?? null,
    receiverName: null,
    projectId: row.projectId ?? null,
    projectName: null,
    payoutRequestId: row.payoutRequestId ?? null,
    seniorSharePercent: row.seniorSharePercent ?? null,
    seniorSharePercentSource: null,
    receiptDocumentId: row.receiptDocumentId ?? null,
    receiptExternalUrl: row.receiptExternalUrl ?? null,
    txHash: row.txHash ?? null,
    // The recorded on-chain sender is
    // ADMIN/ACCOUNTANT-only audit data. This mapper serves the settlement
    // endpoints (no viewer in scope) and the rows it returns are
    // company-obligation settlements, not on-chain transfers — always null,
    // matching the masking applied in `TransactionsService.mapTx`.
    txFromAddress: null,
    validatedBy: row.validatedBy ?? null,
    validatedAt: toIso(row.validatedAt),
    rejectionReason: row.rejectionReason ?? null,
    notes: row.notes ?? null,
    salaryMonth: row.salaryMonth ?? null,
    txDate: toIso(row.txDate),
    recipientId: row.recipientId ?? null,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt) ?? nowIso,
    updatedAt: toIso(row.updatedAt) ?? nowIso,
  }
}
