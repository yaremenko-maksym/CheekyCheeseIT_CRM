import { describe, expect, it } from 'vitest'
import {
  invoiceListItemSchema,
  invoiceListResponseSchema,
  invoiceSchema,
  invoiceSignatureSchema,
  invoiceSignerRoleSchema,
  invoiceSignatureMethodSchema,
  invoiceStatusSchema,
  invoiceTypeSchema,
  invoiceVerifyResponseSchema,
  signInvoiceRequestSchema,
} from './invoices'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-05-26T14:30:00.000Z'

const validSignature = {
  id: uuid,
  transactionId: uuid,
  signerRole: 'COMPANY' as const,
  signerId: uuid,
  signerName: 'Максим Я.',
  signedAt: datetime,
  pdfHashShort: 'a1b2c3d4',
  method: 'AUTO_COMPANY' as const,
}

const validInvoice = {
  transactionId: uuid,
  documentId: uuid,
  status: 'PENDING' as const,
  type: 'SENIOR_INCOME' as const,
  amount: '1234.567890',
  currency: 'USDT' as const,
  counterpartyId: uuid,
  counterpartyName: 'John Doe',
  projectName: 'Acme Corp',
  salaryMonth: null,
  signatures: [validSignature],
  createdAt: datetime,
}

describe('invoiceSignerRoleSchema', () => {
  it('accepts COMPANY and COUNTERPARTY', () => {
    expect(() => invoiceSignerRoleSchema.parse('COMPANY')).not.toThrow()
    expect(() => invoiceSignerRoleSchema.parse('COUNTERPARTY')).not.toThrow()
  })

  it('rejects unknown values', () => {
    expect(() => invoiceSignerRoleSchema.parse('OTHER')).toThrow()
    expect(() => invoiceSignerRoleSchema.parse('company')).toThrow()
  })
})

describe('invoiceSignatureMethodSchema', () => {
  it('accepts AUTO_COMPANY and MANUAL_CLICK', () => {
    expect(() => invoiceSignatureMethodSchema.parse('AUTO_COMPANY')).not.toThrow()
    expect(() => invoiceSignatureMethodSchema.parse('MANUAL_CLICK')).not.toThrow()
  })

  it('rejects unknown method', () => {
    expect(() => invoiceSignatureMethodSchema.parse('OTHER')).toThrow()
  })
})

describe('invoiceStatusSchema', () => {
  it('accepts PENDING and SIGNED', () => {
    expect(() => invoiceStatusSchema.parse('PENDING')).not.toThrow()
    expect(() => invoiceStatusSchema.parse('SIGNED')).not.toThrow()
  })

  it('rejects unknown status', () => {
    expect(() => invoiceStatusSchema.parse('CANCELLED')).toThrow()
    expect(() => invoiceStatusSchema.parse('VALIDATED')).toThrow()
  })
})

describe('invoiceTypeSchema', () => {
  it('accepts only SENIOR_INCOME and SALARY', () => {
    expect(() => invoiceTypeSchema.parse('SENIOR_INCOME')).not.toThrow()
    expect(() => invoiceTypeSchema.parse('SALARY')).not.toThrow()
  })

  it('rejects other transaction types', () => {
    expect(() => invoiceTypeSchema.parse('PAYOUT')).toThrow()
    expect(() => invoiceTypeSchema.parse('EXPENSE')).toThrow()
    expect(() => invoiceTypeSchema.parse('ADMIN_INCOME')).toThrow()
  })
})

describe('invoiceSignatureSchema', () => {
  it('accepts a valid signature row', () => {
    expect(() => invoiceSignatureSchema.parse(validSignature)).not.toThrow()
  })

  it('rejects pdfHashShort != 8 chars', () => {
    expect(() =>
      invoiceSignatureSchema.parse({ ...validSignature, pdfHashShort: 'a1b2c3' }),
    ).toThrow()
    expect(() =>
      invoiceSignatureSchema.parse({ ...validSignature, pdfHashShort: 'a1b2c3d4e5' }),
    ).toThrow()
  })

  it('accepts MANUAL_CLICK for COUNTERPARTY', () => {
    expect(() =>
      invoiceSignatureSchema.parse({
        ...validSignature,
        signerRole: 'COUNTERPARTY',
        method: 'MANUAL_CLICK',
      }),
    ).not.toThrow()
  })

  it('rejects missing signerName (no fallback in DTO)', () => {
    const { signerName: _omitted, ...rest } = validSignature
    expect(() => invoiceSignatureSchema.parse(rest)).toThrow()
  })

  it('never leaks ipAddress / userAgent / full pdf hash via the DTO shape', () => {
    // schema.shape exposes only the public keys
    const keys = Object.keys(invoiceSignatureSchema.shape)
    expect(keys).not.toContain('ipAddress')
    expect(keys).not.toContain('userAgent')
    expect(keys).not.toContain('pdfHash')
  })
})

describe('invoiceSchema', () => {
  it('accepts a valid invoice row', () => {
    expect(() => invoiceSchema.parse(validInvoice)).not.toThrow()
  })

  it('accepts documentId = null (mid-generation race)', () => {
    expect(() => invoiceSchema.parse({ ...validInvoice, documentId: null })).not.toThrow()
  })

  it('accepts SALARY with null projectName + salaryMonth set', () => {
    expect(() =>
      invoiceSchema.parse({
        ...validInvoice,
        type: 'SALARY',
        projectName: null,
        salaryMonth: '2026-05',
      }),
    ).not.toThrow()
  })

  it('rejects invalid status', () => {
    expect(() => invoiceSchema.parse({ ...validInvoice, status: 'CANCELLED' })).toThrow()
  })

  it('rejects invalid currency', () => {
    expect(() => invoiceSchema.parse({ ...validInvoice, currency: 'BTC' })).toThrow()
  })

  it('rejects non-uuid transactionId', () => {
    expect(() => invoiceSchema.parse({ ...validInvoice, transactionId: 'nope' })).toThrow()
  })

  it('accepts empty signatures array (race window before auto-sign)', () => {
    expect(() => invoiceSchema.parse({ ...validInvoice, signatures: [] })).not.toThrow()
  })

  it('accepts both signatures (SIGNED state)', () => {
    const counter = {
      ...validSignature,
      id: '123e4567-e89b-12d3-a456-426614174001',
      signerRole: 'COUNTERPARTY' as const,
      signerName: 'John Doe',
      method: 'MANUAL_CLICK' as const,
    }
    expect(() =>
      invoiceSchema.parse({
        ...validInvoice,
        status: 'SIGNED',
        signatures: [validSignature, counter],
      }),
    ).not.toThrow()
  })
})

describe('invoiceListItemSchema', () => {
  it('accepts a slimmed invoice', () => {
    const slim = {
      transactionId: uuid,
      status: 'PENDING' as const,
      type: 'SALARY' as const,
      amount: '1000.00',
      currency: 'UAH' as const,
      counterpartyName: 'Иван Иванов',
      createdAt: datetime,
    }
    expect(() => invoiceListItemSchema.parse(slim)).not.toThrow()
  })

  it('omits signatures field on the list item shape', () => {
    expect(Object.keys(invoiceListItemSchema.shape)).not.toContain('signatures')
  })
})

describe('invoiceListResponseSchema', () => {
  it('accepts empty items', () => {
    expect(() => invoiceListResponseSchema.parse({ items: [] })).not.toThrow()
  })
})

describe('invoiceVerifyResponseSchema (public, no private fields)', () => {
  const validVerify = {
    transactionId: uuid,
    status: 'SIGNED' as const,
    amount: '1234.56',
    currency: 'USDT' as const,
    type: 'SENIOR_INCOME' as const,
    signatures: [
      {
        role: 'COMPANY' as const,
        signerName: 'Максим Я.',
        signedAt: datetime,
        pdfHashShort: 'a1b2c3d4',
      },
    ],
  }

  it('accepts a valid response', () => {
    expect(() => invoiceVerifyResponseSchema.parse(validVerify)).not.toThrow()
  })

  it('does not expose ipAddress / userAgent / signerId / pdfHash on signatures', () => {
    const sigShape = invoiceVerifyResponseSchema.shape.signatures.element.shape
    const keys = Object.keys(sigShape)
    expect(keys).not.toContain('ipAddress')
    expect(keys).not.toContain('userAgent')
    expect(keys).not.toContain('signerId')
    expect(keys).not.toContain('pdfHash')
    expect(keys).toContain('pdfHashShort')
  })

  it('rejects mistyped pdfHashShort length', () => {
    expect(() =>
      invoiceVerifyResponseSchema.parse({
        ...validVerify,
        signatures: [{ ...validVerify.signatures[0], pdfHashShort: 'short' }],
      }),
    ).toThrow()
  })
})

describe('signInvoiceRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(() => signInvoiceRequestSchema.parse({})).not.toThrow()
  })

  it('passes through arbitrary fields (forward-compat for v2)', () => {
    expect(() =>
      signInvoiceRequestSchema.parse({ acknowledge: true, comment: 'looks good' }),
    ).not.toThrow()
  })
})
