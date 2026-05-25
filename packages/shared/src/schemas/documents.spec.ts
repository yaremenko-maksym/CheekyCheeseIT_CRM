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
} from './documents'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-01-01T00:00:00.000Z'

describe('documentCategorySchema', () => {
  it('accepts all 6 known categories', () => {
    for (const value of ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'AVATAR', 'LOGO']) {
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
    expect(() => createDocumentMetadataSchema.parse({ category: 'CONTRACT', projectId: null })).toThrow()
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
    expect(() =>
      presignedDownloadSchema.parse({ url: 'not-a-url', expiresAt: datetime }),
    ).toThrow()
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

  it('INTERNAL_CATEGORIES contains AVATAR and LOGO only', () => {
    expect(INTERNAL_CATEGORIES).toEqual(['AVATAR', 'LOGO'])
  })
})
