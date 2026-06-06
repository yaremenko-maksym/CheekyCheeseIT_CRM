import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_WHITELIST,
  INTERNAL_CATEGORIES,
  createDocumentMetadataSchema,
  documentCategorySchema,
  documentListFiltersSchema,
  documentSchema,
  presignedDownloadSchema,
  reconcileOrphansOptionsSchema,
  statusBadgeSchema,
} from './documents'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-01-01T00:00:00.000Z'

describe('documentCategorySchema', () => {
  it('accepts all 7 known categories', () => {
    for (const value of ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'AVATAR', 'LOGO', 'INVOICE']) {
      expect(() => documentCategorySchema.parse(value)).not.toThrow()
    }
  })

  it('rejects unknown values', () => {
    expect(() => documentCategorySchema.parse('OTHER')).toThrow()
    expect(() => documentCategorySchema.parse('resume')).toThrow()
  })
})

describe('createDocumentMetadataSchema', () => {
  it('rejects CONTRACT without projectId', () => {
    expect(() => createDocumentMetadataSchema.parse({ category: 'CONTRACT' })).toThrow()
  })

  it('rejects CONTRACT with null projectId', () => {
    expect(() =>
      createDocumentMetadataSchema.parse({ category: 'CONTRACT', projectId: null }),
    ).toThrow()
  })

  it('accepts CONTRACT with valid projectId', () => {
    expect(() =>
      createDocumentMetadataSchema.parse({ category: 'CONTRACT', projectId: uuid }),
    ).not.toThrow()
  })

  it('accepts RESUME without projectId', () => {
    expect(() => createDocumentMetadataSchema.parse({ category: 'RESUME' })).not.toThrow()
  })

  it('accepts SCAN with null projectId', () => {
    expect(() =>
      createDocumentMetadataSchema.parse({ category: 'SCAN', projectId: null }),
    ).not.toThrow()
  })

  it('accepts RECEIPT without projectId', () => {
    expect(() => createDocumentMetadataSchema.parse({ category: 'RECEIPT' })).not.toThrow()
  })

  it('accepts optional ownerId and name', () => {
    expect(() =>
      createDocumentMetadataSchema.parse({
        category: 'RESUME',
        ownerId: uuid,
        name: 'My CV.pdf',
      }),
    ).not.toThrow()
  })
})

describe('documentSchema', () => {
  const validDoc = {
    id: uuid,
    ownerId: uuid,
    projectId: null,
    category: 'RESUME',
    name: 'cv.pdf',
    originalName: 'CV Иванов.pdf',
    s3Key: 'documents/RESUME/owner/doc-cv.pdf',
    thumbnailS3Key: null,
    sizeBytes: 12345,
    mimeType: 'application/pdf',
    uploadedBy: uuid,
    uploadedByDisplayName: 'Иван Иванов',
    deletedAt: null,
    deletedBy: null,
    createdAt: datetime,
  }

  it('accepts a valid document row', () => {
    expect(() => documentSchema.parse(validDoc)).not.toThrow()
  })

  it('accepts deleted documents (deletedAt + deletedBy set)', () => {
    expect(() =>
      documentSchema.parse({ ...validDoc, deletedAt: datetime, deletedBy: uuid }),
    ).not.toThrow()
  })

  it('accepts thumbnailS3Key set + originalName preserving cyrillic', () => {
    expect(() =>
      documentSchema.parse({
        ...validDoc,
        thumbnailS3Key: 'documents/RESUME/owner/doc-cv-thumb.jpg',
        originalName: 'Резюме Иванов.pdf',
      }),
    ).not.toThrow()
  })

  it('accepts null originalName + null thumbnailS3Key (legacy rows)', () => {
    expect(() =>
      documentSchema.parse({
        ...validDoc,
        originalName: null,
        thumbnailS3Key: null,
      }),
    ).not.toThrow()
  })

  it('accepts null uploadedByDisplayName (uploader hard-deleted or missing)', () => {
    expect(() => documentSchema.parse({ ...validDoc, uploadedByDisplayName: null })).not.toThrow()
  })

  it('rejects empty uploadedByDisplayName (set or null, never blank string)', () => {
    expect(() => documentSchema.parse({ ...validDoc, uploadedByDisplayName: '' })).toThrow()
  })

  it('rejects negative sizeBytes', () => {
    expect(() => documentSchema.parse({ ...validDoc, sizeBytes: -1 })).toThrow()
  })

  it('rejects empty name', () => {
    expect(() => documentSchema.parse({ ...validDoc, name: '' })).toThrow()
  })
})

describe('documentListFiltersSchema', () => {
  it('accepts empty filters and defaults includeDeleted=false', () => {
    const parsed = documentListFiltersSchema.parse({})
    expect(parsed.includeDeleted).toBe(false)
  })

  it('accepts a fully populated filter', () => {
    expect(() =>
      documentListFiltersSchema.parse({
        category: 'CONTRACT',
        ownerId: uuid,
        projectId: uuid,
        includeDeleted: true,
      }),
    ).not.toThrow()
  })

  it('rejects non-uuid ownerId', () => {
    expect(() => documentListFiltersSchema.parse({ ownerId: 'not-a-uuid' })).toThrow()
  })
})

describe('presignedDownloadSchema', () => {
  it('accepts a valid url + expiresAt pair', () => {
    expect(() =>
      presignedDownloadSchema.parse({
        url: 'https://minio.local/bucket/key?sig=abc',
        expiresAt: datetime,
      }),
    ).not.toThrow()
  })

  it('rejects non-url values', () => {
    expect(() => presignedDownloadSchema.parse({ url: 'not-a-url', expiresAt: datetime })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// statusBadgeSchema (Task 1 — PR-2)
// ---------------------------------------------------------------------------

describe('statusBadgeSchema', () => {
  it('accepts contract/draft', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'contract', state: 'draft' })).not.toThrow()
  })

  it('accepts contract/ready', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'contract', state: 'ready' })).not.toThrow()
  })

  it('accepts contract/signed', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'contract', state: 'signed' })).not.toThrow()
  })

  it('accepts invoice/ready', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'invoice', state: 'ready' })).not.toThrow()
  })

  it('accepts invoice/signed', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'invoice', state: 'signed' })).not.toThrow()
  })

  it('accepts receipt/pending', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'receipt', state: 'pending' })).not.toThrow()
  })

  it('accepts receipt/validated', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'receipt', state: 'validated' })).not.toThrow()
  })

  it('rejects unknown kind', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'other', state: 'draft' })).toThrow()
  })

  it('rejects unknown state', () => {
    expect(() => statusBadgeSchema.parse({ kind: 'contract', state: 'rejected' })).toThrow()
  })
})

describe('documentSchema — statusBadge + source (Task 1 — PR-2)', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000'
  const datetime = '2026-01-01T00:00:00.000Z'
  const baseDoc = {
    id: uuid,
    ownerId: uuid,
    projectId: null,
    category: 'RESUME' as const,
    name: 'cv.pdf',
    originalName: null,
    s3Key: 'documents/RESUME/owner/doc-cv.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: uuid,
    uploadedByDisplayName: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: datetime,
  }

  it('accepts a file entry without statusBadge (RESUME/SCAN — no badge)', () => {
    expect(() => documentSchema.parse({ ...baseDoc, source: 'file' })).not.toThrow()
  })

  it('accepts a file entry without source (backward compat)', () => {
    expect(() => documentSchema.parse(baseDoc)).not.toThrow()
  })

  it('accepts an employee_contract virtual entry with contract badge', () => {
    expect(() =>
      documentSchema.parse({
        ...baseDoc,
        source: 'employee_contract',
        statusBadge: { kind: 'contract', state: 'draft' },
      }),
    ).not.toThrow()
  })

  it('accepts an invoice file entry with statusBadge', () => {
    expect(() =>
      documentSchema.parse({
        ...baseDoc,
        category: 'INVOICE',
        source: 'file',
        statusBadge: { kind: 'invoice', state: 'signed' },
      }),
    ).not.toThrow()
  })

  it('accepts a receipt file entry with statusBadge', () => {
    expect(() =>
      documentSchema.parse({
        ...baseDoc,
        category: 'RECEIPT',
        source: 'file',
        statusBadge: { kind: 'receipt', state: 'pending' },
      }),
    ).not.toThrow()
  })

  it('accepts null statusBadge (plain uploaded file)', () => {
    expect(() => documentSchema.parse({ ...baseDoc, statusBadge: null })).not.toThrow()
  })

  it('rejects invalid source value', () => {
    expect(() => documentSchema.parse({ ...baseDoc, source: 'unknown_type' })).toThrow()
  })
})

describe('constants', () => {
  it('DOCUMENT_MAX_BYTES is 10 MB', () => {
    expect(DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('DOCUMENT_MIME_WHITELIST contains all expected MIME types', () => {
    expect(DOCUMENT_MIME_WHITELIST).toContain('application/pdf')
    expect(DOCUMENT_MIME_WHITELIST).toContain('image/jpeg')
    expect(DOCUMENT_MIME_WHITELIST).toContain('image/png')
    expect(DOCUMENT_MIME_WHITELIST).toContain('image/webp')
    expect(DOCUMENT_MIME_WHITELIST).toContain('image/heic')
  })

  it('INTERNAL_CATEGORIES contains AVATAR, LOGO, and INVOICE', () => {
    expect(INTERNAL_CATEGORIES).toEqual(['AVATAR', 'LOGO', 'INVOICE'])
  })
})

// ---------------------------------------------------------------------------
// MED-B security hardening: graceHours must be >= 1 to prevent race condition
// ---------------------------------------------------------------------------

describe('reconcileOrphansOptionsSchema — graceHours min(1) (MED-B)', () => {
  it('rejects graceHours=0 (race condition: in-flight upload may be deleted)', () => {
    expect(() => reconcileOrphansOptionsSchema.parse({ graceHours: 0 })).toThrow()
  })

  it('accepts graceHours=1 (minimum safe value)', () => {
    const result = reconcileOrphansOptionsSchema.parse({ graceHours: 1 })
    expect(result.graceHours).toBe(1)
  })

  it('accepts graceHours=48 (typical production value)', () => {
    const result = reconcileOrphansOptionsSchema.parse({ graceHours: 48 })
    expect(result.graceHours).toBe(48)
  })

  it('defaults graceHours to 48 when omitted', () => {
    const result = reconcileOrphansOptionsSchema.parse({})
    expect(result.graceHours).toBe(48)
  })

  it('defaults dryRun to true when omitted (safe-by-default)', () => {
    const result = reconcileOrphansOptionsSchema.parse({})
    expect(result.dryRun).toBe(true)
  })

  it('rejects negative graceHours', () => {
    expect(() => reconcileOrphansOptionsSchema.parse({ graceHours: -1 })).toThrow()
  })

  it('rejects non-integer graceHours (e.g. 1.5)', () => {
    expect(() => reconcileOrphansOptionsSchema.parse({ graceHours: 1.5 })).toThrow()
  })
})
