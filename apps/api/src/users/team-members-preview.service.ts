import { HttpStatus } from '@nestjs/common'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { projectMembers, projects, teamMembers, users, type User } from '../database/schema'
import { loadUserById } from './user-read.util'
import type { AppRole } from './users.service'

export interface TeamMemberPreview {
  id: string
  displayName: string
  role: User['role']
  avatarUrl: string | null
  avatarDocumentId: string | null
}

/**
 * Per-viewer-masked teammate roster (GET /users/:id/team). Read-only leaf
 * extracted from `UsersService`; reads the target via `loadUserById` (not the
 * facade) so there is no back-reference.
 */
export class TeamMembersPreviewService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Returns flat list of teammates for a given user. Combines:
   *  - team_members of teams associated with the user (HR, ACCOUNTANT, SENIOR)
   *  - JUNIORs active in projects owned by those teams' seniors
   * Excludes the user themselves.
   *
   * Mapping of "user → their team(s)":
   *  - SENIOR: teams owned by this senior (teams.senior_id = user.id is implicit via team_members)
   *  - JUNIOR: teams of seniors whose projects this junior is active in
   *  - HR / ACCOUNTANT: teams where the user is a team_member
   *  - ADMIN: no teams (returns empty)
   */
  /**
   * security-review PR #541 follow-up (HIGH): `viewerRole` is REQUIRED, not
   * optional. Before this fix the method had no notion of a viewer at all,
   * so masking JUNIOR identity from a SENIOR was structurally impossible —
   * `TeamTab.tsx` (GET /users/:id/team, this method's only caller) renders
   * the real displayName/avatar and a `/profile/$userId` link built from the
   * real id, the exact identity `ProjectsService.mapProject` and
   * `TeamsService.mapTeam` already redact for a SENIOR viewer elsewhere in
   * the CRM. This method is the data source for a SENIOR's OWN "Команда"
   * profile tab (self-view) — owner decision: RBAC rule #1 ("SENIOR must not
   * see JUNIOR identity anywhere") applies there too, self-view included.
   *
   * security-review PR #541 round 3 (single-exit hardening): the method used
   * to have FIVE exit points, and the viewerRole filter only guarded the
   * last one — the DROP branch `return`ed its own query result directly,
   * structurally bypassing the filter. Safe today only via two invariants
   * OUTSIDE this method (SENIOR can never reach a DROP target's "Команда"
   * tab per the access matrix; no JUNIOR row can exist in `team_members`),
   * neither of which this method itself enforces — widen the access matrix
   * and the bypass opens silently, with no test going red. Refactored so
   * every branch assigns into `rows` instead of returning; the viewerRole
   * filter at the bottom is now the ONLY return statement past the
   * not-found guard, so it cannot be skipped by construction.
   *
   * security-review PR #541 round 5 (mutation-gate suppression rework): the
   * round-4 patch wrapped every downstream query in an
   * `if (x.length > 0)` / `if (x.size > 0)` "skip when empty" guard, each
   * justified as an equivalence proof (`inArray(col, [])` compiles to SQL
   * `false`, so entering with an empty collection finds nothing regardless)
   * and suppressed accordingly. That was correct about the SQL, but wrong
   * about what a single `// Stryker disable next-line <mutator>` comment
   * actually silences: Stryker's `IgnoreRule` matches by (line, mutator
   * name) only, never by which replacement value, so a directive aimed at
   * "always-true is a no-op" also silenced "always-false", and for most of
   * these guards the always-false direction was real and had a real test
   * (BRANCH-SELECT-1/3) — silently swallowed, never executed by the gate.
   * Fixed by removing the guards outright instead of re-suppressing them:
   * every one of them was a pure "skip one DB round-trip" optimization with
   * no observable effect on `rows`, so deleting the condition deletes the
   * mutant along with it. The one remaining outer gate, `user.role !==
   * 'DROP'`, is NOT suppressed — unlike the guards it replaced
   * (`mayDeriveSeniorRoster`), both of its directions are genuine bugs with
   * genuine tests (see the comment at its `if` above).
   */
  async getTeamMembersForUser(userId: string, viewerRole: AppRole): Promise<TeamMemberPreview[]> {
    const user = await loadUserById(this.db.db, userId)
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)

    // Equivalence proof: every reachable path below (the `if` branch AND the
    // `else` branch, exhaustive on `user.role === 'DROP'`) unconditionally
    // reassigns `rows` before it is ever read — there is no path left where
    // this initial value survives to the RBAC filter at the bottom. A
    // mutated placeholder here can never be observed by any test.
    // Stryker disable next-line ArrayDeclaration: provably equivalent — see the paragraph immediately above (rows is unconditionally reassigned by every branch of the if/else below before it is ever read)
    let rows: TeamMemberPreview[] = []

    // security-review PR #541 round 5 (mutation-gate follow-up): a real
    // `if/else` here, not the two independent top-level `if`s round 4 used
    // (`if (user.role === 'DROP')` ... `if (user.role !== 'DROP')`). With two
    // independent conditions, forcing the FIRST one to always-true was a
    // no-op for every non-DROP role: the SECOND condition still evaluated
    // unmutated, Step 1-3 still ran, and its unconditional final assignment
    // silently overwrote whatever this branch produced — an equivalent
    // mutant Stryker could not be told apart from the real "force-always-false
    // skips a real DROP roster" direction (DROP-BRANCH-MASK-1/2), so it could
    // not be safely suppressed either (see the round-5 note in the method
    // docblock). Merging into one `if/else` ties both directions to this
    // SAME condition: force-always-true now means EVERY role — DROP or not —
    // takes this branch and Step 1-3 never runs at all, which BRANCH-SELECT-
    // 1/2/3 (non-DROP targets that need Step 1-3's roster) catch; force-
    // always-false means a DROP target falls through to Step 1-3 instead
    // (whose inner checks don't match 'DROP', producing `[]`), which DROP-
    // BRANCH-MASK-1/2 (non-empty DROP rosters) catch. No suppression needed.
    if (user.role === 'DROP') {
      // Drop role - phase 1: drop's "team members" are the drop-team itself
      // (HR + accountant + optional active senior). JUNIORs are not surfaced
      // (no JUNIOR row can exist in `team_members` — that table only ever
      // gets SENIOR/HR/ACCOUNTANT/DROP rows). The viewerRole filter below
      // still applies to whatever this branch produces regardless.
      //
      // security-review PR #541 round 5 (mutation-gate suppression rework):
      // no `if (dropMemberships.length > 0)` guard here on purpose — it used
      // to exist purely as a DB-round-trip optimization, never a correctness
      // requirement. Verified empirically against this repo's drizzle-orm
      // version: `inArray(teamMembers.teamId, [])` compiles to the literal
      // SQL fragment `false` (never `IN ()`, which would be a syntax error),
      // so running the query below with an empty `dropTeamIds` returns zero
      // rows anyway — identical to skipping it. The guard was removed rather
      // than suppressed because Stryker's `IgnoreRule` matches by (line,
      // mutator name) only, never by which replacement — it cannot silence
      // "always-true" without also silencing "always-false", and the
      // "always-false" direction here is real (killed by
      // DROP-BRANCH-MASK-3). Removing the condition removes the ambiguity
      // instead of trying to suppress half of it.
      const dropMemberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
      const dropTeamIds = dropMemberships.map((m) => m.teamId)
      rows = await this.db.db
        .select({
          id: users.id,
          displayName: users.displayName,
          role: users.role,
          avatarUrl: users.avatarUrl,
          avatarDocumentId: users.avatarDocumentId,
        })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            inArray(teamMembers.teamId, dropTeamIds),
            isNull(teamMembers.leftAt),
            ne(users.id, userId),
          ),
        )
    } else {
      // Step 1: Resolve set of seniorIds whose teams this user belongs to.
      // Left at `[]` for ADMIN (none of the branches below match 'ADMIN'),
      // which is what makes Step 2/3 below resolve nothing for an ADMIN
      // target — DROP-BRANCH-MASK-4 pins that outcome.

      // Equivalence proof: `seniorIds` is always overwritten synchronously or
      // via a DB lookup by exactly one of the four role branches below before
      // it is ever read (SENIOR: `[user.id]`; JUNIOR: derived from active
      // projects; HR/ACCOUNTANT: derived from team_members, or left `[]` when
      // this user has no team memberships of their own). In that last case a
      // mutated placeholder value is "washed out" downstream: `seniorIds`
      // only ever feeds `inArray(...)` filters (never returned directly), and
      // an arbitrary non-matching string finds the same zero rows a
      // genuinely empty array would — the RETURNED `rows` converge to the
      // identical result either way, for any real (non-Stryker-placeholder)
      // seed data. BRANCH-SELECT-1/2/3 each exercise a role whose branch DOES
      // overwrite `seniorIds`, which is the only way this variable's value
      // is ever actually read downstream.
      // Stryker disable next-line ArrayDeclaration: provably equivalent — see the paragraph immediately above (seniorIds only ever feeds inArray(...) filters that are washed out by a non-matching placeholder, never returned directly)
      let seniorIds: string[] = []

      if (user.role === 'SENIOR') {
        seniorIds = [user.id]
      } else if (user.role === 'JUNIOR') {
        const activeProjects = await this.db.db
          .select({ seniorId: projects.seniorId })
          .from(projectMembers)
          .innerJoin(projects, eq(projectMembers.projectId, projects.id))
          .where(and(eq(projectMembers.userId, userId), isNull(projectMembers.leftAt)))
        seniorIds = Array.from(new Set(activeProjects.map((p) => p.seniorId)))
      } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
        // MED-2 (security-review round 2): `isNull(leftAt)` — a soft-removed
        // HR/ACCOUNTANT membership must not resolve a team roster anymore.
        // Mirrors the HIGH-1 fix in teams.service.ts (isHrOfTeam/assertAccess).
        //
        // security-review PR #541 round 5: no `if (memberships.length > 0)`
        // guard — same "remove, don't suppress" reasoning as the DROP branch
        // above. `inArray(teamMembers.teamId, [])` -> SQL `false`, so running
        // the query below with an empty `membershipTeamIds` finds nothing,
        // same as skipping it; the "force skip" direction is real and killed
        // by BRANCH-SELECT-3.
        const memberships = await this.db.db
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
        const membershipTeamIds = memberships.map((m) => m.teamId)
        // LOW (security-review round 3, follow-up to #436): `isNull(leftAt)`
        // here too — without it a SENIOR rotated OUT of one of this HR's teams
        // (team_members.leftAt set, TeamsService.rotateSenior) still resolves
        // into `seniorIds` below, and their JUNIORs surface in this HR's
        // roster. No incremental data exposure (the same fields are visible
        // via the general user list this HR already has), but this brings the
        // check to the same "leftAt === null is the norm for every membership
        // check in this file" shape as everywhere else (see HIGH-1 above).
        const seniorsInTeams = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .innerJoin(users, eq(teamMembers.userId, users.id))
          .where(
            and(
              inArray(teamMembers.teamId, membershipTeamIds),
              eq(users.role, 'SENIOR'),
              isNull(teamMembers.leftAt),
            ),
          )
        seniorIds = Array.from(new Set(seniorsInTeams.map((s) => s.userId)))
      }

      // Step 2: Collect team_members (SENIOR + HR + ACCOUNTANT) across those seniors' teams.
      // Teams are linked to senior via team_members (the SENIOR is itself a member).
      // MED-2 (security-review round 2): `isNull(leftAt)` on BOTH queries below —
      // a detached (rotated-out) senior's team_members row must not resolve a
      // team, and a departed HR/ACCOUNTANT/SENIOR row must not surface in the
      // roster returned to the caller (stale-member leak, distinct from the
      // team-access class of bug already fixed in teams.service.ts).
      //
      // security-review PR #541 round 5: no `if (seniorIds.length > 0)` guard
      // around Step 2/3 — same "remove, don't suppress" reasoning. Every
      // `inArray(..., [])` below compiles to SQL `false`, so an empty
      // `seniorIds` flows through Step 2 and Step 3 finding nothing at each
      // stage, converging on the same `rows` as skipping the whole block
      // would. The "force skip" direction is real and killed by
      // BRANCH-SELECT-1.
      const seniorMemberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(
          and(
            inArray(teamMembers.userId, seniorIds),
            eq(users.role, 'SENIOR'),
            isNull(teamMembers.leftAt),
          ),
        )
      const teamIds = Array.from(new Set(seniorMemberships.map((m) => m.teamId)))

      const memberIds = new Set<string>()
      // security-review PR #541 round 5: no `if (teamIds.length > 0)` guard —
      // `inArray(teamMembers.teamId, [])` -> SQL `false`; the "force skip"
      // direction is real and killed by BRANCH-SELECT-1.
      const tmRows = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(inArray(teamMembers.teamId, teamIds), isNull(teamMembers.leftAt)))
      tmRows.forEach((r) => memberIds.add(r.userId))

      // Step 3: Add active JUNIORs from projects of those seniors.
      //
      // MED-3 (security-review round 3, follow-up to #436, reverted same PR):
      // an earlier round of this fix derived this list from `seniorMemberships`
      // above (i.e. required an ACTIVE team_members row) instead of the raw
      // `seniorIds` from Step 1. That silently narrowed the SENIOR self-view
      // case: rotation/archive-drop-team detaches a senior from their team
      // WITHOUT archiving their projects (`TeamsService.rotateSenior`,
      // `archiveDropTeam` — see their own docs), so a teamless senior still
      // legitimately owns active projects with active JUNIOR members during
      // that gap, and this method is also how a SENIOR views their OWN "team"
      // tab (`seniorIds = [user.id]` in Step 1's SENIOR branch, always exactly
      // themselves — never contaminated by the HR/ACCOUNTANT leak this PR
      // actually closes). Restored to raw `seniorIds`: the real vulnerability
      // (a rotated-out senior surfacing in an HR VIEWER's roster) is already
      // closed at its actual source — the `isNull(teamMembers.leftAt)` filter
      // added to Step 1's `seniorsInTeams` query above, which is the only
      // branch that ever populated `seniorIds` with someone other than the
      // viewer themselves or their own currently-active project seniors.
      const seniorProjects = await this.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.seniorId, seniorIds))
      const projectIds = seniorProjects.map((p) => p.id)
      // security-review PR #541 round 5: no `if (projectIds.length > 0)`
      // guard — `inArray(projectMembers.projectId, [])` -> SQL `false`; the
      // "force skip" direction is real and killed by BRANCH-SELECT-1.
      const juniorRows = await this.db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
      juniorRows.forEach((r) => memberIds.add(r.userId))

      memberIds.delete(userId)
      // security-review PR #541 round 5: no `if (memberIds.size > 0)` guard —
      // `inArray(users.id, [])` -> SQL `false`; the "force skip" direction is
      // real and killed by DROP-BRANCH-MASK-3 (a non-DROP-branch empty roster
      // must leave `rows` at `[]`, not error or hang on an unbounded query).
      rows = await this.db.db
        .select({
          id: users.id,
          displayName: users.displayName,
          role: users.role,
          avatarUrl: users.avatarUrl,
          avatarDocumentId: users.avatarDocumentId,
        })
        .from(users)
        .where(inArray(users.id, Array.from(memberIds)))
    }
    // user.role === 'ADMIN': Step 1's inner checks never match 'ADMIN', so
    // seniorIds stays [] and Step 2/3 resolve nothing — rows ends up [].

    // RBAC rule #1 (security-review PR #541 follow-up, HIGH): SENIOR viewers
    // must not see JUNIOR identity anywhere in the CRM, including their own
    // "Команда" profile tab (self-view is not exempt — owner decision).
    // Blanket-filtered rather than per-item redacted, mirroring the safer
    // shape TeamsService.mapTeam's `filteredJuniorMembers = []` and
    // ProjectsService.computeEffectiveTeam's `juniors = []` already use for
    // the same viewer role — there is no per-item boolean here a future
    // refactor could silently drop. This is the SINGLE return statement for
    // every branch above (round 3 hardening — see method docblock).
    if (viewerRole === 'SENIOR') {
      return rows.filter((r) => r.role !== 'JUNIOR')
    }
    return rows
  }
}
