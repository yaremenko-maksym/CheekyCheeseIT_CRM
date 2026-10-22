import type { documents } from '../database/schema'
import {
  VIRTUAL_CONTRACT_NAME_MARKER,
  deriveStatusBadge,
  mapContractVirtualEntry,
  mapDocument,
} from './document-mapping.util'

type Row = typeof documents.$inferSelect

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'doc-1',
    ownerId: 'owner-1',
    projectId: 'proj-1',
    category: 'RESUME',
    name: 'cv.pdf',
    originalName: 'CV.pdf',
    s3Key: 'documents/RESUME/owner-1/doc-1-cv.pdf',
    thumbnailS3Key: 'documents/RESUME/owner-1/doc-1-cv-thumb.jpg',
    sizeBytes: 1234,
    mimeType: 'application/pdf',
    uploadedBy: 'uploader-1',
    deletedAt: new Date('2026-02-03T04:05:06.000Z'),
    deletedBy: 'deleter-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    ...over,
  } as Row
}

describe('mapDocument', () => {
  it('maps every public field and never leaks s3Key', () => {
    const dto = mapDocument(row(), 'Ann', 'tx-1', true, 'file', { kind: 'invoice', state: 'ready' })
    expect(dto).toEqual({
      id: 'doc-1',
      ownerId: 'owner-1',
      projectId: 'proj-1',
      category: 'RESUME',
      name: 'cv.pdf',
      originalName: 'CV.pdf',
      thumbnailS3Key: 'documents/RESUME/owner-1/doc-1-cv-thumb.jpg',
      sizeBytes: 1234,
      mimeType: 'application/pdf',
      uploadedBy: 'uploader-1',
      uploadedByDisplayName: 'Ann',
      deletedAt: '2026-02-03T04:05:06.000Z',
      deletedBy: 'deleter-1',
      createdAt: '2026-01-02T03:04:05.000Z',
      invoiceTransactionId: 'tx-1',
      invoicePendingSignature: true,
      source: 'file',
      statusBadge: { kind: 'invoice', state: 'ready' },
      nameKind: null,
      contractNumber: null,
    })
    expect(dto).not.toHaveProperty('s3Key')
  })

  it('applies defaults for the optional arguments', () => {
    const dto = mapDocument(row())
    expect(dto.uploadedByDisplayName).toBeNull()
    expect(dto.invoiceTransactionId).toBeNull()
    expect(dto.invoicePendingSignature).toBe(false)
    expect(dto.source).toBe('file')
    expect(dto.statusBadge).toBeNull()
  })

  it('turns nullish nullable columns into null', () => {
    const dto = mapDocument(
      row({
        projectId: null,
        originalName: null,
        thumbnailS3Key: null,
        deletedAt: null,
        deletedBy: null,
      }),
    )
    expect(dto.projectId).toBeNull()
    expect(dto.originalName).toBeNull()
    expect(dto.thumbnailS3Key).toBeNull()
    expect(dto.deletedAt).toBeNull()
    expect(dto.deletedBy).toBeNull()
  })
})

describe('deriveStatusBadge', () => {
  it('INVOICE is signed or ready', () => {
    expect(deriveStatusBadge('INVOICE', true, null)).toEqual({ kind: 'invoice', state: 'signed' })
    expect(deriveStatusBadge('INVOICE', false, null)).toEqual({ kind: 'invoice', state: 'ready' })
  })

  it('RECEIPT without a linked transaction status has no badge', () => {
    expect(deriveStatusBadge('RECEIPT', false, null)).toBeNull()
    expect(deriveStatusBadge('RECEIPT', false, '')).toBeNull()
  })

  it('RECEIPT is validated for VALIDATED / PENDING_PAYMENT / PAID', () => {
    for (const s of ['VALIDATED', 'PENDING_PAYMENT', 'PAID']) {
      expect(deriveStatusBadge('RECEIPT', false, s)).toEqual({
        kind: 'receipt',
        state: 'validated',
      })
    }
  })

  it('RECEIPT is pending for PENDING / REJECTED / anything else', () => {
    for (const s of ['PENDING', 'REJECTED', 'weird']) {
      expect(deriveStatusBadge('RECEIPT', false, s)).toEqual({ kind: 'receipt', state: 'pending' })
    }
  })

  it('other categories carry no badge', () => {
    for (const c of ['RESUME', 'SCAN', 'CONTRACT', 'AVATAR', 'LOGO'] as const) {
      expect(deriveStatusBadge(c, true, 'PAID')).toBeNull()
    }
  })
})

describe('mapContractVirtualEntry', () => {
  const created = new Date('2026-03-04T05:06:07.000Z')
  const names = { u1: 'Bob' }
  const base = { id: 'c1', userId: 'u1', createdAt: created }

  it('uses a fixed ASCII marker for name', () => {
    expect(VIRTUAL_CONTRACT_NAME_MARKER).toBe('employee-contract')
  })

  it('SIGNED with a signed contract: number, signer, signedAt, size, badge', () => {
    const dto = mapContractVirtualEntry(
      {
        ...base,
        status: 'SIGNED',
        signedContract: {
          contractNumber: 'CHK-7F3A9C',
          signedTypedName: 'Bob B',
          signedAt: '2026-04-05T06:07:08.000Z',
          pdfSizeBytes: 999,
        },
      },
      names,
    )
    expect(dto).toEqual({
      id: 'c1',
      ownerId: 'u1',
      projectId: null,
      category: 'CONTRACT',
      name: 'employee-contract',
      originalName: null,
      nameKind: 'CONTRACT_SIGNED',
      contractNumber: 'CHK-7F3A9C',
      thumbnailS3Key: null,
      sizeBytes: 999,
      mimeType: 'application/pdf',
      uploadedBy: 'u1',
      uploadedByDisplayName: 'Bob',
      deletedAt: null,
      deletedBy: null,
      createdAt: '2026-03-04T05:06:07.000Z',
      invoiceTransactionId: null,
      invoicePendingSignature: false,
      source: 'employee_contract',
      statusBadge: { kind: 'contract', state: 'signed' },
      signedByName: 'Bob B',
      signedAt: '2026-04-05T06:07:08.000Z',
    })
  })

  it('signedAt accepts a Date and serialises it to ISO', () => {
    const dto = mapContractVirtualEntry(
      {
        ...base,
        status: 'SIGNED',
        signedContract: {
          contractNumber: 'N',
          signedTypedName: null,
          signedAt: new Date('2026-05-06T07:08:09.000Z'),
        },
      },
      names,
    )
    expect(dto.signedAt).toBe('2026-05-06T07:08:09.000Z')
    expect(dto.signedByName).toBeNull()
    expect(dto.sizeBytes).toBe(0)
  })

  it('SIGNED without a signedContract relation falls back to neutral CONTRACT', () => {
    const dto = mapContractVirtualEntry({ ...base, status: 'SIGNED' }, names)
    expect(dto.nameKind).toBe('CONTRACT')
    expect(dto.contractNumber).toBeNull()
    expect(dto.signedByName).toBeNull()
    expect(dto.signedAt).toBeNull()
    expect(dto.sizeBytes).toBe(0)
    expect(dto.statusBadge).toEqual({ kind: 'contract', state: 'signed' })
  })

  it('SIGNED with a relation but no signedAt has null signedAt', () => {
    const dto = mapContractVirtualEntry(
      {
        ...base,
        status: 'SIGNED',
        signedContract: { contractNumber: 'N', signedTypedName: 'X', signedAt: null },
      },
      names,
    )
    expect(dto.signedAt).toBeNull()
  })

  it('READY_TO_SIGN is CONTRACT_TO_SIGN / ready and ignores signed-contract data', () => {
    const dto = mapContractVirtualEntry(
      {
        ...base,
        status: 'READY_TO_SIGN',
        signedContract: {
          contractNumber: 'LEAK',
          signedTypedName: 'LEAK',
          signedAt: '2026-04-05T06:07:08.000Z',
        },
      },
      names,
    )
    expect(dto.nameKind).toBe('CONTRACT_TO_SIGN')
    expect(dto.contractNumber).toBeNull()
    expect(dto.signedByName).toBeNull()
    expect(dto.signedAt).toBeNull()
    expect(dto.statusBadge).toEqual({ kind: 'contract', state: 'ready' })
  })

  it('anything else is CONTRACT_DRAFT / draft', () => {
    const dto = mapContractVirtualEntry({ ...base, status: 'DRAFT' }, names)
    expect(dto.nameKind).toBe('CONTRACT_DRAFT')
    expect(dto.statusBadge).toEqual({ kind: 'contract', state: 'draft' })
  })

  it('missing owner display name is null', () => {
    expect(
      mapContractVirtualEntry({ ...base, status: 'DRAFT' }, {}).uploadedByDisplayName,
    ).toBeNull()
  })

  it('missing createdAt falls back to a current ISO timestamp', () => {
    const before = Date.now()
    const dto = mapContractVirtualEntry(
      { id: 'c', userId: 'u', status: 'DRAFT', createdAt: undefined as unknown as Date },
      {},
    )
    const t = new Date(dto.createdAt).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
})
