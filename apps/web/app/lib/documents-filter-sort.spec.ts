/**
 * documents-filter-sort.spec.ts — unit tests for filterDocuments / sortDocuments.
 *
 * TDD: RED phase — these tests are written before the implementation.
 * AC6 (task-documents-search-sort).
 */
import { describe, expect, it } from 'vitest'
import type { Document } from '@crm/shared'
import { filterDocuments, sortDocuments } from './documents-filter-sort'

// ---------------------------------------------------------------------------
// Minimal Document fixture factory
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<Document>): Document {
  return {
    id: 'doc-' + Math.random().toString(36).slice(2),
    ownerId: 'owner-1',
    projectId: null,
    category: 'RESUME',
    name: 'file.pdf',
    originalName: null,
    s3Key: 'documents/RESUME/owner-1/file.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: 'owner-1',
    uploadedByDisplayName: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    invoiceTransactionId: null,
    invoicePendingSignature: false,
    source: null,
    statusBadge: null,
    ...overrides,
  } as Document
}

// ---------------------------------------------------------------------------
// filterDocuments
// ---------------------------------------------------------------------------

describe('filterDocuments', () => {
  it('returns full list when query is empty string', () => {
    const docs = [makeDoc({ originalName: 'Резюме.pdf' }), makeDoc({ originalName: 'Скан.jpg' })]
    expect(filterDocuments(docs, '')).toHaveLength(2)
  })

  it('returns full list when query is whitespace only', () => {
    const docs = [makeDoc({ originalName: 'foo.pdf' })]
    expect(filterDocuments(docs, '   ')).toHaveLength(1)
  })

  it('filters by substring in originalName (case-insensitive)', () => {
    const docs = [
      makeDoc({ originalName: 'Резюме Senior.pdf', name: 'rezyume.pdf' }),
      makeDoc({ originalName: 'Скан паспорта.jpg', name: 'scan.jpg' }),
    ]
    expect(filterDocuments(docs, 'резюме')).toHaveLength(1)
    expect(filterDocuments(docs, 'РЕЗЮМЕ')).toHaveLength(1)
    expect(filterDocuments(docs, 'senior')).toHaveLength(1)
  })

  it('falls back to name when originalName is null', () => {
    const docs = [
      makeDoc({ originalName: null, name: 'my-contract.pdf' }),
      makeDoc({ originalName: null, name: 'avatar.png' }),
    ]
    expect(filterDocuments(docs, 'contract')).toHaveLength(1)
    expect(filterDocuments(docs, 'CONTRACT')).toHaveLength(1)
  })

  it('matches kirilic in originalName', () => {
    const docs = [
      makeDoc({ originalName: 'Підписаний договір.pdf' }),
      makeDoc({ originalName: 'Invoice_2026.pdf' }),
    ]
    expect(filterDocuments(docs, 'договір')).toHaveLength(1)
    expect(filterDocuments(docs, 'ДОГОВІР')).toHaveLength(1)
  })

  it('returns empty array when no match', () => {
    const docs = [makeDoc({ originalName: 'Резюме.pdf' })]
    expect(filterDocuments(docs, 'totally-absent')).toHaveLength(0)
  })

  it('matches partial substring in middle of filename', () => {
    const docs = [makeDoc({ originalName: 'Трудовий_договір_CHK-7F3A9C.pdf' })]
    expect(filterDocuments(docs, 'CHK-7F')).toHaveLength(1)
    expect(filterDocuments(docs, 'chk-7f')).toHaveLength(1)
  })

  it('does NOT mutate the original array', () => {
    const docs = [makeDoc({ originalName: 'A.pdf' }), makeDoc({ originalName: 'B.pdf' })]
    const original = [...docs]
    filterDocuments(docs, 'A')
    expect(docs).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// sortDocuments
// ---------------------------------------------------------------------------

describe('sortDocuments', () => {
  it('date_desc: newest first (default sort)', () => {
    const docs = [
      makeDoc({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeDoc({ id: 'new', createdAt: '2026-06-01T00:00:00.000Z' }),
    ]
    const sorted = sortDocuments(docs, 'date_desc')
    expect(sorted[0]?.id).toBe('new')
    expect(sorted[1]?.id).toBe('old')
  })

  it('date_asc: oldest first', () => {
    const docs = [
      makeDoc({ id: 'new', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeDoc({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const sorted = sortDocuments(docs, 'date_asc')
    expect(sorted[0]?.id).toBe('old')
    expect(sorted[1]?.id).toBe('new')
  })

  it('name_asc: alphabetical A→Z using localeCompare ru', () => {
    const docs = [
      makeDoc({ id: 'c', originalName: 'Цена.pdf', name: 'tsena.pdf' }),
      makeDoc({ id: 'a', originalName: 'Абитуриент.pdf', name: 'abiturient.pdf' }),
      makeDoc({ id: 'b', originalName: 'Балans.pdf', name: 'balans.pdf' }),
    ]
    const sorted = sortDocuments(docs, 'name_asc')
    expect(sorted[0]?.id).toBe('a')
    expect(sorted[1]?.id).toBe('b')
    expect(sorted[2]?.id).toBe('c')
  })

  it('name_desc: alphabetical Z→A using localeCompare ru', () => {
    const docs = [
      makeDoc({ id: 'a', originalName: 'Абитуриент.pdf', name: 'abiturient.pdf' }),
      makeDoc({ id: 'b', originalName: 'Балans.pdf', name: 'balans.pdf' }),
      makeDoc({ id: 'c', originalName: 'Цена.pdf', name: 'tsena.pdf' }),
    ]
    const sorted = sortDocuments(docs, 'name_desc')
    expect(sorted[0]?.id).toBe('c')
    expect(sorted[1]?.id).toBe('b')
    expect(sorted[2]?.id).toBe('a')
  })

  it('size_desc: largest first', () => {
    const docs = [
      makeDoc({ id: 'small', sizeBytes: 512 }),
      makeDoc({ id: 'large', sizeBytes: 99999 }),
      makeDoc({ id: 'medium', sizeBytes: 4096 }),
    ]
    const sorted = sortDocuments(docs, 'size_desc')
    expect(sorted[0]?.id).toBe('large')
    expect(sorted[1]?.id).toBe('medium')
    expect(sorted[2]?.id).toBe('small')
  })

  it('size_asc: smallest first', () => {
    const docs = [
      makeDoc({ id: 'large', sizeBytes: 99999 }),
      makeDoc({ id: 'small', sizeBytes: 512 }),
      makeDoc({ id: 'medium', sizeBytes: 4096 }),
    ]
    const sorted = sortDocuments(docs, 'size_asc')
    expect(sorted[0]?.id).toBe('small')
    expect(sorted[1]?.id).toBe('medium')
    expect(sorted[2]?.id).toBe('large')
  })

  it('name sort: falls back to name when originalName is null', () => {
    const docs = [
      makeDoc({ id: 'b', originalName: null, name: 'zebra.pdf' }),
      makeDoc({ id: 'a', originalName: null, name: 'apple.pdf' }),
    ]
    const sorted = sortDocuments(docs, 'name_asc')
    expect(sorted[0]?.id).toBe('a')
    expect(sorted[1]?.id).toBe('b')
  })

  it('does NOT mutate the original array', () => {
    const docs = [
      makeDoc({ id: 'b', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeDoc({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const original = [...docs]
    sortDocuments(docs, 'date_asc')
    expect(docs[0]?.id).toBe('b') // original order preserved
    expect(docs).toEqual(original)
  })

  it('is stable: equal keys preserve original order', () => {
    const sameDate = '2026-03-15T12:00:00.000Z'
    const docs = [
      makeDoc({ id: 'first', createdAt: sameDate }),
      makeDoc({ id: 'second', createdAt: sameDate }),
      makeDoc({ id: 'third', createdAt: sameDate }),
    ]
    const sorted = sortDocuments(docs, 'date_desc')
    expect(sorted[0]?.id).toBe('first')
    expect(sorted[1]?.id).toBe('second')
    expect(sorted[2]?.id).toBe('third')
  })
})

// ---------------------------------------------------------------------------
// Integration: filter then sort
// ---------------------------------------------------------------------------

describe('filterDocuments + sortDocuments combined', () => {
  it('applies filter and then sort correctly', () => {
    const docs = [
      makeDoc({ id: 'r2', originalName: 'Резюме Б.pdf', sizeBytes: 200 }),
      makeDoc({ id: 'other', originalName: 'Скан.jpg', sizeBytes: 50 }),
      makeDoc({ id: 'r1', originalName: 'Резюме А.pdf', sizeBytes: 500 }),
    ]
    const filtered = filterDocuments(docs, 'резюме')
    const sorted = sortDocuments(filtered, 'size_desc')
    expect(sorted).toHaveLength(2)
    expect(sorted[0]?.id).toBe('r1')
    expect(sorted[1]?.id).toBe('r2')
  })
})
