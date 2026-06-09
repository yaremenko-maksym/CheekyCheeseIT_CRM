/**
 * Unit tests for LegendsService — RBAC visibility + edit logic
 *
 * Covers:
 *   - canViewLegend: all 5+1 roles × own/foreign legend combinations
 *   - getLegend: 400 if not SENIOR, 403 if not allowed, 404 if no legend
 *   - upsertLegend: 403 for non-ADMIN/non-self, creates then updates (unique userId)
 */
import { describe, it, expect, vi } from 'vitest'
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { LegendsService } from './legends.service'

// ---------------------------------------------------------------------------
// Minimal DatabaseService stub
// ---------------------------------------------------------------------------

const makeDbStub = () => {
  // We intercept the chained query builder calls on db.db
  const chainable = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
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
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001'
const HR_ID = 'a0000000-0000-4000-8000-000000000004'
const JUNIOR_ID = 'a0000000-0000-4000-8000-000000000003'
const ACCOUNTANT_ID = 'a0000000-0000-4000-8000-000000000005'
const OTHER_SENIOR_ID = 'a0000000-0000-4000-8000-000000000006'

const senior: SessionUser = { id: SENIOR_ID, role: 'SENIOR', email: 's@test.com', displayName: 'S' }
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
const mockUserJuniorRow = [{ id: JUNIOR_ID, role: 'JUNIOR' as const }]

// ---------------------------------------------------------------------------
// Helper: build service with controlled DB responses
// ---------------------------------------------------------------------------

function buildService(dbOverride?: ReturnType<typeof makeDbStub>) {
  const dbStub = dbOverride ?? makeDbStub()
  const service = new LegendsService(dbStub as never)
  return { service, db: dbStub }
}

// ---------------------------------------------------------------------------
// canViewLegend
// ---------------------------------------------------------------------------

describe('LegendsService.canViewLegend', () => {
  it('ADMIN can always view any legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(admin, SENIOR_ID)
    expect(result).toBe(true)
  })

  it('SENIOR can view their own legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(senior, SENIOR_ID)
    expect(result).toBe(true)
  })

  it("SENIOR cannot view another SENIOR's legend", async () => {
    const { service } = buildService()
    // hrCanViewSeniorLegend will be skipped (not HR), juniorCanView skipped (not JUNIOR)
    // other-senior hits the final `return false`
    const result = await service.canViewLegend(otherSenior, SENIOR_ID)
    expect(result).toBe(false)
  })

  it('ACCOUNTANT cannot view any legend', async () => {
    const { service } = buildService()
    const result = await service.canViewLegend(accountant, SENIOR_ID)
    expect(result).toBe(false)
  })

  it('HR CAN view legend when they share a team with the SENIOR', async () => {
    const { service, db } = buildService()
    // hrCanViewSeniorLegend: first query returns HR's team, second finds SENIOR in it
    const chainable = db.db._chainable
    let callIdx = 0
    chainable.limit.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        // HR teams query
        return Promise.resolve([{ teamId: 'team-1' }])
      }
      // SENIOR in team query
      return Promise.resolve([{ id: 'tm-1' }])
    })
    const result = await service.canViewLegend(hr, SENIOR_ID)
    expect(result).toBe(true)
  })

  it('HR CANNOT view legend when they share NO team with the SENIOR', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    let callIdx = 0
    chainable.limit.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return Promise.resolve([{ teamId: 'team-1' }])
      return Promise.resolve([]) // SENIOR not found in team
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

  it('JUNIOR CAN view legend when they are active member of senior project', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce([{ id: 'pm-1' }])
    const result = await service.canViewLegend(junior, SENIOR_ID)
    expect(result).toBe(true)
  })

  it('JUNIOR CANNOT view legend when they have no project with the SENIOR', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce([])
    const result = await service.canViewLegend(junior, SENIOR_ID)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getLegend
// ---------------------------------------------------------------------------

describe('LegendsService.getLegend', () => {
  it('throws BadRequestException if target is not SENIOR', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    // First query: target user — returns JUNIOR
    chainable.limit.mockResolvedValueOnce(mockUserJuniorRow)
    await expect(service.getLegend(admin, JUNIOR_ID)).rejects.toThrow(BadRequestException)
  })

  it('throws NotFoundException if target user not found', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce([]) // user not found
    await expect(service.getLegend(admin, 'nonexistent')).rejects.toThrow(NotFoundException)
  })

  it('throws ForbiddenException if ACCOUNTANT tries to read legend', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([]) // legend row — does not matter, forbidden first
    await expect(service.getLegend(accountant, SENIOR_ID)).rejects.toThrow(ForbiddenException)
  })

  it('throws NotFoundException if legend does not exist yet', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([]) // no legend row
    await expect(service.getLegend(admin, SENIOR_ID)).rejects.toThrow(NotFoundException)
  })

  it('returns parsed legend for ADMIN', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([mockLegendRow]) // legend found
    const result = await service.getLegend(admin, SENIOR_ID)
    expect(result.userId).toBe(SENIOR_ID)
    expect(result.fullName).toBe('Іванов Іван Іванович')
  })

  it('returns legend when SENIOR reads own', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow).mockResolvedValueOnce([mockLegendRow])
    const result = await service.getLegend(senior, SENIOR_ID)
    expect(result.userId).toBe(SENIOR_ID)
  })
})

// ---------------------------------------------------------------------------
// upsertLegend — edit permissions
// ---------------------------------------------------------------------------

describe('LegendsService.upsertLegend — edit permissions', () => {
  const dto = { fullName: 'Новий Іван Петрович' }

  it('throws ForbiddenException when HR tries to upsert', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
    await expect(service.upsertLegend(hr, SENIOR_ID, dto)).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException when JUNIOR tries to upsert', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserSeniorRow)
    await expect(service.upsertLegend(junior, SENIOR_ID, dto)).rejects.toThrow(ForbiddenException)
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

  it('throws BadRequestException when target is not SENIOR', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit.mockResolvedValueOnce(mockUserJuniorRow) // target is JUNIOR
    await expect(service.upsertLegend(admin, JUNIOR_ID, dto)).rejects.toThrow(BadRequestException)
  })

  it('ADMIN can upsert legend — creates new row', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([]) // no existing legend
    chainable.returning.mockResolvedValueOnce([mockLegendRow]) // insert result
    const result = await service.upsertLegend(admin, SENIOR_ID, dto)
    expect(result.userId).toBe(SENIOR_ID)
  })

  it('SENIOR can upsert own legend — updates existing row', async () => {
    const { service, db } = buildService()
    const chainable = db.db._chainable
    chainable.limit
      .mockResolvedValueOnce(mockUserSeniorRow) // target is SENIOR
      .mockResolvedValueOnce([{ id: 'b0000000-0000-4000-8000-000000000001' }]) // existing legend
    const updatedRow = { ...mockLegendRow, fullName: 'Новий Іван Петрович', updatedAt: new Date() }
    chainable.returning.mockResolvedValueOnce([updatedRow])
    const result = await service.upsertLegend(senior, SENIOR_ID, dto)
    expect(result.fullName).toBe('Новий Іван Петрович')
  })
})
