/**
 * Tests for ProjectAuditLogService — mirror of users' AuditLogService.
 */
import { describe, expect, it, vi } from 'vitest'
import { ProjectAuditLogService } from './project-audit-log.service'

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
    },
  }
}

describe('ProjectAuditLogService.record', () => {
  it('does not insert when changes are empty', async () => {
    const fake = makeDb()
    const service = new ProjectAuditLogService({ db: fake.db } as never)
    await service.record({ actorId: 'a', targetId: 't', action: 'project_archived', changes: {} })
    expect(fake.inserted).toHaveLength(0)
  })

  it('inserts when changes are non-empty', async () => {
    const fake = makeDb()
    const service = new ProjectAuditLogService({ db: fake.db } as never)
    await service.record({
      actorId: 'a',
      targetId: 't',
      action: 'project_archived',
      changes: { archivedAt: { before: null, after: new Date().toISOString() } },
    })
    expect(fake.inserted).toHaveLength(1)
    expect(fake.inserted[0]).toMatchObject({ action: 'project_archived' })
  })
})
