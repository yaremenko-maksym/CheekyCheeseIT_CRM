import { HttpStatus } from '@nestjs/common'
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

// Rejections are HttpExceptions built by apiError: assert BOTH the code and the
// HTTP status (a 400 -> 404 regression must not pass).
async function expectRejects(p: Promise<void>, code: string): Promise<void> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toMatchObject({ response: expect.objectContaining({ code }) })
  expect((err as { getStatus(): number }).getStatus()).toBe(HttpStatus.BAD_REQUEST)
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
    // The lookup must be filtered (a bare findFirst({}) would fetch an arbitrary document).
    expect(findFirst).toHaveBeenCalledWith({ where: expect.anything() })
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
    await expectRejects(assertLogoDocument(db, 'doc-x', 'proj-1'), 'LOGO_DOCUMENT_NOT_FOUND')
  })

  it('rejects a wrong category', async () => {
    const { db } = stubDb({ ...okRow, category: 'CONTRACT' })
    await expectRejects(assertLogoDocument(db, 'doc-1', 'proj-1'), 'LOGO_DOCUMENT_WRONG_CATEGORY')
  })

  it('rejects a soft-deleted document', async () => {
    const { db } = stubDb({ ...okRow, deletedAt: new Date() })
    await expectRejects(assertLogoDocument(db, 'doc-1', 'proj-1'), 'LOGO_DOCUMENT_DELETED')
  })

  it("rejects another project's document", async () => {
    const { db } = stubDb({ ...okRow, projectId: 'proj-other' })
    await expectRejects(assertLogoDocument(db, 'doc-1', 'proj-1'), 'LOGO_DOCUMENT_WRONG_PROJECT')
  })

  it('checks category before deleted, deleted before project', async () => {
    const { db } = stubDb({ ...okRow, category: 'X', deletedAt: new Date(), projectId: 'p2' })
    await expectRejects(assertLogoDocument(db, 'doc-1', 'proj-1'), 'LOGO_DOCUMENT_WRONG_CATEGORY')
    const { db: db2 } = stubDb({ ...okRow, deletedAt: new Date(), projectId: 'p2' })
    await expectRejects(assertLogoDocument(db2, 'doc-1', 'proj-1'), 'LOGO_DOCUMENT_DELETED')
  })
})
