/**
 * Unit tests — the DROP branch of UsersService.getTeamMembersForUser is
 * covered by the SAME viewerRole masking filter as every other branch.
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
 * This spec calls `getTeamMembersForUser` DIRECTLY with a synthetic DB
 * response that contains a `role: 'JUNIOR'` row inside the DROP branch's
 * query result — a shape that cannot occur via any real, currently-reachable
 * path — specifically to prove the METHOD ITSELF is safe regardless of what
 * upstream permission checks exist today or might change tomorrow. Same
 * defense-in-depth posture as `MEMBER-MASK-5` in
 * `senior-junior-member-mask.unit.spec.ts` (dangling `user: null` there;
 * "row shape that shouldn't happen but might" here).
 *
 * DROP-BRANCH-MASK-1  SENIOR viewer, DROP-team roster containing a synthetic
 *                      JUNIOR row → that row is filtered out; a real HR row
 *                      in the SAME result stays.
 * DROP-BRANCH-MASK-2  ADMIN viewer, the SAME synthetic roster → BOTH rows
 *                      stay (reverse-direction control — proves the filter
 *                      is viewer-scoped, not "always strip JUNIOR rows here").
 *
 * Mutation-testing proof: reverted the single-exit refactor by hand
 * (restoring the DROP branch's direct `return memberRows`, which skips the
 * filter), ran `pnpm --filter @crm/api exec vitest run get-team-members-drop-branch-mask`,
 * observed DROP-BRANCH-MASK-1 (and only that test) fail, then reverted the
 * revert (source unchanged in this PR — transcript in the PR body).
 */
import { describe, expect, it } from 'vitest'
import { UsersService } from './users.service'

// ---------------------------------------------------------------------------
// Fixture — a DROP target's team roster, containing rows the real schema
// cannot actually produce together (see file docblock).
// ---------------------------------------------------------------------------

const DROP_TARGET_ID = 'drop-real-uuid-5001'
const HR_ID = 'hr-real-uuid-6002'
const HR_DISPLAY_NAME = 'Drop Team HR'
const SYNTHETIC_JUNIOR_ID = 'synthetic-junior-uuid-7003'
const SYNTHETIC_JUNIOR_DISPLAY_NAME = 'Synthetic Junior (should never exist in this branch)'

const dropMemberRows = [
  {
    id: HR_ID,
    displayName: HR_DISPLAY_NAME,
    role: 'HR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
  },
  {
    id: SYNTHETIC_JUNIOR_ID,
    displayName: SYNTHETIC_JUNIOR_DISPLAY_NAME,
    role: 'JUNIOR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
  },
]

// ---------------------------------------------------------------------------
// Harness — sequential `db.select(...)` stub. `getTeamMembersForUser`'s DROP
// path issues exactly 3 selects in order:
//   1. findById(userId)         -> [{ id, role: 'DROP' }]
//   2. dropMemberships query    -> [{ teamId }]  (non-empty, enters the branch)
//   3. memberRows query         -> dropMemberRows (the fixture above)
// Each call gets its OWN result regardless of whether the caller chains
// `.from().where()` or `.from().innerJoin().where()`.
// ---------------------------------------------------------------------------

function buildService() {
  const sequencedResults: unknown[][] = [
    [{ id: DROP_TARGET_ID, role: 'DROP' }],
    [{ teamId: 'team-drop-1' }],
    dropMemberRows,
  ]
  let callIndex = 0

  const db = {
    db: {
      select: (_fields?: unknown) => {
        const result = sequencedResults[callIndex] ?? []
        callIndex++
        return {
          from: () => ({
            where: () => Promise.resolve(result),
            innerJoin: () => ({ where: () => Promise.resolve(result) }),
          }),
        }
      },
    },
  }

  return new UsersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getTeamMembersForUser — DROP branch is covered by the SAME viewerRole filter', () => {
  it('DROP-BRANCH-MASK-1. SENIOR viewer → synthetic JUNIOR row filtered out, real HR row stays', async () => {
    const service = buildService()
    const rows = await service.getTeamMembersForUser(DROP_TARGET_ID, 'SENIOR')
    const ids = rows.map((r) => r.id)

    expect(
      ids,
      'SENIOR viewer: JUNIOR row must be filtered out of the DROP branch too',
    ).not.toContain(SYNTHETIC_JUNIOR_ID)
    expect(ids, 'SENIOR viewer: real HR row must stay').toContain(HR_ID)
  })

  it('DROP-BRANCH-MASK-2. ADMIN viewer → both rows stay (reverse-direction control)', async () => {
    const service = buildService()
    const rows = await service.getTeamMembersForUser(DROP_TARGET_ID, 'ADMIN')
    const ids = rows.map((r) => r.id)

    expect(ids, 'ADMIN viewer: HR row present').toContain(HR_ID)
    expect(ids, 'ADMIN viewer: JUNIOR row present (proves the filter is SENIOR-scoped)').toContain(
      SYNTHETIC_JUNIOR_ID,
    )
  })
})
