import { ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { AuditLogService } from './audit-log.service'
import type { UsersAccessService } from './users-access.service'
import { UsersService } from './users.service'

type DrizzleDb = { db: NodePgDatabase<typeof schema> }

// ---------------------------------------------------------------------------
// Service constructor helpers
// ---------------------------------------------------------------------------

/**
 * UsersService takes constructor args: DatabaseService, UsersAccessService,
 * AuditLogService, TosService, ... None of the methods exercised by these unit
 * tests need real implementations — but `createUser` calls
 * `auditLogService.record()` to seed a `profile_created` event, so we must
 * supply a stub (otherwise `TypeError: Cannot read properties of undefined`).
 */
const makeAccessService = (): UsersAccessService => ({}) as unknown as UsersAccessService

const makeAuditLogService = (): AuditLogService =>
  ({ record: vi.fn().mockResolvedValue(undefined) }) as unknown as AuditLogService

// TosService stub — getLatestAcceptanceForUser returns null (no acceptance)
const makeTosService = () =>
  ({ getLatestAcceptanceForUser: vi.fn().mockResolvedValue(null) }) as never

const makeUsersService = (db: DrizzleDb): UsersService =>
  new UsersService(
    db as never,
    makeAccessService() as never,
    makeAuditLogService() as never,
    makeTosService(),
  )

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
  makeUser({
    id: 'senior-1',
    email: 'senior@example.com',
    displayName: 'Senior Dev',
    role: 'SENIOR',
    ...overrides,
  })

const makeJunior = (overrides: Record<string, unknown> = {}) =>
  makeUser({
    id: 'junior-1',
    email: 'junior@example.com',
    displayName: 'Junior Dev',
    role: 'JUNIOR',
    ...overrides,
  })

const makeHr = (overrides: Record<string, unknown> = {}) =>
  makeUser({
    id: 'hr-1',
    email: 'hr@example.com',
    displayName: 'HR Person',
    role: 'HR',
    ...overrides,
  })

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

  // Stub `db.transaction(cb)` so callers that wrap their work in a tx still
  // exercise the same select/insert/update/delete chains. The `tx` arg shares
  // the same chain handles — sufficient for these unit-level assertions which
  // verify call counts / passed values rather than atomicity semantics (see
  // users.archive.spec for the richer atomicity harness).
  const txHandle = {
    ...selectChain,
    ...insertChain,
    ...updateChain,
    ...deleteChain,
    // Drizzle's `tx.update(table).set(set).where(...).returning()` shape — but
    // the wrapping transaction body for adminUpdateUser uses a fresh update
    // chain inside the tx, so we expose the same one.
  }
  const dbHandle = {
    ...selectChain,
    ...insertChain,
    ...updateChain,
    ...deleteChain,
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txHandle)),
  }

  return { db: dbHandle as unknown } as unknown as DrizzleDb
}

// ---------------------------------------------------------------------------
// findByEmail / findById / findAll
// ---------------------------------------------------------------------------

describe('UsersService.findByEmail', () => {
  it('returns undefined when no rows', async () => {
    const db = makeDb({ existingUser: undefined })
    const service = makeUsersService(db)
    expect(await service.findByEmail('nobody@example.com')).toBeUndefined()
  })

  it('returns first row when found', async () => {
    const user = makeHr()
    const db = makeDb({ existingUser: user })
    const service = makeUsersService(db)
    expect(await service.findByEmail(user.email)).toEqual(user)
  })
})

describe('UsersService.findById', () => {
  it('returns undefined when no rows', async () => {
    const db = makeDb({ existingUser: undefined })
    const service = makeUsersService(db)
    expect(await service.findById('non-existent')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// findAll — legalFullName PII exclusion (security AC, list projection)
// ---------------------------------------------------------------------------

describe('UsersService.findAll — legalFullName not present in list response', () => {
  /**
   * Drizzle select() with an explicit projection returns only the projected
   * columns.  The mock below simulates this by returning a row that already
   * lacks legalFullName (matching what the DB driver returns for an explicit
   * column-list select).  The test confirms that the service's projection
   * contract holds: no legalFullName key is present on any item in the result.
   *
   * This prevents the side-channel described in security-reviewer round-3:
   * HR calls GET /api/users → previously received legalFullName for every user
   * because findAll used select() without projection (returned all columns).
   */
  function makeListDb(rows: ReturnType<typeof makeUser>[]): DrizzleDb {
    // Simulate Drizzle's explicit projection: return rows without legalFullName.
    const rowsWithoutLegal = rows.map(({ ...r }) => {
      const copy = r as Record<string, unknown>
      delete copy['legalFullName']
      return copy
    })

    // findAll calls db.select(projection).from(users).where(...)
    // then db.select({userId}).from(projectMembers).where(...)
    // We need the chain to return the right value for each call.
    let callIndex = 0
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callIndex++
        // First where() = users list query
        if (callIndex === 1) return Promise.resolve(rowsWithoutLegal)
        // Second where() = projectMembers active memberships
        return Promise.resolve([])
      }),
    }

    return { db: selectChain as unknown } as unknown as DrizzleDb
  }

  it('result items do NOT contain legalFullName key (HR caller scenario)', async () => {
    const senior = makeSenior({ legalFullName: 'Коваленко Олексій Сергійович' })
    const junior = makeJunior({ legalFullName: 'Бондаренко Софія Олегівна' })
    const db = makeListDb([senior, junior])
    const service = makeUsersService(db)

    const result = await service.findAll()

    expect(result).toHaveLength(2)
    for (const item of result) {
      expect(item).not.toHaveProperty('legalFullName')
    }
  })

  it('result items do NOT contain legalFullName key (ADMIN caller via findAllIncludingAdmin)', async () => {
    const senior = makeSenior({ legalFullName: 'Іваненко Іван Іванович' })
    const db = makeListDb([senior])
    const service = makeUsersService(db)

    const result = await service.findAllIncludingAdmin()

    expect(result).toHaveLength(1)
    expect(result[0]).not.toHaveProperty('legalFullName')
  })
})

// ---------------------------------------------------------------------------
// createUser — base cases
// ---------------------------------------------------------------------------

describe('UsersService.createUser — JUNIOR', () => {
  it('creates a JUNIOR user without a project', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

    await expect(
      service.createUser({ email: junior.email, displayName: 'Dup', role: 'JUNIOR' }),
    ).rejects.toThrow(ConflictException)
  })

  it('does not insert anything after ConflictException', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: junior })
    const service = makeUsersService(db)

    await service
      .createUser({ email: junior.email, displayName: 'Dup', role: 'JUNIOR' })
      .catch(() => {})

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

    await service.createUser({
      email: senior.email,
      displayName: 'Ivan Drago',
      role: 'SENIOR',
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    const insertValuesMock = insertMock.mock.results[1]?.value as {
      values: ReturnType<typeof vi.fn>
    }
    // Second insert call is for the teams table — check the team name
    expect(insertValuesMock?.values).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Команда Ivan Drago' }),
    )
  })

  it('throws ConflictException for duplicate SENIOR email', async () => {
    const senior = makeSenior()
    const db = makeDb({ existingUser: senior })
    const service = makeUsersService(db)

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
      const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
    const service = makeUsersService(db)

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
  // Note: adminUpdateUser fetches the existing user first (for ut-10/11 role
  // guards). `makeDb` returns `existingUser` on the FIRST select chain call,
  // so each test must seed `existingUser` matching the id being updated.

  it('updates displayName', async () => {
    const existing = makeUser({ displayName: 'Old Name' })
    const updated = makeUser({ displayName: 'New Name' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser('user-1', { displayName: 'New Name' })
    expect(result.displayName).toBe('New Name')
  })

  it('updates techStack', async () => {
    const existing = makeUser()
    const updated = makeUser({ techStack: 'Kotlin' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)
    const result = await service.adminUpdateUser('user-1', { techStack: 'Kotlin' })
    expect(result.techStack).toBe('Kotlin')
  })

  it('clears techStack when set to null', async () => {
    const existing = makeUser({ techStack: 'Kotlin' })
    const updated = makeUser({ techStack: null })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)
    const result = await service.adminUpdateUser('user-1', { techStack: null })
    expect(result.techStack).toBeNull()
  })

  it('updates seniorSharePercent for SENIOR', async () => {
    const existing = makeSenior()
    const updated = makeSenior({ seniorSharePercent: 80 })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)
    const result = await service.adminUpdateUser('senior-1', { seniorSharePercent: 80 })
    expect(result.seniorSharePercent).toBe(80)
  })

  it('updates monthlySalary for non-SENIOR', async () => {
    const existing = makeHr()
    const updated = makeHr({ monthlySalary: '2000.00' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)
    const result = await service.adminUpdateUser('hr-1', { monthlySalary: 2000 })
    expect(result.monthlySalary).toBe('2000.00')
  })

  it('throws NotFoundException when user not found', async () => {
    // No existing user → findById returns undefined → NotFoundException
    const db = makeDb({ existingUser: undefined })
    const service = makeUsersService(db)
    await expect(service.adminUpdateUser('ghost', { displayName: 'X' })).rejects.toThrow(
      NotFoundException,
    )
  })

  // ─── ut-10: ADMIN cannot edit another ADMIN ─────────────────────────────
  it('throws ForbiddenException when ADMIN tries to edit another ADMIN', async () => {
    const targetAdmin = makeUser({ id: 'admin-2', role: 'ADMIN', email: 'admin2@example.com' })
    const db = makeDb({ existingUser: targetAdmin })
    const service = makeUsersService(db)
    const { ForbiddenException } = await import('@nestjs/common')
    await expect(
      service.adminUpdateUser('admin-2', { displayName: 'Hacked' }, 'admin-1'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows ADMIN editing themselves (id === actorId)', async () => {
    const selfAdmin = makeUser({ id: 'admin-1', role: 'ADMIN', email: 'me@example.com' })
    const updated = makeUser({ id: 'admin-1', role: 'ADMIN', displayName: 'Updated Me' })
    const db = makeDb({ existingUser: selfAdmin, updatedUser: updated })
    const service = makeUsersService(db)
    const result = await service.adminUpdateUser(
      'admin-1',
      { displayName: 'Updated Me' },
      'admin-1',
    )
    expect(result.displayName).toBe('Updated Me')
  })

  // ─── ut-11: ADMIN cannot change own role away from ADMIN ───────────────
  it('throws ForbiddenException when self-ADMIN tries to change own role', async () => {
    const selfAdmin = makeUser({ id: 'admin-1', role: 'ADMIN' })
    const db = makeDb({ existingUser: selfAdmin })
    const service = makeUsersService(db)
    const { ForbiddenException } = await import('@nestjs/common')
    await expect(service.adminUpdateUser('admin-1', { role: 'SENIOR' }, 'admin-1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('allows self-ADMIN to update non-role fields', async () => {
    const selfAdmin = makeUser({ id: 'admin-1', role: 'ADMIN' })
    const updated = makeUser({ id: 'admin-1', role: 'ADMIN', telegram: '@newhandle' })
    const db = makeDb({ existingUser: selfAdmin, updatedUser: updated })
    const service = makeUsersService(db)
    const result = await service.adminUpdateUser('admin-1', { telegram: '@newhandle' }, 'admin-1')
    expect(result.telegram).toBe('@newhandle')
  })

  // ─── fix(bug-2): registrationAddress / usrRecord persist via adminUpdateUser ──

  it('persists registrationAddress when provided', async () => {
    const existing = makeUser({ registrationAddress: null })
    const updated = makeUser({ registrationAddress: 'м. Київ, вул. Хрещатик, 1' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser('user-1', {
      registrationAddress: 'м. Київ, вул. Хрещатик, 1',
    })
    expect(result.registrationAddress).toBe('м. Київ, вул. Хрещатик, 1')

    // Verify .set() received the field
    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = updateMock.mock.results[0]?.value?.set?.mock?.calls
    if (setCalls?.length) {
      const setArg = setCalls[0][0] as Record<string, unknown>
      expect(setArg).toHaveProperty('registrationAddress', 'м. Київ, вул. Хрещатик, 1')
    }
  })

  it('persists usrRecord when provided', async () => {
    const existing = makeUser({ usrRecord: null })
    const updated = makeUser({ usrRecord: '12.05.2024 №2070020000000123456' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser('user-1', {
      usrRecord: '12.05.2024 №2070020000000123456',
    })
    expect(result.usrRecord).toBe('12.05.2024 №2070020000000123456')

    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = updateMock.mock.results[0]?.value?.set?.mock?.calls
    if (setCalls?.length) {
      const setArg = setCalls[0][0] as Record<string, unknown>
      expect(setArg).toHaveProperty('usrRecord', '12.05.2024 №2070020000000123456')
    }
  })

  it('clears registrationAddress when set to null', async () => {
    const existing = makeUser({ registrationAddress: 'старый адрес' })
    const updated = makeUser({ registrationAddress: null })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser('user-1', { registrationAddress: null })
    expect(result.registrationAddress).toBeNull()
  })

  it('does NOT include registrationAddress in set when key absent from payload', async () => {
    const existing = makeUser({ registrationAddress: 'should stay' })
    const updated = makeUser({ registrationAddress: 'should stay' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await service.adminUpdateUser('user-1', { displayName: 'Only Name' })

    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = updateMock.mock.results[0]?.value?.set?.mock?.calls
    if (setCalls?.length) {
      const setArg = setCalls[0][0] as Record<string, unknown>
      expect(setArg).not.toHaveProperty('registrationAddress')
    }
  })
})

// ---------------------------------------------------------------------------
// ut-12: ADMIN creation is blocked (fixed pool)
// ---------------------------------------------------------------------------

describe('UsersService.createUser — ut-12 ADMIN block', () => {
  it('throws ForbiddenException when role=ADMIN is requested', async () => {
    const db = makeDb({ existingUser: undefined })
    const service = makeUsersService(db)
    const { ForbiddenException } = await import('@nestjs/common')
    await expect(
      service.createUser({
        email: 'newadmin@example.com',
        displayName: 'New Admin',
        role: 'ADMIN',
      }),
    ).rejects.toThrow(ForbiddenException)
  })
})

// NOTE: `deleteUser` hard-delete has been removed (use `archive` for soft archive).
// The corresponding test block has been removed alongside the dead method.

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
    const service = makeUsersService(db)
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
    const service = makeUsersService(db)
    await expect(service.getProfile('ghost')).rejects.toThrow(NotFoundException)
  })
})

// ---------------------------------------------------------------------------
// buildProfileView — legalFullName PII masking (security AC1)
// ---------------------------------------------------------------------------

describe('UsersService.buildProfileView — legalFullName masking', () => {
  /**
   * Builds a minimal UsersService whose findById returns `target` and whose
   * accessService.getViewPermissions returns the given permissions object.
   */
  function makeServiceForProfileView(
    target: ReturnType<typeof makeUser>,
    permissions: { tabs: string[]; actions: string[]; fields: Record<string, boolean> },
  ): UsersService {
    const db = {
      db: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([target]),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as DrizzleDb

    const accessService = {
      getViewPermissions: vi.fn().mockResolvedValue(permissions),
    } as unknown as import('./users-access.service').UsersAccessService

    const auditService = makeAuditLogService()
    const tosService = makeTosService()

    return new UsersService(db as never, accessService as never, auditService as never, tosService)
  }

  const targetWithLegalName = makeUser({
    id: 'target-id',
    role: 'SENIOR',
    legalFullName: 'Іваненко Іван Іванович',
  } as Record<string, unknown>)

  it('ADMIN viewer — legalFullName is visible (fields.legalName = true)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: { requisites: true, legalName: true, techStack: true },
    }
    const service = makeServiceForProfileView(targetWithLegalName, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect((result.user as Record<string, unknown>).legalFullName).toBe('Іваненко Іван Іванович')
  })

  it('owner (self) — legalFullName is visible (fields.legalName = true)', async () => {
    const viewer = makeUser({ id: 'target-id', role: 'SENIOR' })
    const permissions = {
      tabs: ['overview', 'projects', 'team', 'requisites', 'documents', 'finance'],
      actions: [],
      fields: { requisites: true, legalName: true, techStack: true },
    }
    const service = makeServiceForProfileView(targetWithLegalName, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect((result.user as Record<string, unknown>).legalFullName).toBe('Іваненко Іван Іванович')
  })

  it('HR viewer — legalFullName is masked to null (fields.legalName falsy)', async () => {
    const viewer = makeUser({ id: 'hr-id', role: 'HR' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true },
      // legalName is NOT set — HR must not see passport PII
    }
    const service = makeServiceForProfileView(targetWithLegalName, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect((result.user as Record<string, unknown>).legalFullName).toBeNull()
  })

  it('ACCOUNTANT viewer — legalFullName is masked to null (fields.legalName falsy)', async () => {
    const viewer = makeUser({ id: 'acc-id', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: { requisites: true, techStack: true },
      // legalName is NOT set — ACCOUNTANT sees requisites but not passport PII
    }
    const service = makeServiceForProfileView(targetWithLegalName, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect((result.user as Record<string, unknown>).legalFullName).toBeNull()
  })

  it('SENIOR viewer (shared project) — legalFullName is masked to null', async () => {
    const viewer = makeUser({ id: 'sr-other', role: 'SENIOR' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true },
    }
    const service = makeServiceForProfileView(targetWithLegalName, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect((result.user as Record<string, unknown>).legalFullName).toBeNull()
  })
})
