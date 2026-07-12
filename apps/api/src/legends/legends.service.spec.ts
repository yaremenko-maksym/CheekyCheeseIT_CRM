/**
 * Unit tests for LegendsService — per-project legend RBAC
 *
 * NEW MODEL (legend per-project):
 *   canAccess(viewer, project{seniorId,dropId}):
 *     ADMIN                → true
 *     viewer.id === seniorId → false (subject excluded)
 *     viewer.id === dropId   → false (subject excluded)
 *     HR sharing active team with project.seniorId → true
 *     HR no shared team → false
 *     JUNIOR active member of this project → true
 *     JUNIOR not member → false
 *     ACCOUNTANT → false
 *     other SENIOR/DROP → false
 *
 *   view-access == edit-access
 *   getLegend: 404 if project not found; 404 if no legend; 403 if !canAccess
 *   upsertLegend: 403 if !canAccess; atomic upsert on legends.projectId
 *   addEntry: 403 if !canAccess; 404 if no legend; inserts entry
 */
import { describe, it, expect, vi } from 'vitest'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { LegendsService } from './legends.service'

// ---------------------------------------------------------------------------
// Minimal DatabaseService stub
// ---------------------------------------------------------------------------

function makeChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    // orderBy is the terminal call for loadEntries — must return a Promise
    orderBy: vi.fn().mockResolvedValue([]),
    // limit is the terminal call for project/legend/membership queries
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  }
  return chain
}

function makeDbStub() {
  const chain = makeChain()
  return {
    db: {
      select: vi.fn(() => chain),
      insert: vi.fn(() => chain),
      update: vi.fn(() => chain),
      _chain: chain,
    },
    _chain: chain,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'a1b2c3d4-e5f6-4aaa-8bbb-000000000001'
const PROJECT_ID_B = 'a1b2c3d4-e5f6-4aaa-8bbb-000000000002'
const LEGEND_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000001'
const SENIOR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000002'
const DROP_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000007'
const ADMIN_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000003'
const HR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000004'
const JUNIOR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000005'
const ACCOUNTANT_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000006'
const OTHER_SENIOR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000008'
const AUTHOR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000009'

const makeUser = (id: string, role: SessionUser['role']): SessionUser => ({
  id,
  role,
  email: `${role}@test.com`,
  displayName: role,
})

const admin = makeUser(ADMIN_ID, 'ADMIN')
const senior = makeUser(SENIOR_ID, 'SENIOR')
const drop = makeUser(DROP_ID, 'DROP')
const hr = makeUser(HR_ID, 'HR')
const junior = makeUser(JUNIOR_ID, 'JUNIOR')
const accountant = makeUser(ACCOUNTANT_ID, 'ACCOUNTANT')
const otherSenior = makeUser(OTHER_SENIOR_ID, 'SENIOR')

// Project rows: seniorProject has seniorId; dropProject has both seniorId and dropId
const seniorProject = { id: PROJECT_ID, seniorId: SENIOR_ID, dropId: null as string | null }
const dropProject = { id: PROJECT_ID, seniorId: SENIOR_ID, dropId: DROP_ID }

const mockLegendRow = {
  id: LEGEND_ID,
  projectId: PROJECT_ID,
  fullName: 'Іванов Іван',
  dateOfBirth: '1990-01-15' as string | null,
  address: 'Київ' as string | null,
  presentedRole: 'Senior Backend Engineer' as string | null,
  presentedStack: 'Node.js, TypeScript' as string | null,
  backstory: 'Досвідчений' as string | null,
  hobbies: 'Читання' as string | null,
  notes: 'Нотатки' as string | null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
}

// Entry row as returned by the DB join query (raw DB row — createdAt is Date)
const mockEntryDbRow = {
  id: 'a1b2c3d4-e5f6-4aaa-9bbb-000000000010',
  legendId: LEGEND_ID,
  authorId: AUTHOR_ID,
  authorName: 'Author Name',
  text: 'Entry text',
  createdAt: new Date('2024-01-02T00:00:00Z'),
}

// ---------------------------------------------------------------------------
// Helper to build service
// ---------------------------------------------------------------------------

function buildService() {
  const stub = makeDbStub()
  // HrAccessService shares the SAME db stub so the existing chain.limit mock
  // sequencing drives the HR-access queries (they were relocated out of
  // LegendsService into HrAccessService — same SQL, same stub behavior).
  const hrAccess = new HrAccessService(stub as never)
  const service = new LegendsService(stub as never, hrAccess)
  return { service, chain: stub._chain, db: stub.db }
}

// ---------------------------------------------------------------------------
// canAccess — full RBAC matrix
// ---------------------------------------------------------------------------

describe('LegendsService.canAccess — per-project RBAC', () => {
  it('ADMIN → true for senior project', async () => {
    const { service } = buildService()
    expect(await service.canAccess(admin, seniorProject)).toBe(true)
  })

  it('ADMIN → true for drop project', async () => {
    const { service } = buildService()
    expect(await service.canAccess(admin, dropProject)).toBe(true)
  })

  it('viewer.id === seniorId → false (subject excluded)', async () => {
    const { service } = buildService()
    expect(await service.canAccess(senior, seniorProject)).toBe(false)
  })

  it('viewer.id === dropId → false (subject excluded)', async () => {
    const { service } = buildService()
    expect(await service.canAccess(drop, dropProject)).toBe(false)
  })

  it('ACCOUNTANT → false', async () => {
    const { service } = buildService()
    expect(await service.canAccess(accountant, seniorProject)).toBe(false)
  })

  it('other SENIOR → false', async () => {
    const { service } = buildService()
    expect(await service.canAccess(otherSenior, seniorProject)).toBe(false)
  })

  it('HR sharing active team with project.seniorId → true', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([{ teamId: 'team-1' }]) // HR teams
      .mockResolvedValueOnce([{ id: 'tm-1' }]) // seniorId in team
    expect(await service.canAccess(hr, seniorProject)).toBe(true)
  })

  it('HR with no shared team → false', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([{ teamId: 'team-1' }]) // HR teams
      .mockResolvedValueOnce([]) // seniorId NOT in team
    expect(await service.canAccess(hr, seniorProject)).toBe(false)
  })

  it('HR with no teams → false', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([]) // no HR teams
    expect(await service.canAccess(hr, seniorProject)).toBe(false)
  })

  it('JUNIOR active member of this project → true', async () => {
    const { service, chain } = buildService()
    // project_members query returns an active membership for this project
    chain.limit.mockResolvedValueOnce([{ id: 'pm-1' }])
    expect(await service.canAccess(junior, seniorProject)).toBe(true)
  })

  it('JUNIOR not a member → false', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([]) // no active membership
    expect(await service.canAccess(junior, seniorProject)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getLegend
// ---------------------------------------------------------------------------

describe('LegendsService.getLegend', () => {
  it('throws NotFoundException if project not found', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([]) // project not found
    await expect(service.getLegend(admin, PROJECT_ID)).rejects.toThrow(NotFoundException)
  })

  it('throws ForbiddenException if viewer has no access (ACCOUNTANT)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject]) // project found
    // canAccess(accountant, ...) returns false immediately (no DB calls)
    await expect(service.getLegend(accountant, PROJECT_ID)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException if seniorId is the viewer (subject excluded)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject])
    await expect(service.getLegend(senior, PROJECT_ID)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException if dropId is the viewer (subject excluded)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([dropProject])
    await expect(service.getLegend(drop, PROJECT_ID)).rejects.toThrow(ForbiddenException)
  })

  it('returns null if legend does not exist yet (accessible project, no legend created)', async () => {
    // AC1: missing legend → null (not NotFoundException); server contract change
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project found
      .mockResolvedValueOnce([]) // no legend row
    const result = await service.getLegend(admin, PROJECT_ID)
    expect(result).toBeNull()
  })

  it('returns parsed legend with entries for ADMIN', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project found
      .mockResolvedValueOnce([mockLegendRow]) // legend found
    // entries query terminates with orderBy — return mapped entry
    chain.orderBy.mockResolvedValueOnce([mockEntryDbRow])
    const result = await service.getLegend(admin, PROJECT_ID)
    expect(result.projectId).toBe(PROJECT_ID)
    expect(result.fullName).toBe('Іванов Іван')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.text).toBe('Entry text')
  })

  it('returns legend for JUNIOR who is active member', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project
      .mockResolvedValueOnce([{ id: 'pm-1' }]) // junior active member (canAccess)
      .mockResolvedValueOnce([mockLegendRow]) // legend
    chain.orderBy.mockResolvedValueOnce([])
    const result = await service.getLegend(junior, PROJECT_ID)
    expect(result.projectId).toBe(PROJECT_ID)
  })
})

// ---------------------------------------------------------------------------
// upsertLegend
// ---------------------------------------------------------------------------

describe('LegendsService.upsertLegend', () => {
  const dto = { fullName: 'Новий Іван' }

  it('throws ForbiddenException for subject (seniorId)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject])
    await expect(service.upsertLegend(senior, PROJECT_ID, dto)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException for subject (dropId)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([dropProject])
    await expect(service.upsertLegend(drop, PROJECT_ID, dto)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException for ACCOUNTANT', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject])
    await expect(service.upsertLegend(accountant, PROJECT_ID, dto)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws NotFoundException if project not found', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([]) // project not found
    await expect(service.upsertLegend(admin, PROJECT_ID, dto)).rejects.toThrow(NotFoundException)
  })

  it('ADMIN can create legend (first upsert)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject])
    chain.returning.mockResolvedValueOnce([mockLegendRow])
    chain.orderBy.mockResolvedValueOnce([])
    const result = await service.upsertLegend(admin, PROJECT_ID, dto)
    expect(result.projectId).toBe(PROJECT_ID)
  })

  it('ADMIN can update existing legend (second upsert same projectId)', async () => {
    const { service, chain } = buildService()
    const updated = { ...mockLegendRow, fullName: 'Новий Іван' }
    chain.limit.mockResolvedValueOnce([seniorProject])
    chain.returning.mockResolvedValueOnce([updated])
    chain.orderBy.mockResolvedValueOnce([])
    const result = await service.upsertLegend(admin, PROJECT_ID, dto)
    expect(result.fullName).toBe('Новий Іван')
  })

  it('HR with team access can upsert', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project
      .mockResolvedValueOnce([{ teamId: 'team-1' }]) // HR teams (canAccess)
      .mockResolvedValueOnce([{ id: 'tm-1' }]) // senior in team
    chain.returning.mockResolvedValueOnce([mockLegendRow])
    chain.orderBy.mockResolvedValueOnce([])
    const result = await service.upsertLegend(hr, PROJECT_ID, dto)
    expect(result.projectId).toBe(PROJECT_ID)
  })

  it('HR without team access CANNOT upsert', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject]).mockResolvedValueOnce([]) // no HR teams
    await expect(service.upsertLegend(hr, PROJECT_ID, dto)).rejects.toThrow(ForbiddenException)
  })
})

// ---------------------------------------------------------------------------
// addEntry
// ---------------------------------------------------------------------------

describe('LegendsService.addEntry', () => {
  const entryDto = { text: 'Нова запис про синьора' }

  it('throws ForbiddenException if no access (ACCOUNTANT)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject])
    await expect(service.addEntry(accountant, PROJECT_ID, entryDto)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws ForbiddenException for subject (seniorId)', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([seniorProject])
    await expect(service.addEntry(senior, PROJECT_ID, entryDto)).rejects.toThrow(ForbiddenException)
  })

  it('throws NotFoundException if project not found', async () => {
    const { service, chain } = buildService()
    chain.limit.mockResolvedValueOnce([])
    await expect(service.addEntry(admin, PROJECT_ID, entryDto)).rejects.toThrow(NotFoundException)
  })

  it('throws NotFoundException if legend does not exist yet', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project
      .mockResolvedValueOnce([]) // no legend
    await expect(service.addEntry(admin, PROJECT_ID, entryDto)).rejects.toThrow(NotFoundException)
  })

  it('ADMIN can add entry and gets back updated legend', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project
      .mockResolvedValueOnce([mockLegendRow]) // legend exists
    // insert returns via returning (but addEntry doesn't use it — uses loadEntries)
    chain.returning.mockResolvedValueOnce([])
    chain.orderBy.mockResolvedValueOnce([mockEntryDbRow])
    const result = await service.addEntry(admin, PROJECT_ID, entryDto)
    expect(result.projectId).toBe(PROJECT_ID)
    expect(result.entries).toHaveLength(1)
  })

  it('JUNIOR active member can add entry', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project
      .mockResolvedValueOnce([{ id: 'pm-1' }]) // junior member (canAccess)
      .mockResolvedValueOnce([mockLegendRow]) // legend exists
    chain.returning.mockResolvedValueOnce([])
    chain.orderBy.mockResolvedValueOnce([mockEntryDbRow])
    const result = await service.addEntry(junior, PROJECT_ID, entryDto)
    expect(result.projectId).toBe(PROJECT_ID)
  })
})

// ---------------------------------------------------------------------------
// TASK 7 — RBAC sweep: cross-project isolation + team isolation
// ---------------------------------------------------------------------------

describe('LegendsService — TASK 7: cross-project isolation + team isolation', () => {
  it('JUNIOR of project A → DENIED for project B (cross-project)', async () => {
    const { service, chain } = buildService()
    // project B belongs to a different senior
    const projectB = { id: PROJECT_ID_B, seniorId: OTHER_SENIOR_ID, dropId: null as string | null }
    chain.limit.mockResolvedValueOnce([projectB]) // project B found
    // Junior has no membership in project B
    chain.limit.mockResolvedValueOnce([]) // no active membership in project B
    await expect(service.getLegend(junior, PROJECT_ID_B)).rejects.toThrow(ForbiddenException)
  })

  it('HR of team X → DENIED for project whose senior is only in team Y', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // project found
      .mockResolvedValueOnce([{ teamId: 'team-X' }]) // HR teams = [X]
      .mockResolvedValueOnce([]) // seniorId NOT in team-X
    await expect(service.getLegend(hr, PROJECT_ID)).rejects.toThrow(ForbiddenException)
  })
})

// ---------------------------------------------------------------------------
// AC8 — canReceiveDefaults RBAC: ADMIN/HR yes; JUNIOR/SENIOR/ACCOUNTANT no
// ---------------------------------------------------------------------------

describe('LegendsService.canReceiveDefaults — defaults RBAC (AC8)', () => {
  it('ADMIN viewer → canReceiveDefaults = true', () => {
    const { service } = buildService()
    expect(
      (
        service as unknown as { canReceiveDefaults: (v: SessionUser) => boolean }
      ).canReceiveDefaults(admin),
    ).toBe(true)
  })

  it('HR viewer → canReceiveDefaults = true', () => {
    const { service } = buildService()
    expect(
      (
        service as unknown as { canReceiveDefaults: (v: SessionUser) => boolean }
      ).canReceiveDefaults(hr),
    ).toBe(true)
  })

  it('JUNIOR viewer → canReceiveDefaults = false (identity isolation)', () => {
    const { service } = buildService()
    expect(
      (
        service as unknown as { canReceiveDefaults: (v: SessionUser) => boolean }
      ).canReceiveDefaults(junior),
    ).toBe(false)
  })

  it('SENIOR viewer → canReceiveDefaults = false', () => {
    const { service } = buildService()
    expect(
      (
        service as unknown as { canReceiveDefaults: (v: SessionUser) => boolean }
      ).canReceiveDefaults(senior),
    ).toBe(false)
  })

  it('ACCOUNTANT viewer → canReceiveDefaults = false', () => {
    const { service } = buildService()
    expect(
      (
        service as unknown as { canReceiveDefaults: (v: SessionUser) => boolean }
      ).canReceiveDefaults(accountant),
    ).toBe(false)
  })

  it('getLegend for ADMIN includes defaults object (non-null)', async () => {
    const { service, chain } = buildService()
    // Simulate: project found → ADMIN has access (no membership query) →
    // legend exists → entries empty → loadDefaults returns subject data
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // loadProject
      .mockResolvedValueOnce([mockLegendRow]) // loadLegendRow
      .mockResolvedValueOnce([{ legalFullName: 'Справжнє ФІО', registrationAddress: 'Київ' }]) // loadDefaults
    chain.orderBy.mockResolvedValueOnce([]) // loadEntries

    const legend = await service.getLegend(admin, PROJECT_ID)
    expect(legend.defaults).not.toBeNull()
    expect(legend.defaults?.fullName).toBe('Справжнє ФІО')
    expect(legend.defaults?.address).toBe('Київ')
  })

  it('getLegend for JUNIOR returns defaults = null (no identity leak)', async () => {
    const { service, chain } = buildService()
    chain.limit
      .mockResolvedValueOnce([seniorProject]) // loadProject
      .mockResolvedValueOnce([{ id: 'pm-1' }]) // juniorCanAccess — active member
      .mockResolvedValueOnce([mockLegendRow]) // loadLegendRow
    chain.orderBy.mockResolvedValueOnce([]) // loadEntries — no loadDefaults call

    const legend = await service.getLegend(junior, PROJECT_ID)
    // defaults must be null — JUNIOR must never receive real identity data
    expect(legend.defaults).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC9 — eventDate sort: entries ordered by eventDate (fallback createdAt)
// ---------------------------------------------------------------------------

describe('LegendsService.loadEntries — eventDate sort (AC9)', () => {
  it('getLegend returns entries in ascending eventDate order when all have eventDate', async () => {
    const { service, chain } = buildService()

    const entryEarlier = {
      id: 'b0000001-0000-4000-a000-000000000001',
      legendId: LEGEND_ID,
      authorId: AUTHOR_ID,
      authorName: 'Author',
      text: 'Earlier event',
      eventDate: '2024-01-10',
      createdAt: new Date('2024-01-15T00:00:00Z'), // createdAt is LATER
    }
    const entryLater = {
      id: 'b0000001-0000-4000-a000-000000000002',
      legendId: LEGEND_ID,
      authorId: AUTHOR_ID,
      authorName: 'Author',
      text: 'Later event',
      eventDate: '2024-03-20',
      createdAt: new Date('2024-01-01T00:00:00Z'), // createdAt is EARLIER
    }

    chain.limit
      .mockResolvedValueOnce([seniorProject]) // loadProject
      .mockResolvedValueOnce([mockLegendRow]) // loadLegendRow
      .mockResolvedValueOnce([]) // loadDefaults (ADMIN)
    // loadEntries — DB returns entries sorted by COALESCE(eventDate, to_char(createdAt))
    chain.orderBy.mockResolvedValueOnce([entryEarlier, entryLater])

    const legend = await service.getLegend(admin, PROJECT_ID)
    expect(legend.entries).toHaveLength(2)
    expect(legend.entries[0].id).toBe('b0000001-0000-4000-a000-000000000001')
    expect(legend.entries[0].eventDate).toBe('2024-01-10')
    expect(legend.entries[1].id).toBe('b0000001-0000-4000-a000-000000000002')
    expect(legend.entries[1].eventDate).toBe('2024-03-20')
  })

  it('entry with null eventDate falls back to createdAt for display', async () => {
    const { service, chain } = buildService()

    const entryNoEventDate = {
      id: 'b0000001-0000-4000-a000-000000000003',
      legendId: LEGEND_ID,
      authorId: AUTHOR_ID,
      authorName: 'Author',
      text: 'No event date',
      eventDate: null as string | null,
      createdAt: new Date('2024-02-01T00:00:00Z'),
    }

    chain.limit
      .mockResolvedValueOnce([seniorProject]) // loadProject
      .mockResolvedValueOnce([mockLegendRow]) // loadLegendRow
      .mockResolvedValueOnce([]) // loadDefaults (ADMIN)
    chain.orderBy.mockResolvedValueOnce([entryNoEventDate])

    const legend = await service.getLegend(admin, PROJECT_ID)
    expect(legend.entries).toHaveLength(1)
    expect(legend.entries[0].eventDate).toBeNull()
    // createdAt is preserved as ISO string
    expect(legend.entries[0].createdAt).toBe('2024-02-01T00:00:00.000Z')
  })

  it('addEntry saves eventDate to the DB row', async () => {
    const { service, chain } = buildService()

    chain.limit
      .mockResolvedValueOnce([seniorProject]) // loadProject
      .mockResolvedValueOnce([{ id: 'pm-1' }]) // juniorCanAccess
      .mockResolvedValueOnce([mockLegendRow]) // loadLegendRow
    chain.returning.mockResolvedValueOnce([])
    chain.orderBy.mockResolvedValueOnce([
      {
        id: 'b0000001-0000-4000-a000-000000000004',
        legendId: LEGEND_ID,
        authorId: JUNIOR_ID,
        authorName: 'Junior',
        text: 'Event with specific date',
        eventDate: '2024-05-15',
        createdAt: new Date('2024-06-01T00:00:00Z'),
      },
    ])

    const legend = await service.addEntry(junior, PROJECT_ID, {
      text: 'Event with specific date',
      eventDate: '2024-05-15',
    })

    // Verify the insert was called (db.insert → chain.values was invoked)
    expect(chain.values).toHaveBeenCalled()
    // Result should include the entry with the eventDate
    expect(legend.entries[0].eventDate).toBe('2024-05-15')
  })
})
