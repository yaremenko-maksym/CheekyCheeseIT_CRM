import { describe, expect, it, vi } from 'vitest'
import { UserProfileService } from './user-profile.service'

type Perms = { tabs: string[]; actions: string[]; fields: Record<string, boolean> }

function makeService(target: Record<string, unknown>, permissions: Perms) {
  const db = {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([target]),
      query: { userEmails: { findFirst: vi.fn().mockResolvedValue(undefined) } },
    },
  }
  const access = { getViewPermissions: vi.fn().mockResolvedValue(permissions) }
  const auditRecord = vi.fn().mockResolvedValue(undefined)
  const getLatestAcceptanceForUser = vi.fn().mockResolvedValue({
    acceptedAt: new Date('2026-01-02T03:04:05.000Z'),
    tosVersion: 'v1',
  })
  const approvals = { getStatus: vi.fn().mockResolvedValue('NONE') }
  const service = new UserProfileService(
    db as never,
    access as never,
    { record: auditRecord } as never,
    { getLatestAcceptanceForUser } as never,
    approvals as never,
  )
  return { service, auditRecord, getLatestAcceptanceForUser }
}

const baseTarget = {
  id: 'target-id',
  email: 't@example.com',
  displayName: 'Target',
  role: 'SENIOR',
  techStack: null,
  adminNote: null,
}
const viewerOf = (id: string, role: string) => ({ id, role }) as never

describe('UserProfileService.buildProfileView — overview data', () => {
  it('without the overview tab, data stays empty and ToS is not read', async () => {
    const { service, getLatestAcceptanceForUser } = makeService(baseTarget, {
      tabs: ['projects'],
      actions: [],
      fields: {},
    })
    const result = await service.buildProfileView(viewerOf('admin-id', 'ADMIN'), 'target-id')
    expect(result.data).toEqual({})
    expect(getLatestAcceptanceForUser).not.toHaveBeenCalled()
  })

  it('non-admin non-self viewer with overview gets no ToS data', async () => {
    const { service, getLatestAcceptanceForUser } = makeService(baseTarget, {
      tabs: ['overview'],
      actions: [],
      fields: {},
    })
    const result = await service.buildProfileView(viewerOf('hr-id', 'HR'), 'target-id')
    expect(getLatestAcceptanceForUser).not.toHaveBeenCalled()
    expect(result.data.overview).toEqual({
      techStack: null,
      adminNote: null,
      tosAcceptedAt: null,
      tosVersion: null,
    })
  })

  it('admin with techStack/adminNote flags and null columns gets [] and null', async () => {
    const { service } = makeService(baseTarget, {
      tabs: ['overview'],
      actions: [],
      fields: { techStack: true, adminNote: true },
    })
    const result = await service.buildProfileView(viewerOf('admin-id', 'ADMIN'), 'target-id')
    expect(result.data.overview).toEqual({
      techStack: [],
      adminNote: null,
      tosAcceptedAt: '2026-01-02T03:04:05.000Z',
      tosVersion: 'v1',
    })
  })

  it('admin with populated techStack/adminNote gets the real values', async () => {
    const { service } = makeService(
      { ...baseTarget, techStack: ['ts'], adminNote: 'note' },
      { tabs: ['overview'], actions: [], fields: { techStack: true, adminNote: true } },
    )
    const result = await service.buildProfileView(viewerOf('admin-id', 'ADMIN'), 'target-id')
    expect(result.data.overview).toMatchObject({ techStack: ['ts'], adminNote: 'note' })
  })
})

describe('UserProfileService.buildProfileView — requisites_read audit', () => {
  const populated = {
    ...baseTarget,
    bankUahIban: 'UA213223130000026007233566001',
    bankUahRnokpp: '1234567890',
  }
  const perms: Perms = {
    tabs: ['overview', 'requisites'],
    actions: [],
    fields: { requisites: true },
  }

  it('accountant (not self) receiving requisites records one redacted, names-only audit', async () => {
    const { service, auditRecord } = makeService(populated, perms)
    await service.buildProfileView(viewerOf('acc-id', 'ACCOUNTANT'), 'target-id')
    expect(auditRecord).toHaveBeenCalledTimes(1)
    const entry = auditRecord.mock.calls[0][0]
    expect(entry).toMatchObject({
      actorId: 'acc-id',
      targetId: 'target-id',
      action: 'requisites_read',
    })
    expect(Object.keys(entry.changes).sort()).toEqual(['bankUahIban', 'bankUahRnokpp'])
    for (const change of Object.values(entry.changes)) {
      expect(change).toEqual({ before: '[redacted]', after: '[redacted]' })
    }
    expect(JSON.stringify(entry)).not.toContain('1234567890')
    expect(JSON.stringify(entry)).not.toContain('UA2132')
  })

  it('attributes the audit to the impersonator when one is supplied', async () => {
    const { service, auditRecord } = makeService(populated, perms)
    await service.buildProfileView(viewerOf('acc-id', 'ACCOUNTANT'), 'target-id', 'imp-id')
    expect(auditRecord.mock.calls[0][0].actorId).toBe('imp-id')
  })

  it('accountant with requisites access but no populated requisite fields writes no audit', async () => {
    const { service, auditRecord } = makeService(baseTarget, {
      tabs: ['overview', 'requisites'],
      actions: [],
      fields: { requisites: true },
    })
    await service.buildProfileView(viewerOf('acc-id', 'ACCOUNTANT'), 'target-id')
    expect(auditRecord).not.toHaveBeenCalled()
  })
})
