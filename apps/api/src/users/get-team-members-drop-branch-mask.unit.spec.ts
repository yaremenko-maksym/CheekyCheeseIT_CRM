/**
 * Unit tests — the DROP branch of UsersService.getTeamMembersForUser is
 * covered by the SAME viewerRole masking filter as every other branch, AND
 * actually threads its query results correctly (not just "some condition
 * was passed").
 *
 * security-review PR #541 round 3. The method used to have FIVE exit
 * points and the SENIOR-viewer JUNIOR-masking filter only guarded the
 * LAST one — the DROP branch (`user.role === 'DROP'`) `return`ed its own
 * query result directly, structurally bypassing the filter. Reviewer's own
 * words: "Сегодня это не эксплуатируется... но оба барьера снаружи метода" —
 * today a SENIOR viewer can never reach this branch (the access matrix
 * blocks SENIOR from ever opening a DROP target's "Команда" tab, checked
 * upstream in `UsersAccessService.getViewPermissions`) AND no JUNIOR row can
 * exist in `team_members` (only SENIOR/HR/ACCOUNTANT/DROP rows are ever
 * inserted there) — but BOTH of those are invariants of OTHER code, not of
 * this method. Widen the access matrix, or let a JUNIOR row into
 * `team_members` some other way, and the bypass opens with zero red tests.
 *
 * DROP-BRANCH-MASK-1  SENIOR viewer, DROP-team roster containing a synthetic
 *                      JUNIOR row → that row is filtered out; a real HR row
 *                      in the SAME result stays.
 * DROP-BRANCH-MASK-2  ADMIN viewer, the SAME synthetic roster → BOTH rows
 *                      stay (reverse-direction control — proves the filter
 *                      is viewer-scoped, not "always strip JUNIOR rows here").
 * DROP-BRANCH-MASK-3  DROP viewer/target with ZERO team memberships → []
 *                      (not the roster of some other team) — pins the
 *                      `dropMemberships.length > 0` guard and the initial
 *                      `rows = []` value that guard protects (security-review
 *                      PR #541 round 4 mutation-gate follow-up: CI's mutation
 *                      gate flagged both as unkilled once the single-exit
 *                      refactor made them changed lines).
 *
 * This spec calls `getTeamMembersForUser` DIRECTLY with a synthetic DB
 * response that contains a `role: 'JUNIOR'` row inside the DROP branch's
 * query result — a shape that cannot occur via any real, currently-reachable
 * path — specifically to prove the METHOD ITSELF is safe regardless of what
 * upstream permission checks exist today or might change tomorrow. Same
 * defense-in-depth posture as `MEMBER-MASK-5` in
 * `senior-junior-member-mask.unit.spec.ts` (dangling `user: null` there;
 * "row shape that shouldn't happen but might" here).
 *
 * HARNESS (round 4 rewrite): the ORIGINAL harness resolved each `db.select()`
 * call by call ORDER, returning a canned array regardless of what `.where()`
 * was actually called with. That passed DROP-BRANCH-MASK-1/2, but a
 * mutation-gate run in CI found it could NOT catch a mutant that broke the
 * VALUE flowing between the two DROP-branch queries
 * (`dropMemberships.map((m) => m.teamId)` → `.map(() => undefined)`) or one
 * that emptied the projected columns (`.select({...5 fields})` →
 * `.select({})`) — the canned response didn't care. Below is a small
 * in-memory fake DB, keyed by table name (`getTableName`) and AWARE of the
 * actual bound values in a `.where(...)` condition (walked out of drizzle's
 * own `Param` nodes — see `extractParamValues`) and of the actual requested
 * column set (`fields`, from `.select(fields)`) — so a query for the wrong
 * ids, or with an empty projection, genuinely returns different (wrong) data,
 * and the existing `.id`/`.displayName` assertions below catch it without
 * needing bespoke new tests per broken line.
 */
import { describe, expect, it } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { UsersService } from './users.service'

// ---------------------------------------------------------------------------
// Fixture — a DROP target's team roster. HR_ID / SYNTHETIC_JUNIOR_ID are
// seeded as real `team_members` rows of `team-drop-1`; SYNTHETIC_JUNIOR_ID's
// `role: 'JUNIOR'` is a shape the real schema cannot actually produce here
// (see file docblock) — deliberately synthetic, to exercise the filter in
// isolation from that external invariant.
// ---------------------------------------------------------------------------

const DROP_TARGET_ID = 'drop-real-uuid-5001'
const HR_ID = 'hr-real-uuid-6002'
const HR_DISPLAY_NAME = 'Drop Team HR'
const SYNTHETIC_JUNIOR_ID = 'synthetic-junior-uuid-7003'
const SYNTHETIC_JUNIOR_DISPLAY_NAME = 'Synthetic Junior (should never exist in this branch)'
const TEAM_ID = 'team-drop-1'

interface FakeUser {
  id: string
  displayName: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}
interface FakeTeamMember {
  teamId: string
  userId: string
  leftAt: Date | null
}
interface FakeProject {
  id: string
  seniorId: string
}
interface FakeProjectMember {
  projectId: string
  userId: string
  leftAt: Date | null
}
interface Store {
  users: FakeUser[]
  teamMembers: FakeTeamMember[]
  projects?: FakeProject[]
  projectMembers?: FakeProjectMember[]
}

/**
 * Recursively pulls every drizzle `Param.value` out of a built condition
 * (`and(inArray(...), isNull(...), ne(...))` etc.) — verified empirically
 * against this repo's drizzle-orm version: `Param` nodes carry the actual
 * bound value, reachable by walking each `SQL` node's `queryChunks`. Values
 * from `eq`/`inArray`/`ne` all land in the same flat list; `isNull` (no bound
 * value) contributes nothing. Good enough to tell "the real seeded id" from
 * "undefined" apart, which is all these tests need.
 */
function extractParamValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (node == null) return acc
  if (Array.isArray(node)) {
    for (const item of node) extractParamValues(item, acc)
    return acc
  }
  if (typeof node === 'object') {
    const ctorName = (node as { constructor?: { name?: string } }).constructor?.name
    if (ctorName === 'Param' && 'value' in (node as Record<string, unknown>)) {
      acc.push((node as { value: unknown }).value)
      return acc
    }
    const chunks = (node as { queryChunks?: unknown }).queryChunks
    if (Array.isArray(chunks)) extractParamValues(chunks, acc)
  }
  return acc
}

/**
 * In-memory fake DB for the tables `getTeamMembersForUser` touches across all
 * of its branches (DROP / SENIOR self / JUNIOR-via-projects / HR-ACCOUNTANT).
 * Routes by real table name (`getTableName`, not the `t._` shortcut used
 * elsewhere in this codebase — verified empirically that `_` is `undefined`
 * on a plain `pgTable()` result in this drizzle-orm version, which would make
 * that shortcut silently match nothing).
 */
function makeDb(store: Store) {
  function chainSelect(fields: Record<string, unknown> | undefined) {
    let table: string | null = null
    let joinedTable: string | null = null
    let lastCondition: unknown

    // `.select()` with NO argument means "all columns" (findById); `.select({})`
    // means "zero columns" — these are different drizzle semantics and must
    // stay distinguishable, or the ObjectLiteral mutant (`{...5 fields}` -> `{}`)
    // becomes unobservable for the wrong reason (a harness bug, not a real kill).
    const project = (row: Record<string, unknown>): Record<string, unknown> => {
      if (fields === undefined) return row
      const keys = Object.keys(fields)
      if (keys.length === 0) return {}
      const out: Record<string, unknown> = {}
      for (const k of keys) out[k] = row[k]
      return out
    }

    const obj = {
      from: (t: unknown) => {
        table = getTableName(t as never)
        return obj
      },
      innerJoin: (t: unknown) => {
        joinedTable = getTableName(t as never)
        return obj
      },
      where: (condition: unknown) => {
        lastCondition = condition
        return obj
      },
      // A proper Promise/A+ thenable: MUST return a real Promise. Some call
      // sites `await` the chain (fine either way); `UsersService.findById`
      // calls `.then(fn)` DIRECTLY and returns that value as its own
      // `Promise<User | undefined>` — an implementation that doesn't return
      // a real promise here breaks `findById` silently (`undefined` instead
      // of the row).
      then: (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) => {
        const params = extractParamValues(lastCondition)
        const fieldKeys = fields ? Object.keys(fields) : []
        let rows: Record<string, unknown>[] = []
        if (table === 'team_members' && joinedTable === 'users' && fieldKeys.includes('teamId')) {
          // seniorMemberships query (Step 2): `{teamId} FROM team_members
          // INNER JOIN users WHERE userId IN seniorIds AND users.role =
          // 'SENIOR' AND leftAt IS NULL` — projects the team_members row
          // itself, but the JOIN also gates on the joined user's role. The
          // role-filter VALUE is read out of `params` (not hardcoded) so a
          // StringLiteral mutation on the production code's `'SENIOR'`
          // literal (-> `''`) is observable: no real user has an empty-string
          // role, so a mutated filter matches nothing.
          const KNOWN_ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
          const roleFilterValue = params.find(
            (p): p is string => typeof p === 'string' && KNOWN_ROLES.includes(p),
          )
          rows = store.teamMembers.filter((m) => {
            if (m.leftAt !== null || !params.includes(m.userId)) return false
            return store.users.find((u) => u.id === m.userId)?.role === roleFilterValue
          }) as unknown as Record<string, unknown>[]
        } else if (
          table === 'team_members' &&
          joinedTable === 'users' &&
          fieldKeys.length === 1 &&
          fieldKeys.includes('userId')
        ) {
          // seniorsInTeams query (Step 1, HR/ACCOUNTANT branch): `{userId}
          // FROM team_members INNER JOIN users WHERE teamId IN teamIds AND
          // users.role = 'SENIOR' AND leftAt IS NULL` — projects the
          // team_members row's OWN userId (not the joined user's other
          // fields), gated on the joined user's role (read from `params`,
          // same as the seniorMemberships case above).
          const KNOWN_ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
          const roleFilterValue = params.find(
            (p): p is string => typeof p === 'string' && KNOWN_ROLES.includes(p),
          )
          rows = store.teamMembers.filter((m) => {
            if (m.leftAt !== null || !params.includes(m.teamId)) return false
            return store.users.find((u) => u.id === m.userId)?.role === roleFilterValue
          }) as unknown as Record<string, unknown>[]
        } else if (table === 'team_members' && joinedTable === 'users') {
          // memberRows query (DROP branch): filter team_members by the bound
          // ids, then join each matched row to its fake user record.
          const matched = store.teamMembers.filter(
            (m) => m.leftAt === null && params.includes(m.teamId),
          )
          rows = matched
            .map((m) => store.users.find((u) => u.id === m.userId))
            .filter((u): u is FakeUser => u !== undefined) as unknown as Record<string, unknown>[]
        } else if (table === 'team_members') {
          // dropMemberships (filter by userId) OR tmRows (Step 2, filter by
          // teamId) — both are plain, un-joined `team_members` queries;
          // matching on EITHER bound value is enough for these fixtures
          // (ids never collide across the two axes).
          rows = store.teamMembers.filter(
            (m) => m.leftAt === null && (params.includes(m.userId) || params.includes(m.teamId)),
          ) as unknown as Record<string, unknown>[]
        } else if (table === 'users') {
          // findById: filter users by the bound id.
          rows = store.users.filter((u) => params.includes(u.id)) as unknown as Record<
            string,
            unknown
          >[]
        } else if (table === 'project_members' && joinedTable === 'projects') {
          // Step 1 (JUNIOR branch): `{seniorId: projects.seniorId} FROM
          // project_members INNER JOIN projects WHERE userId = <this junior>
          // AND leftAt IS NULL` — projects the JOINED project's seniorId.
          const matched = (store.projectMembers ?? []).filter(
            (pm) => pm.leftAt === null && params.includes(pm.userId),
          )
          rows = matched
            .map((pm) => {
              const proj = (store.projects ?? []).find((p) => p.id === pm.projectId)
              return proj ? { seniorId: proj.seniorId } : undefined
            })
            .filter((r): r is { seniorId: string } => r !== undefined)
        } else if (table === 'projects') {
          // Step 3 (first query): `{id} FROM projects WHERE seniorId IN seniorIds`.
          rows = (store.projects ?? []).filter((p) =>
            params.includes(p.seniorId),
          ) as unknown as Record<string, unknown>[]
        } else if (table === 'project_members') {
          // Step 3 (second query, NOT joined): `{userId} FROM project_members
          // WHERE projectId IN projectIds AND leftAt IS NULL`.
          rows = (store.projectMembers ?? []).filter(
            (pm) => pm.leftAt === null && params.includes(pm.projectId),
          ) as unknown as Record<string, unknown>[]
        }
        return Promise.resolve(rows.map((r) => project(r))).then(resolve, reject)
      },
    }
    return obj
  }

  return {
    db: {
      select: (fields?: Record<string, unknown>) => chainSelect(fields),
    },
  }
}

function buildService(store: Store) {
  return new UsersService(
    makeDb(store) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // task-pending-share fix-round-1 (CR-H-1): working stub, see the
    // sibling comment in archived-entitlement.realdb.integration.spec.ts.
    { getStatus: async () => 'NONE' as const } as never,
  )
}

/** Standard fixture: DROP_TARGET_ID belongs to TEAM_ID, alongside a real HR
 * and a synthetic JUNIOR row (see file docblock for why the JUNIOR is
 * synthetic). */
function standardStore() {
  return {
    users: [
      {
        id: DROP_TARGET_ID,
        displayName: 'Drop Target',
        role: 'DROP',
        avatarUrl: null,
        avatarDocumentId: null,
      },
      {
        id: HR_ID,
        displayName: HR_DISPLAY_NAME,
        role: 'HR',
        avatarUrl: null,
        avatarDocumentId: null,
      },
      {
        id: SYNTHETIC_JUNIOR_ID,
        displayName: SYNTHETIC_JUNIOR_DISPLAY_NAME,
        role: 'JUNIOR',
        avatarUrl: null,
        avatarDocumentId: null,
      },
    ],
    teamMembers: [
      { teamId: TEAM_ID, userId: DROP_TARGET_ID, leftAt: null },
      { teamId: TEAM_ID, userId: HR_ID, leftAt: null },
      { teamId: TEAM_ID, userId: SYNTHETIC_JUNIOR_ID, leftAt: null },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getTeamMembersForUser — DROP branch is covered by the SAME viewerRole filter', () => {
  it('DROP-BRANCH-MASK-1. SENIOR viewer → synthetic JUNIOR row filtered out, real HR row stays', async () => {
    const service = buildService(standardStore())
    const rows = await service.getTeamMembersForUser(DROP_TARGET_ID, 'SENIOR')
    const ids = rows.map((r) => r.id)

    expect(
      ids,
      'SENIOR viewer: JUNIOR row must be filtered out of the DROP branch too',
    ).not.toContain(SYNTHETIC_JUNIOR_ID)
    const hr = rows.find((r) => r.id === HR_ID)
    expect(hr, 'SENIOR viewer: real HR row must stay').toBeDefined()
    expect(hr?.displayName, 'HR displayName must be the real value (projection intact)').toBe(
      HR_DISPLAY_NAME,
    )
  })

  it('DROP-BRANCH-MASK-2. ADMIN viewer → both rows stay (reverse-direction control)', async () => {
    const service = buildService(standardStore())
    const rows = await service.getTeamMembersForUser(DROP_TARGET_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)

    expect(ids, 'ADMIN viewer: HR row present').toContain(HR_ID)
    expect(ids, 'ADMIN viewer: JUNIOR row present (proves the filter is SENIOR-scoped)').toContain(
      SYNTHETIC_JUNIOR_ID,
    )
  })

  it('DROP-BRANCH-MASK-3. DROP target with ZERO team memberships → [] (not some other roster)', async () => {
    const store = {
      users: [
        {
          id: DROP_TARGET_ID,
          displayName: 'Drop Target',
          role: 'DROP',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        // A team that exists but that DROP_TARGET_ID is NOT a member of —
        // if the `dropMemberships.length > 0` guard were mutated away, this
        // (wrong) roster would leak through instead of an empty result.
        {
          id: HR_ID,
          displayName: HR_DISPLAY_NAME,
          role: 'HR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [{ teamId: 'someone-elses-team', userId: HR_ID, leftAt: null }],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(DROP_TARGET_ID, 'ADMIN')
    expect(rows, 'a DROP with no team memberships gets an empty roster, not a stale one').toEqual(
      [],
    )
  })

  it('DROP-BRANCH-MASK-4. ADMIN target → [] even with incidental team_members data (proves branch SELECTION, not just the DROP branch itself)', async () => {
    // security-review PR #541 round 4 (mutation-gate follow-up): `if (user.role
    // === 'DROP')` survived a mutation to `if (true)` — DROP-BRANCH-MASK-1..3
    // only ever exercise a DROP target, so they never notice a bypassed
    // branch check. ADMIN_TARGET_ID has an (incidental/legacy) team_members
    // row alongside a real HR teammate AND a real SENIOR teammate in the SAME
    // team: the CORRECT code takes neither the DROP branch nor the
    // SENIOR/JUNIOR/HR-ACCOUNTANT branch for an ADMIN target (`rows` stays
    // its initial `[]`) — but a `if (user.role === 'DROP')` mutated to
    // always-true WOULD wrongly enter the DROP branch and leak the HR
    // teammate, and an `else if (user.role === 'HR' || user.role ===
    // 'ACCOUNTANT')` mutated to always-true (round 5 mutation-gate
    // follow-up) WOULD wrongly enter the HR/ACCOUNTANT branch, resolve the
    // SENIOR teammate via `seniorsInTeams`, and leak THEIR JUNIORs/teammates
    // through Step 2 — an earlier version of this fixture had no SENIOR in
    // the incidental team, so entering that branch by mistake still resolved
    // an empty `seniorIds` and the mutation went unnoticed.
    const ADMIN_TARGET_ID = 'admin-target-uuid-8004'
    const SENIOR_IN_ADMIN_TEAM_ID = 'senior-in-admin-team-uuid-8005'
    const store = {
      users: [
        {
          id: ADMIN_TARGET_ID,
          displayName: 'Admin Target',
          role: 'ADMIN',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: HR_ID,
          displayName: HR_DISPLAY_NAME,
          role: 'HR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: SENIOR_IN_ADMIN_TEAM_ID,
          displayName: 'Senior In Admin Incidental Team',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [
        { teamId: TEAM_ID, userId: ADMIN_TARGET_ID, leftAt: null },
        { teamId: TEAM_ID, userId: HR_ID, leftAt: null },
        { teamId: TEAM_ID, userId: SENIOR_IN_ADMIN_TEAM_ID, leftAt: null },
      ],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(ADMIN_TARGET_ID, 'ADMIN')
    expect(rows, 'ADMIN target always gets [] — no branch queries on their behalf').toEqual([])
  })

  it('BRANCH-SELECT-1. SENIOR target with a real team + project → Step 2 AND Step 3 rosters are derived (pins the non-ADMIN/non-DROP branch selection)', async () => {
    // security-review PR #541 round 4 (mutation-gate follow-up): `else if
    // (user.role !== 'ADMIN')` (the branch gating Step 1-3 for
    // SENIOR/JUNIOR/HR/ACCOUNTANT targets) survived TWO of its four mutants
    // even with DROP-BRANCH-MASK-4 in place. Root cause: DROP-BRANCH-MASK-4
    // only exercises an ADMIN target, and Step 1's inner role-checks
    // (SENIOR/JUNIOR/HR/ACCOUNTANT) never match 'ADMIN' either way — so
    // forcing entry into this branch for an ADMIN target is a genuine no-op,
    // not something any test could observe (see the `// Stryker disable`
    // comment on this condition for the two mutants that really are
    // equivalent). This test uses a SENIOR target instead: entering the
    // branch, `seniorIds = [user.id]` is set synchronously (no DB call), so
    // Step 2 actually runs and finds this senior's own team — skipping the
    // branch (or routing SENIOR through the wrong branch) loses that roster.
    //
    // A project + active JUNIOR project-member are ALSO seeded so Step 3
    // (the `projects` / `project_members` round-trip) has something real to
    // find — mutating any of Step 3's internals (`.map`, `.select` shape,
    // the `projectIds.length > 0` guard) drops JUNIOR_ID from the result.
    const SENIOR_TARGET_ID = 'senior-target-uuid-9005'
    const JUNIOR_ID = 'junior-under-senior-uuid-9006'
    const PROJECT_ID = 'project-under-senior-9007'
    const store = {
      users: [
        {
          id: SENIOR_TARGET_ID,
          displayName: 'Senior Target',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: HR_ID,
          displayName: HR_DISPLAY_NAME,
          role: 'HR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: JUNIOR_ID,
          displayName: 'Junior Under Senior',
          role: 'JUNIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [
        { teamId: TEAM_ID, userId: SENIOR_TARGET_ID, leftAt: null },
        { teamId: TEAM_ID, userId: HR_ID, leftAt: null },
      ],
      projects: [{ id: PROJECT_ID, seniorId: SENIOR_TARGET_ID }],
      projectMembers: [{ projectId: PROJECT_ID, userId: JUNIOR_ID, leftAt: null }],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(SENIOR_TARGET_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)
    expect(
      ids,
      "SENIOR target's own team roster (their HR teammate) must be derived via Step 2",
    ).toContain(HR_ID)
    expect(ids, "SENIOR target's own project JUNIOR must be derived via Step 3").toContain(
      JUNIOR_ID,
    )
  })

  it("BRANCH-SELECT-2. JUNIOR target → their senior's team is derived via Step 1's project-based lookup (not treated as a fake SENIOR)", async () => {
    // security-review PR #541 round 4 (mutation-gate follow-up): `if
    // (user.role === 'SENIOR')` survived — BRANCH-SELECT-1 only ever uses a
    // SENIOR target, for whom that condition is already true either way. A
    // JUNIOR target discriminates it: entering the SENIOR branch by mistake
    // would set `seniorIds = [JUNIOR_ID]` (the junior's OWN id, treated as if
    // it were a senior) instead of correctly resolving it via their active
    // project — the wrong id finds no real team, and the junior's real
    // senior's HR teammate would be missing from the result.
    const JUNIOR_TARGET_ID = 'junior-target-uuid-9008'
    const SENIOR_OF_JUNIOR_ID = 'senior-of-junior-uuid-9009'
    const PROJECT_ID = 'project-of-junior-9010'
    const store = {
      users: [
        {
          id: JUNIOR_TARGET_ID,
          displayName: 'Junior Target',
          role: 'JUNIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: SENIOR_OF_JUNIOR_ID,
          displayName: 'Senior Of Junior',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: HR_ID,
          displayName: HR_DISPLAY_NAME,
          role: 'HR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [
        { teamId: TEAM_ID, userId: SENIOR_OF_JUNIOR_ID, leftAt: null },
        { teamId: TEAM_ID, userId: HR_ID, leftAt: null },
      ],
      projects: [{ id: PROJECT_ID, seniorId: SENIOR_OF_JUNIOR_ID }],
      projectMembers: [{ projectId: PROJECT_ID, userId: JUNIOR_TARGET_ID, leftAt: null }],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(JUNIOR_TARGET_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)
    expect(
      ids,
      "the JUNIOR's real senior must be resolved via their active project, and that senior's HR teammate must appear",
    ).toContain(HR_ID)
  })

  it("BRANCH-SELECT-3. HR target → their team's SENIOR is resolved via Step 1's HR/ACCOUNTANT lookup (not treated as a fake JUNIOR)", async () => {
    // security-review PR #541 round 4 (mutation-gate follow-up): `else if
    // (user.role === 'JUNIOR')` survived — BRANCH-SELECT-2 only ever uses a
    // JUNIOR target, for whom that condition is already true either way. An
    // HR target discriminates it: entering the JUNIOR branch by mistake
    // would try to resolve `seniorIds` via `project_members` (a table this HR
    // has no rows in), finding nothing, instead of correctly walking their
    // own `team_members` row to the team's SENIOR — the accountant teammate
    // on that same team would then be missing from the result.
    const HR_TARGET_ID = 'hr-target-uuid-9011'
    const SENIOR_OF_HR_ID = 'senior-of-hr-uuid-9012'
    const ACCOUNTANT_ID = 'accountant-of-hr-uuid-9013'
    const store = {
      users: [
        {
          id: HR_TARGET_ID,
          displayName: 'HR Target',
          role: 'HR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: SENIOR_OF_HR_ID,
          displayName: 'Senior Of HR',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: ACCOUNTANT_ID,
          displayName: 'Accountant Of HR',
          role: 'ACCOUNTANT',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [
        { teamId: TEAM_ID, userId: HR_TARGET_ID, leftAt: null },
        { teamId: TEAM_ID, userId: SENIOR_OF_HR_ID, leftAt: null },
        { teamId: TEAM_ID, userId: ACCOUNTANT_ID, leftAt: null },
      ],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(HR_TARGET_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)
    expect(
      ids,
      "HR target's own team SENIOR must be resolved via Step 1's team_members lookup",
    ).toContain(SENIOR_OF_HR_ID)
    expect(
      ids,
      "HR target's ACCOUNTANT teammate (same team, found via Step 2) must appear",
    ).toContain(ACCOUNTANT_ID)
  })

  it("BRANCH-SELECT-4. ACCOUNTANT target → their team's SENIOR is resolved too (pins the '|| user.role === ACCOUNTANT' half in isolation from the HR half)", async () => {
    // security-review PR #541 round 4 (mutation-gate follow-up): `user.role
    // === 'HR' || user.role === 'ACCOUNTANT'` survived on its RIGHT-hand
    // side specifically (forced to `false`, and the 'ACCOUNTANT' string
    // literal forced to `''`) even with BRANCH-SELECT-3 in place —
    // BRANCH-SELECT-3 only ever uses an HR target, for whom the LEFT half
    // alone already makes the condition true; the RIGHT half is never
    // exercised. An ACCOUNTANT target pins it in isolation, mirroring
    // MEMBER-MASK-2/3's "each half separately" rigor elsewhere in this PR.
    const ACCOUNTANT_TARGET_ID = 'accountant-target-uuid-9018'
    const SENIOR_OF_ACCOUNTANT_ID = 'senior-of-accountant-uuid-9019'
    const store = {
      users: [
        {
          id: ACCOUNTANT_TARGET_ID,
          displayName: 'Accountant Target',
          role: 'ACCOUNTANT',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: SENIOR_OF_ACCOUNTANT_ID,
          displayName: 'Senior Of Accountant',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [
        { teamId: TEAM_ID, userId: ACCOUNTANT_TARGET_ID, leftAt: null },
        { teamId: TEAM_ID, userId: SENIOR_OF_ACCOUNTANT_ID, leftAt: null },
      ],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(ACCOUNTANT_TARGET_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)
    expect(
      ids,
      "ACCOUNTANT target's own team SENIOR must be resolved via Step 1's team_members lookup",
    ).toContain(SENIOR_OF_ACCOUNTANT_ID)
  })

  it("DROP-BRANCH-MASK-5. DROP target whose drop-team ALSO has a SENIOR → the SENIOR's OTHER team is not leaked in (proves the HR/ACCOUNTANT branch selection excludes DROP)", async () => {
    // security-review PR #541 round 4 (mutation-gate follow-up): `else if
    // (user.role === 'HR' || user.role === 'ACCOUNTANT')` survived —
    // BRANCH-SELECT-3 only ever uses an HR target, for whom that condition
    // is already true either way. A DROP target discriminates it
    // differently from the SENIOR/JUNIOR cases above: DROP is NOT excluded
    // from `mayDeriveSeniorRoster`'s block by construction (see that
    // variable's own equivalence proof — DROP normally no-ops through Step
    // 1's role checks, since 'DROP' matches none of them). But mutating
    // THIS specific check to always-true makes a DROP with their OWN
    // team_members row (drop-teams can have an optional active SENIOR,
    // per TeamsService.mapDropTeam) incorrectly resolve THAT senior's OTHER
    // team roster and merge it into `rows` — polluting the DROP branch's
    // own, already-correct result with an unrelated team's HR.
    const DROP_ID = 'drop-with-senior-teammate-uuid-9014'
    const SENIOR_IN_DROP_TEAM_ID = 'senior-in-drop-team-uuid-9015'
    const OTHER_TEAM_ID = 'other-team-of-that-senior-9016'
    const UNRELATED_HR_ID = 'unrelated-hr-uuid-9017'
    const store = {
      users: [
        {
          id: DROP_ID,
          displayName: 'Drop With Senior Teammate',
          role: 'DROP',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: SENIOR_IN_DROP_TEAM_ID,
          displayName: 'Senior In Drop Team',
          role: 'SENIOR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
        {
          id: UNRELATED_HR_ID,
          displayName: 'Unrelated HR',
          role: 'HR',
          avatarUrl: null,
          avatarDocumentId: null,
        },
      ],
      teamMembers: [
        // The DROP-team itself: DROP + a SENIOR colleague.
        { teamId: TEAM_ID, userId: DROP_ID, leftAt: null },
        { teamId: TEAM_ID, userId: SENIOR_IN_DROP_TEAM_ID, leftAt: null },
        // A COMPLETELY UNRELATED team where that same SENIOR also happens to
        // be an active member, alongside an HR who must never surface in a
        // DROP's own roster.
        { teamId: OTHER_TEAM_ID, userId: SENIOR_IN_DROP_TEAM_ID, leftAt: null },
        { teamId: OTHER_TEAM_ID, userId: UNRELATED_HR_ID, leftAt: null },
      ],
    }
    const service = buildService(store)

    const rows = await service.getTeamMembersForUser(DROP_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)
    expect(ids, 'the DROP branch correctly finds their own SENIOR teammate').toContain(
      SENIOR_IN_DROP_TEAM_ID,
    )
    expect(
      ids,
      "an unrelated HR from the senior's OTHER team must never leak into a DROP's own roster",
    ).not.toContain(UNRELATED_HR_ID)
  })
})
