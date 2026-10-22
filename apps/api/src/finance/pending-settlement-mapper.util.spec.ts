import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transaction } from '../database/schema'
import { toObligationDto, toTransactionDto } from './pending-settlement-mapper.util'

const CREATED = new Date('2026-03-01T10:00:00.000Z')
const UPDATED = new Date('2026-03-02T11:30:00.000Z')

type ObligationRow = Parameters<typeof toObligationDto>[0]

function makeObligation(over: Partial<ObligationRow> = {}): ObligationRow {
  return {
    id: 'ob-1',
    creditorUserId: 'senior-1',
    debtorType: 'COMPANY',
    debtorUserId: null,
    sourceTransactionId: 'tx-src',
    closingTransactionId: 'tx-close',
    amount: '125.500000',
    currency: 'USDT',
    status: 'PAID',
    payoutRequestId: 'pr-1',
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...over,
  }
}

function makeTx(over: Record<string, unknown> = {}): Transaction {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'PAID',
    amount: '40.000000',
    currency: 'USDT',
    originalAmount: '30.000000',
    originalCurrency: 'EUR',
    exchangeRate: '1.33333333',
    senderId: 'admin-1',
    senderLabel: 'Admin One',
    receiverId: 'senior-1',
    receiverLabel: 'Senior One',
    projectId: 'proj-1',
    payoutRequestId: 'pr-1',
    seniorSharePercent: 26,
    receiptDocumentId: 'doc-1',
    receiptExternalUrl: 'https://explorer.example/tx/abc',
    txHash: '0xabc',
    validatedBy: 'admin-2',
    validatedAt: new Date('2026-03-03T09:00:00.000Z'),
    rejectionReason: 'none',
    notes: 'settled',
    salaryMonth: '2026-03',
    txDate: new Date('2026-03-04T00:00:00.000Z'),
    recipientId: 'rec-1',
    createdBy: 'creator-1',
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...over,
  } as unknown as Transaction
}

const NULLABLE_TX_COLUMNS = [
  'originalAmount',
  'originalCurrency',
  'exchangeRate',
  'senderId',
  'senderLabel',
  'receiverId',
  'receiverLabel',
  'projectId',
  'payoutRequestId',
  'seniorSharePercent',
  'receiptDocumentId',
  'receiptExternalUrl',
  'txHash',
  'validatedBy',
  'validatedAt',
  'rejectionReason',
  'notes',
  'salaryMonth',
  'txDate',
  'recipientId',
] as const

describe('toObligationDto', () => {
  it('maps every field and serialises Date columns to ISO strings', () => {
    expect(
      toObligationDto(makeObligation({ debtorType: 'DROP', debtorUserId: 'drop-1' })),
    ).toStrictEqual({
      id: 'ob-1',
      creditorUserId: 'senior-1',
      debtorType: 'DROP',
      debtorUserId: 'drop-1',
      sourceTransactionId: 'tx-src',
      closingTransactionId: 'tx-close',
      amount: '125.500000',
      currency: 'USDT',
      status: 'PAID',
      payoutRequestId: 'pr-1',
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-02T11:30:00.000Z',
    })
  })

  it('passes string timestamps through unchanged', () => {
    const dto = toObligationDto(
      makeObligation({
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    )
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(dto.updatedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('normalises an omitted payoutRequestId to null', () => {
    const { payoutRequestId: _omitted, ...rest } = makeObligation()
    expect(toObligationDto(rest).payoutRequestId).toBeNull()
  })

  it('keeps explicit null payoutRequestId and closingTransactionId as null', () => {
    const dto = toObligationDto(
      makeObligation({ payoutRequestId: null, closingTransactionId: null }),
    )
    expect(dto.payoutRequestId).toBeNull()
    expect(dto.closingTransactionId).toBeNull()
  })

  it('keeps a PENDING status', () => {
    expect(toObligationDto(makeObligation({ status: 'PENDING' })).status).toBe('PENDING')
  })
})

describe('toTransactionDto', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps a fully populated row, leaving the viewer-scoped name fields and txFromAddress null', () => {
    expect(toTransactionDto(makeTx())).toStrictEqual({
      id: 'tx-1',
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '40.000000',
      currency: 'USDT',
      originalAmount: '30.000000',
      originalCurrency: 'EUR',
      exchangeRate: '1.33333333',
      senderId: 'admin-1',
      senderLabel: 'Admin One',
      senderName: null,
      receiverId: 'senior-1',
      receiverLabel: 'Senior One',
      receiverName: null,
      projectId: 'proj-1',
      projectName: null,
      payoutRequestId: 'pr-1',
      seniorSharePercent: 26,
      seniorSharePercentSource: null,
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: 'https://explorer.example/tx/abc',
      txHash: '0xabc',
      txFromAddress: null,
      validatedBy: 'admin-2',
      validatedAt: '2026-03-03T09:00:00.000Z',
      rejectionReason: 'none',
      notes: 'settled',
      salaryMonth: '2026-03',
      txDate: '2026-03-04T00:00:00.000Z',
      recipientId: 'rec-1',
      createdBy: 'creator-1',
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-02T11:30:00.000Z',
    })
  })

  it.each([null, undefined])('normalises every nullable column that is %s to null', (empty) => {
    const over = Object.fromEntries(NULLABLE_TX_COLUMNS.map((k) => [k, empty]))
    const dto = toTransactionDto(makeTx(over))
    for (const key of NULLABLE_TX_COLUMNS) {
      expect(dto[key], key).toBeNull()
    }
  })

  it('keeps a zero seniorSharePercent (falsy but present)', () => {
    expect(toTransactionDto(makeTx({ seniorSharePercent: 0 })).seniorSharePercent).toBe(0)
  })

  it('passes string timestamps through unchanged', () => {
    const dto = toTransactionDto(
      makeTx({
        validatedAt: '2026-05-01T00:00:00.000Z',
        txDate: '2026-05-02',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
      }),
    )
    expect(dto.validatedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(dto.txDate).toBe('2026-05-02')
    expect(dto.createdAt).toBe('2026-05-03T00:00:00.000Z')
    expect(dto.updatedAt).toBe('2026-05-04T00:00:00.000Z')
  })

  it('maps a non-Date, non-string timestamp to null', () => {
    expect(toTransactionDto(makeTx({ validatedAt: 12345 })).validatedAt).toBeNull()
  })

  it('falls back to the current time when createdAt / updatedAt are missing', () => {
    const dto = toTransactionDto(makeTx({ createdAt: null, updatedAt: undefined }))
    expect(dto.createdAt).toBe('2030-01-01T00:00:00.000Z')
    expect(dto.updatedAt).toBe('2030-01-01T00:00:00.000Z')
  })
})
