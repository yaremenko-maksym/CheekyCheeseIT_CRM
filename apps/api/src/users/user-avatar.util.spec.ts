import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { assertAvatarDocument } from './user-avatar.util'

type Row = {
  id: string
  category: string
  ownerId: string
  deletedAt: Date | null
}

const okRow: Row = { id: 'doc-1', category: 'AVATAR', ownerId: 'user-1', deletedAt: null }

function stubDb(row: Row | undefined) {
  const findFirst = vi.fn().mockResolvedValue(row)
  const db = { query: { documents: { findFirst } } } as unknown as DatabaseService['db']
  return { db, findFirst }
}

async function rejection(promise: Promise<void>) {
  try {
    await promise
  } catch (e) {
    return e as { getStatus(): number; getResponse(): unknown }
  }
  throw new Error('expected rejection')
}

describe('assertAvatarDocument', () => {
  it('short-circuits on null / undefined without querying', async () => {
    const { db, findFirst } = stubDb(okRow)
    await expect(assertAvatarDocument(db, null, 'user-1')).resolves.toBeUndefined()
    await expect(assertAvatarDocument(db, undefined, 'user-1')).resolves.toBeUndefined()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('accepts a live AVATAR document owned by the expected owner', async () => {
    const { db, findFirst } = stubDb(okRow)
    await expect(assertAvatarDocument(db, 'doc-1', 'user-1')).resolves.toBeUndefined()
    expect(findFirst).toHaveBeenCalledTimes(1)
    // The lookup must be filtered (a bare findFirst({}) would fetch an arbitrary document).
    expect(findFirst).toHaveBeenCalledWith({ where: expect.anything() })
  })

  it.each([
    ['missing document', undefined, 'AVATAR_DOCUMENT_NOT_FOUND'],
    ['wrong category', { ...okRow, category: 'CONTRACT' }, 'AVATAR_DOCUMENT_WRONG_CATEGORY'],
    ['another owner', { ...okRow, ownerId: 'user-2' }, 'AVATAR_DOCUMENT_WRONG_OWNER'],
    ['soft-deleted', { ...okRow, deletedAt: new Date() }, 'AVATAR_DOCUMENT_DELETED'],
  ] as const)('rejects %s with HTTP 400', async (_name, row, code) => {
    const { db } = stubDb(row)
    const err = await rejection(assertAvatarDocument(db, 'doc-1', 'user-1'))
    expect(err.getStatus()).toBe(400)
    expect(err.getResponse()).toMatchObject({ code })
  })

  it('checks category before owner, owner before deleted', async () => {
    const all = { ...okRow, category: 'X', ownerId: 'user-2', deletedAt: new Date() }
    const e1 = await rejection(assertAvatarDocument(stubDb(all).db, 'doc-1', 'user-1'))
    expect(e1.getResponse()).toMatchObject({ code: 'AVATAR_DOCUMENT_WRONG_CATEGORY' })
    const e2 = await rejection(
      assertAvatarDocument(stubDb({ ...all, category: 'AVATAR' }).db, 'doc-1', 'user-1'),
    )
    expect(e2.getResponse()).toMatchObject({ code: 'AVATAR_DOCUMENT_WRONG_OWNER' })
  })
})
