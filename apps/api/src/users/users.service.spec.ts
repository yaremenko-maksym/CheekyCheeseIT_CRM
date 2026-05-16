import { ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import { UsersService } from './users.service'

type DrizzleDb = { db: NodePgDatabase<typeof schema> }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'test@example.com',
  displayName: 'Test User',
  role: 'JUNIOR' as const,
  telegram: null,
  phone: null,
  avatar: null,
  googleId: null,
  techStack: null,
  monthlySalary: null,
  seniorSharePercent: 26,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const makeSenior = (overrides: Record<string, unknown> = {}) =>
  makeUser({ id: 'senior-1', email: 'senior@example.com', displayName: 'Senior Dev', role: 'SENIOR', ...overrides })

const makeJunior = (overrides: Record<string, unknown> = {}) =>
  makeUser({ id: 'junior-1', email: 'junior@example.com', displayName: 'Junior Dev', role: 'JUNIOR', ...overrides })

const makeHr = (overrides: Record<string, unknown> = {}) =>
  makeUser({ id: 'hr-1', email: 'hr@example.com', displayName: 'HR Person', role: 'HR', ...overrides })

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

interface MakeDbOptions {
  existingUser?: ReturnType<typeof makeUser> | undefined
  createdUser?: ReturnType<typeof makeUser>
  insertedTeam?: { id: string; name: string } | null
  updatedUser?: ReturnType<typeof makeUser>
  deletedRows?: ReturnType<typeof makeUser>[]
}

function makeDb({
  existingUser = undefined,
  createdUser = makeUser(),
  insertedTeam = { id: 'team-1', name: 'Команда Senior Dev' },
  updatedUser = makeUser(),
  deletedRows = [makeUser()],
}: MakeDbOptions = {}): DrizzleDb {
  // select chain: used by findByEmail / findById / findAll
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
  }

  // findByEmail (first call in createUser) returns existingUser;
  // findById (second+ calls) returns createdUser
  let selectCallCount = 0
  selectChain.where.mockImplementation(() => {
    selectCallCount++
    if (selectCallCount === 1) return Promise.resolve(existingUser ? [existingUser] : [])
    return Promise.resolve(createdUser ? [createdUser] : [])
  })

  // insert chain — handles users, teams, teamMembers, projectMembers
  const insertValuesChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  }
  insertValuesChain.returning
    // first insert = users table → return createdUser
    .mockResolvedValueOnce([createdUser])
    // second insert = teams table → return insertedTeam (may be null for non-senior)
    .mockResolvedValue(insertedTeam ? [insertedTeam] : [])

  const insertChain = {
    insert: vi.fn().mockReturnValue(insertValuesChain),
  }

  // update chain
  const updateChain = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedUser]),
        }),
      }),
    }),
  }

  // delete chain
  const deleteChain = {
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(deletedRows),
      }),
    }),
  }

  return {
    db: {
      ...selectChain,
      ...insertChain,
      ...updateChain,
      ...deleteChain,
    },
  } as unknown as DrizzleDb
}

// ---------------------------------------------------------------------------
// findByEmail / findById / findAll
// ---------------------------------------------------------------------------

describe('UsersService.findByEmail', () => {
  it('returns undefined when no rows', async () => {
    const db = makeDb({ existingUser: undefined })
    const service = new UsersService(db)
    expect(await service.findByEmail('nobody@example.com')).toBeUndefined()
  })

  it('returns first row when found', async () => {
    const user = makeHr()
    const db = makeDb({ existingUser: user })
    const service = new UsersService(db)
    expect(await service.findByEmail(user.email)).toEqual(user)
  })
})

describe('UsersService.findById', () => {
  it('returns undefined when no rows', async () => {
    const db = makeDb({ existingUser: undefined })
    const service = new UsersService(db)
    expect(await service.findById('non-existent')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createUser — base cases
// ---------------------------------------------------------------------------

describe('UsersService.createUser — JUNIOR', () => {
  it('creates a JUNIOR user without a project', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
    })

    expect(result.role).toBe('JUNIOR')
    expect(result.email).toBe(junior.email)
    // No project insert should happen (projectId not provided)
    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    // Only one insert call: users table
    expect(insertMock).toHaveBeenCalledTimes(1)
  })

  it('creates a JUNIOR user and assigns them to a project when projectId provided', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = new UsersService(db)

    await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      projectId: 'proj-1',
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    // insert called twice: users + projectMembers
    expect(insertMock).toHaveBeenCalledTimes(2)
  })

  it('creates a JUNIOR with null projectId — no project assignment', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = new UsersService(db)

    await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      projectId: null,
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    // Only one insert: users table (projectId null → no project assignment)
    expect(insertMock).toHaveBeenCalledTimes(1)
  })

  it('stores telegram and phone when provided', async () => {
    const junior = makeJunior({ telegram: '@myhandle', phone: '+380991234567' })
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      telegram: '@myhandle',
      phone: '+380991234567',
    })

    expect(result.telegram).toBe('@myhandle')
    expect(result.phone).toBe('+380991234567')
  })

  it('throws ConflictException when email already exists', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: junior })
    const service = new UsersService(db)

    await expect(
      service.createUser({ email: junior.email, displayName: 'Dup', role: 'JUNIOR' }),
    ).rejects.toThrow(ConflictException)
  })

  it('does not insert anything after ConflictException', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: junior })
    const service = new UsersService(db)

    await service.createUser({ email: junior.email, displayName: 'Dup', role: 'JUNIOR' }).catch(() => {})

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    expect(insertMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createUser — SENIOR auto-creates team
// ---------------------------------------------------------------------------

describe('UsersService.createUser — SENIOR', () => {
  it('creates a SENIOR and auto-creates a team with the senior as sole member', async () => {
    const senior = makeSenior()
    const db = makeDb({ existingUser: undefined, createdUser: senior })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: senior.email,
      displayName: senior.displayName,
      role: 'SENIOR',
    })

    expect(result.role).toBe('SENIOR')
    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    // insert: users + teams + teamMembers(senior only)
    expect(insertMock).toHaveBeenCalledTimes(3)
  })

  it('creates a SENIOR team with HR and accountant members', async () => {
    const senior = makeSenior()
    const db = makeDb({ existingUser: undefined, createdUser: senior })
    const service = new UsersService(db)

    await service.createUser({
      email: senior.email,
      displayName: senior.displayName,
      role: 'SENIOR',
      hrIds: ['hr-1', 'hr-2'],
      accountantId: 'acc-1',
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    // insert: users + teams + teamMembers(senior) + teamMembers(hr-1) + teamMembers(hr-2) + teamMembers(acc-1) = 6
    expect(insertMock).toHaveBeenCalledTimes(6)
  })

  it('creates a SENIOR team with HR only (no accountant)', async () => {
    const senior = makeSenior()
    const db = makeDb({ existingUser: undefined, createdUser: senior })
    const service = new UsersService(db)

    await service.createUser({
      email: senior.email,
      displayName: senior.displayName,
      role: 'SENIOR',
      hrIds: ['hr-1'],
      accountantId: null,
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    // insert: users + teams + teamMembers(senior) + teamMembers(hr-1) = 4
    expect(insertMock).toHaveBeenCalledTimes(4)
  })

  it('auto-names the team after the senior displayName', async () => {
    const senior = makeSenior({ displayName: 'Ivan Drago' })
    const db = makeDb({ existingUser: undefined, createdUser: senior })
    const service = new UsersService(db)

    await service.createUser({
      email: senior.email,
      displayName: 'Ivan Drago',
      role: 'SENIOR',
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    const insertValuesMock = insertMock.mock.results[1]?.value as { values: ReturnType<typeof vi.fn> }
    // Second insert call is for the teams table — check the team name
    expect(insertValuesMock?.values).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Команда Ivan Drago' }),
    )
  })

  it('throws ConflictException for duplicate SENIOR email', async () => {
    const senior = makeSenior()
    const db = makeDb({ existingUser: senior })
    const service = new UsersService(db)

    await expect(
      service.createUser({ email: senior.email, displayName: 'Dup', role: 'SENIOR' }),
    ).rejects.toThrow(ConflictException)
  })
})

// ---------------------------------------------------------------------------
// createUser — other roles (HR, ACCOUNTANT)
// ---------------------------------------------------------------------------

describe('UsersService.createUser — HR / ACCOUNTANT', () => {
  it.each(['HR', 'ACCOUNTANT'] as const)(
    'creates a %s user with only a users insert (no team, no project)',
    async (role) => {
      const user = makeUser({ role, email: `${role.toLowerCase()}@example.com` })
      const db = makeDb({ existingUser: undefined, createdUser: user })
      const service = new UsersService(db)

      const result = await service.createUser({
        email: user.email,
        displayName: user.displayName,
        role,
      })

      expect(result.role).toBe(role)
      const insertMock = db.db.insert as ReturnType<typeof vi.fn>
      expect(insertMock).toHaveBeenCalledTimes(1)
    },
  )
})

// ---------------------------------------------------------------------------
// createUser — new profile fields (techStack, seniorSharePercent, monthlySalary)
// ---------------------------------------------------------------------------

describe('UsersService.createUser — profile fields', () => {
  it('stores techStack when provided for any role', async () => {
    const junior = makeJunior({ techStack: 'JavaScript FE' })
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      techStack: 'JavaScript FE',
    })

    expect(result.techStack).toBe('JavaScript FE')
  })

  it('stores custom seniorSharePercent for SENIOR', async () => {
    const senior = makeSenior({ seniorSharePercent: 60 })
    const db = makeDb({ existingUser: undefined, createdUser: senior })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: senior.email,
      displayName: senior.displayName,
      role: 'SENIOR',
      seniorSharePercent: 60,
    })

    expect(result.seniorSharePercent).toBe(60)
  })

  it('uses default 26% when no seniorSharePercent provided for SENIOR', async () => {
    const senior = makeSenior({ seniorSharePercent: 26 })
    const db = makeDb({ existingUser: undefined, createdUser: senior })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: senior.email,
      displayName: senior.displayName,
      role: 'SENIOR',
    })

    expect(result.seniorSharePercent).toBe(26)
  })

  it('stores monthlySalary for non-SENIOR roles', async () => {
    const hr = makeHr({ monthlySalary: '1500.00' })
    const db = makeDb({ existingUser: undefined, createdUser: hr })
    const service = new UsersService(db)

    const result = await service.createUser({
      email: hr.email,
      displayName: hr.displayName,
      role: 'HR',
      monthlySalary: 1500,
    })

    expect(result.monthlySalary).toBe('1500.00')
  })
})

// ---------------------------------------------------------------------------
// adminUpdateUser
// ---------------------------------------------------------------------------

describe('UsersService.adminUpdateUser', () => {
  it('updates displayName', async () => {
    const updated = makeUser({ displayName: 'New Name' })
    const db = makeDb({ updatedUser: updated })
    const service = new UsersService(db)

    const result = await service.adminUpdateUser('user-1', { displayName: 'New Name' })
    expect(result.displayName).toBe('New Name')
  })

  it('updates techStack', async () => {
    const updated = makeUser({ techStack: 'Kotlin' })
    const db = makeDb({ updatedUser: updated })
    const service = new UsersService(db)
    const result = await service.adminUpdateUser('user-1', { techStack: 'Kotlin' })
    expect(result.techStack).toBe('Kotlin')
  })

  it('clears techStack when set to null', async () => {
    const updated = makeUser({ techStack: null })
    const db = makeDb({ updatedUser: updated })
    const service = new UsersService(db)
    const result = await service.adminUpdateUser('user-1', { techStack: null })
    expect(result.techStack).toBeNull()
  })

  it('updates seniorSharePercent for SENIOR', async () => {
    const updated = makeSenior({ seniorSharePercent: 80 })
    const db = makeDb({ updatedUser: updated })
    const service = new UsersService(db)
    const result = await service.adminUpdateUser('senior-1', { seniorSharePercent: 80 })
    expect(result.seniorSharePercent).toBe(80)
  })

  it('updates monthlySalary for non-SENIOR', async () => {
    const updated = makeHr({ monthlySalary: '2000.00' })
    const db = makeDb({ updatedUser: updated })
    const service = new UsersService(db)
    const result = await service.adminUpdateUser('hr-1', { monthlySalary: 2000 })
    expect(result.monthlySalary).toBe('2000.00')
  })

  it('throws NotFoundException when user not found', async () => {
    const db = makeDb({ updatedUser: undefined as unknown as ReturnType<typeof makeUser> })
    // Force the update chain to return empty
    ;(db.db.update as ReturnType<typeof vi.fn>).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    })
    const service = new UsersService(db)
    await expect(service.adminUpdateUser('ghost', { displayName: 'X' })).rejects.toThrow(NotFoundException)
  })
})

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------

// Helper: builds a minimal db for deleteUser tests.
// `selectResults` is consumed in order — each .where() call pops the next value.
function makeDeleteDb({
  selectResults = [] as unknown[][],
  deleteReturning = [] as unknown[],
} = {}) {
  let callIdx = 0
  const whereFn = vi.fn().mockImplementation(() => Promise.resolve(selectResults[callIdx++] ?? []))

  const deleteMock = vi.fn()
  const deleteWhereMock = vi.fn().mockResolvedValue(deleteReturning)
  deleteMock.mockReturnValue({ where: deleteWhereMock })

  return {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: whereFn,
      insert: vi.fn(),
      update: vi.fn(),
      delete: deleteMock,
      _deleteMock: deleteMock,
      _deleteWhereMock: deleteWhereMock,
    },
  } as unknown as DrizzleDb & { db: { _deleteMock: ReturnType<typeof vi.fn>; _deleteWhereMock: ReturnType<typeof vi.fn> } }
}

describe('UsersService.deleteUser', () => {
  it('resolves when non-senior user exists', async () => {
    const hr = makeHr()
    const db = makeDeleteDb({ selectResults: [[hr]] })
    const service = new UsersService(db)
    await expect(service.deleteUser(hr.id)).resolves.toBeUndefined()
  })

  it('throws NotFoundException when user not found', async () => {
    const db = makeDeleteDb({ selectResults: [[]] })
    const service = new UsersService(db)
    await expect(service.deleteUser('ghost')).rejects.toThrow(NotFoundException)
  })

  it('does not delete team when deleting a non-senior user', async () => {
    const hr = makeHr()
    const db = makeDeleteDb({ selectResults: [[hr]] })
    const service = new UsersService(db)
    await service.deleteUser(hr.id)
    // delete called once: the user row
    expect(db.db._deleteMock).toHaveBeenCalledTimes(1)
  })

  it('deletes the senior\'s team when deleting a SENIOR user', async () => {
    const senior = makeSenior()
    const membership = { id: 'tm-1', teamId: 'team-1', userId: senior.id, joinedAt: new Date() }
    // selectResults: [findById → senior], [teamMembers query → membership]
    const db = makeDeleteDb({ selectResults: [[senior], [membership]] })
    const service = new UsersService(db)
    await service.deleteUser(senior.id)
    // delete called twice: teams (senior's team) + users (senior)
    expect(db.db._deleteMock).toHaveBeenCalledTimes(2)
  })

  it('still deletes senior user even if they have no team membership', async () => {
    const senior = makeSenior()
    // teamMembers query returns empty — senior has no team row
    const db = makeDeleteDb({ selectResults: [[senior], []] })
    const service = new UsersService(db)
    await service.deleteUser(senior.id)
    // delete called once: only the user (no team to delete)
    expect(db.db._deleteMock).toHaveBeenCalledTimes(1)
  })

  it('deletes team before user so FK cascade can remove projects', async () => {
    const senior = makeSenior()
    const membership = { id: 'tm-1', teamId: 'team-42', userId: senior.id, joinedAt: new Date() }
    const db = makeDeleteDb({ selectResults: [[senior], [membership]] })
    const service = new UsersService(db)
    await service.deleteUser(senior.id)
    const calls = db.db._deleteMock.mock.calls
    // First delete arg should reference teams, second should reference users
    const firstTableName = calls[0]?.[0]?.[Symbol.for('drizzle:Name')] ?? calls[0]?.[0]?._.name ?? String(calls[0]?.[0])
    const secondTableName = calls[1]?.[0]?.[Symbol.for('drizzle:Name')] ?? calls[1]?.[0]?._.name ?? String(calls[1]?.[0])
    expect(firstTableName).toMatch(/team/)
    expect(secondTableName).toMatch(/user/)
  })
})

// ---------------------------------------------------------------------------
// getProfile
// ---------------------------------------------------------------------------

describe('UsersService.getProfile', () => {
  it('returns the user when found', async () => {
    const user = makeHr()
    // Make selectChain return user on the second call (findById uses same chain)
    const db = {
      db: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([user]),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as DrizzleDb
    const service = new UsersService(db)
    const result = await service.getProfile(user.id)
    expect(result).toEqual(user)
  })

  it('throws NotFoundException when user not found', async () => {
    const db = {
      db: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as DrizzleDb
    const service = new UsersService(db)
    await expect(service.getProfile('ghost')).rejects.toThrow(NotFoundException)
  })
})
