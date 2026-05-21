/**
 * Tests for TeamAuditLogService — mirror of users' AuditLogService.
 */
import { describe, expect, it, vi } from 'vitest'
import { TeamAuditLogService } from './team-audit-log.service'

function makeDb() {
  const inserted: Array<Record<string, unknown>> = []
  return {
    inserted,
    db: {
      insert: vi.fn(() => ({
        values: vi.fn(async (vals: Record<string, unknown>) => {
          inserted.push(vals)
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn(async () => ([
                  { id: 'a1', action: 'team_archived', changes: {}, createdAt: new Date() },
                ])),
              })),
            })),
          })),
        })),
      })),
    },
  }
}

describe('TeamAuditLogService.record', () => {
  it('does not insert when changes are empty', async () => {
    const fake = makeDb()
    const service = new TeamAuditLogService({ db: fake.db } as never)
    await service.record({ actorId: 'a', targetId: 't', action: 'team_archived', changes: {} })
    expect(fake.inserted).toHaveLength(0)
  })

  it('inserts when changes are non-empty', async () => {
    const fake = makeDb()
    const service = new TeamAuditLogService({ db: fake.db } as never)
    await service.record({
      actorId: 'a',
      targetId: 't',
      action: 'team_archived',
      changes: { archivedAt: { before: null, after: new Date().toISOString() } },
    })
    expect(fake.inserted).toHaveLength(1)
    expect(fake.inserted[0]).toMatchObject({ action: 'team_archived', actorId: 'a', targetId: 't' })
  })
})

describe('TeamAuditLogService.diff', () => {
  it('produces a key-by-key diff for changed fields', () => {
    const service = new TeamAuditLogService({} as never)
    const result = service.diff({ name: 'A', notes: null }, { name: 'B', notes: null })
    expect(result).toEqual({ name: { before: 'A', after: 'B' } })
  })

  it('ignores updatedAt / createdAt / id by default', () => {
    const service = new TeamAuditLogService({} as never)
    const result = service.diff(
      { name: 'A', updatedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01'), id: 't-1' },
      { name: 'A', updatedAt: new Date('2026-01-02'), createdAt: new Date('2026-01-01'), id: 't-1' },
    )
    expect(result).toEqual({})
  })
})
