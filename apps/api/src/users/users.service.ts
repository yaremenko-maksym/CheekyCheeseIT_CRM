import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common'
import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import type { ArchiveImpact } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projectMembers, projects, teamMembers, teams, users, type User } from '../database/schema'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { AuditLogService } from './audit-log.service'
import { UsersAccessService } from './users-access.service'

export interface TeamMemberPreview {
  id: string
  displayName: string
  role: User['role']
  avatar: string | null
}

export type UserWithAvailability = User & { hasActiveProject: boolean }

@Injectable()
export class UsersService {
  constructor(
    private db: DatabaseService,
    private accessService: UsersAccessService,
    private auditLogService: AuditLogService,
    @Inject(forwardRef(() => TeamAuditLogService))
    private teamAuditLogService: TeamAuditLogService,
    @Inject(forwardRef(() => ProjectAuditLogService))
    private projectAuditLogService: ProjectAuditLogService,
  ) {}

  findByEmail(email: string): Promise<User | undefined> {
    return this.db.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .then((rows) => rows[0])
  }

  findById(id: string): Promise<User | undefined> {
    return this.db.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0])
  }

  async findAll(filter: { archived?: boolean } = {}): Promise<UserWithAvailability[]> {
    const archivedFilter = filter.archived === true
      ? isNotNull(users.archivedAt)
      : isNull(users.archivedAt)
    const allUsers = await this.db.db
      .select()
      .from(users)
      .where(and(ne(users.role, 'ADMIN'), archivedFilter))
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return allUsers.map((u) => ({
      ...u,
      hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
    }))
  }

  async findAllIncludingAdmin(filter: { archived?: boolean } = {}): Promise<UserWithAvailability[]> {
    const archivedFilter = filter.archived === true
      ? isNotNull(users.archivedAt)
      : isNull(users.archivedAt)
    const allUsers = await this.db.db.select().from(users).where(archivedFilter)
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return allUsers.map((u) => ({
      ...u,
      hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
    }))
  }

  async getProfile(id: string): Promise<User> {
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')
    return user
  }

  async createUser(data: {
    email: string
    displayName: string
    role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
    telegram?: string | null
    phone?: string | null
    avatar?: string | null
    techStack?: string[] | null
    seniorSharePercent?: number
    monthlySalary?: number | null
    hrIds?: string[]
    accountantId?: string | null
    projectId?: string | null
  }): Promise<User> {
    const existing = await this.findByEmail(data.email)
    if (existing) throw new ConflictException('User with this email already exists')

    const rows = await this.db.db
      .insert(users)
      .values({
        email: data.email,
        displayName: data.displayName,
        role: data.role,
        telegram: data.telegram ?? null,
        phone: data.phone ?? null,
        avatar: data.avatar ?? `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(data.displayName)}`,
        techStack: data.techStack ?? null,
        ...(data.seniorSharePercent !== undefined && { seniorSharePercent: data.seniorSharePercent }),
        ...(data.monthlySalary != null && { monthlySalary: String(data.monthlySalary) }),
      })
      .returning()

    const created = rows[0]
    if (!created) throw new Error('Failed to create user')

    // Seed initial audit event — always has changes so record() won't skip it
    await this.auditLogService.record({
      actorId: null,
      targetId: created.id,
      action: 'profile_created',
      changes: {
        displayName: { before: null, after: created.displayName },
        role: { before: null, after: created.role },
      },
    })

    if (data.role === 'SENIOR') {
      const [team] = await this.db.db
        .insert(teams)
        .values({ name: `Команда ${data.displayName}` })
        .returning()
      if (team) {
        const memberIds = [
          created.id,
          ...(data.hrIds ?? []),
          ...(data.accountantId ? [data.accountantId] : []),
        ]
        for (const userId of memberIds) {
          await this.db.db.insert(teamMembers).values({ teamId: team.id, userId })
        }
      }
    }

    if (data.role === 'JUNIOR' && data.projectId) {
      await this.db.db.insert(projectMembers).values({
        projectId: data.projectId,
        userId: created.id,
      })
    }

    return created
  }

  async adminUpdateUser(
    id: string,
    data: {
      displayName?: string
      role?: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
      telegram?: string | null | undefined
      phone?: string | null | undefined
      avatar?: string | null | undefined
      avatarOverride?: string | null | undefined
      techStack?: string[] | null | undefined
      seniorSharePercent?: number | undefined
      monthlySalary?: number | null | undefined
      hrIds?: string[] | undefined
      accountantId?: string | null | undefined
    },
    actorId: string | null = null,
  ): Promise<User> {
    const set: Partial<{
      displayName: string
      role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
      telegram: string | null
      phone: string | null
      avatar: string | null
      avatarOverride: string | null
      techStack: string[] | null
      seniorSharePercent: number
      monthlySalary: string | null
      updatedAt: Date
    }> = { updatedAt: new Date() }

    if (data.displayName !== undefined) set.displayName = data.displayName
    if (data.role !== undefined) set.role = data.role
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('avatar' in data) set.avatar = data.avatar ?? null
    if ('avatarOverride' in data) set.avatarOverride = data.avatarOverride ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null
    if (data.seniorSharePercent !== undefined) set.seniorSharePercent = data.seniorSharePercent
    if ('monthlySalary' in data) set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null

    const rows = await this.db.db
      .update(users)
      .set(set)
      .where(eq(users.id, id))
      .returning()

    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')

    // SENIOR-only: optional team composition reconcile.
    if (updated.role === 'SENIOR' && (data.hrIds !== undefined || data.accountantId !== undefined)) {
      await this.reconcileSeniorTeam(updated.id, {
        hrIds: data.hrIds,
        accountantId: data.accountantId,
      }, actorId)
    }

    return updated
  }

  /**
   * Reconciles HR/Accountant membership in the SENIOR's team.
   * Active members (`leftAt IS NULL`) are diffed against the target sets:
   *  - new HR/Acc -> insert team_member or restore via leftAt=NULL on existing row
   *  - removed HR/Acc -> set leftAt=now()
   * Each delta is logged into `team_audit_log`.
   */
  private async reconcileSeniorTeam(
    seniorId: string,
    data: { hrIds?: string[] | undefined; accountantId?: string | null | undefined },
    actorId: string | null,
  ): Promise<void> {
    // Resolve the senior's team via team_members (teams has no seniorId column —
    // a SENIOR is always team_member of exactly one team by business invariant).
    const seniorMembership = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)),
    })
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const activeMembers = await this.db.db
      .select({
        userId: teamMembers.userId,
        id: teamMembers.id,
        role: users.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))

    const now = new Date()

    if (data.hrIds !== undefined) {
      const desiredHrIds = new Set(data.hrIds)
      const currentHrIds = new Set(activeMembers.filter((m) => m.role === 'HR').map((m) => m.userId))

      // To remove: currently active HR not in desired set.
      const toRemove = [...currentHrIds].filter((id) => !desiredHrIds.has(id))
      // To add: desired but not currently active.
      const toAdd = [...desiredHrIds].filter((id) => !currentHrIds.has(id))

      for (const userId of toRemove) {
        await this.db.db
          .update(teamMembers)
          .set({ leftAt: now })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
        await this.teamAuditLogService.record({
          actorId,
          targetId: teamId,
          action: 'team_member_removed',
          changes: { userId: { before: userId, after: null }, role: { before: 'HR', after: null } },
        })
      }
      for (const userId of toAdd) {
        await this.upsertTeamMember(teamId, userId)
        await this.teamAuditLogService.record({
          actorId,
          targetId: teamId,
          action: 'team_member_added',
          changes: { userId: { before: null, after: userId }, role: { before: null, after: 'HR' } },
        })
      }
    }

    if (data.accountantId !== undefined) {
      const desiredId = data.accountantId ?? null
      const currentAcc = activeMembers.find((m) => m.role === 'ACCOUNTANT')
      const currentId = currentAcc?.userId ?? null

      if (currentId !== desiredId) {
        if (currentId) {
          await this.db.db
            .update(teamMembers)
            .set({ leftAt: now })
            .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, currentId), isNull(teamMembers.leftAt)))
          await this.teamAuditLogService.record({
            actorId,
            targetId: teamId,
            action: 'team_member_removed',
            changes: { userId: { before: currentId, after: null }, role: { before: 'ACCOUNTANT', after: null } },
          })
        }
        if (desiredId) {
          await this.upsertTeamMember(teamId, desiredId)
          await this.teamAuditLogService.record({
            actorId,
            targetId: teamId,
            action: 'team_member_added',
            changes: { userId: { before: null, after: desiredId }, role: { before: null, after: 'ACCOUNTANT' } },
          })
        }
      }
    }
  }

  /**
   * Insert team_member; if row already exists (left previously) — clear leftAt to restore.
   * Necessary because team_members has FK constraints with no unique index across (teamId, userId).
   */
  private async upsertTeamMember(teamId: string, userId: string): Promise<void> {
    const existing = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    })
    if (existing) {
      if (existing.leftAt !== null) {
        await this.db.db
          .update(teamMembers)
          .set({ leftAt: null })
          .where(eq(teamMembers.id, existing.id))
      }
      return
    }
    await this.db.db.insert(teamMembers).values({ teamId, userId })
  }

  async updateProfile(
    id: string,
    data: {
      displayName?: string
      telegram?: string | null
      phone?: string | null
      techStack?: string[] | null
      avatarOverride?: string | null
    },
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) set.displayName = data.displayName
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null
    if ('avatarOverride' in data) set.avatarOverride = data.avatarOverride ?? null

    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async updateRequisites(
    id: string,
    data: {
      paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP'
      walletUsdtErc20?: string
      walletUsdtLabel?: string | null
      bankUahRecipient?: string
      bankUahIban?: string
      bankUahRnokpp?: string
      bankUahBankName?: string | null
    },
  ): Promise<User> {
    const set: Record<string, unknown> = {
      paymentMethod: data.paymentMethod,
      updatedAt: new Date(),
    }
    if (data.paymentMethod === 'USDT_ERC20') {
      set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      set.walletUsdtLabel = data.walletUsdtLabel ?? null
      set.bankUahRecipient = null
      set.bankUahIban = null
      set.bankUahRnokpp = null
      set.bankUahBankName = null
    } else {
      set.bankUahRecipient = data.bankUahRecipient ?? null
      set.bankUahIban = data.bankUahIban ?? null
      set.bankUahRnokpp = data.bankUahRnokpp ?? null
      set.bankUahBankName = data.bankUahBankName ?? null
      set.walletUsdtErc20 = null
      set.walletUsdtLabel = null
    }
    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async changeRole(id: string, role: User['role']): Promise<User> {
    const rows = await this.db.db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async changeSalary(id: string, data: { monthlySalary?: number | null; salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'; seniorSharePercent?: number }): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.monthlySalary !== undefined) set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    if (data.seniorSharePercent !== undefined) set.seniorSharePercent = data.seniorSharePercent
    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  async setAdminNote(id: string, note: string | null): Promise<User> {
    const rows = await this.db.db.update(users).set({ adminNote: note, updatedAt: new Date() }).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  /**
   * Soft-archive a user with role-specific cascade:
   *  - SENIOR: paired with their team — archives team + active projects + sets leftAt
   *    for HR/Acc team_members (but NOT for senior's own team_member row).
   *  - HR/ACCOUNTANT: sets leftAt for their team memberships.
   *  - JUNIOR: sets leftAt for their project memberships (and any team_members).
   *  - ADMIN: just the user row.
   * Audit log entries written to user_audit_log + team_audit_log + project_audit_log.
   * All mutations in one transaction — any throw rolls back the whole cascade.
   *
   * @param id user id
   * @param actorId admin who triggered archive (for audit log)
   */
  async archive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!user) throw new NotFoundException('User not found')
      if (user.archivedAt) throw new BadRequestException('User is already archived')

      const now = new Date()

      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, id))

      if (user.role === 'SENIOR') {
        // Pair-archive: senior's team + projects. SENIOR's own team_member row is NOT touched.
        const seniorMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (seniorMembership) {
          const teamId = seniorMembership.teamId
          await tx
            .update(teams)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(teams.id, teamId))
          await this.teamAuditLogService.record({
            actorId,
            targetId: teamId,
            action: 'team_archived',
            changes: { archivedAt: { before: null, after: now.toISOString() } },
          }, tx)

          // Snapshot HR/Acc that get detached so we can write per-member audit entries
          // BEFORE the bulk UPDATE marks them as left.
          const hrAccToRemove = await tx
            .select({ userId: teamMembers.userId, role: users.role })
            .from(teamMembers)
            .innerJoin(users, eq(users.id, teamMembers.userId))
            .where(and(
              eq(teamMembers.teamId, teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ))

          // Set leftAt for HR/Acc — keep SENIOR's own row untouched (ne userId, id).
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(and(
              eq(teamMembers.teamId, teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ))

          // One team_member_removed audit entry per detached HR/Accountant, so the
          // team's history mirrors a manual removal (matches HR-only branch below).
          for (const m of hrAccToRemove) {
            await this.teamAuditLogService.record({
              actorId,
              targetId: teamId,
              action: 'team_member_removed',
              changes: { userId: { before: m.userId, after: null }, role: { before: m.role, after: null } },
            }, tx)
          }
        }

        // Archive all of senior's active projects + remove active project_members.
        const ownedProjects = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))

        for (const p of ownedProjects) {
          await tx
            .update(projects)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(projects.id, p.id))
          await this.projectAuditLogService.record({
            actorId,
            targetId: p.id,
            action: 'project_archived',
            changes: { archivedAt: { before: null, after: now.toISOString() } },
          }, tx)
          // Cascade-remove active JUNIORs from project_members.
          await tx
            .update(projectMembers)
            .set({ leftAt: now })
            .where(and(eq(projectMembers.projectId, p.id), isNull(projectMembers.leftAt)))
        }
      } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
        // Set leftAt across all team memberships.
        const memberships = await tx
          .select({ id: teamMembers.id, teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        if (memberships.length > 0) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          for (const m of memberships) {
            await this.teamAuditLogService.record({
              actorId,
              targetId: m.teamId,
              action: 'team_member_removed',
              changes: { userId: { before: id, after: null }, role: { before: user.role, after: null } },
            }, tx)
          }
        }
      } else if (user.role === 'JUNIOR') {
        // Detach JUNIOR from all active project memberships.
        // NB: JUNIOR is never persisted in `team_members` — team membership for
        // JUNIORs is derived state (project membership ⇒ implicit team), see
        // CLAUDE.md §Teams. So we deliberately do NOT update team_members here.
        const projectMemberships = await tx
          .select({ id: projectMembers.id, projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
        if (projectMemberships.length > 0) {
          await tx
            .update(projectMembers)
            .set({ leftAt: now })
            .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
          for (const pm of projectMemberships) {
            await this.projectAuditLogService.record({
              actorId,
              targetId: pm.projectId,
              action: 'project_member_removed',
              changes: { userId: { before: id, after: null } },
            }, tx)
          }
        }
      }
      // ADMIN: no dependencies.

      // Final user_audit_log entry.
      await this.auditLogService.record({
        actorId,
        targetId: id,
        action: 'user_archived',
        changes: { archivedAt: { before: null, after: now.toISOString() } },
      }, tx)

      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!updated) throw new NotFoundException('User not found')
      return updated
    })
  }

  /**
   * Restore an archived user. SENIOR restoration is paired with their team —
   * projects remain archived; HR/Acc team_members.leftAt is NOT restored.
   * For HR/Acc/Junior/Admin — only the user row is restored, memberships stay closed.
   */
  async unarchive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      await this.unarchivePairTx(tx, id, actorId)
      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!updated) throw new NotFoundException('User not found')
      return updated
    })
  }

  /**
   * Pair-unarchive primitive that runs ENTIRELY within the caller's transaction.
   * Used by:
   *   - `UsersService.unarchive()` — wraps this in its own tx
   *   - `ProjectsService.unarchive(cascade=true)` — passes its outer tx so the
   *     project unarchive + senior/team unarchive commit atomically (no nested
   *     transactions, no orphaned state if the outer flow throws).
   *
   * IMPORTANT: All mutations and audit log writes use the supplied `tx` — never
   * `this.db.db` — so rollback discards everything together. Caller is
   * responsible for opening the transaction.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async unarchivePairTx(tx: any, id: string, actorId: string | null = null): Promise<void> {
    const user = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows: User[]) => rows[0])
    if (!user) throw new NotFoundException('User not found')
    if (!user.archivedAt) throw new BadRequestException('User is not archived')

    const now = new Date()
    const previousArchivedAt = user.archivedAt

    await tx
      .update(users)
      .set({ archivedAt: null, updatedAt: now })
      .where(eq(users.id, id))

    await this.auditLogService.record({
      actorId,
      targetId: id,
      action: 'user_unarchived',
      changes: { archivedAt: { before: previousArchivedAt?.toISOString() ?? null, after: null } },
    }, tx)

    if (user.role === 'SENIOR') {
      // Pair-unarchive: also unarchive the team via senior's team_member row.
      // We require `leftAt IS NULL` because senior's own membership is the
      // permanent identity link and stays active even while archived. A row
      // with `leftAt != NULL` would be stale data we shouldn't follow.
      const seniorMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        .then((rows: Array<typeof teamMembers.$inferSelect>) => rows[0])
      if (seniorMembership) {
        const team = await tx
          .select()
          .from(teams)
          .where(eq(teams.id, seniorMembership.teamId))
          .then((rows: Array<typeof teams.$inferSelect>) => rows[0])
        if (team?.archivedAt) {
          const teamPreviousArchivedAt = team.archivedAt
          await tx
            .update(teams)
            .set({ archivedAt: null, updatedAt: now })
            .where(eq(teams.id, team.id))
          await this.teamAuditLogService.record({
            actorId,
            targetId: team.id,
            action: 'team_unarchived',
            changes: { archivedAt: { before: teamPreviousArchivedAt.toISOString(), after: null } },
          }, tx)
        }
      }
      // Projects intentionally stay archived; HR/Acc team_members.leftAt stays.
    }
  }

  /**
   * Returns the cascade impact summary the UI shows before the admin confirms archive.
   * Shape varies by role — see ArchiveImpact union in @crm/shared.
   */
  async getArchiveImpact(id: string): Promise<ArchiveImpact> {
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')

    if (user.role === 'SENIOR') {
      // Find senior's team via team_members.
      const seniorMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsToBeRemoved = 0
      if (seniorMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, seniorMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(and(
            eq(teamMembers.teamId, seniorMembership.teamId),
            isNull(teamMembers.leftAt),
            ne(teamMembers.userId, id),
          ))
        hrAccountantsToBeRemoved = others.length
      }
      const seniorProjects = await this.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))
      const projectIds = seniorProjects.map((p) => p.id)
      let juniorsAffected = 0
      if (projectIds.length > 0) {
        const activeJuniors = await this.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
        juniorsAffected = activeJuniors.length
      }
      return {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        teamName,
        projectsCount: seniorProjects.length,
        juniorsAffected,
        hrAccountantsToBeRemoved,
      }
    }

    if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
      return { type: 'user', role: user.role, teamsCount: memberships.length }
    }

    if (user.role === 'JUNIOR') {
      const memberships = await this.db.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
      return { type: 'user', role: 'JUNIOR', projectsCount: memberships.length }
    }

    // ADMIN
    return { type: 'user', role: 'ADMIN', noDependencies: true }
  }

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
  async getTeamMembersForUser(userId: string): Promise<TeamMemberPreview[]> {
    const user = await this.findById(userId)
    if (!user) throw new NotFoundException('User not found')
    if (user.role === 'ADMIN') return []

    // Step 1: Resolve set of seniorIds whose teams this user belongs to
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
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId))
      if (memberships.length === 0) return []
      const teamIds = memberships.map((m) => m.teamId)
      const seniorsInTeams = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
      seniorIds = Array.from(new Set(seniorsInTeams.map((s) => s.userId)))
    }

    if (seniorIds.length === 0) return []

    // Step 2: Collect team_members (SENIOR + HR + ACCOUNTANT) across those seniors' teams.
    // Teams are linked to senior via team_members (the SENIOR is itself a member).
    const seniorMemberships = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(and(inArray(teamMembers.userId, seniorIds), eq(users.role, 'SENIOR')))
    const teamIds = Array.from(new Set(seniorMemberships.map((m) => m.teamId)))

    const memberIds = new Set<string>()
    if (teamIds.length > 0) {
      const tmRows = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, teamIds))
      tmRows.forEach((r) => memberIds.add(r.userId))
    }

    // Step 3: Add active JUNIORs from projects of those seniors
    const seniorProjects = await this.db.db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.seniorId, seniorIds))
    const projectIds = seniorProjects.map((p) => p.id)
    if (projectIds.length > 0) {
      const juniorRows = await this.db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
      juniorRows.forEach((r) => memberIds.add(r.userId))
    }

    memberIds.delete(userId)
    if (memberIds.size === 0) return []

    const rows = await this.db.db
      .select({
        id: users.id,
        displayName: users.displayName,
        role: users.role,
        avatar: users.avatar,
      })
      .from(users)
      .where(inArray(users.id, Array.from(memberIds)))
    return rows
  }

  async buildProfileView(viewer: User, targetId: string) {
    const target = await this.findById(targetId)
    if (!target) throw new NotFoundException('User not found')
    const permissions = await this.accessService.getViewPermissions(viewer, target)

    // Filter user fields based on permissions
    const filteredUser: User = { ...target }
    if (!permissions.fields.salary) {
      filteredUser.monthlySalary = null
    }
    if (!permissions.fields.share) {
      filteredUser.seniorSharePercent = 0
    }
    if (!permissions.fields.techStack) {
      filteredUser.techStack = null
    }
    if (!permissions.fields.requisites) {
      filteredUser.paymentMethod = null
      filteredUser.walletUsdtErc20 = null
      filteredUser.walletUsdtLabel = null
      filteredUser.bankUahRecipient = null
      filteredUser.bankUahIban = null
      filteredUser.bankUahRnokpp = null
      filteredUser.bankUahBankName = null
    }

    const data: Record<string, unknown> = {}
    if (permissions.tabs.includes('overview')) {
      data.overview = {
        techStack: permissions.fields.techStack ? (target.techStack ?? []) : null,
        adminNote: viewer.role === 'ADMIN' ? target.adminNote : null,
      }
    }
    // Other tabs (finance, projects, team, interviews, requisites, audit) — wired in later tasks

    return { user: filteredUser, permissions, data }
  }

  updateGoogleId(id: string, googleId: string): Promise<void> {
    return this.db.db
      .update(users)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(users.id, id))
      .then(() => undefined)
  }
}
