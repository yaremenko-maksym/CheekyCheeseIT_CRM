import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { assertLogoDocument } from './project-logo.util'

type Row = {
  id: string
  category: string
  deletedAt: Date | null
  projectId: string | null
}

const okRow: Row = { id: 'doc-1', category: 'LOGO', deletedAt: null, projectId: 'proj-1' }

function stubDb(row: Row | undefined) {
  const findFirst = vi.fn().mockResolvedValue(row)
  const db = { query: { documents: { findFirst } } } as unknown as DatabaseService['db']
  return { db, findFirst }
}

describe('assertLogoDocument', () => {
  it('short-circuits on null / undefined without querying', async () => {
    const { db, findFirst } = stubDb(okRow)
    await expect(assertLogoDocument(db, null, 'proj-1')).resolves.toBeUndefined()
    await expect(assertLogoDocument(db, undefined, 'proj-1')).resolves.toBeUndefined()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('accepts a live LOGO document of the same project', async () => {
    const { db, findFirst } = stubDb(okRow)
    await expect(assertLogoDocument(db, 'doc-1', 'proj-1')).resolves.toBeUndefined()
    expect(findFirst).toHaveBeenCalledTimes(1)
  })

  it('accepts a project-less LOGO document for any project', async () => {
    const { db } = stubDb({ ...okRow, projectId: null })
    await expect(assertLogoDocument(db, 'doc-1', 'proj-9')).resolves.toBeUndefined()
  })

  it('accepts any project binding when projectId arg is null (create)', async () => {
    const { db } = stubDb(okRow)
    await expect(assertLogoDocument(db, 'doc-1', null)).resolves.toBeUndefined()
  })

  it('rejects a missing document', async () => {
    const { db } = stubDb(undefined)
    await expect(assertLogoDocument(db, 'doc-x', 'proj-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGO_DOCUMENT_NOT_FOUND' }),
    })
  })

  it('rejects a wrong category', async () => {
    const { db } = stubDb({ ...okRow, category: 'CONTRACT' })
    await expect(assertLogoDocument(db, 'doc-1', 'proj-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGO_DOCUMENT_WRONG_CATEGORY' }),
    })
  })

  it('rejects a soft-deleted document', async () => {
    const { db } = stubDb({ ...okRow, deletedAt: new Date() })
    await expect(assertLogoDocument(db, 'doc-1', 'proj-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGO_DOCUMENT_DELETED' }),
    })
  })

  it("rejects another project's document", async () => {
    const { db } = stubDb({ ...okRow, projectId: 'proj-other' })
    await expect(assertLogoDocument(db, 'doc-1', 'proj-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGO_DOCUMENT_WRONG_PROJECT' }),
    })
  })

  it('checks category before deleted, deleted before project', async () => {
    const { db } = stubDb({ ...okRow, category: 'X', deletedAt: new Date(), projectId: 'p2' })
    await expect(assertLogoDocument(db, 'doc-1', 'proj-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGO_DOCUMENT_WRONG_CATEGORY' }),
    })
    const { db: db2 } = stubDb({ ...okRow, deletedAt: new Date(), projectId: 'p2' })
    await expect(assertLogoDocument(db2, 'doc-1', 'proj-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGO_DOCUMENT_DELETED' }),
    })
  })
})
