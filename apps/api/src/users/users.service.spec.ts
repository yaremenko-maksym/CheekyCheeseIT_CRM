import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { PgDialect } from 'drizzle-orm/pg-core'
import type * as schema from '../database/schema'
import { userEmails } from '../database/schema'
import type { AuditLogService } from './audit-log.service'
import { hashInviteToken } from './invite-token.util'
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

// task-user-emails-invite: `createUser`'s constructor grew a `PersonalEmailInviteMailerService`
// dependency (best-effort invite send, AFTER the tx commits — see that
// method's doc). Stubbed here so the `personalEmail`-carrying tests below
// (which DO exercise that call) don't crash on `undefined.sendInvite`.
const makeInviteMailer = () => ({ sendInvite: vi.fn().mockResolvedValue(undefined) }) as never
// The remaining three constructor args (teamAuditLogService,
// projectAuditLogService, teamsService) are untouched by any test in this
// file (no JOIN_DROP_TEAM / createDrop path exercised here — see
// users.drop.spec.ts for those) — stubbed anyway so a future test that DOES
// reach them fails on a missing MOCK METHOD, not on `undefined` entirely.
const makeTeamAuditLogService = () => ({ record: vi.fn().mockResolvedValue(undefined) }) as never
const makeProjectAuditLogService = () => ({ record: vi.fn().mockResolvedValue(undefined) }) as never
const makeTeamsService = () =>
  ({
    isActiveMemberOfTeam: vi.fn().mockResolvedValue(true),
    addSeniorToDropTeam: vi.fn().mockResolvedValue(undefined),
    createDropTeam: vi.fn().mockResolvedValue({ id: 'team-x' }),
  }) as never

const makeUsersService = (db: DrizzleDb): UsersService =>
  new UsersService(
    db as never,
    makeAccessService() as never,
    makeAuditLogService() as never,
    makeTosService(),
    makeTeamAuditLogService(),
    makeProjectAuditLogService(),
    makeTeamsService(),
    makeInviteMailer(),
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
    // task-user-emails-invite: `issuePersonalEmailInviteTx`'s
    // `tx.insert(userEmailInvites).values(...).onConflictDoUpdate(...)` —
    // a THIRD terminal method on this same shared chain, alongside
    // `.returning()` above. Resolves like a bare insert with no RETURNING.
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
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

  // user_emails lookups (§4.4) go through the Drizzle relational query API
  // (`db.query.userEmails.findFirst`), a SEPARATE surface from `.select()`
  // above — so it does not disturb `selectChain`'s call-count-based
  // existingUser/createdUser sequencing that the rest of this harness
  // relies on. Default: "nothing found" (no email conflict, no existing
  // WORK row to update) — the common case for every test that does not
  // specifically exercise the §4.4 paths. Tests that DO exercise them
  // override via `mockResolvedValueOnce` on the returned handle.
  const queryChain = {
    query: { userEmails: { findFirst: vi.fn().mockResolvedValue(undefined) } },
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
    ...queryChain,
    // Drizzle's `tx.update(table).set(set).where(...).returning()` shape — but
    // the wrapping transaction body for adminUpdateUser uses a fresh update
    // chain inside the tx, so we expose the same one.
  }
  const dbHandle = {
    ...selectChain,
    ...insertChain,
    ...updateChain,
    ...deleteChain,
    ...queryChain,
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

// mutation-gate closure (PR #623, no-coverage bucket): `findLoginableUserByEmail`
// had ZERO unit coverage — `auth.controller.spec.ts` mocks it outright (see the
// comment there), and the real implementation was exercised only by
// `auth.one-tap.integration.spec.ts` / `auth.oauth-callback.integration.spec.ts`
// (DATABASE_URL-gated, invisible to the mutation gate — see
// `.claude/rules/common/mutation-gate-integration-specs.md`). This is the login
// gate itself (SR-H-1) — worth a unit double alongside the integration proof,
// not just accepting the gap.
describe('UsersService.findLoginableUserByEmail (§4.4/§5 — login-address resolution)', () => {
  it('folds the query email to lowercase and gates on canLogin=true (matches the case-folded unique index, SR-H-1)', async () => {
    const target = makeJunior({ id: 'target-1' })
    const db = makeDb({ existingUser: target, createdUser: target })
    const service = makeUsersService(db)
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userId: target.id,
      canLogin: true,
    })

    const result = await service.findLoginableUserByEmail('Target@Example.com')

    const findFirstMock = db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>
    const whereArg = (findFirstMock.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where
    expect(whereArg, 'expected a where clause').toBeDefined()
    const compiled = new PgDialect().sqlToQuery(whereArg as Parameters<PgDialect['sqlToQuery']>[0])
    expect(compiled.params).toContain('target@example.com')
    expect(compiled.params).not.toContain('Target@Example.com')
    expect(compiled.params).toContain(true)

    expect(result?.id).toBe(target.id)
  })

  it('returns undefined without resolving a session when no matching row exists (unrecognized and unverified-personal-address look identical)', async () => {
    const db = makeDb({ existingUser: undefined })
    const service = makeUsersService(db)
    // default mock: findFirst resolves undefined

    const result = await service.findLoginableUserByEmail('nobody@example.com')

    expect(result).toBeUndefined()
    // A mutated `if (!row) return undefined` that always/never short-circuits
    // would either skip findById's select entirely (fine here, `select` is
    // never called on the "not found" path — this assertion only strengthens
    // that) or reach it despite no row — the value assertion above already
    // catches the latter.
    expect(db.db.select as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
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
    // Two insert calls: users + user_emails WORK row (§4.4)
    expect(insertMock).toHaveBeenCalledTimes(2)
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
    // insert called three times: users + user_emails WORK row (§4.4) + projectMembers
    expect(insertMock).toHaveBeenCalledTimes(3)
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
    // Two insert calls: users + user_emails WORK row (§4.4) — projectId null
    // → no project assignment
    expect(insertMock).toHaveBeenCalledTimes(2)
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
// createUser — user_emails writes (§4.4, task-user-emails-dual-login)
//
// Mutation-gate finding: the earlier tests above only assert insert CALL
// COUnt, never call CONTENT — a mutant that empties the values object, flips
// `kind`/`canLogin`, or inverts the `if (data.personalEmail)` guards passed
// every existing test silently. These assert on the actual payload and on
// distinguishing behavior between "personalEmail given" / "omitted".
// ---------------------------------------------------------------------------

describe('UsersService.createUser — user_emails writes (§4.4)', () => {
  it('inserts a login-enabled WORK row with the correct shape', async () => {
    const junior = makeJunior({ id: 'junior-1', email: 'junior@example.com' })
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
    })

    const insertValuesMock = (db.db.insert as ReturnType<typeof vi.fn>).mock.results[0]?.value
      ?.values as ReturnType<typeof vi.fn>
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: junior.id,
        email: junior.email,
        kind: 'WORK',
        canLogin: true,
      }),
    )
  })

  it('omitted personalEmail — exactly one user_emails conflict-check, no PERSONAL insert', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
    })

    // Only the work-email pre-check ran — a mutated `if (data.personalEmail)`
    // that always takes the truthy branch would call this a second time
    // (querying availability for `undefined`).
    expect(db.db.query.userEmails.findFirst).toHaveBeenCalledTimes(1)

    const insertValuesMock = (db.db.insert as ReturnType<typeof vi.fn>).mock.results[0]?.value
      ?.values as ReturnType<typeof vi.fn>
    expect(insertValuesMock).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'PERSONAL' }))
  })

  it('provided personalEmail — both pre-checks run, and a PERSONAL row is inserted', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      email: junior.email,
      personalEmail: 'personal@example.com',
      displayName: junior.displayName,
      role: 'JUNIOR',
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
    })

    // work-email check + personal-email check — a mutated guard that skips
    // either would leave this at 1.
    expect(db.db.query.userEmails.findFirst).toHaveBeenCalledTimes(2)

    const insertValuesMock = (db.db.insert as ReturnType<typeof vi.fn>).mock.results[0]?.value
      ?.values as ReturnType<typeof vi.fn>
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: junior.id,
        email: 'personal@example.com',
        kind: 'PERSONAL',
      }),
    )
  })

  // task-user-emails-invite: mutation gate found `issuePersonalEmailInviteTx`
  // (called from THIS branch of createUser) had zero assertions on its own
  // output — the test above only checks the PERSONAL row's `.values()` call
  // (the 3rd insert), never the 4th (`userEmailInvites`) that immediately
  // follows it. `inviteMailer` is exposed here (unlike `makeUsersService`'s
  // internal stub) specifically so the raw token it receives can be
  // cross-checked against the HASH written to the DB — proving the two are
  // the SAME token, not just that "some insert happened" and "some send
  // happened" independently (which two ordinary mocked calls could satisfy
  // by coincidence even if the token were wired to the wrong place).
  it('issues a real invite token for the PERSONAL row: DB gets its hash, the mailer gets the raw value, and they match', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const inviteMailer = { sendInvite: vi.fn().mockResolvedValue(undefined) }
    const service = new UsersService(
      db as never,
      makeAccessService() as never,
      makeAuditLogService() as never,
      makeTosService(),
      makeTeamAuditLogService(),
      makeProjectAuditLogService(),
      makeTeamsService(),
      inviteMailer as never,
    )

    const before = Date.now()
    await service.createUser({
      email: junior.email,
      personalEmail: 'personal@example.com',
      displayName: junior.displayName,
      role: 'JUNIOR',
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
    })

    // 4th insert call = userEmailInvites (1: users, 2: WORK, 3: PERSONAL, 4: invite).
    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    expect(insertMock).toHaveBeenCalledTimes(4)
    const inviteValuesMock = insertMock.mock.results[3]?.value?.values as ReturnType<typeof vi.fn>
    // `.values` is a SINGLE shared mock across all 4 inserts (see makeDb's
    // doc on insertValuesChain) — its call log accumulates every insert in
    // order, so the invite's own values are call index 3 (0-based), not 0.
    const inviteValues = inviteValuesMock.mock.calls[3]?.[0] as {
      userEmailId: string
      tokenHash: string
      expiresAt: Date
    }
    expect(inviteValues.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    // 7-day TTL — independent literal bound (not the same `+ INVITE_TOKEN_TTL_MS`
    // formula the implementation uses), generous slack for test execution time.
    const expiresMs = inviteValues.expiresAt.getTime() - before
    expect(expiresMs).toBeGreaterThan(604_800_000 - 5_000)
    expect(expiresMs).toBeLessThan(604_800_000 + 5_000)

    // The `.onConflictDoUpdate` resend-gating shape carries the SAME
    // tokenHash/expiresAt just inserted, plus `usedAt: null`.
    const onConflictMock = insertMock.mock.results[3]?.value?.onConflictDoUpdate as ReturnType<
      typeof vi.fn
    >
    expect(onConflictMock).toHaveBeenCalledTimes(1)
    const onConflictArg = onConflictMock.mock.calls[0]?.[0] as {
      set: { tokenHash: string; expiresAt: Date; usedAt: null }
    }
    expect(onConflictArg.set.tokenHash).toBe(inviteValues.tokenHash)
    expect(onConflictArg.set.usedAt).toBeNull()

    // The mailer receives the RAW token — its hash must equal the DB row's
    // tokenHash. This is the one assertion that would fail if the token
    // handed to the email were ever swapped for a different/stale one.
    expect(inviteMailer.sendInvite).toHaveBeenCalledTimes(1)
    const mailerArg = inviteMailer.sendInvite.mock.calls[0]?.[0] as { rawToken: string }
    expect(mailerArg.rawToken).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInviteToken(mailerArg.rawToken)).toBe(inviteValues.tokenHash)
  })

  it('rejects with ConflictException when the email collides with an existing user_emails row on another user', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)
    // §4.4: the row-level check is separate from the users.email check
    // (`existingUser` above stays undefined) — this simulates a collision
    // with someone else's PERSONAL address, which users.email alone can
    // never see. The mock only returns the conflict when a real predicate
    // was passed (`args?.where`), so a mutant that empties the query's
    // `where` argument is also caught — with the argument gone the mock
    // falls back to "not found" and the throw this test expects would not
    // happen, failing the assertion under that mutant too.
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (args: { where?: unknown }) =>
        args?.where
          ? Promise.resolve({ id: 'row-1', userId: 'someone-else', email: junior.email })
          : Promise.resolve(undefined),
    )

    await expect(
      service.createUser({
        email: junior.email,
        displayName: junior.displayName,
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      }),
    ).rejects.toThrow('User with this email already exists')

    // No half-created account — the rejection happens before any insert.
    expect(db.db.insert).not.toHaveBeenCalled()

    // Companion half, same test (Stryker's coverage analysis attributes
    // this file's assertEmailAvailable mutants to THIS test specifically —
    // see the comment above `mockImplementationOnce`): a mutated
    // `if (existing && …)` guard that always throws (`if (true)`) would
    // reject this SECOND, genuinely-no-conflict call too. The default mock
    // (configured in makeDb, not overridden here) resolves `undefined`, so
    // this call must succeed.
    const other = makeJunior({ id: 'junior-2', email: 'no-conflict@example.com' })
    const cleanDb = makeDb({ existingUser: undefined, createdUser: other })
    const cleanService = makeUsersService(cleanDb)
    await expect(
      cleanService.createUser({
        email: other.email,
        displayName: other.displayName,
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      }),
    ).resolves.toMatchObject({ id: other.id })
  })

  // mutation-gate closure (PR #623): `assertEmailAvailable` folds the QUERY
  // value with `.toLowerCase()` to match the DB-side `lower(...)` the
  // case-folded unique index (SR-H-1) actually applies — a mutant flipping
  // that to `.toUpperCase()` still compiles and still runs (every createUser
  // test exercises this line), but binds the WRONG value. Nothing before this
  // asserted the actual bound param, only that a `where` was present.
  it('assertEmailAvailable folds the query email to lowercase, not uppercase (matches the case-folded unique index, SR-H-1)', async () => {
    const junior = makeJunior({ email: 'Junior@Example.com' })
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      email: junior.email,
      displayName: junior.displayName,
      role: 'JUNIOR',
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
    })

    const findFirstMock = db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>
    const whereArg = (findFirstMock.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where
    expect(whereArg, 'expected assertEmailAvailable to pass a where clause').toBeDefined()
    const compiled = new PgDialect().sqlToQuery(whereArg as Parameters<PgDialect['sqlToQuery']>[0])
    expect(compiled.params).toContain(junior.email.toLowerCase())
    expect(compiled.params).not.toContain(junior.email.toUpperCase())
  })

  // mutation-gate closure (PR #623): the transaction's `if (!createdUser)
  // throw new Error(...)` guard on the insert result had zero test coverage
  // — every existing test's mock always returns a row. Defensive code, but
  // real code: a mutant collapsing the condition to `if (false)` survived
  // because nothing ever drove the "no row back" branch.
  it('throws when the users insert comes back with no row (defensive guard on an empty .returning())', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    const insertValuesChain = (
      db.db.insert as unknown as (table: unknown) => { returning: ReturnType<typeof vi.fn> }
    )(userEmails)
    insertValuesChain.returning.mockReset()
    insertValuesChain.returning.mockResolvedValueOnce([])

    await expect(
      service.createUser({
        email: junior.email,
        displayName: junior.displayName,
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      }),
    ).rejects.toThrow('Failed to create user')
  })

  // SR-M-8 (security-review PR #623 round 2, MED): the transaction wrapper
  // ITSELF — the SR-M-1 fix — had zero coverage. The reviewer reproduced this
  // by reverting `createUser` to three bare sequential statements (the
  // pre-SR-M-1 state, no `this.db.db.transaction(...)`) and re-running: 312
  // unit + 9 integration tests all stayed green. Nothing noticed, because
  // `makeDb()`'s mock `tx` shares its `insert`/`query` spies with `db.db`
  // (see the comment on `txHandle` above) — every OTHER test in this file
  // asserts on insert VALUES, which look identical whether they went through
  // `tx.insert(...)` or `this.db.db.insert(...)` directly. `db.db.transaction`
  // itself is the one call site that CANNOT be reached any other way — if the
  // wrapper is removed, this specific mock is simply never invoked.
  it('SR-M-8: createUser wraps its writes in db.transaction (removing it — the pre-SR-M-1 state — is invisible to every OTHER test here)', async () => {
    const junior = makeJunior()
    const db = makeDb({ existingUser: undefined, createdUser: junior })
    const service = makeUsersService(db)

    await service.createUser({
      email: junior.email,
      personalEmail: 'personal@example.com',
      displayName: junior.displayName,
      role: 'JUNIOR',
      actorRole: 'ADMIN',
      actorId: 'actor-test-id',
    })

    expect(db.db.transaction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// UsersService.acceptPersonalEmailInvite — task-user-emails-invite (spec §2)
//
// The 6 real-DB integration cases (user-email-invites.integration.spec.ts)
// prove this behaves correctly against real Postgres — but the mutation
// gate cannot execute an *.integration.spec.ts file at all (structural
// vitest.config.mts exclude — see mutation-gate-integration-specs.md), so
// that file's coverage does not exist from the gate's point of view: 50
// NoCoverage mutants across this exact method were reported until these
// unit-level doubles were added. Mocked db, not a duplicate of the
// integration file's assertions — this checks BRANCHING (which exception,
// which DB calls happen/don't), the integration file checks REALITY
// (actual Postgres rows, actual unique-index behaviour).
// ---------------------------------------------------------------------------

describe("UsersService.updateEmailRowGoogleId (per-row Google-identity binding, verifyOrBindGoogleIdentity's PERSONAL branch)", () => {
  it('updates the userEmails row by id with the given googleId and a fresh updatedAt', async () => {
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    const updateMock = vi.fn().mockReturnValue({ set: setMock })
    const db = { db: { update: updateMock } } as unknown as DrizzleDb
    const service = makeUsersService(db)

    await expect(service.updateEmailRowGoogleId('row-1', 'google-sub-x')).resolves.toBeUndefined()

    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ googleId: 'google-sub-x', updatedAt: expect.any(Date) }),
    )
  })
})

describe('UsersService.resendPersonalEmailInvite (spec §5, unit doubles for the integration-only branches)', () => {
  interface EmailRow {
    id: string
    email: string
    canLogin: boolean
  }

  function makeResendDb(opts: { target?: { id: string; displayName: string }; row?: EmailRow }) {
    const selectWhere = vi.fn().mockResolvedValue(opts.target ? [opts.target] : [])
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: selectWhere,
    }
    const findFirst = vi.fn().mockResolvedValue(opts.row)
    const insertValuesChain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }
    const insertMock = vi.fn().mockReturnValue(insertValuesChain)
    const dbHandle = {
      ...selectChain,
      insert: insertMock,
      query: { userEmails: { findFirst } },
    }
    return { db: { db: dbHandle } as unknown as DrizzleDb, findFirst, insertMock }
  }

  it('user not found → NotFoundException, no queries against user_emails', async () => {
    const { db, findFirst } = makeResendDb({ target: undefined })
    const service = makeUsersService(db)
    const promise = service.resendPersonalEmailInvite('ghost-id')
    await expect(promise).rejects.toBeInstanceOf(NotFoundException)
    await expect(promise).rejects.toThrow('Пользователь не найден')
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('no PERSONAL row on file → BadRequestException with the exact copy, no invite issued', async () => {
    const { db, insertMock, findFirst } = makeResendDb({
      target: { id: 'u-1', displayName: 'Ivan' },
      row: undefined,
    })
    const service = makeUsersService(db)
    const promise = service.resendPersonalEmailInvite('u-1')
    await expect(promise).rejects.toBeInstanceOf(BadRequestException)
    await expect(promise).rejects.toThrow('У пользователя не задан личный email')
    expect(insertMock).not.toHaveBeenCalled()
    // Kills the `findFirst({})` ObjectLiteral mutant (and the `kind: ''`
    // StringLiteral inside its WHERE) — a query with no WHERE clause, or one
    // that filters on kind:'' instead of kind:'PERSONAL', would match rows
    // it should not.
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }))
  })

  it('already accepted (canLogin=true) → ConflictException with the exact copy, no invite issued', async () => {
    const { db, insertMock } = makeResendDb({
      target: { id: 'u-1', displayName: 'Ivan' },
      row: { id: 'row-1', email: 'ivan.personal@gmail.com', canLogin: true },
    })
    const service = makeUsersService(db)
    const promise = service.resendPersonalEmailInvite('u-1')
    await expect(promise).rejects.toBeInstanceOf(ConflictException)
    await expect(promise).rejects.toThrow(
      'Личный email уже подтверждён — повторное приглашение не требуется',
    )
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('happy path: issues a fresh token and returns { rawToken, email, displayName } exactly', async () => {
    const { db, insertMock } = makeResendDb({
      target: { id: 'u-1', displayName: 'Ivan Petrov' },
      row: { id: 'row-1', email: 'ivan.personal@gmail.com', canLogin: false },
    })
    const service = makeUsersService(db)
    const result = await service.resendPersonalEmailInvite('u-1')

    expect(result.email).toBe('ivan.personal@gmail.com')
    expect(result.displayName).toBe('Ivan Petrov')
    expect(result.rawToken).toMatch(/^[0-9a-f]{64}$/)
    expect(insertMock).toHaveBeenCalledTimes(1)
    const values = insertMock.mock.results[0]?.value?.values as ReturnType<typeof vi.fn>
    const insertedArg = values.mock.calls[0]?.[0] as { userEmailId: string; tokenHash: string }
    expect(insertedArg.userEmailId).toBe('row-1')
    expect(insertedArg.tokenHash).toBe(hashInviteToken(result.rawToken))
  })
})

describe('UsersService.acceptPersonalEmailInvite (spec §2, unit doubles for the integration-only branches)', () => {
  interface InviteRow {
    id: string
    userEmailId: string
    usedAt: Date | null
    expiresAt: Date
  }
  interface EmailRow {
    id: string
    email: string
  }

  function makeAcceptDb(opts: { invite?: InviteRow; row?: EmailRow }) {
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    const updateMock = vi.fn().mockReturnValue({ set: setMock })
    const inviteFindFirst = vi.fn().mockResolvedValue(opts.invite)
    const emailFindFirst = vi.fn().mockResolvedValue(opts.row)
    const queryChain = {
      query: {
        userEmailInvites: { findFirst: inviteFindFirst },
        userEmails: { findFirst: emailFindFirst },
      },
    }
    const txHandle = { ...queryChain, update: updateMock }
    const dbHandle = {
      ...queryChain,
      update: updateMock,
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txHandle)),
    }
    return {
      db: { db: dbHandle } as unknown as DrizzleDb,
      updateMock,
      setMock,
      transactionMock: dbHandle.transaction,
      inviteFindFirst,
      emailFindFirst,
    }
  }

  const FUTURE = new Date(Date.now() + 1000 * 60 * 60) // 1h from now
  const PAST = new Date(Date.now() - 1000) // 1s ago

  it('token hash matches no row → NotFoundException with the exact copy, no writes, real WHERE clause built', async () => {
    const { db, transactionMock, inviteFindFirst } = makeAcceptDb({ invite: undefined })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'x@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(NotFoundException)
    await expect(promise).rejects.toThrow('Приглашение недействительно')
    expect(transactionMock).not.toHaveBeenCalled()
    // Kills the `findFirst({})` ObjectLiteral mutant — a query with no WHERE
    // clause at all would match ANY row, not "no row for this token".
    expect(inviteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    )
  })

  it('invite already used → ConflictException with the exact copy, no writes', async () => {
    const { db, transactionMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: new Date(), expiresAt: FUTURE },
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'x@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(ConflictException)
    await expect(promise).rejects.toThrow('Приглашение уже использовано')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('invite expired → BadRequestException with the exact copy, no writes', async () => {
    const { db, transactionMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: PAST },
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'x@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(BadRequestException)
    await expect(promise).rejects.toThrow('Срок действия приглашения истёк')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('boundary: an invite expiring at the EXACT current instant is not yet expired (kills the `<` → `<=` mutant)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const { db } = makeAcceptDb({
        invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: now },
        row: { id: 'row-1', email: 'real@example.com' },
      })
      const service = makeUsersService(db)
      // Real code: `expiresAt.getTime() < Date.now()` → `now < now` → false →
      // NOT expired, proceeds to the happy path. The `<=` mutant would throw
      // BadRequestException here instead.
      await expect(
        service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1'),
      ).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the user_emails row the invite points at is gone (defensive) → NotFoundException with the exact copy, no writes, real WHERE clause built', async () => {
    const { db, transactionMock, emailFindFirst } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: undefined,
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'x@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(NotFoundException)
    await expect(promise).rejects.toThrow('Приглашение недействительно')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(emailFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    )
  })

  it('Google email does not match the invited address → ForbiddenException with the exact copy, no writes', async () => {
    const { db, transactionMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com' },
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'wrong@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(ForbiddenException)
    await expect(promise).rejects.toThrow(
      'Адрес аккаунта Google не совпадает с приглашённым адресом',
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('email match is case-insensitive (mirrors the case-folded unique index — SR-H-1 precedent)', async () => {
    const { db, transactionMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'Real@Example.com' },
    })
    const service = makeUsersService(db)
    await expect(
      service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1'),
    ).resolves.toBeUndefined()
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it('happy path: one transaction, marks the invite used AND flips canLogin/verifiedAt/googleId on the row', async () => {
    const { db, transactionMock, updateMock, setMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com' },
    })
    const service = makeUsersService(db)
    await expect(
      service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-42'),
    ).resolves.toBeUndefined()

    expect(transactionMock).toHaveBeenCalledTimes(1)
    // Two updates inside the one transaction: the invite row, then the
    // user_emails row.
    expect(updateMock).toHaveBeenCalledTimes(2)
    expect(setMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ usedAt: expect.any(Date) }),
    )
    expect(setMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ canLogin: true, googleId: 'sub-42', verifiedAt: expect.any(Date) }),
    )
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
    // insert: users + user_emails WORK row (§4.4) + teams + teamMembers(senior only)
    expect(insertMock).toHaveBeenCalledTimes(4)
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
    // insert: users + user_emails WORK row (§4.4) + teams + teamMembers(senior)
    // + teamMembers(hr-1) + teamMembers(hr-2) + teamMembers(acc-1) = 7
    expect(insertMock).toHaveBeenCalledTimes(7)
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
    // insert: users + user_emails WORK row (§4.4) + teams + teamMembers(senior)
    // + teamMembers(hr-1) = 5
    expect(insertMock).toHaveBeenCalledTimes(5)
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
      // users + user_emails WORK row (§4.4)
      expect(insertMock).toHaveBeenCalledTimes(2)
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

  // §4.4 (task-user-emails-dual-login): the WORK row in user_emails must
  // stay in sync with users.email, or login for that user silently breaks
  // (findLoginableUserByEmail reads user_emails, not users.email).
  it('email change triggers the user_emails WORK-row sync', async () => {
    const existing = makeUser({ id: 'user-1', email: 'old@example.com' })
    const updated = makeUser({ id: 'user-1', email: 'new@example.com' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await service.adminUpdateUser('user-1', { email: 'new@example.com' })

    // 2 calls: assertEmailAvailable's pre-check (before the tx) +
    // upsertWorkEmail's find-existing-WORK-row lookup (inside the tx). A
    // mutated `data.email !== existing.email` guard that always skips the
    // sync would leave this at 1.
    const findFirstMock = db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>
    expect(findFirstMock).toHaveBeenCalledTimes(2)

    // mutation-gate closure (PR #623): upsertWorkEmail's own lookup (2nd
    // call) must pass a REAL where clause filtering kind = 'WORK' — a
    // mutant emptying the whole call to `.findFirst({})` (ObjectLiteral) or
    // blanking the literal to `''` (StringLiteral) both still resolve via
    // this mock (which ignores its args), so only inspecting the ACTUAL
    // compiled where clause catches either.
    const upsertLookupArgs = findFirstMock.mock.calls[1]?.[0] as { where?: unknown } | undefined
    expect(
      upsertLookupArgs?.where,
      'expected upsertWorkEmail to pass a where clause, not {}',
    ).toBeDefined()
    const compiledUpsertWhere = new PgDialect().sqlToQuery(
      upsertLookupArgs!.where as Parameters<PgDialect['sqlToQuery']>[0],
    )
    expect(compiledUpsertWhere.params).toContain('WORK')
    expect(compiledUpsertWhere.params).toContain('user-1')

    // No existing WORK row was found (default mock) → upsertWorkEmail takes
    // the INSERT branch. Assert its exact shape — a mutant that empties the
    // values object, or flips kind/canLogin, would leave this looking like
    // any other insert call.
    const insertValuesMock = (db.db.insert as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
      ?.values as ReturnType<typeof vi.fn>
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        email: 'new@example.com',
        kind: 'WORK',
        canLogin: true,
      }),
    )
  })

  it('does NOT touch user_emails when email is unchanged', async () => {
    const existing = makeUser({ id: 'user-1', email: 'same@example.com' })
    const updated = makeUser({ id: 'user-1', email: 'same@example.com' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await service.adminUpdateUser('user-1', { displayName: 'Just a name change' })

    expect(db.db.query.userEmails.findFirst).not.toHaveBeenCalled()
  })

  it('resubmitting the SAME email value (present in the payload, unchanged) does not touch user_emails either', async () => {
    // Distinct from the test above: here `email` IS present in the payload
    // (`data.email !== undefined` is true) but equals the current value — a
    // mutated `data.email !== existing.email` that is forced to always-true
    // would still fire the sync for this resubmit; the correct code must not.
    const existing = makeUser({ id: 'user-1', email: 'same@example.com' })
    const updated = makeUser({ id: 'user-1', email: 'same@example.com' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await service.adminUpdateUser('user-1', { email: 'same@example.com', displayName: 'Resave' })

    expect(db.db.query.userEmails.findFirst).not.toHaveBeenCalled()
  })

  it('email change UPDATES the existing WORK row when one is already on file (not a duplicate insert)', async () => {
    const existing = makeUser({ id: 'user-1', email: 'old@example.com' })
    const updated = makeUser({ id: 'user-1', email: 'new@example.com' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    // upsertWorkEmail's own lookup (the 2nd findFirst call — the 1st is
    // assertEmailAvailable's pre-check) finds an existing WORK row, so it
    // must take the UPDATE branch, not INSERT a second one.
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // assertEmailAvailable: no conflict
      .mockResolvedValueOnce({ id: 'row-1', userId: 'user-1', kind: 'WORK' }) // upsertWorkEmail: found
    const service = makeUsersService(db)

    await service.adminUpdateUser('user-1', { email: 'new@example.com' })

    // A found existing WORK row must route through UPDATE, not INSERT — a
    // mutated `if (existing)` guard that always takes the else-branch would
    // insert a duplicate row instead (and never call .update(userEmails)).
    const updateMock = db.db.update as ReturnType<typeof vi.fn>
    expect(updateMock).toHaveBeenCalledWith(userEmails)

    const insertMock = db.db.insert as ReturnType<typeof vi.fn>
    const userEmailsInsertCalls = insertMock.mock.calls.filter((c) => c[0] === userEmails)
    expect(userEmailsInsertCalls).toHaveLength(0)

    // mutation-gate closure (PR #623): `workRowUpdate = { email, updatedAt:
    // new Date() }` mutated to `{}` still routes through `.set()` (the
    // UPDATE-vs-INSERT branch check above already passes under that
    // mutant) — only the PAYLOAD is empty. `.update()` is a single shared
    // mock across BOTH this update (userEmails) and the main user-row
    // update (`updateUserRow`), so a naive "find a 2-key call" check is NOT
    // enough to isolate upsertWorkEmail's own call: for THIS minimal
    // payload (`{ email }` only), `updateUserRow`'s own `set` ALSO ends up
    // exactly `{ email, updatedAt }` — 2 keys, same shape, same values
    // (confirmed by reading `updateUserRow`: every other field is `if
    // (data.X !== undefined)`-gated and `data` here carries only `email`).
    // What's fixed is the ORDER, not the shape: `adminUpdateUser` calls
    // `updateUserRow` (the main table) BEFORE `upsertWorkEmail` — see the
    // tx body — so `.set()`'s SECOND call is unambiguously upsertWorkEmail's,
    // regardless of what the first one happens to look like this run.
    const setMock = (updateMock.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> }).set
    expect(setMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const workEmailSetArg = setMock.mock.calls[1]?.[0] as Record<string, unknown>
    expect(workEmailSetArg).toEqual({ email: 'new@example.com', updatedAt: expect.any(Date) })
  })

  // SR-M-3 (security-review PR #623, MED): `assertEmailAvailable`'s
  // `isOwnRow` guard (`existing.userId === excludeUserId`) used to live
  // inside one compound `if`, under a single Stryker suppression that
  // covered every mutation of the whole condition at once. It is now two
  // independent `if` statements specifically so each can be pinned on its
  // own — this is the pin for the SECOND one: a row already exists, but it
  // belongs to the SAME user the write is for, so the APP-LEVEL check must
  // let it through (return, not throw) and let the actual write proceed.
  // Every REAL caller in this codebase happens to hit a genuine DB
  // constraint immediately afterward when this branch is taken (see
  // user-emails-uniqueness.integration.spec.ts's SR-M-2 test) — which means
  // an end-to-end test alone cannot tell "the app-level check correctly
  // passed through, then the DB legitimately objected" apart from "the
  // app-level check incorrectly objected on its own": both produce the same
  // ConflictException. Only a mocked unit test, where the write is made to
  // SUCCEED, can observe the pass-through in isolation — which is the
  // entire point of this test.
  it('SR-M-3: does NOT throw when the only existing row for that email belongs to the SAME user (isOwnRow pass-through)', async () => {
    const existing = makeUser({ id: 'user-1', email: 'old@example.com' })
    const updated = makeUser({ id: 'user-1', email: 'shared@example.com' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    // assertEmailAvailable's pre-check finds a row — but its userId is the
    // SAME 'user-1' that adminUpdateUser is called for (excludeUserId).
    // A mutant flipping `===` to `!==`, or negating either `if`, would
    // make this call throw ConflictException instead of resolving.
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'row-other-kind', userId: 'user-1', kind: 'PERSONAL' }) // assertEmailAvailable: own row, different kind
      .mockResolvedValueOnce(undefined) // upsertWorkEmail: no existing WORK row → insert branch
    const service = makeUsersService(db)

    await expect(
      service.adminUpdateUser('user-1', { email: 'shared@example.com' }),
    ).resolves.toMatchObject({ id: 'user-1' })
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
        // §4.4: buildProfileView's personalEmail lookup — no PERSONAL row by
        // default (most of these tests don't care about it either way).
        query: { userEmails: { findFirst: vi.fn().mockResolvedValue(undefined) } },
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
  /**
   * Reuse the same factory pattern as the legalFullName block above.
   * `personalEmailRow` — §4.4: what `db.query.userEmails.findFirst` returns
   * for the target's PERSONAL row. `undefined` (default) = none on file.
   * Only returned when a real `where` predicate was passed — a mutant that
   * empties that argument falls back to "not found" here too, so it cannot
   * hide behind a mock that ignores its own input.
   */
  function makeServicePii(
    target: ReturnType<typeof makeUser>,
    permissions: { tabs: string[]; actions: string[]; fields: Record<string, boolean> },
    personalEmailRow?: { email: string },
  ): UsersService {
    const db = {
      db: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([target]),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        // §4.4: buildProfileView's personalEmail lookup.
        query: {
          userEmails: {
            findFirst: vi
              .fn()
              .mockImplementation((args: { where?: unknown }) =>
                args?.where && personalEmailRow
                  ? Promise.resolve(personalEmailRow)
                  : Promise.resolve(undefined),
              ),
          },
        },
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

  // §4.4 (task-user-emails-dual-login): personalEmail is gated by its OWN
  // `personalContact` flag, NOT `realContacts` — security-review PR #623
  // (SR-M-4) found the two conflated: HR gets `realContacts=true` for a
  // teammate (see the isHr branch in users-access.service.ts) but is
  // deliberately barred from ever SETTING personalEmail
  // (UsersController.createUser forces it null for an HR actor) — reading
  // it through the wider flag let HR see what it cannot write. This block
  // pins BOTH the positive case and, separately, that realContacts alone
  // (without personalContact) does NOT unlock it — the exact shape of the
  // regression that shipped.
  describe('personalEmail (§4.4, gated by personalContact — SR-M-4)', () => {
    const fullAccessPermissions = {
      tabs: ['overview'],
      actions: [],
      fields: { realContacts: true, personalContact: true },
    }

    it('returns the PERSONAL row email when the viewer has personalContact access and one exists', async () => {
      const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
      const service = makeServicePii(seniorTarget, fullAccessPermissions, {
        email: 'personal@example.com',
      })
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      expect((result.user as Record<string, unknown>).personalEmail).toBe('personal@example.com')
    })

    it('is null when no PERSONAL row exists, even with full access', async () => {
      const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
      const service = makeServicePii(seniorTarget, fullAccessPermissions)
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      expect((result.user as Record<string, unknown>).personalEmail).toBeNull()
    })

    it('is null when the viewer lacks ALL contact access, even though a PERSONAL row exists', async () => {
      const viewer = makeJunior({ id: 'junior-viewer' })
      const noContactsPermissions = {
        tabs: ['overview'],
        actions: [],
        fields: { realContacts: false, personalContact: false },
      }
      const service = makeServicePii(seniorTarget, noContactsPermissions, {
        email: 'personal@example.com',
      })
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      expect((result.user as Record<string, unknown>).personalEmail).toBeNull()
    })

    it('SR-M-4 regression: realContacts=true WITHOUT personalContact does NOT unlock it (the HR case)', async () => {
      const viewer = makeUser({ id: 'hr-id', role: 'HR' })
      // Mirrors what users-access.service.ts actually hands HR viewing a
      // teammate: realContacts=true, personalContact left at its `false`
      // default (never set in the isHr branch).
      const hrTeammatePermissions = {
        tabs: ['overview', 'team'],
        actions: [],
        fields: { realContacts: true },
      }
      const service = makeServicePii(seniorTarget, hrTeammatePermissions, {
        email: 'personal@example.com',
      })
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      // The regular email field DOES show (realContacts=true) — only
      // personalEmail is masked. Proves the fields are independently gated,
      // not that everything got locked down together.
      expect((result.user as Record<string, unknown>).email).toBe(seniorTarget.email)
      expect((result.user as Record<string, unknown>).personalEmail).toBeNull()
    })
  })

  // UX-M-1 (design-gate audit, PR #623): before `personalContactVisible`
  // existed, "no access to this field" and "field is genuinely empty" both
  // produced the exact same wire value — `personalEmail: null`,
  // `personalEmailCanLogin: null` — leaving a viewer with real access (e.g.
  // ADMIN on a user who never got a personal address) indistinguishable,
  // over the API, from a viewer masked from the field entirely (ACCOUNTANT,
  // or HR outside their own team). Both branches below are RED against that
  // older shape (comment out `personalContactVisible` in
  // `buildProfileView` to reproduce — both assertions on that field fail;
  // the SIBLING `null` assertions stay green either way, which is exactly
  // the ambiguity this pins).
  describe('personalContactVisible (UX-M-1) — "no access" vs "not set" are distinguishable', () => {
    it('no access: personalContactVisible is false (the ACCOUNTANT/masked case)', async () => {
      const viewer = makeUser({ id: 'accountant-id', role: 'ACCOUNTANT' })
      const noContactsPermissions = {
        tabs: ['overview'],
        actions: [],
        fields: { realContacts: true, personalContact: false },
      }
      // A PERSONAL row EXISTS on the target — access is what is being denied
      // here, not absence of data. If the two states collapsed to the same
      // `null` (the pre-fix bug), this test could not tell that apart from
      // the "empty" case below even though the underlying situation is the
      // opposite (data present, viewer blind to it).
      const service = makeServicePii(seniorTarget, noContactsPermissions, {
        email: 'personal@example.com',
      })
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      const user = result.user as Record<string, unknown>
      expect(user.personalContactVisible).toBe(false)
      expect(user.personalEmail).toBeNull()
      expect(user.personalEmailCanLogin).toBeNull()
    })

    it('empty: personalContactVisible is true, personalEmail/personalEmailCanLogin are null because nothing is set', async () => {
      const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
      const fullAccessPermissions = {
        tabs: ['overview'],
        actions: [],
        fields: { realContacts: true, personalContact: true },
      }
      // No third arg — makeServicePii defaults `personalEmailRow` to
      // undefined (see its own doc), i.e. the target genuinely has no
      // PERSONAL row on file.
      const service = makeServicePii(seniorTarget, fullAccessPermissions)
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      const user = result.user as Record<string, unknown>
      expect(user.personalContactVisible).toBe(true)
      expect(user.personalEmail).toBeNull()
      expect(user.personalEmailCanLogin).toBeNull()
    })
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
        // §4.4: buildProfileView's personalEmail lookup.
        query: { userEmails: { findFirst: vi.fn().mockResolvedValue(undefined) } },
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
