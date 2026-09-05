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
import { userEmails, userEmailInvites } from '../database/schema'
import { REDACTED_TOKEN, type AuditLogService } from './audit-log.service'
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

// task-pending-share (position 5): `ApprovalsService` — injectable (defaults
// to a stub reporting 'NONE') for the SAME reason `auditLogService` above
// is: `buildProfileView` (`getStatus`) and `adminUpdateUser`/`changeSalary`
// (`proposeInTx`) reach it now, and specific tests below need to assert ON
// or CONTROL those calls.
const makeApprovalsService = () =>
  ({
    getStatus: vi.fn().mockResolvedValue('NONE'),
    proposeInTx: vi.fn().mockResolvedValue(undefined),
    approveInTx: vi.fn().mockResolvedValue(undefined),
    rejectInTx: vi.fn().mockResolvedValue(undefined),
    // task-648-fix-round-1 (SR-H-1): default "nothing open to cancel"
    // (matches this harness's own `getStatus: 'NONE'` default) — tests with
    // a live proposal override this per-case.
    cancelInTx: vi
      .fn()
      .mockRejectedValue(new NotFoundException('Подтверждение не найдено или уже закрыто')),
  }) as never

// `auditLogService` is injectable (defaults to a fresh stub) — SR-M-12 /
// personal_email_changed tests below need to assert ON that specific call,
// which a freshly-constructed internal stub they cannot reach would not let
// them do; every pre-existing call site keeps passing a single `db` arg.
const makeUsersService = (
  db: DrizzleDb,
  auditLogService?: AuditLogService,
  approvalsService?: unknown,
): UsersService =>
  new UsersService(
    db as never,
    makeAccessService() as never,
    (auditLogService ?? makeAuditLogService()) as never,
    makeTosService(),
    makeTeamAuditLogService(),
    makeProjectAuditLogService(),
    makeTeamsService(),
    makeInviteMailer(),
    (approvalsService ?? makeApprovalsService()) as never,
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
// writeUserEmailOrConflict (SR-M-2) — exercised directly, not just through
// its callers. Every caller (createUser's two inserts, changePersonalEmail's
// one) always passes a write that succeeds in every OTHER test in this file
// — the catch branch itself (a real 23505 → ConflictException, anything
// else → rethrown as-is) had never actually run.
// ---------------------------------------------------------------------------

describe('UsersService.writeUserEmailOrConflict (SR-M-2, private helper exercised directly)', () => {
  function accessPrivateHelper(service: UsersService) {
    return service as unknown as {
      writeUserEmailOrConflict: <T>(write: () => Promise<T>) => Promise<T>
    }
  }

  it('a real Postgres unique-violation (23505) becomes a clean ConflictException', async () => {
    const db = makeDb({ existingUser: undefined, createdUser: makeJunior() })
    const service = accessPrivateHelper(makeUsersService(db))
    const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    })

    await expect(
      service.writeUserEmailOrConflict(() => Promise.reject(violation)),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(service.writeUserEmailOrConflict(() => Promise.reject(violation))).rejects.toThrow(
      'Этот адрес уже используется — введите другой.',
    )
  })

  it('a non-unique-violation error is rethrown unchanged, not swallowed into a 409', async () => {
    const db = makeDb({ existingUser: undefined, createdUser: makeJunior() })
    const service = accessPrivateHelper(makeUsersService(db))
    const otherError = new Error('connection reset by peer')

    await expect(service.writeUserEmailOrConflict(() => Promise.reject(otherError))).rejects.toBe(
      otherError,
    )
  })

  it('a successful write passes its result straight through', async () => {
    const db = makeDb({ existingUser: undefined, createdUser: makeJunior() })
    const service = accessPrivateHelper(makeUsersService(db))

    await expect(service.writeUserEmailOrConflict(() => Promise.resolve('ok'))).resolves.toBe('ok')
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
      makeApprovalsService() as never,
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
      // COPY-H-5 (security-review PR #623 round 5): assertEmailAvailable's
      // message is Russian now — this is the SAME shared function
      // changePersonalEmail calls, translated once for every caller.
    ).rejects.toThrow('Этот адрес уже занят другим пользователем.')

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

  // mutation-gate closure (PR #623 round 4): mirrors the test above, one
  // insert later — the PERSONAL row's OWN `.returning()` coming back empty
  // (defensive `if (personalRow)` guard, line ~583) had zero coverage,
  // because every other test's shared mock always returns a truthy row here
  // too. Also the ONLY test that drives `data.personalEmail && personalInviteToken`
  // (the post-transaction invite-send guard) with the token half FALSE while
  // personalEmail is TRUE — the one combination that can actually occur in
  // this control flow and the one that distinguishes `&&` from `||` from an
  // always-true condition on that guard.
  it('personal-row insert returns no row (defensive guard on an empty .returning()) — user is still created, no invite is issued', async () => {
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
      makeApprovalsService() as never,
    )

    // 1st `.returning()` call (inside makeDb) already resolves [createdUser]
    // for the `users` insert — this queues the NEXT one, consumed by the
    // PERSONAL row insert that immediately follows it.
    const insertValuesChain = (
      db.db.insert as unknown as (table: unknown) => { returning: ReturnType<typeof vi.fn> }
    )(userEmails)
    insertValuesChain.returning.mockResolvedValueOnce([])

    await expect(
      service.createUser({
        email: junior.email,
        personalEmail: 'personal@example.com',
        displayName: junior.displayName,
        role: 'JUNIOR',
        actorRole: 'ADMIN',
        actorId: 'actor-test-id',
      }),
    ).resolves.toMatchObject({ id: junior.id })

    expect(inviteMailer.sendInvite).not.toHaveBeenCalled()
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
    const promise = service.resendPersonalEmailInvite('ghost-id', 'actor-1')
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
    const promise = service.resendPersonalEmailInvite('u-1', 'actor-1')
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
    const promise = service.resendPersonalEmailInvite('u-1', 'actor-1')
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
    const result = await service.resendPersonalEmailInvite('u-1', 'actor-1')

    expect(result.email).toBe('ivan.personal@gmail.com')
    expect(result.displayName).toBe('Ivan Petrov')
    expect(result.rawToken).toMatch(/^[0-9a-f]{64}$/)
    expect(insertMock).toHaveBeenCalledTimes(1)
    const values = insertMock.mock.results[0]?.value?.values as ReturnType<typeof vi.fn>
    const insertedArg = values.mock.calls[0]?.[0] as { userEmailId: string; tokenHash: string }
    expect(insertedArg.userEmailId).toBe('row-1')
    expect(insertedArg.tokenHash).toBe(hashInviteToken(result.rawToken))
  })

  // SR-M-12 (security-review PR #623 round 4): the resend endpoint was the
  // ONLY write on UsersController with no audit trail. Written directly via
  // AuditLogService.record() — NOT the @AuditLog decorator, whose automatic
  // before/after diff only ever looks at the `users` TABLE row, which this
  // write never touches (only `user_email_invites` does) — see the method's
  // own doc for why that decorator would have recorded nothing.
  it('writes its own audit record (actorId threaded through, no @AuditLog decorator to rely on)', async () => {
    const { db } = makeResendDb({
      target: { id: 'u-1', displayName: 'Ivan Petrov' },
      row: { id: 'row-1', email: 'ivan.personal@gmail.com', canLogin: false },
    })
    const auditLogService = makeAuditLogService()
    const service = makeUsersService(db, auditLogService)
    await service.resendPersonalEmailInvite('u-1', 'admin-7')

    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-7',
        targetId: 'u-1',
        action: 'personal_email_invite_resend',
        // mutation-gate closure (PR #623 round 4): the previous assertion
        // only checked WHO/WHAT-target/WHICH-action — an audit record with
        // `changes: {}` (a raw token literally left in the record, or the
        // record shape silently emptied) would have passed it unnoticed.
        changes: { personalEmailInvite: { before: REDACTED_TOKEN, after: REDACTED_TOKEN } },
      }),
    )
  })
})

describe('UsersService.changePersonalEmail (security-review PR #623 round 4, owner decision)', () => {
  interface ExistingRow {
    id: string
    email: string
  }

  function makeChangeDb(opts: {
    target?: { id: string; email: string; displayName: string }
    existingRow?: ExistingRow
    assertConflict?: boolean
  }) {
    const selectWhere = vi.fn().mockResolvedValue(opts.target ? [opts.target] : [])
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: selectWhere,
    }

    // Two DIFFERENT db.query.userEmails.findFirst call sites are exercised
    // in sequence by the real method: (1) the existing-PERSONAL-row lookup,
    // (2) assertEmailAvailable's own lookup (only reached when a real
    // change is being made to a non-colliding address) — same underlying
    // mock function, call-count-ordered, mirrors `makeDb`'s own
    // selectCallCount convention elsewhere in this file.
    let findFirstCalls = 0
    const findFirst = vi.fn().mockImplementation(() => {
      findFirstCalls++
      if (findFirstCalls === 1) return Promise.resolve(opts.existingRow)
      return Promise.resolve(
        opts.assertConflict ? { userId: 'someone-else', email: 'conflict@example.com' } : undefined,
      )
    })

    const deleteWhere = vi.fn().mockResolvedValue(undefined)
    const deleteMock = vi.fn().mockReturnValue({ where: deleteWhere })

    const newRowReturning = vi.fn().mockResolvedValue([{ id: 'new-row-id' }])
    const insertValuesChain = {
      values: vi.fn().mockReturnThis(),
      returning: newRowReturning,
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }
    const insertMock = vi.fn().mockReturnValue(insertValuesChain)

    const queryChain = { query: { userEmails: { findFirst } } }
    const txHandle = { ...queryChain, delete: deleteMock, insert: insertMock }
    const dbHandle = {
      ...selectChain,
      ...queryChain,
      delete: deleteMock,
      insert: insertMock,
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txHandle)),
    }
    return {
      db: { db: dbHandle } as unknown as DrizzleDb,
      deleteMock,
      deleteWhere,
      insertMock,
      newRowReturning,
      findFirst,
      transactionMock: dbHandle.transaction,
    }
  }

  it('user not found → NotFoundException, nothing touched', async () => {
    const { db, transactionMock } = makeChangeDb({ target: undefined })
    const service = makeUsersService(db)
    const promise = service.changePersonalEmail('ghost-id', 'x@example.com', 'admin-1')
    await expect(promise).rejects.toBeInstanceOf(NotFoundException)
    await expect(promise).rejects.toThrow('Пользователь не найден')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('no-op: resubmitting the SAME address as the existing row → returns null, no transaction, no audit', async () => {
    const { db, transactionMock } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: { id: 'row-1', email: 'personal@example.com' },
    })
    const auditLogService = makeAuditLogService()
    const service = makeUsersService(db, auditLogService)
    const result = await service.changePersonalEmail('u-1', 'personal@example.com', 'admin-1')
    expect(result).toBeNull()
    expect(transactionMock).not.toHaveBeenCalled()
    expect(auditLogService.record).not.toHaveBeenCalled()
  })

  // mutation-gate closure (PR #623 round 4): the existing-row lookup
  // (`db.db.query.userEmails.findFirst({ where: and(eq(userId), eq(kind,
  // 'PERSONAL')) })`) had no assertion on its call shape anywhere in this
  // describe block — a mutant emptying the WHERE entirely (`findFirst({})`)
  // would match ANY row for ANY user, not specifically this user's PERSONAL
  // row, and every existing test's mock is call-order-based, not
  // WHERE-based, so none of them would have noticed.
  it('the existing-row lookup is called with a real WHERE clause (kills the findFirst({}) ObjectLiteral mutant)', async () => {
    const { db, findFirst } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: { id: 'row-1', email: 'personal@example.com' },
    })
    const service = makeUsersService(db)
    await service.changePersonalEmail('u-1', 'personal@example.com', 'admin-1')
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }))
  })

  it('no-op: no existing row and newEmail=null (nothing to remove) → returns null, no transaction', async () => {
    const { db, transactionMock } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: undefined,
    })
    const service = makeUsersService(db)
    const result = await service.changePersonalEmail('u-1', null, 'admin-1')
    expect(result).toBeNull()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('newEmail equal to the WORK address (case-insensitive) → BadRequestException, no transaction', async () => {
    const { db, transactionMock } = makeChangeDb({
      target: { id: 'u-1', email: 'Work@Example.com', displayName: 'Ivan' },
      existingRow: { id: 'row-1', email: 'personal@example.com' },
    })
    const service = makeUsersService(db)
    const promise = service.changePersonalEmail('u-1', 'work@example.com', 'admin-1')
    await expect(promise).rejects.toBeInstanceOf(BadRequestException)
    await expect(promise).rejects.toThrow('Личный email должен отличаться от рабочего')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('newEmail already in use by another row → ConflictException, no transaction', async () => {
    const { db, transactionMock } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: { id: 'row-1', email: 'personal@example.com' },
      assertConflict: true,
    })
    const service = makeUsersService(db)
    const promise = service.changePersonalEmail('u-1', 'taken@example.com', 'admin-1')
    await expect(promise).rejects.toBeInstanceOf(ConflictException)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('removal (newEmail=null, existing row present) → deletes the row, does NOT insert, returns null, writes audit', async () => {
    const { db, transactionMock, deleteMock, insertMock } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: { id: 'row-1', email: 'personal@example.com' },
    })
    const auditLogService = makeAuditLogService()
    const service = makeUsersService(db, auditLogService)
    const result = await service.changePersonalEmail('u-1', null, 'admin-1')

    expect(result).toBeNull()
    expect(transactionMock).toHaveBeenCalledTimes(1)
    // Revocation: the OLD row is DELETED — not updated, not left in place.
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(insertMock).not.toHaveBeenCalled()
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        targetId: 'u-1',
        action: 'personal_email_changed',
        // mutation-gate closure (PR #623 round 4): kills the `changes: {}`
        // / `changes: { personalEmail: {} }` ObjectLiteral mutants.
        changes: { personalEmail: { before: REDACTED_TOKEN, after: REDACTED_TOKEN } },
      }),
    )
  })

  it('add (no existing row, newEmail provided) → no delete, inserts the new row + issues an invite token', async () => {
    const { db, transactionMock, deleteMock, insertMock, newRowReturning } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: undefined,
    })
    const service = makeUsersService(db)
    const result = await service.changePersonalEmail('u-1', 'new@example.com', 'admin-1')

    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).not.toHaveBeenCalled()
    // Two inserts inside the transaction: the PERSONAL row, then its invite token.
    expect(insertMock).toHaveBeenCalledTimes(2)
    expect(newRowReturning).toHaveBeenCalledTimes(1)
    // mutation-gate closure (PR #623 round 4): the actual VALUES the row was
    // inserted with had no assertion — unlike the `findFirst` WHERE lookups
    // above, `.values({...})` receives a plain object straight from a mocked
    // vi.fn(), so this DOES distinguish a real value from an emptied/wrong one.
    const insertValuesMock = insertMock.mock.results[0]?.value?.values as ReturnType<typeof vi.fn>
    expect(insertValuesMock).toHaveBeenCalledWith({
      userId: 'u-1',
      email: 'new@example.com',
      kind: 'PERSONAL',
    })
    expect(result?.email).toBe('new@example.com')
    expect(result?.displayName).toBe('Ivan')
    expect(result?.rawToken).toMatch(/^[0-9a-f]{64}$/)
  })

  // mutation-gate closure (PR #623 round 4): mirrors createUser's identical
  // defensive-guard gap — the new PERSONAL row's OWN `.returning()` coming
  // back empty had zero coverage (`if (row)` at the insert site, and the
  // post-transaction `if (newEmail && personalInviteToken)` gate one step
  // later) — every other test's mock always returns a row here.
  it('new-row insert returns no row (defensive guard) → no invite token issued, method returns null despite newEmail being set', async () => {
    const { db, newRowReturning } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: undefined,
    })
    newRowReturning.mockResolvedValueOnce([])
    const service = makeUsersService(db)
    await expect(
      service.changePersonalEmail('u-1', 'new@example.com', 'admin-1'),
    ).resolves.toBeNull()
  })

  it('change (existing row present, DIFFERENT newEmail) → deletes the OLD row AND inserts a fresh one — revocation is unconditional', async () => {
    const { db, transactionMock, deleteMock, insertMock } = makeChangeDb({
      target: { id: 'u-1', email: 'work@example.com', displayName: 'Ivan' },
      existingRow: { id: 'old-row-id', email: 'old-personal@example.com' },
    })
    const auditLogService = makeAuditLogService()
    const service = makeUsersService(db, auditLogService)
    const result = await service.changePersonalEmail('u-1', 'new-personal@example.com', 'admin-1')

    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledTimes(2)
    expect(result?.email).toBe('new-personal@example.com')
    expect(auditLogService.record).toHaveBeenCalledTimes(1)
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
    userId?: string
  }

  /**
   * `owner` backs `this.findById(row.userId)` (LOW-2, security-review PR
   * #623 round 4) — defaults to an ACTIVE (non-archived) user so every
   * pre-existing test in this block reaches the transaction unchanged;
   * pass `{ archivedAt: new Date() }` to exercise the archived branch.
   *
   * SR-H-5 (security-review PR #623 round 5): the transaction now writes
   * `user_emails` FIRST, `user_email_invites` SECOND (reversed from before
   * — see `acceptPersonalEmailInvite`'s own comment for the deadlock this
   * removes) — so `googleIdConflict: true` makes the FIRST
   * `.update(userEmails)...where()` (LOW-1, the only one that can hit
   * `idx_user_emails_google_id`) reject with a fake Postgres
   * unique-violation, mirroring what `uniqueViolationConstraint` actually
   * walks (`.code`/`.constraint`, real driver shape).
   *
   * `.where()` now also returns `.returning()` (SR-L-3, round 5) — both
   * updates use it to detect a raced zero-row UPDATE. `emailReturningRows`/
   * `inviteReturningRows` default to one row (the ordinary case); pass `[]`
   * to simulate the row having vanished between the pre-transaction read
   * and this UPDATE.
   */
  function makeAcceptDb(opts: {
    invite?: InviteRow
    row?: EmailRow
    owner?: { archivedAt: Date | null } | null
    googleIdConflict?: boolean
    /** Same shape as googleIdConflict but an UNRECOGNISED constraint name —
     * exercises the "rethrow, do not mislabel" branch (pg-errors.ts's doc). */
    unrecognizedConflict?: boolean
    /** SR-L-3: defaults to `[{ id: 'row-1' }]` — pass `[]` to simulate the
     * `user_emails` row having been deleted by a concurrent revoke. */
    emailReturningRows?: Array<{ id: string }>
    /** SR-L-3: defaults to `[{ id: 'inv-1' }]` — pass `[]` for the
     * defense-in-depth branch (see that check's own comment for why it is
     * not reachable via any real path once the lock-order fix is in place). */
    inviteReturningRows?: Array<{ id: string }>
  }) {
    let setCallCount = 0
    const conflictConstraint = opts.googleIdConflict
      ? 'idx_user_emails_google_id'
      : opts.unrecognizedConflict
        ? 'some_other_index'
        : null
    const emailReturningRows = opts.emailReturningRows ?? [{ id: 'row-1' }]
    const inviteReturningRows = opts.inviteReturningRows ?? [{ id: 'inv-1' }]
    // Captured in call order (1st = user_emails, 2nd = user_email_invites)
    // so a test can inspect what COLUMNS each `.returning(...)` call asked
    // for, not just what rows it resolved to — the mock itself ignores its
    // argument (same call-order convention as `makeDb`'s own `findFirst`
    // elsewhere in this file), so only reading the ACTUAL argument catches
    // a mutant that empties it (`.returning({ id: ... })` → `.returning({})`).
    const returningMocks: ReturnType<typeof vi.fn>[] = []
    const setMock = vi.fn().mockImplementation(() => {
      setCallCount++
      // SR-H-5: call 1 = user_emails (canLogin/googleId/verifiedAt), call 2
      // = user_email_invites (usedAt) — reversed from before this fix.
      const isFirstCall = setCallCount === 1
      if (isFirstCall && conflictConstraint) {
        const returningMock = vi.fn().mockRejectedValue(
          Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
            constraint: conflictConstraint,
          }),
        )
        returningMocks.push(returningMock)
        return {
          where: vi.fn().mockReturnValue({ returning: returningMock }),
        }
      }
      const returningRows = isFirstCall ? emailReturningRows : inviteReturningRows
      const returningMock = vi.fn().mockResolvedValue(returningRows)
      returningMocks.push(returningMock)
      return {
        where: vi.fn().mockReturnValue({ returning: returningMock }),
      }
    })
    const updateMock = vi.fn().mockReturnValue({ set: setMock })
    const inviteFindFirst = vi.fn().mockResolvedValue(opts.invite)
    const emailFindFirst = vi.fn().mockResolvedValue(opts.row)
    const queryChain = {
      query: {
        userEmailInvites: { findFirst: inviteFindFirst },
        userEmails: { findFirst: emailFindFirst },
      },
    }
    // findById's `.select().from(users).where(...)` chain — `owner` is
    // `undefined` by default meaning "active user" (matches every
    // pre-existing test, none of which set it), `null` explicitly means
    // "no row found" (defensive/unreachable in practice).
    const ownerRow = opts.owner === null ? undefined : (opts.owner ?? { archivedAt: null })
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(ownerRow ? [ownerRow] : []),
      }),
    })
    const txHandle = { ...queryChain, update: updateMock }
    const dbHandle = {
      ...queryChain,
      update: updateMock,
      select: selectMock,
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txHandle)),
    }
    return {
      db: { db: dbHandle } as unknown as DrizzleDb,
      updateMock,
      setMock,
      transactionMock: dbHandle.transaction,
      inviteFindFirst,
      emailFindFirst,
      selectMock,
      returningMocks,
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
    const { db, transactionMock, updateMock, setMock, returningMocks } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com' },
    })
    const service = makeUsersService(db)
    await expect(
      service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-42'),
    ).resolves.toBeUndefined()

    expect(transactionMock).toHaveBeenCalledTimes(1)
    // Two updates inside the one transaction — SR-H-5 (security-review PR
    // #623 round 5): the user_emails row FIRST, the invite row SECOND
    // (reversed from before this fix — see the method's own comment for
    // the deadlock this ordering removes).
    expect(updateMock).toHaveBeenCalledTimes(2)
    expect(setMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ canLogin: true, googleId: 'sub-42', verifiedAt: expect.any(Date) }),
    )
    expect(setMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ usedAt: expect.any(Date) }),
    )
    // mutation-gate closure: `.returning({ id: userEmails.id })` /
    // `.returning({ id: userEmailInvites.id })` mutated to `.returning({})`
    // — the SR-L-3 zero-rows check (`!emailRows[0]`/`!inviteRows[0]`) only
    // looks at array length, which this mock's resolved VALUE does not
    // depend on, so nothing above would notice. Only inspecting the actual
    // argument each call was made WITH catches it.
    expect(returningMocks).toHaveLength(2)
    expect(returningMocks[0]).toHaveBeenCalledWith({ id: userEmails.id })
    expect(returningMocks[1]).toHaveBeenCalledWith({ id: userEmailInvites.id })
  })

  // SR-L-3 (security-review PR #623 round 5): a concurrent
  // `changePersonalEmail` can delete the `user_emails` row (and cascade the
  // invite with it) in the gap between the pre-transaction reads and this
  // transaction's own UPDATE — an UPDATE matching zero rows is not a
  // Postgres error, so without the `.returning()` check this would commit
  // having changed nothing and report success to the caller.
  it('SR-L-3: user_emails row vanished between read and write (raced revoke) → NotFoundException, invite never touched', async () => {
    const { db, transactionMock, updateMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com' },
      emailReturningRows: [],
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(NotFoundException)
    await expect(promise).rejects.toThrow('Приглашение недействительно')
    expect(transactionMock).toHaveBeenCalledTimes(1)
    // Reported as "invalid" BEFORE the invite update ever runs — the
    // user_emails UPDATE (call 1) matched zero rows, so the transaction
    // throws without reaching the invite UPDATE (call 2) at all.
    expect(updateMock).toHaveBeenCalledTimes(1)
  })

  // SR-L-3, defense-in-depth half: the lock-order fix means a real path
  // never reaches this (the cascade removes both rows together, so the
  // user_emails check above already catches it) — this pins the check
  // exists independently, for a hypothetical future writer of
  // `user_email_invites` alone.
  it('SR-L-3: invite row vanished between read and write, user_emails write DID succeed → NotFoundException', async () => {
    const { db, transactionMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com' },
      inviteReturningRows: [],
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(NotFoundException)
    await expect(promise).rejects.toThrow('Приглашение недействительно')
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  // LOW-2 (security-review PR #623 round 4): the invited row's OWNING user
  // was archived (fired) after the invite was issued.
  it('owning user is archived → ForbiddenException with the archived-specific message, no writes', async () => {
    const { db, transactionMock, selectMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com', userId: 'owner-1' },
      owner: { archivedAt: new Date() },
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(ForbiddenException)
    await expect(promise).rejects.toThrow('Учётная запись уволена — приглашение недействительно')
    expect(transactionMock).not.toHaveBeenCalled()
    // Kills the `findById({})` ObjectLiteral mutant — a query with no real
    // WHERE clause would match ANY user, not specifically the row's owner.
    expect(selectMock).toHaveBeenCalled()
  })

  it("an ACTIVE owning user (archivedAt: null) is not blocked — mutation coverage for the archived guard's condition", async () => {
    const { db } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com', userId: 'owner-1' },
      owner: { archivedAt: null },
    })
    const service = makeUsersService(db)
    await expect(
      service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1'),
    ).resolves.toBeUndefined()
  })

  // mutation-gate closure (PR #623 round 4): kills the `owner?.archivedAt`
  // → `owner.archivedAt` OptionalChaining mutant. `owner: null` here makes
  // `findById(row.userId)` resolve `undefined` (the owning user row is gone
  // — a real, if rare, race between the emailRow lookup and this one).
  // Under the correct optional-chaining code, `undefined?.archivedAt` is
  // `undefined` (falsy) and the flow proceeds normally; the mutant reads
  // `undefined.archivedAt` directly and throws a TypeError, which would turn
  // this `resolves` assertion into a rejection.
  it('owning user row is GONE (race with the emailRow lookup) → does not crash, proceeds normally', async () => {
    const { db } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com', userId: 'owner-1' },
      owner: null,
    })
    const service = makeUsersService(db)
    await expect(
      service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1'),
    ).resolves.toBeUndefined()
  })

  // LOW-1 (security-review PR #623 round 4): the confirming Google account
  // is already bound to a DIFFERENT user_emails row — a REAL Postgres
  // unique-constraint violation on idx_user_emails_google_id, not "already
  // used" (this token's own usedAt is never set: the whole transaction
  // that would have set it also rolls back).
  it('Google account already bound to a different row → ConflictException with the DISTINCT message (not "already used")', async () => {
    const { db, transactionMock } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com', userId: 'owner-1' },
      googleIdConflict: true,
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1')
    await expect(promise).rejects.toBeInstanceOf(ConflictException)
    await expect(promise).rejects.toThrow(
      'Этот Google-аккаунт уже привязан к другому адресу в системе',
    )
    // Distinct from "already used" — same exception TYPE, different message.
    await expect(promise).rejects.not.toThrow('Приглашение уже использовано')
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it('an UNRECOGNISED unique-violation constraint is rethrown as-is, not mislabelled', async () => {
    // pg-errors.ts's own doc: an unanticipated collision must surface as a
    // real error, not get silently relabelled as the google_id case.
    const { db } = makeAcceptDb({
      invite: { id: 'inv-1', userEmailId: 'row-1', usedAt: null, expiresAt: FUTURE },
      row: { id: 'row-1', email: 'real@example.com', userId: 'owner-1' },
      unrecognizedConflict: true,
    })
    const service = makeUsersService(db)
    const promise = service.acceptPersonalEmailInvite('tok', 'real@example.com', 'sub-1')
    await expect(promise).rejects.toThrow('duplicate key value violates unique constraint')
    // NOT relabelled as the google_id-specific message.
    await expect(promise).rejects.not.toThrow(
      'Этот Google-аккаунт уже привязан к другому адресу в системе',
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

  it('task-pending-share: PROPOSES seniorSharePercent for SENIOR instead of writing it directly', async () => {
    const existing = makeSenior({ seniorSharePercent: 26 })
    // The live column is UNCHANGED by this call (task-pending-share AC2) —
    // the mock's canned `updatedUser` return represents that: `updateUserRow`
    // is never handed `seniorSharePercent` in its `set`, so what actually
    // comes back is the row as it stood, not 80.
    const db = makeDb({ existingUser: existing, updatedUser: existing })
    const approvals = makeApprovalsService() as {
      proposeInTx: ReturnType<typeof vi.fn>
      getStatus: ReturnType<typeof vi.fn>
    }
    const service = makeUsersService(db, undefined, approvals)
    const result = await service.adminUpdateUser('senior-1', { seniorSharePercent: 80 }, 'admin-1')
    expect(result.seniorSharePercent).toBe(26)
    expect(approvals.proposeInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: 'senior-1',
        approverUserIds: ['senior-1'],
        proposedByUserId: 'admin-1',
      }),
    )
  })

  it('task-pending-share: no-ops (does not propose) when requested value equals the current one', async () => {
    const existing = makeSenior({ seniorSharePercent: 26 })
    const db = makeDb({ existingUser: existing, updatedUser: existing })
    const approvals = makeApprovalsService() as { proposeInTx: ReturnType<typeof vi.fn> }
    const service = makeUsersService(db, undefined, approvals)
    await service.adminUpdateUser('senior-1', { seniorSharePercent: 26 }, 'admin-1')
    expect(approvals.proposeInTx).not.toHaveBeenCalled()
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

    // 3 calls: COPY-M-15's own-PERSONAL-row check (before the tx) +
    // assertEmailAvailable's pre-check (before the tx) + upsertWorkEmail's
    // find-existing-WORK-row lookup (inside the tx). A mutated
    // `data.email !== existing.email` guard that always skips the sync
    // would leave this at 2.
    const findFirstMock = db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>
    expect(findFirstMock).toHaveBeenCalledTimes(3)

    // mutation-gate closure (PR #623): upsertWorkEmail's own lookup (3rd
    // call — see the count above) must pass a REAL where clause filtering
    // kind = 'WORK' — a mutant emptying the whole call to `.findFirst({})`
    // (ObjectLiteral) or blanking the literal to `''` (StringLiteral) both
    // still resolve via this mock (which ignores its args), so only
    // inspecting the ACTUAL compiled where clause catches either.
    const upsertLookupArgs = findFirstMock.mock.calls[2]?.[0] as { where?: unknown } | undefined
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
    // upsertWorkEmail's own lookup (the 3rd findFirst call — the 1st is
    // COPY-M-15's own-PERSONAL-row check, the 2nd is assertEmailAvailable's
    // pre-check) finds an existing WORK row, so it must take the UPDATE
    // branch, not INSERT a second one.
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // COPY-M-15: no own PERSONAL row
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
  // let it through (return, not throw).
  //
  // COPY-M-15 (copy-review PR #623 closing round): this test used to call
  // `adminUpdateUser` directly, with a WORK-email-equals-own-PERSONAL-email
  // scenario, to reach this branch — `adminUpdateUser` now has its OWN,
  // EARLIER check for exactly that scenario (own WORK email set to own
  // PERSONAL email — see the check above the `assertEmailAvailable` call
  // inside that method), which throws `BadRequestException` BEFORE
  // `assertEmailAvailable` is ever reached from there. Routing through
  // `adminUpdateUser` would now pin the WRONG layer and silently start
  // asserting the OLD, now-incorrect outcome (a resolve, where the correct
  // behavior for THAT scenario is a 400 — see the new tests above).
  // Exercising `assertEmailAvailable` directly (same pattern as
  // `writeUserEmailOrConflict` above) keeps this test about the ONE thing
  // it was written to pin, independent of what any particular caller does
  // around it. This is still real, reachable production behavior, just
  // through OTHER callers: `changePersonalEmail`'s own call relies on the
  // exact same pass-through for a re-cased resubmit of a PERSONAL address
  // (see that method's own SR-L-1 comment), and `adminUpdateUser`'s call
  // still reaches it for a same-user, different-case resubmit of the WORK
  // address (COPY-M-15's new check only queries the PERSONAL row, so a
  // WORK-vs-WORK match is untouched by it).
  it('SR-M-3: does NOT throw when the only existing row for that email belongs to the SAME user (isOwnRow pass-through)', async () => {
    const db = makeDb({ existingUser: undefined, createdUser: makeJunior() })
    // The found row's userId is the SAME 'user-1' passed as excludeUserId
    // below. A mutant flipping `===` to `!==`, or negating either `if`,
    // would make this call throw ConflictException instead of resolving.
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'row-other-kind',
      userId: 'user-1',
      kind: 'PERSONAL',
    })
    const service = makeUsersService(db) as unknown as {
      assertEmailAvailable: (dbArg: unknown, email: string, excludeUserId?: string) => Promise<void>
    }

    await expect(
      service.assertEmailAvailable(db.db, 'shared@example.com', 'user-1'),
    ).resolves.toBeUndefined()
  })

  // COPY-M-15 (copy-review PR #623 closing round): an admin editing a
  // user's WORK email to that SAME user's own PERSONAL email used to reach
  // `assertEmailAvailable`'s `isOwnRow` pass-through (SR-M-3, above) and
  // only fail downstream at the DB unique index, surfacing as the generic
  // 409 `UserDialog.tsx`'s `explainUserMutationError` then overwrites with
  // a hardcoded "already exists" toast — sending the admin to look for a
  // second account that does not exist. This is the pin for the new,
  // earlier, dedicated check: a 400 that names the actual problem, and
  // that the frontend's 409-only override does not touch.
  it("COPY-M-15: throws BadRequestException (not the generic 409) when the new WORK email equals the SAME user's own PERSONAL email", async () => {
    const existing = makeUser({ id: 'user-1', email: 'work@example.com' })
    const db = makeDb({ existingUser: existing })
    // The FIRST findFirst call is COPY-M-15's own check (userId + kind =
    // 'PERSONAL') — resolving it to a row whose email matches (case-
    // insensitively) the new WORK email is the exact scenario this check
    // exists for. A mutant that drops the `ownPersonalRow &&` guard, flips
    // the `.toLowerCase() === .toLowerCase()` comparison, or empties the
    // WHERE clause would all fail to throw here.
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'row-personal',
      userId: 'user-1',
      kind: 'PERSONAL',
      email: 'Personal@Example.com',
    })
    const service = makeUsersService(db)

    const promise = service.adminUpdateUser('user-1', { email: 'personal@example.com' })
    await expect(promise).rejects.toBeInstanceOf(BadRequestException)
    await expect(promise).rejects.toThrow('Рабочий email должен отличаться от личного')
    // Caught before `assertEmailAvailable`/`upsertWorkEmail` — no write was
    // even attempted, so the transaction never opens.
    expect(db.db.transaction).not.toHaveBeenCalled()
    // mutation-gate closure: the check's own WHERE clause must actually
    // filter by THIS user's id and kind='PERSONAL', not `.findFirst({})` —
    // a mutant emptying it would still resolve via this call-order-based
    // mock (which ignores its args).
    const findFirstMock = db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>
    const ownRowLookupArgs = findFirstMock.mock.calls[0]?.[0] as { where?: unknown } | undefined
    expect(ownRowLookupArgs?.where, 'expected a real where clause, not {}').toBeDefined()
    const compiledWhere = new PgDialect().sqlToQuery(
      ownRowLookupArgs!.where as Parameters<PgDialect['sqlToQuery']>[0],
    )
    expect(compiledWhere.params).toContain('PERSONAL')
    expect(compiledWhere.params).toContain('user-1')
  })

  // mutation-gate closure: kills the `if (ownPersonalRow && true)`
  // ConditionalExpression mutant on the check above — every OTHER test in
  // this file either has NO PERSONAL row at all (falsy either way, so a
  // mutant that drops the email comparison behaves identically) or a
  // MATCHING one (throws either way). Only a row that EXISTS but does NOT
  // match distinguishes the real `.toLowerCase() === .toLowerCase()`
  // comparison from a mutant that ignores it and throws on ANY row.
  it('COPY-M-15: does NOT throw when the user HAS a PERSONAL row, but its email is DIFFERENT from the new WORK email', async () => {
    const existing = makeUser({ id: 'user-1', email: 'work@example.com' })
    const updated = makeUser({ id: 'user-1', email: 'new-work@example.com' })
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    ;(db.db.query.userEmails.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'row-personal',
        userId: 'user-1',
        kind: 'PERSONAL',
        email: 'unrelated-personal@example.com',
      }) // COPY-M-15's check: a PERSONAL row exists, but at a DIFFERENT address
      .mockResolvedValueOnce(undefined) // assertEmailAvailable: no conflict
      .mockResolvedValueOnce(undefined) // upsertWorkEmail: no existing WORK row → insert
    const service = makeUsersService(db)

    await expect(
      service.adminUpdateUser('user-1', { email: 'new-work@example.com' }),
    ).resolves.toMatchObject({ id: 'user-1' })
  })

  // COPY-M-15 regression: a collision with a DIFFERENT (stranger's) user's
  // email must still be the OLD, pre-existing 409 — COPY-M-15 only adds a
  // NEW, EARLIER branch for the same-user case; it must not touch this one.
  it("COPY-M-15 regression: a stranger's already-taken email still throws the OLD 409 unchanged", async () => {
    const existing = makeUser({ id: 'user-1', email: 'old@example.com' })
    const stranger = makeUser({ id: 'user-2', email: 'taken@example.com' })
    // makeDb's select-chain resolves the 1st select().where() call
    // (findById, inside adminUpdateUser) to `existingUser` and every
    // subsequent one to `createdUser` — the 2nd call here is
    // `findByEmail(data.email)`, so seeding the stranger as `createdUser`
    // is what makes that lookup return THEIR row.
    const db = makeDb({ existingUser: existing, createdUser: stranger })
    const service = makeUsersService(db)

    const promise = service.adminUpdateUser('user-1', { email: 'taken@example.com' })
    await expect(promise).rejects.toBeInstanceOf(ConflictException)
    await expect(promise).rejects.toThrow('User with this email already exists')
    // This collision is caught by `findByEmail`, strictly BEFORE COPY-M-15's
    // own-PERSONAL-row check — a mutant reordering the two checks would
    // still throw SOMETHING here, but `userEmails.findFirst` would no
    // longer be untouched.
    expect(db.db.query.userEmails.findFirst).not.toHaveBeenCalled()
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

/**
 * Builds a minimal UsersService whose findById returns `target` and whose
 * accessService.getViewPermissions returns the given permissions object.
 *
 * Module-scoped (not local to the `legalFullName masking` describe below) —
 * task-pending-share's `buildProfileView — pendingSeniorShare` describe,
 * further down this file, needs the SAME harness shape.
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
  // task-pending-share (position 5): optional override so tests below that
  // need `fields.share = true` can control (and assert on)
  // `approvals.getStatus` — every pre-existing call site here leaves it
  // unset and gets the safe 'NONE' default, same as `makeUsersService`'s
  // own optional `approvalsService` param.
  approvalsService?: unknown,
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
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (approvalsService ?? makeApprovalsService()) as never,
  )
  return { service, auditRecord }
}

describe('UsersService.buildProfileView — legalFullName masking', () => {
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
// buildProfileView — pendingSeniorShare (task-pending-share, position 5)
// ---------------------------------------------------------------------------

describe('UsersService.buildProfileView — pendingSeniorShare', () => {
  const seniorTarget = makeSenior({ id: 'target-id', pendingSeniorSharePercent: 55 })
  const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
  // task-648-fix-round-1 (QA-HIGH-1): `sharePending` is the field that
  // actually gates this method now — `share` alone (kept here at `true` too,
  // matching a real ADMIN's permissions shape) is no longer sufficient. See
  // the masked-viewer test below for the decoupled case this fix exists for.
  const permissions = {
    tabs: ['overview', 'finance'],
    actions: [],
    fields: { share: true, sharePending: true },
  }

  it('is populated (percent/effectivePercentAfterApproval/approverId/approverName) when approvals.getStatus reports PENDING', async () => {
    const approvals = makeApprovalsService() as { getStatus: ReturnType<typeof vi.fn> }
    approvals.getStatus.mockResolvedValue('PENDING')
    const { service } = makeServiceForProfileViewWithAudit(seniorTarget, permissions, approvals)
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect((result.user as Record<string, unknown>).pendingSeniorShare).toEqual({
      percent: 55,
      // task-648-fix-round-1 (COPY-H-2/COPY-H-3): a base-share proposal
      // always equals `percent` itself — see PendingSeniorShare's own doc.
      effectivePercentAfterApproval: 55,
      approverId: 'target-id',
      approverName: 'Senior Dev',
    })
  })

  it.each(['NONE', 'APPROVED', 'REJECTED'] as const)(
    'is null when approvals.getStatus reports %s (only PENDING surfaces a proposal)',
    async (status) => {
      const approvals = makeApprovalsService() as { getStatus: ReturnType<typeof vi.fn> }
      approvals.getStatus.mockResolvedValue(status)
      const { service } = makeServiceForProfileViewWithAudit(seniorTarget, permissions, approvals)
      const result = await service.buildProfileView(viewer as never, 'target-id')
      expect((result.user as Record<string, unknown>).pendingSeniorShare).toBeNull()
    },
  )

  it('does not call approvals.getStatus at all when fields.sharePending is false (masked viewer)', async () => {
    const approvals = makeApprovalsService() as { getStatus: ReturnType<typeof vi.fn> }
    const maskedPermissions = {
      tabs: ['overview'],
      actions: [],
      fields: { share: false, sharePending: false },
    }
    const { service } = makeServiceForProfileViewWithAudit(
      seniorTarget,
      maskedPermissions,
      approvals,
    )
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect(approvals.getStatus).not.toHaveBeenCalled()
    expect((result.user as Record<string, unknown>).pendingSeniorShare).toBeNull()
  })

  // task-648-fix-round-1 (QA-HIGH-1): the exact bug this fix closes — a
  // viewer (ACCOUNTANT-shaped) who sees the ACTIVE share (`share: true`,
  // payroll need-to-know) must NOT learn a change is even proposed. Before
  // this fix, both flags were the same underlying `fields.share` value, so
  // this exact combination was unreachable and the leak went unnoticed.
  it('does not call approvals.getStatus, and returns null, when share=true but sharePending=false (ACCOUNTANT-shaped viewer)', async () => {
    const approvals = makeApprovalsService() as { getStatus: ReturnType<typeof vi.fn> }
    const accountantShapedPermissions = {
      tabs: ['overview', 'finance'],
      actions: [],
      fields: { share: true, sharePending: false },
    }
    const { service } = makeServiceForProfileViewWithAudit(
      seniorTarget,
      accountantShapedPermissions,
      approvals,
    )
    const result = await service.buildProfileView(viewer as never, 'target-id')
    expect(approvals.getStatus).not.toHaveBeenCalled()
    expect((result.user as Record<string, unknown>).pendingSeniorShare).toBeNull()
    // The ACTIVE value stays visible — only the PENDING one is masked.
    expect((result.user as Record<string, unknown>).seniorSharePercent).toBe(
      seniorTarget.seniorSharePercent,
    )
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

    return new UsersService(
      db as never,
      accessService as never,
      auditService as never,
      tosService,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      makeApprovalsService(),
    )
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
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      makeApprovalsService(),
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

    // mutation-gate closure (PR #623 round 4): `?? false` on this line is a
    // safe-by-default fallback for a permissions object that omits the key
    // entirely — every OTHER test here always sets `personalContact`
    // explicitly (true or false), so the fallback itself was never driven.
    // `?? true` would LEAK visibility by default instead of denying it —
    // the two are not an "unreachable defensive branch", they are opposite
    // security postures.
    it('permissions object omits personalContact entirely → personalContactVisible defaults to false (deny, not leak)', async () => {
      const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
      const missingKeyPermissions = {
        tabs: ['overview'],
        actions: [],
        fields: { realContacts: true },
      }
      const service = makeServicePii(seniorTarget, missingKeyPermissions)
      const result = await service.buildProfileView(viewer as never, 'senior-target')
      const user = result.user as Record<string, unknown>
      expect(user.personalContactVisible).toBe(false)
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
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      makeApprovalsService(),
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
