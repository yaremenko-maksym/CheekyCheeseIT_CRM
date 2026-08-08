import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
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

const makeDrop = (overrides: Record<string, unknown> = {}) =>
  makeUser({
    id: 'drop-1',
    email: 'drop@example.com',
    displayName: 'Drop Person',
    role: 'DROP',
    dropSharePercent: 5,
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
// Slim list projection — sensitive PII / finance fields excluded
// (security data-exposure fix, ревью #222 / task-slim-users-projection)
// ---------------------------------------------------------------------------

/**
 * GET /api/users (list) must NOT carry PII / finance for every user to the
 * ADMIN/HR/ACCOUNTANT audience — pickers only need id/displayName/role.
 *
 * Stronger than the legalFullName test above: rather than simulating Drizzle's
 * projection by deleting keys from the mock row, this captures the *actual
 * projection object* passed to `db.select(projection)` and asserts the sensitive
 * column refs are absent. That tests USER_LIST_PROJECTION directly — if someone
 * re-adds `bankUahIban` to the projection, this fails even though the mock row
 * would still "look" clean.
 */
const SENSITIVE_LIST_FIELDS = [
  'bankUahIban',
  'bankUahRnokpp',
  'bankUahRecipient',
  'bankUahBankName',
  'walletUsdtErc20',
  'walletUsdtLabel',
  'paymentMethod',
  'monthlySalary',
  'registrationAddress',
  'adminNote',
  'legalFullName',
] as const

describe('UsersService list projection — sensitive fields excluded', () => {
  /**
   * Capture the projection object handed to `db.select(...)` on the FIRST call
   * (the users list query). The second select() (projectMembers) is ignored.
   * `where()` resolves to the row data so the method completes normally.
   */
  function makeProjectionCapturingDb(rows: ReturnType<typeof makeUser>[]): {
    db: DrizzleDb
    getListProjection: () => Record<string, unknown> | undefined
  } {
    let listProjection: Record<string, unknown> | undefined
    let selectCall = 0
    let whereCall = 0
    const chain = {
      select: vi.fn().mockImplementation((projection?: Record<string, unknown>) => {
        selectCall++
        // First select() = the users list projection we care about.
        if (selectCall === 1) listProjection = projection
        return chain
      }),
      from: vi.fn().mockReturnThis(),
      // findAllIncludingAdmin (no archived filter) resolves at `.from(...)`,
      // while findAll / archived variants resolve at `.where(...)`. Make BOTH
      // thenable so either call shape works, returning rows once then [].
      where: vi.fn().mockImplementation(() => {
        whereCall++
        return Promise.resolve(whereCall === 1 ? rows : [])
      }),
    }
    return {
      db: { db: chain as unknown } as unknown as DrizzleDb,
      getListProjection: () => listProjection,
    }
  }

  it('USER_LIST_PROJECTION (findAll) selects no sensitive PII/finance column', async () => {
    const { db, getListProjection } = makeProjectionCapturingDb([makeSenior()])
    const service = makeUsersService(db)

    await service.findAll()

    const projection = getListProjection()
    expect(projection).toBeDefined()
    for (const field of SENSITIVE_LIST_FIELDS) {
      expect(projection).not.toHaveProperty(field)
    }
    // Sanity: the slim directory fields the pickers need ARE selected.
    for (const keep of ['id', 'displayName', 'role', 'email', 'avatarUrl']) {
      expect(projection).toHaveProperty(keep)
    }
  })

  it('USER_LIST_PROJECTION (findAllIncludingAdmin) selects no sensitive PII/finance column', async () => {
    const { db, getListProjection } = makeProjectionCapturingDb([makeSenior()])
    const service = makeUsersService(db)

    await service.findAllIncludingAdmin()

    const projection = getListProjection()
    expect(projection).toBeDefined()
    for (const field of SENSITIVE_LIST_FIELDS) {
      expect(projection).not.toHaveProperty(field)
    }
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      service.createUser({
        email: junior.email,
        displayName: 'Dup',
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      }),
    ).rejects.toThrow(ConflictException)
  })

  it('does not insert anything after ConflictException', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: junior })
    const service = makeUsersService(db)

    await service
      .createUser({
        email: junior.email,
        displayName: 'Dup',
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      })
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      service.createUser({
        email: senior.email,
        displayName: 'Dup',
        role: 'SENIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      }),
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
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
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
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
      email: hr.email,
      displayName: hr.displayName,
      role: 'HR',
      monthlySalary: 1500,
    })

    expect(result.monthlySalary).toBe('1500.00')
  })
})

// ---------------------------------------------------------------------------
// createUser — avatarUrl (owner request: stop auto-generating dicebear avatars
// for new users; UI renders initials fallback instead)
// ---------------------------------------------------------------------------

describe('UsersService.createUser — avatarUrl', () => {
  it('stores null when avatarUrl is omitted — no dicebear auto-generation', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    const valuesMock = (insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      .values
    const insertedValues = valuesMock.mock.calls[0]?.[0] as { avatarUrl: unknown }
    expect(insertedValues.avatarUrl).toBeNull()
  })

  it('passes through an explicit avatarUrl unchanged', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      avatarUrl: 'https://example.com/me.png',
    })

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    const valuesMock = (insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      .values
    const insertedValues = valuesMock.mock.calls[0]?.[0] as { avatarUrl: unknown }
    expect(insertedValues.avatarUrl).toBe('https://example.com/me.png')
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

  // ─── LOW findings from PR #373: role-scoped share-percent writes ───────
  // seniorSharePercent is only meaningful for SENIOR, dropSharePercent only
  // for DROP — adminUpdateUser now gates each write on effectiveRole so a
  // value assigned under the wrong role can't surface later if the user is
  // promoted into that role.

  it('writes dropSharePercent when target is already DROP', async () => {
    const existing = makeDrop()
    const updated = makeDrop({ dropSharePercent: 30 })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser('drop-1', { dropSharePercent: 30 })
    expect(result.dropSharePercent).toBe(30)

    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = updateMock.mock.results[0]?.value?.set?.mock?.calls
    expect(setCalls?.length).toBeGreaterThan(0)
    const setArg = setCalls[0][0] as Record<string, unknown>
    expect(setArg).toHaveProperty('dropSharePercent', 30)
  })

  it('ignores dropSharePercent for a non-DROP target', async () => {
    const existing = makeHr()
    const updated = makeHr()
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await service.adminUpdateUser('hr-1', { dropSharePercent: 30 })

    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = updateMock.mock.results[0]?.value?.set?.mock?.calls
    expect(setCalls?.length).toBeGreaterThan(0)
    const setArg = setCalls[0][0] as Record<string, unknown>
    expect(setArg).not.toHaveProperty('dropSharePercent')
  })

  // MED (security-audit authz-hardening): promoting a user to DROP via the
  // general PATCH /:id body used to succeed silently (this test previously
  // asserted THAT behavior — see git history). DROP must always be created
  // via POST /users/drops, which atomically provisions the mandatory
  // drop-team; routing the transition through adminUpdateUser left the user
  // without a team (broken invariant) and bypassed the same guard that
  // PATCH /:id/role (changeRole) already enforces. See
  // users.admin-update-role-escalation.spec.ts for the full guard coverage.
  it('rejects promoting a user to DROP via adminUpdateUser (must use POST /users/drops)', async () => {
    const existing = makeHr()
    const updated = makeDrop({ dropSharePercent: 40 })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await expect(
      service.adminUpdateUser('hr-1', { role: 'DROP', dropSharePercent: 40 }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('ignores seniorSharePercent for a non-SENIOR target', async () => {
    const existing = makeHr()
    const updated = makeHr()
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await service.adminUpdateUser('hr-1', { seniorSharePercent: 80 })

    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = updateMock.mock.results[0]?.value?.set?.mock?.calls
    expect(setCalls?.length).toBeGreaterThan(0)
    const setArg = setCalls[0][0] as Record<string, unknown>
    expect(setArg).not.toHaveProperty('seniorSharePercent')
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

  // ─── fix(bug-2): registrationAddress persists via adminUpdateUser ──

  it('persists registrationAddress when provided', async () => {
    const existing = makeUser({ registrationAddress: null })
    const updated = makeUser({ registrationAddress: 'м. Київ, вул. Хрещатик, 1' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser('user-1', {
      registrationAddress: 'м. Київ, вул. Хрещатик, 1',
    })
    expect(result.registrationAddress).toBe('м. Київ, вул. Хрещатик, 1')

    // Verify .set() received the field. The non-empty check is load-bearing:
    // this assertion used to sit inside `if (setCalls?.length)`, so a change
    // that stopped calling `.set()` at all skipped it and the test still
    // passed. (task-lint-teeth)
    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = (updateMock.mock.results[0]?.value?.set?.mock?.calls ?? []) as unknown[][]
    expect(setCalls.length, 'expected .set() to have been called').toBeGreaterThan(0)

    const setArg = setCalls[0]?.[0] as Record<string, unknown>
    expect(setArg).toHaveProperty('registrationAddress', 'м. Київ, вул. Хрещатик, 1')
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

    // Same as above — and here the `if` mattered even more: the whole point of
    // this test is the absence of a key in `.set()`'s argument, so an empty
    // `setCalls` made it assert nothing at all while reporting green.
    const updateMock = (db.db as unknown as { update: ReturnType<typeof vi.fn> }).update
    const setCalls = (updateMock.mock.results[0]?.value?.set?.mock?.calls ?? []) as unknown[][]
    expect(setCalls.length, 'expected .set() to have been called').toBeGreaterThan(0)

    const setArg = setCalls[0]?.[0] as Record<string, unknown>
    expect(setArg).not.toHaveProperty('registrationAddress')
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
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
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
    return makeServiceForProfileViewWithAudit(target, permissions).service
  }

  // Variant that also returns the audit-log spy so read-audit tests can assert
  // on `auditLogService.record(...)`.
  function makeServiceForProfileViewWithAudit(
    target: ReturnType<typeof makeUser>,
    permissions: { tabs: string[]; actions: string[]; fields: Record<string, boolean> },
  ): { service: UsersService; auditRecord: ReturnType<typeof vi.fn> } {
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

    const auditRecord = vi.fn().mockResolvedValue(undefined)
    const auditService = { record: auditRecord } as unknown as AuditLogService
    const tosService = makeTosService()

    const service = new UsersService(
      db as never,
      accessService as never,
      auditService as never,
      tosService,
    )
    return { service, auditRecord }
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

  // ── Pre-deploy MEDIUM #1: ACCOUNTANT requisites — wallet exclusion + read-audit ──

  const targetWithRequisites = makeUser({
    id: 'target-id',
    role: 'ADMIN',
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0xADMINWALLET',
    walletUsdtLabel: 'admin wallet',
    bankUahRecipient: 'Admin FOP',
    bankUahIban: 'UA000000000000000000000000001',
    bankUahRnokpp: '1234567890',
    bankUahBankName: 'PrivatBank',
  } as Record<string, unknown>)

  it('ACCOUNTANT viewing an ADMIN — wallet/IBAN/RNOKPP masked (requisitesExcludeWallet)', async () => {
    const viewer = makeUser({ id: 'acc-id', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      // mirrors what UsersAccessService emits for ACCOUNTANT → ADMIN
      fields: { requisites: true, requisitesExcludeWallet: true, techStack: true },
    }
    const service = makeServiceForProfileView(targetWithRequisites, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    const u = result.user as Record<string, unknown>
    // Payout destination fields are excluded for the admin target…
    expect(u.walletUsdtErc20).toBeNull()
    expect(u.walletUsdtLabel).toBeNull()
    expect(u.bankUahRecipient).toBeNull()
    expect(u.bankUahIban).toBeNull()
    expect(u.bankUahRnokpp).toBeNull()
    expect(u.bankUahBankName).toBeNull()
    // …but the method type (no destination) is still surfaced.
    expect(u.paymentMethod).toBe('USDT_ERC20')
  })

  it('ACCOUNTANT viewing a non-ADMIN — wallet/IBAN visible (no exclusion)', async () => {
    const seniorTarget = makeUser({
      id: 'target-id',
      role: 'SENIOR',
      paymentMethod: 'BANK_UAH_FOP',
      walletUsdtErc20: '0xSENIORWALLET',
      bankUahIban: 'UA000000000000000000000000002',
      bankUahRnokpp: '9876543210',
    } as Record<string, unknown>)
    const viewer = makeUser({ id: 'acc-id', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: { requisites: true, requisitesExcludeWallet: false, techStack: true },
    }
    const service = makeServiceForProfileView(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    const u = result.user as Record<string, unknown>
    expect(u.walletUsdtErc20).toBe('0xSENIORWALLET')
    expect(u.bankUahIban).toBe('UA000000000000000000000000002')
    expect(u.bankUahRnokpp).toBe('9876543210')
  })

  it('ACCOUNTANT reading requisites writes a requisites_read audit (redacted, actor=accountant)', async () => {
    const seniorTarget = makeUser({
      id: 'target-id',
      role: 'SENIOR',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahIban: 'UA000000000000000000000000002',
      bankUahRnokpp: '9876543210',
    } as Record<string, unknown>)
    const viewer = makeUser({ id: 'acc-id', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: { requisites: true, techStack: true },
    }
    const { service, auditRecord } = makeServiceForProfileViewWithAudit(seniorTarget, permissions)
    await service.buildProfileView(viewer as never, 'target-id')
    expect(auditRecord).toHaveBeenCalledTimes(1)
    const entry = auditRecord.mock.calls[0]![0] as {
      actorId: string
      targetId: string
      action: string
      changes: Record<string, { before: unknown; after: unknown }>
    }
    expect(entry.action).toBe('requisites_read')
    expect(entry.actorId).toBe('acc-id')
    expect(entry.targetId).toBe('target-id')
    // Read-audit records WHICH fields were read but never their plaintext values.
    expect(Object.keys(entry.changes)).toContain('bankUahIban')
    expect(Object.keys(entry.changes)).toContain('bankUahRnokpp')
    expect(entry.changes.bankUahIban.before).toBe('[redacted]')
    expect(entry.changes.bankUahIban.after).toBe('[redacted]')
  })

  it('ACCOUNTANT viewing SELF does NOT write a requisites_read audit', async () => {
    const selfTarget = makeUser({
      id: 'acc-self',
      role: 'ACCOUNTANT',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahIban: 'UA000000000000000000000000003',
    } as Record<string, unknown>)
    const viewer = makeUser({ id: 'acc-self', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'requisites'],
      actions: [],
      fields: { requisites: true, techStack: true },
    }
    const { service, auditRecord } = makeServiceForProfileViewWithAudit(selfTarget, permissions)
    await service.buildProfileView(viewer as never, 'acc-self')
    expect(auditRecord).not.toHaveBeenCalled()
  })

  it('ADMIN reading requisites does NOT write a requisites_read audit (accountant-only)', async () => {
    const seniorTarget = makeUser({
      id: 'target-id',
      role: 'SENIOR',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahIban: 'UA000000000000000000000000004',
    } as Record<string, unknown>)
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const permissions = {
      tabs: ['overview', 'finance', 'requisites'],
      actions: [],
      fields: { requisites: true, techStack: true },
    }
    const { service, auditRecord } = makeServiceForProfileViewWithAudit(seniorTarget, permissions)
    await service.buildProfileView(viewer as never, 'target-id')
    expect(auditRecord).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// buildProfileView — 403 guard when tabs.length === 0 (OWASP A01 fix)
// ---------------------------------------------------------------------------

describe('UsersService.buildProfileView — ForbiddenException on empty tabs', () => {
  /**
   * makeServiceForProfileView is defined in the previous describe block above.
   * We duplicate the minimal factory here to keep this block self-contained.
   */
  function makeServiceForForbiddenCheck(
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

  const juniorTarget = makeJunior({ id: 'junior-target-id' })

  // ── SENIOR → JUNIOR: must throw 403 ─────────────────────────────────────

  it('SENIOR viewing JUNIOR profile → throws ForbiddenException (no tabs)', async () => {
    // accessService returns empty tabs — this is what getViewPermissions produces
    // for SENIOR→JUNIOR per users-access.service.ts isSenior branch.
    const viewer = makeSenior({ id: 'sr-viewer' })
    const permissions = { tabs: [], actions: [], fields: {} }
    const service = makeServiceForForbiddenCheck(juniorTarget, permissions)
    await expect(service.buildProfileView(viewer as never, 'junior-target-id')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('SENIOR viewing JUNIOR from own project → still throws ForbiddenException (rule #1 absolute)', async () => {
    // Even if SENIOR and JUNIOR share a project, SENIOR must not see JUNIOR identity.
    // The access service already returns [] tabs for any SENIOR→JUNIOR combination.
    const viewer = makeSenior({ id: 'sr-with-project' })
    const permissions = { tabs: [], actions: [], fields: {} }
    const service = makeServiceForForbiddenCheck(juniorTarget, permissions)
    await expect(service.buildProfileView(viewer as never, 'junior-target-id')).rejects.toThrow(
      ForbiddenException,
    )
  })

  // ── Regression: legitimate viewers must NOT be broken ───────────────────

  it('ADMIN viewing JUNIOR → succeeds (ADMIN has full tabs)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: ['edit-profile'],
      fields: { salary: true, requisites: true, legalName: true, techStack: true },
    }
    const service = makeServiceForForbiddenCheck(juniorTarget, permissions)
    await expect(
      service.buildProfileView(viewer as never, 'junior-target-id'),
    ).resolves.toBeDefined()
  })

  it('HR viewing JUNIOR in own team → succeeds (HR has tabs via isHrInTargetTeam)', async () => {
    const viewer = makeHr({ id: 'hr-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true },
    }
    const service = makeServiceForForbiddenCheck(juniorTarget, permissions)
    await expect(
      service.buildProfileView(viewer as never, 'junior-target-id'),
    ).resolves.toBeDefined()
  })

  it('JUNIOR viewing self → succeeds (isSelf produces non-empty tabs)', async () => {
    // viewer.id === target.id → isSelf path in access service → tabs populated
    const viewer = makeJunior({ id: 'junior-target-id' })
    const permissions = {
      tabs: ['overview', 'projects', 'team', 'requisites', 'documents', 'finance'],
      actions: [],
      fields: { salary: true, requisites: true, legalName: true, techStack: true },
    }
    const service = makeServiceForForbiddenCheck(juniorTarget, permissions)
    await expect(
      service.buildProfileView(viewer as never, 'junior-target-id'),
    ).resolves.toBeDefined()
  })

  it('SENIOR viewing self → succeeds (isSelf produces non-empty tabs)', async () => {
    const seniorSelf = makeSenior({ id: 'sr-self-id' })
    const viewer = makeSenior({ id: 'sr-self-id' })
    const permissions = {
      tabs: ['overview', 'projects', 'team', 'requisites', 'documents', 'finance'],
      actions: [],
      fields: { share: true, requisites: true, legalName: true, techStack: true },
    }
    const service = makeServiceForForbiddenCheck(seniorSelf, permissions)
    await expect(service.buildProfileView(viewer as never, 'sr-self-id')).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// buildProfileView — PII field masking matrix (RBAC A01, 2026-06-10)
//
// Matrix enforced by buildProfileView explicit allow-list projection:
//   adminNote         → ADMIN only (never self)
//   registrationAddress (FOP PII)             → ADMIN + self
//   email, phone, telegram (realContacts)    → hidden when viewer=JUNIOR
//                                              and target is SENIOR or DROP
//                                              (legend-subject persona boundary)
// ---------------------------------------------------------------------------

describe('UsersService.buildProfileView — PII field masking matrix (RBAC A01)', () => {
  /** Reuse the same factory pattern as the legalFullName block above. */
  function makeServicePii(
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

    return new UsersService(
      db as never,
      accessService as never,
      makeAuditLogService() as never,
      makeTosService(),
    )
  }

  // Shared target fixture: SENIOR with all sensitive fields populated
  const seniorTarget = makeSenior({
    id: 'senior-target',
    email: 'secret-email@example.com',
    phone: '+380991112233',
    telegram: '@secrethandle',
    adminNote: 'Internal admin-only note',
    registrationAddress: 'Kyiv, Khreshchatyk 1',
  } as Record<string, unknown>)

  // ── JUNIOR viewing their SENIOR (legend-subject) ──────────────────────────
  // Access service: fields.realContacts = false (JUNIOR→SENIOR), no adminNote, no fopPii

  it('JUNIOR → SENIOR: email is null (realContacts hidden)', async () => {
    const viewer = makeJunior({ id: 'junior-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, legend: true, realContacts: false },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).email).toBeNull()
  })

  it('JUNIOR → SENIOR: phone is null (realContacts hidden)', async () => {
    const viewer = makeJunior({ id: 'junior-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, legend: true, realContacts: false },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).phone).toBeNull()
  })

  it('JUNIOR → SENIOR: telegram is null (realContacts hidden)', async () => {
    const viewer = makeJunior({ id: 'junior-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, legend: true, realContacts: false },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).telegram).toBeNull()
  })

  it('JUNIOR → SENIOR: registrationAddress is null (fopPii hidden from non-ADMIN/non-self)', async () => {
    const viewer = makeJunior({ id: 'junior-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, legend: true, realContacts: false },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).registrationAddress).toBeNull()
  })

  it('JUNIOR → SENIOR: adminNote is null (adminNote never exposed to non-ADMIN)', async () => {
    const viewer = makeJunior({ id: 'junior-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, legend: true, realContacts: false },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).adminNote).toBeNull()
  })

  it('JUNIOR → SENIOR: displayName is present (persona display field, never masked)', async () => {
    const viewer = makeJunior({ id: 'junior-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, legend: true, realContacts: false },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).displayName).toBe('Senior Dev')
  })

  // ── ACCOUNTANT viewing any user ───────────────────────────────────────────
  // ACCOUNTANT has requisites access but NOT adminNote, NOT fopPii, contacts visible

  it('ACCOUNTANT → SENIOR: adminNote is null', async () => {
    const viewer = makeUser({ id: 'acc-viewer', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: { salary: true, share: true, requisites: true, techStack: true, realContacts: true },
      // adminNote NOT in fields → must be null
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).adminNote).toBeNull()
  })

  it('ACCOUNTANT → SENIOR: registrationAddress is null (fopPii not in fields)', async () => {
    const viewer = makeUser({ id: 'acc-viewer', role: 'ACCOUNTANT' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: { salary: true, share: true, requisites: true, techStack: true, realContacts: true },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).registrationAddress).toBeNull()
  })

  // ── HR viewing their SENIOR ───────────────────────────────────────────────

  it('HR → SENIOR: adminNote is null', async () => {
    const viewer = makeHr({ id: 'hr-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, realContacts: true },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).adminNote).toBeNull()
  })

  it('HR → SENIOR: registrationAddress is null (fopPii not for HR)', async () => {
    const viewer = makeHr({ id: 'hr-viewer' })
    const permissions = {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true, realContacts: true },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).registrationAddress).toBeNull()
  })

  // ── ADMIN viewing any user ────────────────────────────────────────────────
  // ADMIN should see everything except adminNote on self (tested separately)

  it('ADMIN → SENIOR: all PII fields visible (fields.adminNote, fopPii, realContacts all true)', async () => {
    const viewer = makeUser({ id: 'admin-viewer', role: 'ADMIN' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: ['edit-profile'],
      fields: {
        adminNote: true,
        fopPii: true,
        realContacts: true,
        requisites: true,
        legalName: true,
        techStack: true,
        salary: true,
        share: true,
      },
    }
    const service = makeServicePii(seniorTarget, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-target')
    expect((result.user as Record<string, unknown>).adminNote).toBe('Internal admin-only note')
    expect((result.user as Record<string, unknown>).registrationAddress).toBe(
      'Kyiv, Khreshchatyk 1',
    )
    expect((result.user as Record<string, unknown>).email).toBe('secret-email@example.com')
  })

  it('ADMIN self: registrationAddress visible, adminNote null (self cannot see own note)', async () => {
    const adminSelf = makeUser({
      id: 'admin-self',
      role: 'ADMIN',
      email: 'admin@cc.com',
      adminNote: 'My own note',
      registrationAddress: 'Admin street 1',
    } as Record<string, unknown>)
    const viewer = makeUser({ id: 'admin-self', role: 'ADMIN' })
    // ADMIN self: isSelf → fopPii=true (legalName=true), but adminNote=false
    const permissions = {
      tabs: ['overview', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: {
        fopPii: true,
        realContacts: true,
        requisites: true,
        legalName: true,
        techStack: true,
        // adminNote intentionally absent → must be masked
      },
    }
    const service = makeServicePii(adminSelf, permissions)
    const result = await service.buildProfileView(viewer as never, 'admin-self')
    expect((result.user as Record<string, unknown>).adminNote).toBeNull()
    expect((result.user as Record<string, unknown>).registrationAddress).toBe('Admin street 1')
  })

  // ── SENIOR self ───────────────────────────────────────────────────────────
  // self sees fopPii (registrationAddress), but NOT adminNote

  it('SENIOR self: registrationAddress visible, adminNote null', async () => {
    const seniorSelf = makeSenior({
      id: 'senior-self',
      adminNote: 'Staff note',
      registrationAddress: 'Lviv, Rynok sq 1',
    } as Record<string, unknown>)
    const viewer = makeSenior({ id: 'senior-self' })
    const permissions = {
      tabs: ['overview', 'projects', 'team', 'requisites', 'documents', 'finance'],
      actions: [],
      fields: {
        fopPii: true,
        realContacts: true,
        requisites: true,
        legalName: true,
        techStack: true,
        share: true,
        // adminNote absent → must be masked
      },
    }
    const service = makeServicePii(seniorSelf, permissions)
    const result = await service.buildProfileView(viewer as never, 'senior-self')
    expect((result.user as Record<string, unknown>).adminNote).toBeNull()
    expect((result.user as Record<string, unknown>).registrationAddress).toBe('Lviv, Rynok sq 1')
  })
})

// ---------------------------------------------------------------------------
// buildProfileView — ToS acceptance masking for JUNIOR self (task-junior-ut-round3 §6b)
// ---------------------------------------------------------------------------

describe('UsersService.buildProfileView — ToS hidden from JUNIOR self (data-privacy)', () => {
  /** Factory with configurable tosService mock */
  function makeServiceToS(
    target: ReturnType<typeof makeUser>,
    permissions: { tabs: string[]; actions: string[]; fields: Record<string, boolean> },
    tosReturnValue: { acceptedAt: Date; tosVersion: string } | null,
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

    const tosService = {
      getLatestAcceptanceForUser: vi.fn().mockResolvedValue(tosReturnValue),
    } as never

    return new UsersService(
      db as never,
      accessService as never,
      makeAuditLogService() as never,
      tosService,
    )
  }

  const tosData = { acceptedAt: new Date('2026-01-15T10:00:00Z'), tosVersion: 'v1' }

  // task-junior-ut-round3 §6b: JUNIOR self-view must NOT receive tosAcceptedAt/tosVersion
  it('JUNIOR self — tosAcceptedAt and tosVersion are null in overview (data-privacy)', async () => {
    const junior = makeJunior({ id: 'jr-self' })
    const viewer = makeJunior({ id: 'jr-self' })
    const permissions = {
      tabs: ['overview', 'requisites'],
      actions: [],
      fields: { salary: true, requisites: true, techStack: true, realContacts: true },
    }
    const service = makeServiceToS(junior, permissions, tosData)
    const result = await service.buildProfileView(viewer as never, 'jr-self')
    const overview = result.data.overview as Record<string, unknown>
    expect(overview.tosAcceptedAt).toBeNull()
    expect(overview.tosVersion).toBeNull()
  })

  // Regression: SENIOR self must still receive tosAcceptedAt
  it('SENIOR self — tosAcceptedAt is visible (non-JUNIOR role allowed)', async () => {
    const senior = makeSenior({ id: 'sr-self' })
    const viewer = makeSenior({ id: 'sr-self' })
    const permissions = {
      tabs: ['overview', 'projects', 'team', 'requisites', 'documents', 'finance'],
      actions: [],
      fields: {
        salary: true,
        share: true,
        requisites: true,
        techStack: true,
        realContacts: true,
        legalName: true,
        fopPii: true,
      },
    }
    const service = makeServiceToS(senior, permissions, tosData)
    const result = await service.buildProfileView(viewer as never, 'sr-self')
    const overview = result.data.overview as Record<string, unknown>
    expect(overview.tosAcceptedAt).toBe('2026-01-15T10:00:00.000Z')
    expect(overview.tosVersion).toBe('v1')
  })

  // Regression: ADMIN viewing JUNIOR must still receive tosAcceptedAt (ADMIN role)
  it('ADMIN viewing JUNIOR — tosAcceptedAt is visible (ADMIN always allowed)', async () => {
    const junior = makeJunior({ id: 'jr-target' })
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const permissions = {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: ['edit-profile'],
      fields: {
        salary: true,
        requisites: true,
        legalName: true,
        techStack: true,
        realContacts: true,
        adminNote: true,
        fopPii: true,
      },
    }
    const service = makeServiceToS(junior, permissions, tosData)
    const result = await service.buildProfileView(viewer as never, 'jr-target')
    const overview = result.data.overview as Record<string, unknown>
    expect(overview.tosAcceptedAt).toBe('2026-01-15T10:00:00.000Z')
    expect(overview.tosVersion).toBe('v1')
  })
})
