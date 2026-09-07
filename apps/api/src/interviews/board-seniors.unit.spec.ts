/**
 * task-hr-drop-team-senior-board — mock-DB unit twin of
 * `InterviewsService.getBoardSeniors` (GET /interviews/seniors).
 *
 * Real-DB RBAC + team-scope proof (incl. the actual drop-team repro) lives in
 * `board-seniors.integration.spec.ts` (AC2). This file is the mutation-gate
 * counterpart (AC1 + AC3) — the mutation gate runs the UNIT suite only and
 * cannot execute an `*.integration.spec.ts` file at all (see
 * `.claude/rules/common/mutation-gate-integration-specs.md`), so every branch
 * `getBoardSeniors` adds needs a mocked-DB test here too, or a mutant in that
 * branch is invisible to `mutation-gate.mjs --changed`.
 *
 * The `users.findMany` / `users.findFirst` mocks below do not ignore their
 * `where` argument and return canned rows regardless — they compile the REAL
 * Drizzle `where` AST each call receives (via `compileWhere`, mirroring
 * `create-from-interview-active-teams.unit.spec.ts`) and only return rows
 * that predicate would actually match. That ties the mock's answer to the
 * production code's own predicate: delete the shared `notArchived` field
 * (SR-M-1) from either the ADMIN or the HR branch, or swap `inArray` for the
 * wrong id set in the HR branch, and the assertions below fail for real —
 * not just "the mock was called".
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { InterviewsService } from './interviews.service'
import { compileWhere } from '../finance/__test-helpers__/drizzle-where-introspection'

type UserRow = {
  id: string
  displayName: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
  archivedAt: Date | null
  email: string
  techStack: string[] | null
  walletUsdtErc20: string | null
}

const ADMIN: SessionUser = {
  id: 'a1000000-0000-4000-aa00-000000000001',
  email: 'bs-admin@test.spec',
  displayName: 'BS Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'a1000000-0000-4000-aa00-000000000002',
  email: 'bs-hr@test.spec',
  displayName: 'BS HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'a1000000-0000-4000-aa00-000000000003',
  email: 'bs-senior@test.spec',
  displayName: 'BS Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'a1000000-0000-4000-aa00-000000000004',
  email: 'bs-junior@test.spec',
  displayName: 'BS Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'a1000000-0000-4000-aa00-000000000005',
  email: 'bs-accountant@test.spec',
  displayName: 'BS Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'a1000000-0000-4000-aa00-000000000006',
  email: 'bs-drop@test.spec',
  displayName: 'BS Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const SENIOR_ACTIVE: UserRow = {
  id: 'a1000000-0000-4000-bb00-000000000001',
  displayName: 'Senior Active',
  role: 'SENIOR',
  avatarUrl: 'https://example.com/a.png',
  avatarDocumentId: null,
  archivedAt: null,
  email: 'senior-active@test.spec',
  techStack: ['TypeScript'],
  walletUsdtErc20: '0xsecret',
}
const SENIOR_ARCHIVED: UserRow = {
  id: 'a1000000-0000-4000-bb00-000000000002',
  displayName: 'Senior Archived',
  role: 'SENIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  archivedAt: new Date('2026-01-01'),
  email: 'senior-archived@test.spec',
  techStack: null,
  walletUsdtErc20: null,
}
const DROP_TEAM_SENIOR: UserRow = {
  id: 'a1000000-0000-4000-bb00-000000000003',
  displayName: 'Drop Team Senior',
  role: 'SENIOR',
  avatarUrl: null,
  avatarDocumentId: 'a1000000-0000-4000-dd00-000000000001',
  archivedAt: null,
  email: 'drop-team-senior@test.spec',
  techStack: [],
  walletUsdtErc20: null,
}

/**
 * Mocked DatabaseService — `db.query.teamMembers.findMany` (feeds the
 * pre-existing, unmodified `getAccessibleSeniorIds`) and `db.query.users.
 * findMany` / `findFirst` (the NEW code under test), the latter two
 * predicate-aware via `compileWhere`.
 */
function makeDb(opts: { teamMemberships?: unknown[]; allUsers: UserRow[] }) {
  const usersFindMany = vi.fn((args: { where: unknown }) => {
    const { sql, params } = compileWhere(args.where)
    const wantsSenior = params.includes('SENIOR')
    // SR-M-1 (PR #662 round 2): `notArchived` is ANDed into BOTH branches'
    // `where` now, so this check must apply to both, not just the ADMIN
    // ("wantsSenior") one — otherwise the mock would stay green even if the
    // HR branch's archival filter were deleted, defeating the point of
    // compiling the real `where` at all.
    const wantsActiveOnly = sql.includes('"archived_at" is null')
    if (wantsSenior) {
      return Promise.resolve(
        opts.allUsers.filter(
          (u) => u.role === 'SENIOR' && (!wantsActiveOnly || u.archivedAt === null),
        ),
      )
    }
    // HR branch — inArray(users.id, accessibleSeniorIds) AND notArchived.
    // Bound params are the requested ids; return rows matching both the id
    // set and (when present) the archival filter.
    return Promise.resolve(
      opts.allUsers.filter(
        (u) => params.includes(u.id) && (!wantsActiveOnly || u.archivedAt === null),
      ),
    )
  })
  const usersFindFirst = vi.fn((args: { where: unknown }) => {
    const { params } = compileWhere(args.where)
    return Promise.resolve(opts.allUsers.find((u) => params.includes(u.id)))
  })
  const teamMembersFindMany = vi.fn(() => Promise.resolve(opts.teamMemberships ?? []))
  return {
    db: {
      query: {
        users: { findMany: usersFindMany, findFirst: usersFindFirst },
        teamMembers: { findMany: teamMembersFindMany },
      },
    },
    usersFindMany,
    usersFindFirst,
  }
}

function build(opts: { teamMemberships?: unknown[]; allUsers: UserRow[] }) {
  const stub = makeDb(opts)
  const service = new InterviewsService(stub as never, {} as never)
  return { service, usersFindMany: stub.usersFindMany, usersFindFirst: stub.usersFindFirst }
}

describe('InterviewsService.getBoardSeniors', () => {
  // ── ADMIN — all active SENIOR, archived excluded (AC1) ─────────────────
  it('ADMIN: returns every active SENIOR, excludes an archived one', async () => {
    const { service } = build({ allUsers: [SENIOR_ACTIVE, SENIOR_ARCHIVED, DROP_TEAM_SENIOR] })
    const result = await service.getBoardSeniors(ADMIN)
    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual([SENIOR_ACTIVE.id, DROP_TEAM_SENIOR.id].sort())
    expect(ids).not.toContain(SENIOR_ARCHIVED.id)
  })

  // ── AC3 — allow-list masking (both ADMIN and HR paths map through the
  //    same mapper, so proving it once on the richer ADMIN fixture is
  //    sufficient; the HR test below re-checks it on its own fixture too). ──
  it('AC3: response DTO carries only id/displayName/avatarUrl/avatarDocumentId', async () => {
    const { service } = build({ allUsers: [SENIOR_ACTIVE] })
    const [dto] = await service.getBoardSeniors(ADMIN)
    expect(dto).toBeDefined()
    expect(Object.keys(dto!).sort()).toEqual(
      ['avatarDocumentId', 'avatarUrl', 'displayName', 'id'].sort(),
    )
    expect(dto).not.toHaveProperty('email')
    expect(dto).not.toHaveProperty('techStack')
    expect(dto).not.toHaveProperty('walletUsdtErc20')
    expect(dto!.avatarUrl).toBe(SENIOR_ACTIVE.avatarUrl)
  })

  // Mutation-gate: `avatarDocumentId: u.avatarDocumentId ?? null` mutated to
  // `u.avatarDocumentId && null` survived the AC3 test above, because
  // SENIOR_ACTIVE's avatarDocumentId is null — `null ?? null` and
  // `null && null` both evaluate to null, so that fixture cannot tell the two
  // apart. DROP_TEAM_SENIOR carries a NON-null avatarDocumentId specifically
  // so this assertion can: `?? null` passes it through unchanged, `&& null`
  // would collapse a truthy id down to null.
  it('a truthy avatarDocumentId is passed through unchanged (kills the `??`→`&&` mutant)', async () => {
    const { service } = build({ allUsers: [DROP_TEAM_SENIOR] })
    const [dto] = await service.getBoardSeniors(ADMIN)
    expect(dto!.avatarDocumentId).toBe(DROP_TEAM_SENIOR.avatarDocumentId)
  })

  // ── HR — reuses getAccessibleSeniorIds; drop-team repro (AC1) ───────────
  it('HR: sees a SENIOR whose only team is a DROP-type team (the reported bug)', async () => {
    const { service } = build({
      teamMemberships: [
        {
          team: {
            members: [
              { userId: HR.id, leftAt: null, user: { role: 'HR' } },
              { userId: DROP_TEAM_SENIOR.id, leftAt: null, user: { role: 'SENIOR' } },
            ],
          },
        },
      ],
      allUsers: [DROP_TEAM_SENIOR, SENIOR_ACTIVE],
    })
    const result = await service.getBoardSeniors(HR)
    expect(result.map((r) => r.id)).toEqual([DROP_TEAM_SENIOR.id])
  })

  it('HR: not a member of the senior team → gets nothing, and never queries users (empty scope short-circuits)', async () => {
    const { service, usersFindMany } = build({ teamMemberships: [], allUsers: [SENIOR_ACTIVE] })
    const result = await service.getBoardSeniors(HR)
    expect(result).toEqual([])
    // Mutation-gate: `if (accessibleSeniorIds.length === 0) return []` mutated
    // to `if (false) return []` still returns `[]` here (an empty `inArray`
    // filters every fixture row out too), so the RETURN VALUE alone cannot
    // kill that mutant. The short-circuit's actual job — matching the
    // existing getHrSummary comment ("avoids an empty IN () predicate") — is
    // to skip the query entirely; assert that directly.
    expect(usersFindMany).not.toHaveBeenCalled()
  })

  it('HR: a senior who left the shared team is not returned', async () => {
    const { service } = build({
      teamMemberships: [
        {
          team: {
            members: [
              { userId: HR.id, leftAt: null, user: { role: 'HR' } },
              {
                userId: SENIOR_ACTIVE.id,
                leftAt: new Date('2026-02-01'),
                user: { role: 'SENIOR' },
              },
            ],
          },
        },
      ],
      allUsers: [SENIOR_ACTIVE],
    })
    const result = await service.getBoardSeniors(HR)
    expect(result).toEqual([])
  })

  // SR-M-1 (PR #662 round 2): archiving a SENIOR intentionally leaves
  // teamMembers.leftAt untouched for them and their HR (see
  // UsersService.archiveUser's own docblock — resetting it would break
  // salary accrual for the rest of the team), so getAccessibleSeniorIds()
  // alone cannot tell an archived senior apart from an active one. Mirrors
  // the 'ADMIN: ... excludes an archived one' test above, but through the HR
  // branch, which used to skip the archivedAt filter entirely.
  it('HR: an archived senior who is still an active team member is not returned', async () => {
    const { service } = build({
      teamMemberships: [
        {
          team: {
            members: [
              { userId: HR.id, leftAt: null, user: { role: 'HR' } },
              { userId: SENIOR_ACTIVE.id, leftAt: null, user: { role: 'SENIOR' } },
              { userId: SENIOR_ARCHIVED.id, leftAt: null, user: { role: 'SENIOR' } },
            ],
          },
        },
      ],
      allUsers: [SENIOR_ACTIVE, SENIOR_ARCHIVED],
    })
    const result = await service.getBoardSeniors(HR)
    const ids = result.map((r) => r.id)
    expect(ids).toEqual([SENIOR_ACTIVE.id])
    expect(ids).not.toContain(SENIOR_ARCHIVED.id)
  })

  // SPEC-M-1 (PR #662 round 2): AC1 names this case explicitly ("HR, покинувший
  // команду — не получает") but it previously only existed at the integration
  // level (board-seniors.integration.spec.ts, persona HR_LEFT). Same
  // technique as 'HR: a senior who left the shared team is not returned'
  // above, flipped to whose leftAt matters: getAccessibleSeniorIds() scopes
  // its OWN top-level query to `eq(teamMembers.userId, hrId) AND
  // isNull(teamMembers.leftAt)` — a real Postgres query for an HR whose own
  // membership ended returns ZERO rows, which is exactly what an empty
  // `teamMemberships` fixture represents here: `teamMembersFindMany` is a
  // passthrough mock and does not itself compile/apply that WHERE clause (it
  // has no `compileWhere` treatment, unlike `usersFindMany` above), so the
  // real predicate is proven at the DB level by HR_LEFT in the integration
  // spec — this unit test's job is AC1 traceability plus confirming
  // getBoardSeniors' HR branch short-circuits correctly no matter WHY the
  // accessible-senior set came back empty.
  it('HR: own team membership has ended → gets no seniors (not just "never joined")', async () => {
    const { service, usersFindMany } = build({ teamMemberships: [], allUsers: [SENIOR_ACTIVE] })
    const result = await service.getBoardSeniors(HR)
    expect(result).toEqual([])
    expect(usersFindMany).not.toHaveBeenCalled()
  })

  // ── SENIOR — self only ───────────────────────────────────────────────────
  it('SENIOR: gets a list containing only themselves', async () => {
    const self: UserRow = {
      id: SENIOR.id,
      displayName: SENIOR.displayName,
      role: 'SENIOR',
      avatarUrl: null,
      avatarDocumentId: null,
      archivedAt: null,
      email: SENIOR.email,
      techStack: null,
      walletUsdtErc20: null,
    }
    const { service } = build({ allUsers: [self, SENIOR_ACTIVE] })
    const result = await service.getBoardSeniors(SENIOR)
    expect(result.map((r) => r.id)).toEqual([SENIOR.id])
  })

  it('SENIOR: own user row not found → ForbiddenException (not an empty list)', async () => {
    // Fixture deliberately omits a row for SENIOR.id — `findFirst` resolves
    // undefined. Mutation-gate: `if (!self) throw ...` mutated to
    // `if (false) throw ...` was invisible to the "gets only themselves"
    // test above (self is always found there); this is the case that
    // actually exercises the guard.
    const { service } = build({ allUsers: [SENIOR_ACTIVE] })
    await expect(service.getBoardSeniors(SENIOR)).rejects.toBeInstanceOf(ForbiddenException)
  })

  // ── Roles the endpoint must reject outright ─────────────────────────────
  for (const [label, persona] of [
    ['JUNIOR', JUNIOR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['DROP', DROP],
  ] as const) {
    it(`${label}: rejected with ForbiddenException`, async () => {
      const { service } = build({ allUsers: [] })
      await expect(service.getBoardSeniors(persona)).rejects.toBeInstanceOf(ForbiddenException)
    })
  }
})
