import { describe, expect, it } from 'vitest'
import { shortHash } from '../common/pdf/pdf.utils'
import { COMPANY_BRAND_NAME } from './invoice-pdf.service'
import {
  buildVerifyUrl,
  sortAndMapSignatureRows,
  toInvoiceDto,
  toInvoiceListItem,
  toPublicInvoiceType,
  toPublicVerifySignatures,
  type InvoiceDetailTx,
  type SignatureRow,
  type SignatureWithSignerName,
} from './invoice-dto.util'

const sigRow = (over: Partial<SignatureRow>): SignatureRow => ({
  id: 's1',
  transactionId: 'tx-1',
  signerRole: 'COUNTERPARTY',
  signerId: 'u1',
  signerName: 'Ann',
  signedAt: new Date('2026-01-02T00:00:00.000Z'),
  pdfHash: 'a'.repeat(64),
  method: 'MANUAL_CLICK',
  amountSnapshot: '10.00',
  currencySnapshot: 'USD',
  ...over,
})

const sig = (over: Partial<SignatureWithSignerName>): SignatureWithSignerName => ({
  ...sortAndMapSignatureRows([sigRow({})])[0]!,
  ...over,
})

const detailTx = (over: Record<string, unknown>): InvoiceDetailTx =>
  ({
    id: 'tx-1',
    type: 'SALARY',
    amount: '100.50',
    currency: 'USD',
    senderId: 'sender-1',
    receiverId: 'receiver-1',
    salaryMonth: '2026-01',
    createdAt: new Date('2026-01-03T10:00:00.000Z'),
    receiver: { id: 'receiver-1', displayName: 'Rec' },
    sender: { id: 'sender-1', displayName: 'Sen' },
    project: { name: 'Proj' },
    ...over,
  }) as unknown as InvoiceDetailTx

describe('toPublicInvoiceType', () => {
  it('maps PAYOUT to SENIOR_INCOME and leaves others', () => {
    expect(toPublicInvoiceType('PAYOUT')).toBe('SENIOR_INCOME')
    expect(toPublicInvoiceType('SALARY')).toBe('SALARY')
    expect(toPublicInvoiceType('SENIOR_INCOME')).toBe('SENIOR_INCOME')
  })
})

describe('toInvoiceListItem', () => {
  const row = {
    id: 'tx-1',
    type: 'PAYOUT',
    amount: '42.00',
    currency: 'USDT',
    counterpartyName: 'Bob',
    signedFlag: true,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  }
  it('maps a signed PAYOUT row', () => {
    expect(toInvoiceListItem(row)).toEqual({
      transactionId: 'tx-1',
      status: 'SIGNED',
      type: 'SENIOR_INCOME',
      amount: '42.00',
      currency: 'USDT',
      counterpartyName: 'Bob',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
  })
  it('maps unsigned to PENDING and null name to em dash', () => {
    const r = toInvoiceListItem({
      ...row,
      type: 'SALARY',
      signedFlag: false,
      counterpartyName: null,
    })
    expect(r.status).toBe('PENDING')
    expect(r.type).toBe('SALARY')
    expect(r.counterpartyName).toBe('—')
  })
})

describe('toInvoiceDto', () => {
  it('uses the receiver as counterparty for SALARY and PENDING with no counterparty sig', () => {
    const dto = toInvoiceDto(detailTx({}), 'doc-1', [sig({ signerRole: 'COMPANY' })])
    expect(dto).toMatchObject({
      transactionId: 'tx-1',
      documentId: 'doc-1',
      status: 'PENDING',
      type: 'SALARY',
      amount: '100.50',
      currency: 'USD',
      counterpartyId: 'receiver-1',
      counterpartyName: 'Rec',
      projectName: 'Proj',
      salaryMonth: '2026-01',
      createdAt: '2026-01-03T10:00:00.000Z',
    })
    expect(dto.signatures).toHaveLength(1)
  })
  it('uses the sender for PAYOUT, maps to SENIOR_INCOME, SIGNED with counterparty sig', () => {
    const dto = toInvoiceDto(detailTx({ type: 'PAYOUT' }), 'doc-1', [sig({})])
    expect(dto.status).toBe('SIGNED')
    expect(dto.type).toBe('SENIOR_INCOME')
    expect(dto.counterpartyId).toBe('sender-1')
    expect(dto.counterpartyName).toBe('Sen')
    expect(dto.signatures[0]).toEqual({
      id: 's1',
      transactionId: 'tx-1',
      signerRole: 'COUNTERPARTY',
      signerId: 'u1',
      signerName: 'Ann',
      signedAt: '2026-01-02T00:00:00.000Z',
      pdfHashShort: shortHash('a'.repeat(64)),
      method: 'MANUAL_CLICK',
    })
  })
  it('falls back to the tx id column / empty / dash and null project & month', () => {
    const dto = toInvoiceDto(
      detailTx({ receiver: null, project: null, salaryMonth: undefined }),
      'doc-1',
      [],
    )
    expect(dto.counterpartyId).toBe('receiver-1')
    expect(dto.counterpartyName).toBe('—')
    expect(dto.projectName).toBeNull()
    expect(dto.salaryMonth).toBeNull()
    const none = toInvoiceDto(detailTx({ receiver: null, receiverId: null }), 'doc-1', [])
    expect(none.counterpartyId).toBe('')
  })
})

describe('sortAndMapSignatureRows', () => {
  it('puts COMPANY first and orders by signedAt within a role; does not mutate input', () => {
    const rows = [
      sigRow({ id: 'c2', signedAt: new Date('2026-01-05T00:00:00Z') }),
      sigRow({ id: 'k1', signerRole: 'COMPANY', signedAt: new Date('2026-01-09T00:00:00Z') }),
      sigRow({ id: 'c1', signedAt: new Date('2026-01-04T00:00:00Z') }),
    ]
    const out = sortAndMapSignatureRows(rows)
    expect(out.map((s) => s.id)).toEqual(['k1', 'c1', 'c2'])
    expect(rows.map((s) => s.id)).toEqual(['c2', 'k1', 'c1'])
  })
  it('maps names, short hash and snapshots', () => {
    const [o] = sortAndMapSignatureRows([sigRow({ signerName: null })])
    expect(o!.signerName).toBe('—')
    expect(o!.pdfHashShort).toBe(shortHash('a'.repeat(64)))
    expect(o!.amountSnapshot).toBe('10.00')
    expect(o!.currencySnapshot).toBe('USD')
  })
})

describe('toPublicVerifySignatures', () => {
  it('masks the COMPANY signer name and strips private fields', () => {
    const out = toPublicVerifySignatures([
      sig({ signerRole: 'COMPANY', signerName: 'Admin Personal' }),
      sig({ signerRole: 'COUNTERPARTY', signerName: 'Ann' }),
    ])
    expect(out[0]!.signerName).toBe(COMPANY_BRAND_NAME)
    expect(out[1]!.signerName).toBe('Ann')
    expect(out[1]).toEqual({
      role: 'COUNTERPARTY',
      signerName: 'Ann',
      signedAt: '2026-01-02T00:00:00.000Z',
      pdfHashShort: shortHash('a'.repeat(64)),
    })
  })
})

describe('buildVerifyUrl', () => {
  it('joins frontend url and transaction id', () => {
    expect(buildVerifyUrl('https://app.example.com', 'tx-9')).toBe(
      'https://app.example.com/invoice/v/tx-9',
    )
  })
})
