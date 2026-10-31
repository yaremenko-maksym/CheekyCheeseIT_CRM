import { ForbiddenException, HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { NotificationsService } from '../notifications/notifications.service'
import { projects, teamMembers, teams, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { UsersService } from '../users/users.service'
import { TeamAuditLogService } from './team-audit-log.service'
import { assertAccess, isHrOfTeam } from './team-access.util'
import { archiveTeam, getTeamArchiveImpact, unarchiveTeam } from './team-archive.util'
import type { TeamArchiveDeps } from './team-archive.util'
import { mapTeam } from './team-mapping.util'
import {
  assertUserRole as assertUserRoleRead,
  fetchAllProjects as fetchAllProjectsRead,
  isActiveMemberOfTeam as isActiveMemberOfTeamRead,
  wasFormerMemberOfTeam as wasFormerMemberOfTeamRead,
} from './team-membership-read.util'
import { markSeniorDirty } from '../job-sourcing/dirty-producers'
import { addTeamMember, removeTeamMember } from './team-membership.util'
import type { TeamMembershipDeps } from './team-membership.util'
import type { ProjectWithMembers } from './team-mapping.util'

@Injectable()
export class TeamsService {
  constructor(
    private db: DatabaseService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private teamAuditLogService: TeamAuditLogService,
    // task-notification-types-producers (позиция 6). Производитель двух типов:
    // «вас добавили в команду» и «в команде новый участник».
    private readonly notifications: NotificationsService,
  ) {}

  /** Delegate: see `team-membership-read.util` (kept on the facade for UsersService). */
  async isActiveMemberOfTeam(teamId: string, userId: string): Promise<boolean> {
    return isActiveMemberOfTeamRead(this.db.db, teamId, userId)
  }

  /** Delegate: see `team-membership-read.util` (docblock carries the MED-1 rejoin-scope rationale). */
  async wasFormerMemberOfTeam(teamId: string, userId: string): Promise<boolean> {
    return wasFormerMemberOfTeamRead(this.db.db, teamId, userId)
  }

  private async fetchAllProjects(): Promise<ProjectWithMembers[]> {
    return fetchAllProjectsRead(this.db.db)
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
      throw apiError('TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM', HttpStatus.BAD_REQUEST)
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
      // Stryker disable next-line StringLiteral: the reason is a typed union (a blank one does not compile) and only labels the dirty row; the enqueue itself is proven on a real database by roster-fanout.integration.spec.ts
      await markSeniorDirty(tx, seniorId, 'senior.team')

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
      filtered = allTeams.filter((t) => t.type !== 'DROP' && isHrOfTeam(t, currentUser.id))
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

    return filtered.map((t) => mapTeam(t, allProjects, currentUser))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const [team, allProjects] = await Promise.all([
      this.db.db.query.teams.findFirst({
        where: eq(teams.id, id),
        with: { members: { with: { user: true } } },
      }),
      this.fetchAllProjects(),
    ])
    if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertAccess(team, currentUser, allProjects)
    return mapTeam(team, allProjects, currentUser)
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
    if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)

    // HR scope check: HR may only update teams they are a member of.
    // ACCOUNTANT is exempt from this check — their authority is cross-team.
    if (currentUser.role === 'HR' && !isHrOfTeam(team, currentUser.id)) {
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
      throw apiError('TEAM_SENIOR_SHARE_OVERRIDE_TEAM_LEVEL_FORBIDDEN', HttpStatus.FORBIDDEN)
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

  /** Delegate: see `team-archive.util` (pair-cascade via UsersService.archive). */
  async archive(teamId: string, currentUser: SessionUser) {
    return archiveTeam(this.archiveDeps(), teamId, currentUser)
  }

  /** Delegate: see `team-archive.util`. */
  async unarchive(teamId: string, currentUser: SessionUser) {
    return unarchiveTeam(this.archiveDeps(), teamId, currentUser)
  }

  /** Delegate: see `team-archive.util`. */
  async getArchiveImpact(teamId: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    return getTeamArchiveImpact(this.archiveDeps(), teamId, currentUser)
  }

  /** Late-bound closures: `archiveDropTeam`/`findOne` resolve on `this` at call time. */
  private archiveDeps(): TeamArchiveDeps {
    return {
      db: this.db.db,
      usersService: this.usersService,
      archiveDropTeam: (teamId, tx) => this.archiveDropTeam(teamId, tx),
      findOne: (teamId, currentUser) => this.findOne(teamId, currentUser),
    }
  }

  /** Delegate: see `team-membership.util` (RBAC + soft-delete/re-add + member-added notifications). */
  async addMember(teamId: string, userId: string, currentUser: SessionUser) {
    return addTeamMember(this.membershipDeps(), teamId, userId, currentUser)
  }

  /** Delegate: see `team-membership.util`. */
  async removeMember(teamId: string, userId: string, currentUser: SessionUser) {
    return removeTeamMember(this.membershipDeps(), teamId, userId, currentUser)
  }

  private membershipDeps(): TeamMembershipDeps {
    return {
      db: this.db.db,
      teamAuditLogService: this.teamAuditLogService,
      notifications: this.notifications,
      fetchAllProjects: () => this.fetchAllProjects(),
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Drop role - phase 1: drop-team primitives
  //
  // Strictly additive. The legacy senior-team methods above (`create`,
  // `archive`, `addMember`, `removeMember`, `mapTeam` SENIOR branch) are
  // UNCHANGED. All drop-team behavior lives in the methods below.
  // ──────────────────────────────────────────────────────────────────────────

  private async assertUserRole(
    userId: string,
    expectedRole: 'DROP' | 'SENIOR' | 'HR' | 'ACCOUNTANT',
    tx?: DrizzleTx,
    genericMessage = false,
  ): Promise<void> {
    return assertUserRoleRead(this.db.db, userId, expectedRole, tx, genericMessage)
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
      throw apiError('HR_REQUIRED_MINIMUM_ONE', HttpStatus.BAD_REQUEST)
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
    if (!dropUser) throw apiError('DROP_NOT_FOUND', HttpStatus.BAD_REQUEST)

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
    if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (team.type !== 'DROP') {
      throw apiError('TEAM_DROP_TEAMS_ONLY', HttpStatus.BAD_REQUEST)
    }
    if (team.archivedAt) throw apiError('TEAM_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)

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
      await markSeniorDirty(handle, seniorMember.userId, 'senior.team')
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
      if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (team.type !== 'DROP') {
        throw apiError('TEAM_DROP_TEAMS_ONLY', HttpStatus.BAD_REQUEST)
      }
      if (team.archivedAt) throw apiError('TEAM_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)

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
        throw apiError('TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM', HttpStatus.BAD_REQUEST)
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
        await markSeniorDirty(tx, currentSenior.userId, 'senior.team')
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
      await markSeniorDirty(tx, newSeniorId, 'senior.team')
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
    // The membership and its dirty row (r5 4.6 S5) commit together even for a tx-less caller.
    if (!tx) return this.db.db.transaction((t) => this.addSeniorToDropTeam(teamId, seniorId, t))
    const handle = tx
    const team = await handle
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (team.type !== 'DROP') {
      throw apiError('TEAM_DROP_TEAMS_ONLY', HttpStatus.BAD_REQUEST)
    }
    if (team.archivedAt) throw apiError('TEAM_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)

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
      throw apiError('TEAM_ALREADY_HAS_SENIOR', HttpStatus.BAD_REQUEST)
    }

    const otherMembership = await handle
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (otherMembership) {
      throw apiError('TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM', HttpStatus.BAD_REQUEST)
    }

    await handle.insert(teamMembers).values({ teamId, userId: seniorId })
    // Stryker disable next-line StringLiteral: the reason is a typed union (a blank one does not compile) and only labels the dirty row; the enqueue itself is proven on a real database by roster-fanout.integration.spec.ts
    await markSeniorDirty(handle, seniorId, 'senior.team')
  }
}
