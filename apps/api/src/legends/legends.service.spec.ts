/**
 * Unit tests for LegendsService — RBAC visibility + edit logic
 *
 * NEW MODEL (2026-06-09 reversal):
 *   - Subject (SENIOR/DROP themselves) → EXCLUDED from view AND edit
 *   - ADMIN       → can view/edit any SENIOR or DROP legend
 *   - HR          → can view/edit if target is in HR's team
 *   - JUNIOR      → can view/edit if active project_member under target
 *   - ACCOUNTANT  → no access
 *   - view-access == edit-access (canViewLegend used for both)
 *   - getLegend: 400 if target is not SENIOR or DROP
 *   - upsertLegend: 403 for subject, 200 for ADMIN/HR/JUNIOR with access
 */
import { describe, it, expect, vi } from 'vitest'
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { LegendsService } from './legends.service'

// ---------------------------------------------------------------------------
// Minimal DatabaseService stub
// ---------------------------------------------------------------------------

const makeDbStub = () => {
  const chainable = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  }
  return {
    db: {
      select: vi.fn(() => chainable),
      insert: vi.fn(() => chainable),
      update: vi.fn(() => chainable),
      _chainable: chainable,
    },
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SENIOR_ID = 'a0000000-0000-4000-8000-000000000002'
const DROP_ID = 'a0000000-0000-4000-8000-000000000007'
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001'
const HR_ID = 'a0000000-0000-4000-8000-000000000004'
const JUNIOR_ID = 'a0000000-0000-4000-8000-000000000003'
const ACCOUNTANT_ID = 'a0000000-0000-4000-8000-000000000005'
const OTHER_SENIOR_ID = 'a0000000-0000-4000-8000-000000000006'

const senior: SessionUser = { id: SENIOR_ID, role: 'SENIOR', email: 's@test.com', displayName: 'S' }
const drop: SessionUser = { id: DROP_ID, role: 'DROP', email: 'd@test.com', displayName: 'D' }
const admin: SessionUser = { id: ADMIN_ID, role: 'ADMIN', email: 'a@test.com', displayName: 'A' }
const hr: SessionUser = { id: HR_ID, role: 'HR', email: 'h@test.com', displayName: 'H' }
const junior: SessionUser = { id: JUNIOR_ID, role: 'JUNIOR', email: 'j@test.com', displayName: 'J' }
const accountant: SessionUser = {
  id: ACCOUNTANT_ID,
  role: 'ACCOUNTANT',
  email: 'acc@test.com',
  displayName: 'Acc',
}
const otherSenior: SessionUser = {
  id: OTHER_SENIOR_ID,
  role: 'SENIOR',
  email: 'os@test.com',
  displayName: 'OS',
}

const mockLegendRow = {
  id: 'b0000000-0000-4000-8000-000000000001',
  userId: SENIOR_ID,
  fullName: 'Іванов Іван Іванович',
  dateOfBirth: '1990-01-15',
  address: 'Київ, Хрещатик 1',
  hobbies: 'Читання',
  notes: 'Досвідчений фахівець',
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
}

const mockUserSeniorRow = [{ id: SENIOR_ID, role: 'SENIOR' as const }]
const mockUserDropRow = [{ id: DROP_ID, role: 'DROP' as const }]
const mockUserJuniorRow = [{ id: JUNIOR_ID, role: 'JUNIOR' as const }]
const mockUserAccountantRow = [{ id: ACCOUNTANT_ID, role: 'ACCOUNTANT' as const }]

// ---------------------------------------------------------------------------
// Helper: build service with controlled DB responses
// ---------------------------------------------------------------------------

function buildService(dbOverride?: ReturnType<typeof makeDbStub>) {
  const dbStub = dbOverride ?? makeDbStub()
  const service = new LegendsService(dbStub as never)
  return { service, db: dbStub }
}

// ---------------------------------------------------------------------------
// canViewLegend — new model
// ---------------------------------------------------------------------------

describe('LegendsService.canViewLegend — new model (subject excluded, view==edit)', () => {
  // Subject excluded
  it('SENIOR cannot view their OWN legend (subject excluded)', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(senior, SENIOR_ID)
    expect(result).toBe(false)
  })

  it('DROP cannot view their OWN legend (subject excluded)', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(drop, DROP_ID)
    expect(result).toBe(false)
  })

  // ADMIN
  it('ADMIN can view any SENIOR legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(admin, SENIOR_ID)
    expect(result).toBe(true)
  })

  it('ADMIN can view any DROP legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(admin, DROP_ID)
    expect(result).toBe(true)
  })

  // ACCOUNTANT
  it('ACCOUNTANT cannot view any legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(accountant, SENIOR_ID)
    expect(result).toBe(false)
  })

  // Other SENIOR
  it('Other SENIOR cannot view SENIOR legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(otherSenior, SENIOR_ID)
    expect(result).toBe(false)
  })

  // HR with team relationship
  it('HR CAN view SENIOR legend when they share a team', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    let callIdx = 0
    chainable.limit.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return Promise.resolve([{ teamId: 'team-1' }]) // HR teams
      return Promise.resolve([{ id: 'tm-1' }]) // SENIOR in team
    })
    const result = await service.canViewLegend(hr, SENIOR_ID)
    expect(result).toBe(true)
  })

  it('HR CAN view DROP legend when they share a team', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    let callIdx = 0
    chainable.limit.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return Promise.resolve([{ teamId: 'drop-team-1' }])
      return Promise.resolve([{ id: 'tm-drop-1' }])
    })
    const result = await service.canViewLegend(hr, DROP_ID)
    expect(result).toBe(true)
  })

  it('HR CANNOT view legend when they share NO team with the target', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    let callIdx = 0
    chainable.limit.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return Promise.resolve([{ teamId: 'team-1' }])
      return Promise.resolve([]) // target not in team
    })
    const result = await service.canViewLegend(hr, SENIOR_ID)
    expect(result).toBe(false)
  })

  it('HR CANNOT view legend when HR has no teams', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce([]) // no HR teams
    const result = await service.canViewLegend(hr, SENIOR_ID)
    expect(result).toBe(false)
  })

  // JUNIOR with project relationship — spy on private method to avoid complex chainable mock
  it('JUNIOR CAN view SENIOR legend when active on a project with that senior', async () => {
    const { service } = buildService()
    // Spy on private method directly — avoids chained-query mock complexity
    const spy = vi
      .spyOn(service as unknown as Record<string, unknown>, 'juniorCanViewLegend' as never)
      .mockResolvedValue(true as never)
    const result = await service.canViewLegend(junior, SENIOR_ID)
    expect(result).toBe(true)
    expect(spy).toHaveBeenCalledWith(JUNIOR_ID, SENIOR_ID)
  })

  it('JUNIOR CAN view DROP legend when active on a project with that drop', async () => {
    const { service } = buildService()
    const spy = vi
      .spyOn(service as unknown as Record<string, unknown>, 'juniorCanViewLegend' as never)
      .mockResolvedValue(true as never)
    const result = await service.canViewLegend(junior, DROP_ID)
    expect(result).toBe(true)
    expect(spy).toHaveBeenCalledWith(JUNIOR_ID, DROP_ID)
  })

  it('JUNIOR CANNOT view legend when they have no active project memberships', async () => {
    const { service } = buildService()
    vi.spyOn(
      service as unknown as Record<string, unknown>,
      'juniorCanViewLegend' as never,
    ).mockResolvedValue(false as never)
    const result = await service.canViewLegend(junior, SENIOR_ID)
    expect(result).toBe(false)
  })

  it('JUNIOR CANNOT view legend when their projects have unrelated senior/drop', async () => {
    const { service } = buildService()
    vi.spyOn(
      service as unknown as Record<string, unknown>,
      'juniorCanViewLegend' as never,
    ).mockResolvedValue(false as never)
    const result = await service.canViewLegend(junior, SENIOR_ID)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getLegend — new model
// ---------------------------------------------------------------------------

describe('LegendsService.getLegend — new model', () => {
  it('throws BadRequestException if target is not SENIOR or DROP (e.g. JUNIOR)', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserJuniorRow)
    await expect(service.getLegend(admin, JUNIOR_ID)).rejects.toThrow(BadRequestException)
  })

  it('throws BadRequestException if target is ACCOUNTANT', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserAccountantRow)
    await expect(service.getLegend(admin, ACCOUNTANT_ID)).rejects.toThrow(BadRequestException)
  })

  it('throws NotFoundException if target user not found', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce([]) // user not found
    await expect(service.getLegend(admin, 'nonexistent')).rejects.toThrow(NotFoundException)
  })

  it('throws ForbiddenException if ACCOUNTANT tries to read SENIOR legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
    await expect(service.getLegend(accountant, SENIOR_ID)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException if SENIOR reads their OWN legend (subject excluded)', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
    await expect(service.getLegend(senior, SENIOR_ID)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException if DROP reads their OWN legend (subject excluded)', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserDropRow) // target is DROP
    await expect(service.getLegend(drop, DROP_ID)).rejects.toThrow(ForbiddenException)
  })

  it('throws NotFoundException if legend does not exist yet', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([]) // no legend row
    await expect(service.getLegend(admin, SENIOR_ID)).rejects.toThrow(NotFoundException)
  })

  it('returns parsed legend for ADMIN viewing SENIOR', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([mockLegendRow]) // legend found
    const result = await service.getLegend(admin, SENIOR_ID)
    expect(result.userId).toBe(SENIOR_ID)
    expect(result.fullName).toBe('Іванов Іван Іванович')
  })

  it('returns parsed legend for ADMIN viewing DROP', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    const dropLegendRow = { ...mockLegendRow, userId: DROP_ID }
    chainable.limit
      .mockResolvedValueOnce(mockUserDropRow) // target is DROP
      .mockResolvedValueOnce([dropLegendRow]) // legend found
    const result = await service.getLegend(admin, DROP_ID)
    expect(result.userId).toBe(DROP_ID)
  })
})

// ---------------------------------------------------------------------------
// upsertLegend — new model (view == edit, subject excluded)
// ---------------------------------------------------------------------------

describe('LegendsService.upsertLegend — new model (view==edit, subject excluded)', () => {
  const dto = { fullName: 'Новий Іван Петрович' }

  it('throws ForbiddenException when SENIOR tries to upsert their OWN legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    await expect(service.upsertLegend(senior, SENIOR_ID, dto)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException when DROP tries to upsert their OWN legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserDropRow)
    await expect(service.upsertLegend(drop, DROP_ID, dto)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException when ACCOUNTANT tries to upsert', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    await expect(service.upsertLegend(accountant, SENIOR_ID, dto)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws ForbiddenException when other SENIOR tries to upsert', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    await expect(service.upsertLegend(otherSenior, SENIOR_ID, dto)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws BadRequestException when target is not SENIOR or DROP', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserJuniorRow)
    await expect(service.upsertLegend(admin, JUNIOR_ID, dto)).rejects.toThrow(BadRequestException)
  })

  it('ADMIN can upsert SENIOR legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    chainable.returning.mockResolvedValueOnce([mockLegendRow])
    const result = await service.upsertLegend(admin, SENIOR_ID, dto)
    expect(result.userId).toBe(SENIOR_ID)
  })

  it('ADMIN can upsert DROP legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    const dropLegendRow = { ...mockLegendRow, userId: DROP_ID }
    chainable.limit.mockResolvedValueOnce(mockUserDropRow)
    chainable.returning.mockResolvedValueOnce([dropLegendRow])
    const result = await service.upsertLegend(admin, DROP_ID, dto)
    expect(result.userId).toBe(DROP_ID)
  })

  it('HR with team access CAN upsert SENIOR legend (view==edit)', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    // 1. target user check
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    // 2. canViewLegend → hrCanViewLegend: HR teams
    chainable.limit.mockResolvedValueOnce([{ teamId: 'team-1' }])
    // 3. target in team
    chainable.limit.mockResolvedValueOnce([{ id: 'tm-1' }])
    chainable.returning.mockResolvedValueOnce([mockLegendRow])
    const result = await service.upsertLegend(hr, SENIOR_ID, dto)
    expect(result.userId).toBe(SENIOR_ID)
  })

  it('HR without team access CANNOT upsert SENIOR legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    // HR has no teams
    chainable.limit.mockResolvedValueOnce([])
    await expect(service.upsertLegend(hr, SENIOR_ID, dto)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR with project access CAN upsert SENIOR legend (view==edit)', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    // 1. target user check
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    // 2. canViewLegend → spy on juniorCanViewLegend to return true
    vi.spyOn(
      service as unknown as Record<string, unknown>,
      'juniorCanViewLegend' as never,
    ).mockResolvedValue(true as never)
    chainable.returning.mockResolvedValueOnce([mockLegendRow])
    const result = await service.upsertLegend(junior, SENIOR_ID, dto)
    expect(result.userId).toBe(SENIOR_ID)
  })
})
