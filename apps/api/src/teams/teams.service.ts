import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  projectMembers,
  projects,
  teamAuditLog,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { UsersService } from '../users/users.service'
import { TeamAuditLogService } from './team-audit-log.service'

type TeamWithMembers = typeof teams.$inferSelect & {
  members: Array<typeof teamMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

type ProjectWithMembers = typeof projects.$inferSelect & {
  members: Array<typeof projectMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

@Injectable()
export class TeamsService {
  constructor(
    private db: DatabaseService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private teamAuditLogService: TeamAuditLogService,
  ) {}

  // MED-2 (security-review PR #541 follow-up): `currentUser` is REQUIRED, not
  // optional. Both callers (findAll/findOne) already always supply it — an
  // optional param here is a fail-open-by-omission footgun: a future caller
  // that forgets to pass it would silently fall through the SENIOR/JUNIOR
  // `currentUser?.role` checks below to "unmasked" instead of failing `tsc`.
  private mapTeam(
    team: TeamWithMembers,
    allProjects: ProjectWithMembers[],
    currentUser: SessionUser,
  ) {
    // Drop role - phase 1: early return for drop-teams keeps the legacy
    // senior-team branch (below) byte-for-byte identical.
    if (team.type === 'DROP') {
      return this.mapDropTeam(team, currentUser)
    }

    // MED-2 (security-review round 2): `leftAt === null` — a rotated-out
    // (detached) senior's team_members row must not be treated as "the
    // team's senior" here. Without this, a stale/duplicate SENIOR row left
    // by a rotation could seed the wrong seniorId, deriving the wrong
    // (or an empty) junior roster for `mapTeam`'s consumers.
    const senior = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)

    const juniorMembers: Array<{
      id: string
      userId: string
      displayName: string
      email: string
      avatarUrl: string | null
      avatarDocumentId: string | null
      techStack: string[] | null
      phone: string | null
      telegram: string | null
      role: string
      joinedAt: string | Date
    }> = []

    if (senior) {
      const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
      const seenJuniorIds = new Set<string>()
      for (const project of seniorProjects) {
        for (const pm of project.members) {
          if (pm.leftAt === null && pm.user?.role === 'JUNIOR' && !seenJuniorIds.has(pm.userId)) {
            seenJuniorIds.add(pm.userId)
            juniorMembers.push({
              id: pm.id,
              userId: pm.userId,
              displayName: pm.user.displayName,
              email: pm.user.email,
              avatarUrl: pm.user.avatarUrl ?? null,
              avatarDocumentId: pm.user.avatarDocumentId ?? null,
              techStack: pm.user.techStack ?? null,
              phone: pm.user.phone ?? null,
              telegram: pm.user.telegram ?? null,
              role: 'JUNIOR',
              joinedAt: pm.joinedAt.toISOString(),
            })
          }
        }
      }
    }

    // RBAC: filter junior list based on the viewer's role.
    // JUNIOR viewer: sees only themselves (their own entry), not other JUNIORs.
    // SENIOR viewer: sees NO juniors (junior identity hidden from SENIOR per rule #1).
    let filteredJuniorMembers = juniorMembers
    if (currentUser.role === 'JUNIOR') {
      filteredJuniorMembers = juniorMembers.filter((j) => j.userId === currentUser.id)
    } else if (currentUser.role === 'SENIOR') {
      filteredJuniorMembers = []
    }

    // RBAC A01 (2026-06-10): JUNIOR viewer must NOT see real contacts of SENIOR/DROP members.
    // The legend-subject persona boundary: JUNIOR interacts with the client-facing persona
    // (legend), not the real identity. displayName and avatarUrl are safe — they are the
    // persona display fields (kept by #157 single-directional rule).
    // HR, ACCOUNTANT, and other non-legend-subject roles are NOT masked.
    const isJuniorViewer = currentUser.role === 'JUNIOR'

    return {
      id: team.id,
      name: team.name,
      type: team.type,
      telegram: team.telegram ?? null,
      telegramChannel: team.telegramChannel ?? null,
      notes: team.notes ?? null,
      // task-team-senior-share-override. Surfaced on the wire so the FE can
      // render the override field in the edit dialog + the MyProjectShares
      // source badge. NULL = no team override (resolver falls through).
      seniorSharePercentOverride: team.seniorSharePercentOverride ?? null,
      archivedAt: team.archivedAt ? team.archivedAt.toISOString() : null,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members: [
        ...team.members
          // security-review PR #541 round 3: `m.user !== null` added — a
          // dangling/unloaded user relation used to PASS this filter (neither
          // `undefined !== 'ADMIN'` nor `undefined !== 'JUNIOR'` excludes it)
          // and then default to role 'SENIOR' below, the fail-OPEN direction.
          // MEMBER-MASK-5 (senior-junior-member-mask.unit.spec.ts) already
          // pins the opposite, fail-CLOSED convention for mapProject
          // (`m.user?.role ?? 'JUNIOR'`) — a dangling identity is treated as
          // the MOST restricted role, not the least. Excluding it here
          // (same treatment as ADMIN/JUNIOR) brings this branch to the same
          // direction; the `?? 'JUNIOR'` default below is belt-and-suspenders
          // for the same reason.
          .filter(
            (m) =>
              m.user !== null &&
              m.user.role !== 'ADMIN' &&
              m.user.role !== 'JUNIOR' &&
              m.leftAt === null,
          )
          .map((m) => {
            const memberIsLegendSubject = m.user?.role === 'SENIOR' || m.user?.role === 'DROP'
            // Mask real contacts when JUNIOR views a SENIOR or DROP team member.
            const maskContacts = isJuniorViewer && memberIsLegendSubject
            return {
              id: m.id,
              userId: m.userId,
              displayName: m.user?.displayName ?? '',
              email: maskContacts ? null : (m.user?.email ?? ''),
              avatarUrl: m.user?.avatarUrl ?? null,
              avatarDocumentId: m.user?.avatarDocumentId ?? null,
              techStack: m.user?.techStack ?? null,
              phone: maskContacts ? null : (m.user?.phone ?? null),
              telegram: maskContacts ? null : (m.user?.telegram ?? null),
              // Equivalence proof: the `.filter(...)` above this `.map(...)` requires
              // `m.user !== null` for every element that reaches here, so `m.user` is
              // never null/undefined at this point and `m.user?.role` / `m.user.role`
              // read the IDENTICAL value. The `?? 'JUNIOR'` fallback (the actually
              // meaningful half of this expression) is real belt-and-suspenders and
              // stays unmutated — only the now-redundant `?.` is suppressed.
              // Stryker disable next-line OptionalChaining: provably equivalent — see the paragraph immediately above (the preceding .filter() already guarantees m.user is non-null here)
              role: m.user?.role ?? 'JUNIOR',
              joinedAt: m.joinedAt,
              leftAt: m.leftAt ? m.leftAt.toISOString() : null,
            }
          }),
        ...filteredJuniorMembers,
      ],
    }
  }

  /**
   * Drop-team variant: returns DROP owner + active SENIOR (if any) + HR(s)
   * + accountant. JUNIORs are NOT computed via project_members (drop-teams
   * don't propagate juniors through the senior — Phase 2 will add the
   * drop-project distribution; for now juniors remain a senior-team
   * concept only).
   */
  // MED-2 (security-review PR #541 follow-up): `currentUser` required here
  // too — mapTeam (its only caller) now always supplies it; keeping this one
  // optional would just move the same footgun one level down.
  private mapDropTeam(team: TeamWithMembers, currentUser: SessionUser) {
    // security-review PR #541 round 3: `m.user !== null` added — mirrors the
    // identical fail-open→fail-closed fix in mapTeam's senior-team branch
    // just above (same class of bug: a dangling user relation used to pass
    // this filter and default to role 'DROP' below).
    const activeMembers = team.members.filter(
      (m) =>
        m.leftAt === null && m.user !== null && m.user.role !== 'ADMIN' && m.user.role !== 'JUNIOR',
    )
    // RBAC A01 (2026-06-10): JUNIOR viewer must NOT see real contacts of SENIOR/DROP
    // members — same legend-persona boundary as mapTeam (senior-team branch).
    const isJuniorViewer = currentUser.role === 'JUNIOR'
    return {
      id: team.id,
      name: team.name,
      type: team.type,
      telegram: team.telegram ?? null,
      telegramChannel: team.telegramChannel ?? null,
      notes: team.notes ?? null,
      // task-team-senior-share-override. Drop-team can also carry an
      // override — applies to the drop-projects routed through this team
      // (when the project has no project-level override).
      seniorSharePercentOverride: team.seniorSharePercentOverride ?? null,
      archivedAt: team.archivedAt ? team.archivedAt.toISOString() : null,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members: activeMembers.map((m) => {
        const memberIsLegendSubject = m.user?.role === 'SENIOR' || m.user?.role === 'DROP'
        const maskContacts = isJuniorViewer && memberIsLegendSubject
        return {
          id: m.id,
          userId: m.userId,
          displayName: m.user?.displayName ?? '',
          email: maskContacts ? null : (m.user?.email ?? ''),
          avatarUrl: m.user?.avatarUrl ?? null,
          avatarDocumentId: m.user?.avatarDocumentId ?? null,
          techStack: m.user?.techStack ?? null,
          phone: maskContacts ? null : (m.user?.phone ?? null),
          telegram: maskContacts ? null : (m.user?.telegram ?? null),
          // Fail-closed default (belt-and-suspenders — the filter above
          // already excludes a dangling `user`; this default no longer
          // matters in practice but keeps the same safe direction if that
          // filter is ever weakened).
          // Equivalence proof: same as the identical line in mapTeam above —
          // `activeMembers` is already filtered to `m.user !== null`, so `m.user`
          // is never null/undefined here and `m.user?.role` / `m.user.role` read
          // the IDENTICAL value. The `?? 'JUNIOR'` fallback stays unmutated — only
          // the now-redundant `?.` is suppressed.
          // Stryker disable next-line OptionalChaining: provably equivalent — see the paragraph immediately above (the preceding .filter() already guarantees m.user is non-null here)
          role: m.user?.role ?? 'JUNIOR',
          joinedAt: m.joinedAt,
          leftAt: m.leftAt ? m.leftAt.toISOString() : null,
        }
      }),
    }
  }

  // HIGH-1 (security-audit authz-hardening): `team.members` returns EVERY row,
  // including soft-deleted ones (`leftAt != null` — set by removeMember).
  // Without the `leftAt === null` filter a member removed from the team keeps
  // being recognized as an active HR (or, in assertAccess/findAll below, as
  // any active member) for as long as their JWT is valid (up to 7 days) —
  // they retain read/write access, can rename the team, remove other members,
  // and reactivate their own row via addMember. The DROP branch of
  // assertAccess already filtered on `leftAt === null` correctly; this is now
  // the norm for every membership check in this file.
  private isHrOfTeam(team: TeamWithMembers, userId: string) {
    return team.members.some(
      (m) => m.userId === userId && m.user?.role === 'HR' && m.leftAt === null,
    )
  }

  /**
   * MED-3 (security-review round 2, authz-hardening): plain active-membership
   * check (any role), exposed publicly for callers that need to scope an
   * action to "a team this user actually belongs to" without loading the
   * full team+members tree. Introduced for `UsersService.createUser`'s
   * `teamMode='JOIN_DROP_TEAM'` path — `addSeniorToDropTeam` below
   * explicitly delegates RBAC to its caller (see that method's own
   * docblock), so without this check an HR actor could attach the SENIOR
   * they are provisioning to ANY drop-team with a free senior slot, not
   * just one they belong to — reaching into another team's payment routing.
   */
  async isActiveMemberOfTeam(teamId: string, userId: string): Promise<boolean> {
    const row = await this.db.db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, userId),
        isNull(teamMembers.leftAt),
      ),
    })
    return row !== undefined
  }

  /**
   * LOW (security-review round 3, follow-up to #436): scope for
   * `UsersService.rejoinTeam`'s self-service `teamMode='JOIN_DROP_TEAM'`
   * path. That endpoint is invoked by the SENIOR themselves — there is no
   * HR/ADMIN actor to scope against `isActiveMemberOfTeam` above, because
   * the whole point of a self-service endpoint is that nobody else
   * authorizes the request. Without ANY scope check, a teamless SENIOR
   * could self-attach to ANY drop-team with a free senior slot company-wide,
   * not just one they have ever been part of — combined with the accepted
   * round-1 risk (an HR actor can provision a SENIOR on an email HR
   * controls), this chains into another team's payment routing, just one
   * hop further than the path #436 already closed.
   *
   * The correct scope for a "REjoin" is a PAST `team_members` row for this
   * EXACT team **that was held as SENIOR**, not just any past row —
   * `team_members` carries no per-row role snapshot, so a plain
   * `leftAt IS NOT NULL` check (round-3 v1 of this method) cannot tell a
   * former SENIOR apart from a former HR/ACCOUNTANT/DROP member of the SAME
   * team who was later promoted to SENIOR (role change is ADMIN-only, but
   * routine `TeamsController.addMember`/`removeMember` calls make HR/
   * ACCOUNTANT/DROP membership rows trivial to create and remove — far
   * easier than the two SENIOR-only detach paths below).
   *
   * MED-1 (security-review round 3, follow-up to #436) — v1 tried to verify
   * this via NEGATIVE evidence from `team_audit_log` (treat ABSENCE of a
   * disqualifying non-SENIOR removal row as a pass). That was wrong: the
   * SENIOR-only detach paths (`archiveDropTeam`, `rotateSenior`) wrote no
   * audit row of their own either, so absence of evidence proved nothing —
   * the check's correctness quietly depended on `archiveDropTeam`'s mass,
   * un-audited HR/Accountant/DROP detach (`.update(teamMembers).set({
   * leftAt: now }).where(teamId = X AND leftAt IS NULL)`, no per-row
   * `team_member_removed` write) never being reachable again from a
   * currently-active drop-team — true only because that method always also
   * archives the team in the same call, and nothing in this codebase
   * un-archives a drop-team today. A future "unarchive drop-team" feature
   * would have silently reopened the exact HR/ACCOUNTANT/DROP→SENIOR
   * promotion chain this method exists to close, with no test or docblock
   * flagging the dependency.
   *
   * MED-1 round 4 (closed same PR): flipped to POSITIVE evidence instead.
   * `archiveDropTeam`'s senior-detach and `rotateSenior`'s senior-detach —
   * the ONLY two paths that ever move a SENIOR out of a drop-team — now
   * EACH write their own `team_member_removed` `team_audit_log` row with
   * `changes.role.before = 'SENIOR'` (see those methods). This method
   * requires that exact row to exist for `(teamId, userId)` — fail-closed:
   * no positive proof, no rejoin. This needs no migration/backfill, is
   * immune to rows that predate this fix or get imported some other way,
   * and closes both today's archive-only path AND any future
   * unarchive-drop-team path the same way, instead of depending on an
   * incidental invariant holding forever.
   *
   * Accepted cost (owner-reviewed): a SENIOR detached BEFORE this change
   * shipped has no such audit row and therefore cannot self-rejoin anymore —
   * ADMIN/HR must reattach them via `rotateSenior` (or `createUser`'s
   * `teamMode='JOIN_DROP_TEAM'`) instead. Acceptable for the team's current
   * size; the alternative (a role column on `team_members` itself) needs a
   * prod migration plus edits at every one of the half-dozen insert sites.
   */
  async wasFormerMemberOfTeam(teamId: string, userId: string): Promise<boolean> {
    const row = await this.db.db
      .select({ id: teamAuditLog.id })
      .from(teamAuditLog)
      .where(
        and(
          eq(teamAuditLog.targetId, teamId),
          eq(teamAuditLog.action, 'team_member_removed'),
          sql`${teamAuditLog.changes} -> 'userId' ->> 'before' = ${userId}`,
          sql`${teamAuditLog.changes} -> 'role' ->> 'before' = 'SENIOR'`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0])

    return row !== undefined
  }

  private async fetchAllProjects(): Promise<ProjectWithMembers[]> {
    return this.db.db.query.projects.findMany({
      with: { members: { with: { user: true } } },
    }) as Promise<ProjectWithMembers[]>
  }

  async create(
    name: string,
    seniorId: string,
    hrIds: string[],
    accountantId: string | null,
    currentUser: SessionUser,
  ) {
    // HIGH-2 (security-review #328): POST /api/teams is ADMIN-only.
    // HR creates senior+team via POST /api/users (HrCreateSeniorDialog) — that is
    // the established HR workflow and is NOT this endpoint. Restricting to ADMIN
    // eliminates the HR-BOLA vector without breaking any existing HR UX.
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException()
    }

    // SEC-02 (HIGH): validate roles of all supplied member IDs before any INSERT.
    // Without this check a caller could supply a victim SENIOR's id in hrIds
    // (or a non-SENIOR in seniorId) and gain getHrSeniorIds-based access to
    // that SENIOR's projects/documents (BOLA). Pattern follows createDropTeam.
    await this.assertUserRole(seniorId, 'SENIOR')
    for (const hrId of hrIds) {
      await this.assertUserRole(hrId, 'HR')
    }
    if (accountantId !== null) {
      await this.assertUserRole(accountantId, 'ACCOUNTANT')
    }

    // Dual-active-senior guard: a SENIOR may only belong to ONE active team at
    // a time. Mirrors the check in addSeniorToDropTeam.
    const existingMembership = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (existingMembership) {
      throw new BadRequestException('Синьор уже состоит в другой активной команде')
    }

    // Wrap team + members INSERT in a transaction so a partial failure (team
    // inserted but members not) cannot leave an orphaned team row.
    const team = await this.db.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(teams).values({ name }).returning()
      if (!inserted) throw new Error('Failed to create team')

      const memberIds = [seniorId, ...hrIds, ...(accountantId ? [accountantId] : [])]
      for (const userId of memberIds) {
        await tx.insert(teamMembers).values({ teamId: inserted.id, userId })
      }

      return inserted
    })

    return team
  }

  async findAll(currentUser: SessionUser, filter: { archived?: boolean | 'all' } = {}) {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived teams (used by the «Все» tab); boolean keeps the legacy behavior.
    const archivedWhere =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(teams.archivedAt)
          : isNull(teams.archivedAt)
    const [allTeams, allProjects] = await Promise.all([
      this.db.db.query.teams.findMany({
        ...(archivedWhere ? { where: archivedWhere } : {}),
        with: { members: { with: { user: true } } },
      }),
      this.fetchAllProjects(),
    ])

    let filtered = allTeams
    if (currentUser.role === 'HR') {
      // task-hr-team-exclude-drop: HR sees only recruiting (SENIOR-type) teams.
      // DROP-type teams are payment-routing internals and are irrelevant to the
      // HR recruiting workflow. Filter applied before isHrOfTeam so that even if
      // an HR is technically a member of a DROP team they don't see it.
      filtered = allTeams.filter((t) => t.type !== 'DROP' && this.isHrOfTeam(t, currentUser.id))
    } else if (currentUser.role === 'DROP') {
      // Drop role - phase 1 (task-drop-1-backend AC1). EXPLICIT branch: a DROP
      // sees ONLY teams where they are a current static member (their own
      // drop-team — created by `createDropTeam` with drop + HR + ACCOUNTANT).
      // The JUNIOR project-derivation below MUST NOT apply to DROP (a drop is
      // never derived into another senior's team via a project), so this
      // branch is kept separate and deliberately narrow. Contract pinned by
      // teams.drop.spec.ts: own team visible / foreign team hidden / never
      // "all teams". Membership is ACTIVE-only (`leftAt === null`) per the
      // task spec (`team_members.user_id = drop.id AND left_at IS NULL`) — a
      // drop removed from a team must not keep seeing it.
      filtered = allTeams.filter((t) =>
        t.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
      )
    } else if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      // SENIOR/JUNIOR: show teams where they are a static member
      // For JUNIORs derived from projects, also include teams where their senior is
      // HIGH-1: `leftAt === null` — a soft-deleted (removed) static membership
      // must not keep the team visible. Mirrors the DROP branch above.
      filtered = allTeams.filter((t) => {
        if (t.members.some((m) => m.userId === currentUser.id && m.leftAt === null)) return true
        if (currentUser.role === 'JUNIOR') {
          // Check if this team's senior has an active project with this junior
          // MED-2 (security-review round 2): `leftAt === null` — a rotated-out
          // senior's team_members row must not seed this lookup (mirrors the
          // same fix in mapTeam). Without it, a detached senior could keep
          // granting their old juniors visibility into a team they left, or a
          // stale row could shadow the CURRENT senior and wrongly deny access.
          const senior = t.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
          if (senior) {
            const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
            return seniorProjects.some((p) =>
              p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
            )
          }
        }
        return false
      })
    }

    return filtered.map((t) => this.mapTeam(t, allProjects, currentUser))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const [team, allProjects] = await Promise.all([
      this.db.db.query.teams.findFirst({
        where: eq(teams.id, id),
        with: { members: { with: { user: true } } },
      }),
      this.fetchAllProjects(),
    ])
    if (!team) throw new NotFoundException('Team not found')
    this.assertAccess(team, currentUser, allProjects)
    return this.mapTeam(team, allProjects, currentUser)
  }

  async update(
    id: string,
    name: string,
    telegram: string | null | undefined,
    notes: string | null | undefined,
    currentUser: SessionUser,
    telegramChannel?: string | null | undefined,
    extra?: {
      // task-team-senior-share-override. Optional team-level override for
      // the SENIOR's share percent. Integer 0-100 or null (clear). Defined
      // when the PATCH body explicitly carries the field (a JSON `null` is
      // distinct from "absent" because zod's `.optional().nullable()`
      // surfaces both). Validation (range / integer) lives in the shared
      // updateTeamSchema; this method only enforces RBAC.
      seniorSharePercentOverride?: number | null | undefined
    },
  ) {
    // ACCOUNTANT is allowed to set the override but not REQUIRED to be a team
    // member (they have cross-team financial authority). For all other general
    // mutations we still require ADMIN or HR.
    if (
      currentUser.role !== 'ADMIN' &&
      currentUser.role !== 'HR' &&
      currentUser.role !== 'ACCOUNTANT'
    ) {
      throw new ForbiddenException()
    }

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, id),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    // HR scope check: HR may only update teams they are a member of.
    // ACCOUNTANT is exempt from this check — their authority is cross-team.
    if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
      throw new ForbiddenException()
    }

    // HIGH-1 (security-review #328): gate on REAL VALUE CHANGE, not key presence.
    // The controller always calls updateTeamSchema.parse() which produces an
    // object that carries `seniorSharePercentOverride` as a key even when the
    // client body omitted it (zod .optional() yields `undefined`, not absent).
    // Object.prototype.hasOwnProperty therefore always returns true, causing HR
    // to receive 403 when editing only name/notes.  Fix: compare incoming value
    // against the stored value and only block when it actually changes.
    const incomingOverride =
      extra !== undefined &&
      Object.prototype.hasOwnProperty.call(extra, 'seniorSharePercentOverride')
        ? (extra.seniorSharePercentOverride ?? null)
        : undefined // key absent → no override intent

    const storedOverride = team.seniorSharePercentOverride ?? null
    const overrideChanged = incomingOverride !== undefined && incomingOverride !== storedOverride

    // SEC-04 (MED): seniorSharePercentOverride gates separately from general
    // team-update RBAC. The override is snapshotted into
    // transactions.senior_share_percent at income-creation time, so it has
    // direct financial impact. Mirrors the project-level override guard in
    // ProjectsService (~:610-618). HR may update name/notes/telegram but
    // CANNOT change the financial override.
    if (overrideChanged && currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Изменение доли синьора на уровне команды доступно только ADMIN и ACCOUNTANT',
      )
    }

    const [updated] = await this.db.db
      .update(teams)
      .set({
        name,
        ...(telegram !== undefined ? { telegram } : {}),
        ...(telegramChannel !== undefined ? { telegramChannel } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(incomingOverride !== undefined ? { seniorSharePercentOverride: incomingOverride } : {}),
        updatedAt: new Date(),
      })
      .where(eq(teams.id, id))
      .returning()

    // SEC-04 audit: record when seniorSharePercentOverride changes so there is
    // a traceable history of financial-impact edits. Written after UPDATE so
    // the audit row is only created when the DB write succeeded.
    if (overrideChanged) {
      // security-review round 2 (authz-hardening): attribute to the real
      // operator under impersonation — see sessionUserSchema.impersonatorId's
      // doc for the full rationale.
      await this.teamAuditLogService.record({
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: id,
        action: 'team_updated',
        changes: {
          seniorSharePercentOverride: { before: storedOverride, after: incomingOverride },
        },
      })
    }

    return updated
  }

  /**
   * Soft-archive a team. By business invariant, archiving the team is equivalent
   * to archiving its SENIOR — the two are inseparable. We delegate to
   * UsersService.archive(team.seniorId) which performs the pair-cascade
   * (archive senior + projects; membership of HR/Acc/Junior is left alone —
   * see task-archive-pending-modal AC9).
   */
  async archive(teamId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')
    if (team.archivedAt) throw new BadRequestException('Team is already archived')

    // Drop-archive round 2 (B1): dispatch by team type. Drop-teams use the
    // dedicated `archiveDropTeam` primitive (drop archived + projects
    // cascade + senior detached *without* archiving).
    //
    // task-archive-pending-modal (AC10): `archiveDropTeam` issues several
    // sequential writes (team, projects, the drop's own user row) — calling
    // it bare (no `tx`) meant a failure partway left the DB in whatever state
    // the writes-so-far produced. Wrapping the call in `db.transaction()` is
    // what makes AC7's "одной операцией, а не по одному" true at the
    // database level, not just in the code's shape.
    if (team.type === 'DROP') {
      await this.db.db.transaction((tx) => this.archiveDropTeam(teamId, tx))
      return this.findOne(teamId, currentUser)
    }

    const seniorMember = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
    if (!seniorMember) {
      throw new BadRequestException('Team has no active SENIOR — cannot archive via pair flow')
    }
    await this.usersService.archive(seniorMember.userId, currentUser.id)
    return this.findOne(teamId, currentUser)
  }

  /**
   * Pair-unarchive: restore SENIOR + team. Projects remain archived;
   * HR/Acc memberships remain closed (admin re-adds via Teams page).
   */
  async unarchive(teamId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: true },
    })
    if (!team) throw new NotFoundException('Team not found')
    if (!team.archivedAt) throw new BadRequestException('Team is not archived')

    // Find SENIOR via team_members + users join — `with: { members: true }`
    // above doesn't include user.role, so we run a focused lookup here.
    // MED-2 (security-review round 2): `isNull(leftAt)` — without it, a
    // team with rotation history (a detached ex-senior row PLUS the current
    // active senior row, both role=SENIOR) has no ORDER BY guarantee on
    // which row `rows[0]` picks. Picking the detached one would silently
    // restore access to the WRONG (possibly still-fired) person instead of
    // the team's actual current senior.
    const seniorRow = await this.db.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    if (!seniorRow) {
      throw new NotFoundException('Senior of this team not found')
    }
    await this.usersService.unarchive(seniorRow.userId, currentUser.id)
    return this.findOne(teamId, currentUser)
  }

  /**
   * Returns the archive impact for the team (pair = senior). UI uses for warnings.
   */
  async getArchiveImpact(teamId: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
    })
    if (!team) throw new NotFoundException('Team not found')

    // Drop-archive round 2 (B2): branch by team type. Drop-teams have a
    // different "paired" entity — the drop (not a senior). UI keys on
    // `teamType` to render the right copy + confirm-input.
    if (team.type === 'DROP') {
      // Resolve the drop owner (paired user for the confirmation text).
      const dropRow = await this.db.db
        .select({ id: users.id, displayName: users.displayName })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), eq(users.role, 'DROP'), isNull(teamMembers.leftAt)),
        )
        .then((rows) => rows[0])
      // Active senior (informational only — gets detached without archive).
      const seniorRow = await this.db.db
        .select({ id: users.id, displayName: users.displayName })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
        )
        .then((rows) => rows[0])
      // Active HR/Accountant count. task-archive-pending-modal (AC9): these
      // are NOT detached by `archiveDropTeam` any more — they keep their
      // membership and keep earning. Kept as "how many are on this team" for
      // the warning copy. Computed cheaply with a single query excluding the
      // drop + senior rows.
      const others = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt), eq(users.role, 'HR')),
        )
      const accountants = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            isNull(teamMembers.leftAt),
            eq(users.role, 'ACCOUNTANT'),
          ),
        )
      // Drop-projects count + names (AC8).
      const dropProjects = dropRow
        ? await this.db.db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(and(eq(projects.dropId, dropRow.id), isNull(projects.archivedAt)))
        : []
      // task-archive-pending-modal (AC2): the drop's own pending
      // transactions — delegate to UsersService so the rule lives in ONE
      // place. Only reachable when the drop resolved (a team with no active
      // drop member has nothing to forward).
      const dropPendingTransactions = dropRow
        ? await this.usersService
            .getArchiveImpact(dropRow.id, currentUser)
            .then((i) =>
              i.type === 'user' && i.role === 'DROP' ? (i.pendingTransactions ?? []) : [],
            )
        : []
      return {
        type: 'team',
        isPaired: true,
        teamName: team.name,
        // Keep `seniorName` for legacy clients — empty if no senior attached.
        // The new `dropName` field is what the v2 UI keys on.
        seniorName: seniorRow?.displayName ?? '',
        projectsCount: dropProjects.length,
        projectNames: dropProjects.map((p) => p.name),
        membersAffected: others.length + accountants.length,
        teamType: 'DROP',
        dropName: dropRow?.displayName ?? '',
        seniorWillBeDetached: !!seniorRow,
        pendingTransactions: dropPendingTransactions,
      }
    }

    // SENIOR team — legacy path (unchanged 1:1 from round 1).
    const seniorRow = await this.db.db
      .select({ id: users.id, displayName: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    if (!seniorRow) {
      return {
        type: 'team',
        isPaired: true,
        teamName: team.name,
        seniorName: '',
        projectsCount: 0,
        membersAffected: 0,
        teamType: 'SENIOR',
      }
    }
    const userImpact = await this.usersService.getArchiveImpact(seniorRow.id, currentUser)
    const seniorImpact =
      userImpact.type === 'user' && userImpact.role === 'SENIOR' ? userImpact : null
    return {
      type: 'team',
      isPaired: true,
      teamName: team.name,
      seniorName: seniorRow.displayName,
      projectsCount: seniorImpact?.projectsCount ?? 0,
      // task-archive-pending-modal (AC8/AC2): forwarded 1:1 from the senior's
      // own user-impact — archiving the team IS archiving the senior.
      projectNames: seniorImpact?.projectNames ?? [],
      membersAffected: seniorImpact?.hrAccountantsToBeRemoved ?? 0,
      teamType: 'SENIOR',
      pendingTransactions: seniorImpact?.pendingTransactions ?? [],
    }
  }

  async addMember(teamId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
      throw new ForbiddenException()
    }

    const user = await this.db.db.query.users.findFirst({ where: eq(users.id, userId) })
    if (!user) throw new NotFoundException('User not found')
    if (user.role === 'ADMIN') throw new BadRequestException('Admin cannot be a team member')

    // SEC-02 (HIGH) addMember vector: HR adding an arbitrary SENIOR via
    // POST /teams/:id/members is the same BOLA class as the create() vector —
    // HR gains getHrSeniorIds-based scope over a senior they had no prior
    // relationship with. The legitimate way to assign a SENIOR to a team is
    // via POST /api/teams (create, ADMIN-only) or rotateSenior. Restrict
    // SENIOR additions through addMember to ADMIN-only; HR may still add
    // JUNIOR / HR / ACCOUNTANT members (their established recruiting workflow).
    if (user.role === 'SENIOR' && currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Добавление синьора в команду доступно только ADMIN')
    }

    // Prevent adding a second SENIOR
    // MED-2 (security-review round 2, informational — consistency, not a
    // security fix): `leftAt === null` — without it a rotated-out senior's
    // stale row permanently blocks ever adding a new senior to this team
    // (conservative failure, not an access bug), even though the team is
    // legitimately senior-less after rotation. Brought in line with every
    // other SENIOR lookup in this file.
    if (user.role === 'SENIOR') {
      const hasSenior = team.members.some((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
      if (hasSenior) throw new BadRequestException('Team already has a senior')
    }

    // Prevent adding a JUNIOR who has an active project
    if (user.role === 'JUNIOR') {
      const allProjects = await this.fetchAllProjects()
      const hasActiveProject = allProjects.some((p) =>
        p.members.some((m) => m.userId === userId && m.leftAt === null),
      )
      if (hasActiveProject) throw new BadRequestException('Junior already has an active project')
    }

    // Re-add semantics after the soft-delete change to removeMember: a removed
    // member leaves a soft-deleted row (leftAt != null). Reject only ACTIVE
    // duplicates; reactivate a soft-deleted row instead of inserting a second
    // one (mirrors UsersService.upsertTeamMemberTx). Without this, re-adding a
    // previously removed member would 400 ("User is already a member").
    //
    // HIGH-1: reactivating a soft-deleted row is intentionally gated by the
    // SAME guard as the rest of this method (:611-613 role check + :619-621
    // isHrOfTeam, now leftAt-filtered) — only ADMIN or an ACTIVE HR of THIS
    // team can ever reach this line. A removed HR calling addMember on
    // themselves (the attack chain this fix closes) is rejected by the
    // isHrOfTeam check above and never gets here.
    const existing = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    })
    if (existing) {
      if (existing.leftAt === null) {
        throw new BadRequestException('User is already a member')
      }
      await this.db.db
        .update(teamMembers)
        .set({ leftAt: null })
        .where(eq(teamMembers.id, existing.id))
      return
    }

    await this.db.db.insert(teamMembers).values({ teamId, userId })
  }

  async removeMember(teamId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const team = await this.db.db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { members: { with: { user: true } } },
    })
    if (!team) throw new NotFoundException('Team not found')

    if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
      throw new ForbiddenException()
    }

    // The `members` relation returns ALL rows including soft-deleted ones
    // (leftAt != null). Since removeMember now soft-deletes, every check below
    // must consider only ACTIVE members — otherwise a previously-removed row
    // would (a) be re-"found" as removable, and (b) inflate the HR/ACCOUNTANT
    // minimum-count guards.
    const activeMembers = team.members.filter((m) => m.leftAt === null)

    const memberToRemove = activeMembers.find((m) => m.userId === userId)
    if (!memberToRemove) throw new NotFoundException('Member not found in team')

    const removedRole = memberToRemove.user?.role
    if (removedRole === 'SENIOR') {
      throw new BadRequestException(
        'Cannot remove the senior from a team — delete the team instead',
      )
    }

    if (removedRole === 'HR') {
      const hrCount = activeMembers.filter((m) => m.user?.role === 'HR').length
      if (hrCount <= 1) {
        throw new BadRequestException('Team must have at least one HR')
      }
    }

    if (removedRole === 'ACCOUNTANT') {
      const accountantCount = activeMembers.filter((m) => m.user?.role === 'ACCOUNTANT').length
      if (accountantCount <= 1) {
        throw new BadRequestException('Team must have at least one accountant')
      }
    }

    // Soft-delete the membership (set leftAt=now) instead of a physical DELETE,
    // so the row survives for audit/history — consistent with every other exit
    // path (archiveDropTeam, rotateSenior). A physical delete erased the
    // membership entirely and skipped the audit trail (pre-deploy MEDIUM).
    // The audit insert is part of the same transaction: a rollback discards both.
    const now = new Date()
    await this.db.db.transaction(async (tx) => {
      await tx
        .update(teamMembers)
        .set({ leftAt: now })
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, userId),
            isNull(teamMembers.leftAt),
          ),
        )
      // security-review round 2 (authz-hardening): attribute to the real
      // operator under impersonation — see sessionUserSchema.impersonatorId's
      // doc for the full rationale.
      await this.teamAuditLogService.record(
        {
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: teamId,
          action: 'team_member_removed',
          changes: {
            userId: { before: userId, after: null },
            role: { before: removedRole ?? null, after: null },
          },
        },
        tx,
      )
    })
  }

  private assertAccess(
    team: TeamWithMembers,
    currentUser: SessionUser,
    allProjects: ProjectWithMembers[],
  ) {
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return

    // Drop role - phase 1 (task-drop-1-backend AC2). EXPLICIT, ACTIVE-only
    // branch evaluated BEFORE the generic membership check below: a DROP may
    // access a team ONLY when they are a CURRENT member (`leftAt === null`),
    // matching the findAll DROP filter. A foreign team — or one the drop has
    // left — is unconditionally forbidden; the JUNIOR project-derivation below
    // MUST NOT grant a DROP access. Returning/throwing here keeps the contract
    // unambiguous and future-proof.
    if (currentUser.role === 'DROP') {
      if (team.members.some((m) => m.userId === currentUser.id && m.leftAt === null)) return
      throw new ForbiddenException()
    }

    // HIGH-1: `leftAt === null` — a soft-deleted (removed) static membership
    // must not keep granting access. Mirrors the DROP branch above.
    if (team.members.some((m) => m.userId === currentUser.id && m.leftAt === null)) return

    // For JUNIORs: check if they have an active project with this team's senior
    // MED-2 (security-review round 2): `leftAt === null` — same fix as
    // findAll's JUNIOR branch above; a rotated-out senior's stale row must
    // not seed this lookup (mirror-image bug of the DROP/general branches:
    // it could both wrongly grant access via a departed senior AND wrongly
    // deny access by shadowing the current one).
    if (currentUser.role === 'JUNIOR') {
      const senior = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
      if (senior) {
        const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
        const hasActiveProjectWithSenior = seniorProjects.some((p) =>
          p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
        )
        if (hasActiveProjectWithSenior) return
      }
    }

    throw new ForbiddenException()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Drop role - phase 1: drop-team primitives
  //
  // Strictly additive. The legacy senior-team methods above (`create`,
  // `archive`, `addMember`, `removeMember`, `mapTeam` SENIOR branch) are
  // UNCHANGED. All drop-team behavior lives in the methods below.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Helper for asserting that a user has the expected role, surfacing
   * a 400 instead of an opaque 500.
   */
  private async assertUserRole(
    userId: string,
    expectedRole: 'DROP' | 'SENIOR' | 'HR' | 'ACCOUNTANT',
    tx?: DrizzleTx,
    genericMessage = false,
  ): Promise<void> {
    // MED (security-review #328): callers that are reachable by non-ADMIN users
    // (e.g. rotateSenior, addSeniorToDropTeam) should pass genericMessage=true
    // so that the error message does not leak whether a userId exists or what
    // role it holds — an information oracle usable for user enumeration.
    const handle = tx ?? this.db.db
    const u = await handle
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .then((rows) => rows[0])
    if (!u || u.role !== expectedRole) {
      if (genericMessage) {
        throw new BadRequestException(
          'Указанный пользователь не найден или имеет неподходящую роль',
        )
      }
      if (!u) throw new BadRequestException(`Пользователь ${userId} не найден`)
      throw new BadRequestException(`Ожидалась роль ${expectedRole}, получено ${u.role}`)
    }
  }

  /**
   * Create a drop-team for an existing DROP user. Used by
   * `UsersService.createDrop` inside a single transaction so the DROP user
   * insert + team creation either commit together or roll back together.
   *
   * Validations:
   *  - `dropId.role === 'DROP'`
   *  - `hrIds.length >= 1` and every hrId has `role === 'HR'`
   *  - `accountantId` is OPTIONAL (nullable); when supplied it must have
   *    `role === 'ACCOUNTANT'`. A drop-team without an accountant is valid.
   *
   * Telegram channel is stored on `teams.telegram_channel` (column already
   * exists from 0007). No standalone `telegram` field on the drop-team —
   * spec keeps that for senior-team comms only.
   */
  async createDropTeam(
    dropId: string,
    hrIds: string[],
    accountantId: string | null,
    telegramChannel: string | null,
    tx?: DrizzleTx,
  ): Promise<typeof teams.$inferSelect> {
    if (hrIds.length < 1) {
      throw new BadRequestException('HR обязателен (минимум 1)')
    }
    const handle = tx ?? this.db.db
    await this.assertUserRole(dropId, 'DROP', tx)
    for (const hrId of hrIds) await this.assertUserRole(hrId, 'HR', tx)
    // Accountant is OPTIONAL for a drop-team (mirrors the senior `create`
    // path). Only validate the role when one was actually supplied.
    if (accountantId !== null) {
      await this.assertUserRole(accountantId, 'ACCOUNTANT', tx)
    }

    const dropUser = await handle
      .select()
      .from(users)
      .where(eq(users.id, dropId))
      .then((rows) => rows[0])
    if (!dropUser) throw new BadRequestException('Дроп не найден')

    const inserted = await handle
      .insert(teams)
      .values({
        name: `Команда ${dropUser.displayName}`,
        type: 'DROP',
        telegramChannel: telegramChannel ?? null,
      })
      .returning()
    const team = inserted[0]
    if (!team) throw new Error('Failed to create drop team')

    const memberIds = [dropId, ...hrIds, ...(accountantId ? [accountantId] : [])]
    for (const userId of memberIds) {
      await handle.insert(teamMembers).values({ teamId: team.id, userId })
    }
    return team
  }

  /**
   * Archive a drop-team. Caller is `UsersService.archiveDrop` (drop-user
   * archive cascade) or `TeamsService.archive` (explicit team-archive entry
   * point, itself now wrapped in a transaction — see AC10 note on the
   * caller).
   *
   * Cascades (per spec §7, revised by task-archive-pending-modal AC9):
   *  - Drop-projects of this team's drop → `archivedAt=now()`.
   *  - Active SENIOR in this team → `team_members.leftAt=now()`. SENIOR is
   *    NOT archived (their user row stays active; they become teamless).
   *    Pre-existing rotation mechanic, unrelated to AC9 — a senior is never a
   *    project_member/team_member the salary cron reads for THIS person's own
   *    pay (their income comes via `projects.seniorId`, not team membership).
   *  - HR + ACCOUNTANT in this team, and JUNIOR on the drop-projects, are
   *    LEFT ALONE (owner decision 2026-08-19, AC9): archiving the drop's
   *    team/projects is not archiving them — their own `archivedAt` is what
   *    the salary cron reads, and the cascade never touches it. An earlier
   *    revision of this method DID detach both; that was removed here.
   *  - `teams.archivedAt=now()`.
   *
   * Returns `{ archivedProjects, detachedSeniorId }` so the UI can render
   * a confirmation toast.
   */
  async archiveDropTeam(
    teamId: string,
    tx?: DrizzleTx,
  ): Promise<{ archivedProjects: number; detachedSeniorId: string | null }> {
    const handle = tx ?? this.db.db
    // security-review PR #584 round 2 (MED-4): same row-lock rationale as
    // UsersService.archive/archiveDrop — this is the SECOND layer, reached
    // from all three entry points (TeamsService.archive DROP branch,
    // UsersService.archiveDrop, UsersService.archive DROP branch), so it
    // closes the race even for a caller that forgot its own lock. `.for()`
    // is a no-op outside an open transaction (no caller does that today —
    // all three pass `tx`), so this stays harmless if `handle` is ever the
    // bare pool.
    const team = await handle
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .for('update')
      .then((rows) => rows[0])
    if (!team) throw new NotFoundException('Команда не найдена')
    if (team.type !== 'DROP') {
      throw new BadRequestException('Метод доступен только для drop-команд')
    }
    if (team.archivedAt) throw new BadRequestException('Команда уже архивирована')

    const now = new Date()
    // Resolve the drop owner (DROP member of this team).
    const dropMember = await handle
      .select({ userId: teamMembers.userId, role: users.role })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'DROP'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    const dropId = dropMember?.userId ?? null

    // Detach the active SENIOR (if any) — leftAt=now, user row untouched.
    const seniorMember = await handle
      .select({ id: teamMembers.id, userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    const detachedSeniorId = seniorMember?.userId ?? null
    if (seniorMember) {
      await handle
        .update(teamMembers)
        .set({ leftAt: now })
        .where(eq(teamMembers.id, seniorMember.id))
      // MED-1 (security-review round 4, follow-up to #436): record the
      // detach with role='SENIOR' — this is now the POSITIVE evidence
      // `TeamsService.wasFormerMemberOfTeam` requires (see its docblock).
      // `archiveDropTeam` has no caller-supplied SessionUser in scope
      // (called from a transactional cascade in UsersService.archiveDrop /
      // TeamsService.archive as well as this controller path), so
      // `actorId: null` — acceptable per review: this is an audit-trail
      // entry proving WHAT happened (a senior was detached from THIS team),
      // not an accountability record of WHO clicked the button (the parent
      // `team_archived`/`user_archived` audit rows already carry the real
      // actor for that).
      await this.teamAuditLogService.record(
        {
          actorId: null,
          targetId: teamId,
          action: 'team_member_removed',
          changes: {
            userId: { before: seniorMember.userId, after: null },
            role: { before: 'SENIOR', after: null },
          },
        },
        tx,
      )
    }

    // Archive drop-projects (projects.dropId === this team's drop user).
    // AC9: project_members (JUNIOR) are NOT detached — see the docblock above.
    let archivedProjects = 0
    if (dropId) {
      const dropProjects = await handle
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.dropId, dropId), isNull(projects.archivedAt)))
      for (const p of dropProjects) {
        await handle
          .update(projects)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(projects.id, p.id))
        archivedProjects += 1
      }
    }

    // AC9: HR/ACCOUNTANT team_members are NOT detached any more — see the
    // docblock above. (SENIOR was already detached above — pre-existing,
    // unrelated rotation mechanic.)

    // Drop-archive round 2 (B1): archive the DROP user itself — the team
    // and the drop are a paired entity, mirrored from the SENIOR-team pair
    // semantics. Senior is intentionally NOT archived (just detached). The
    // ArchiveConfirmDialog copy in B3 reflects this: "будут архивированы:
    // профиль дропа, команда…, drop-проекты". Without this update the
    // dialog promised something the backend wouldn't deliver.
    if (dropId) {
      await handle
        .update(users)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(users.id, dropId))
    }

    await handle.update(teams).set({ archivedAt: now, updatedAt: now }).where(eq(teams.id, teamId))

    return { archivedProjects, detachedSeniorId }
  }

  /**
   * Rotate the active SENIOR of a drop-team. Caller is ADMIN or an HR of
   * this team (RBAC check below). The new senior cannot already be in
   * another active team — caller must archive/detach first. The current
   * active senior (if any) gets `leftAt=now()`; the new senior is added
   * as a member. DROP stays.
   */
  async rotateSenior(
    teamId: string,
    newSeniorId: string,
    currentUser: SessionUser,
  ): Promise<typeof teams.$inferSelect> {
    return this.db.db.transaction(async (tx) => {
      const team = await tx
        .select()
        .from(teams)
        .where(eq(teams.id, teamId))
        .then((rows) => rows[0])
      if (!team) throw new NotFoundException('Команда не найдена')
      if (team.type !== 'DROP') {
        throw new BadRequestException('Ротация синьора доступна только для drop-команд')
      }
      if (team.archivedAt) throw new BadRequestException('Команда архивирована')

      // RBAC: ADMIN or HR of this team.
      if (currentUser.role !== 'ADMIN') {
        if (currentUser.role !== 'HR') throw new ForbiddenException()
        const isHrHere = await tx
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.userId, currentUser.id),
              isNull(teamMembers.leftAt),
            ),
          )
          .then((rows) => rows[0])
        if (!isHrHere) throw new ForbiddenException()
      }

      await this.assertUserRole(newSeniorId, 'SENIOR', tx, true)

      // Reject if new senior already has an active team membership.
      const otherMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, newSeniorId), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])
      if (otherMembership) {
        throw new BadRequestException('Синьор уже состоит в другой активной команде')
      }

      const now = new Date()
      // Detach current senior if present.
      const currentSenior = await tx
        .select({ id: teamMembers.id, userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
        )
        .then((rows) => rows[0])
      if (currentSenior) {
        await tx
          .update(teamMembers)
          .set({ leftAt: now })
          .where(eq(teamMembers.id, currentSenior.id))
        // MED-1 (security-review round 4, follow-up to #436): record the
        // detach with role='SENIOR' — the POSITIVE evidence
        // `TeamsService.wasFormerMemberOfTeam` now requires (see its
        // docblock). `currentUser` is on hand here (unlike
        // `archiveDropTeam`), so attribute to the real actor.
        await this.teamAuditLogService.record(
          {
            actorId: currentUser.impersonatorId ?? currentUser.id,
            targetId: teamId,
            action: 'team_member_removed',
            changes: {
              userId: { before: currentSenior.userId, after: null },
              role: { before: 'SENIOR', after: null },
            },
          },
          tx,
        )
      }

      await tx.insert(teamMembers).values({ teamId, userId: newSeniorId })
      const updated = await tx
        .update(teams)
        .set({ updatedAt: now })
        .where(eq(teams.id, teamId))
        .returning()
      return updated[0]!
    })
  }

  /**
   * Attach an existing SENIOR (with no active team) to a drop-team that has
   * no active senior. Used by:
   *  - the create-senior flow with `teamMode='JOIN_DROP_TEAM'`
   *  - the rejoin-team endpoint for an orphaned senior
   *  - a future standalone "assign senior" action on the drop-team page
   *
   * Validations:
   *  - team exists, `type='DROP'`, not archived
   *  - team has no active senior
   *  - senior exists, `role='SENIOR'`, has no other active team membership
   *
   * RBAC is delegated to callers (createUser, rejoin-team controller, etc.)
   * because this primitive is reused from several entry points. The `tx`
   * arg is supplied when callers want atomicity with their outer flow.
   */
  async addSeniorToDropTeam(teamId: string, seniorId: string, tx?: DrizzleTx): Promise<void> {
    const handle = tx ?? this.db.db
    const team = await handle
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) throw new NotFoundException('Команда не найдена')
    if (team.type !== 'DROP') {
      throw new BadRequestException('Метод доступен только для drop-команд')
    }
    if (team.archivedAt) throw new BadRequestException('Команда архивирована')

    await this.assertUserRole(seniorId, 'SENIOR', tx, true)

    const existingSenior = await handle
      .select()
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    if (existingSenior) {
      throw new BadRequestException('В команде уже есть активный синьор')
    }

    const otherMembership = await handle
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (otherMembership) {
      throw new BadRequestException('Синьор уже состоит в другой активной команде')
    }

    await handle.insert(teamMembers).values({ teamId, userId: seniorId })
  }
}
