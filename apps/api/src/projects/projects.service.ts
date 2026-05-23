import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { ArchiveImpact, CreateProjectDto, EffectiveTeam, SessionUser, UpdateProjectDto } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  projectFinanceSettings,
  projectMembers,
  projects,
  teamMembers,
  teams,
  users,
  type Interview,
  type Project,
  type ProjectMember,
  type User,
} from '../database/schema'
import { ProjectAuditLogService } from './project-audit-log.service'
import { UsersService } from '../users/users.service'

type ProjectWithRelations = Project & {
  senior: User | null
  members: Array<ProjectMember & { user: User | null }>
}

@Injectable()
export class ProjectsService {
  constructor(
    private db: DatabaseService,
    private projectAuditLogService: ProjectAuditLogService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
  ) {}

  private mapProject(project: ProjectWithRelations) {
    return {
      id: project.id,
      name: project.name,
      companyName: project.companyName,
      domain: project.domain,
      logoUrl: project.logoUrl ?? null,
      startDate: project.startDate.toISOString(),
      seniorId: project.seniorId,
      seniorName: project.senior?.displayName ?? '',
      rate: project.rate,
      currency: project.currency,
      // Per-project SENIOR share override. NULL = senior's global default.
      seniorSharePercentOverride: project.seniorSharePercentOverride ?? null,
      // Computed default for UI hints — falls back to 26 when senior is
      // unreachable (e.g. soft-deleted) so the front-end never sees `null`.
      seniorSharePercentDefault: project.senior?.seniorSharePercent ?? 26,
      techStack: project.techStack ?? null,
      teamSize: project.teamSize ?? null,
      benefits: project.benefits ?? null,
      paymentType: project.paymentType ?? null,
      salaryReview: project.salaryReview ?? null,
      corpTech: project.corpTech ?? null,
      notesGeneral: project.notesGeneral ?? null,
      archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      members: project.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        displayName: m.user?.displayName ?? '',
        email: m.user?.email ?? '',
        avatar: m.user?.avatar ?? null,
        role: m.user?.role ?? 'JUNIOR',
        joinedAt: m.joinedAt.toISOString(),
        leftAt: m.leftAt ? m.leftAt.toISOString() : null,
      })),
    }
  }

  private async getHrSeniorIds(hrId: string): Promise<string[]> {
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, hrId))
    if (!hrTeams.length) return []
    const teamIds = hrTeams.map((r) => r.teamId)
    const seniors = await this.db.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
    return seniors.map((r) => r.userId)
  }

  async findAll(currentUser: SessionUser, filter: { archived?: boolean | 'all' } = {}) {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived projects (used by the «Все» tab); boolean keeps legacy behavior.
    const archivedWhere =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(projects.archivedAt)
          : isNull(projects.archivedAt)
    const allProjects = await this.db.db.query.projects.findMany({
      ...(archivedWhere ? { where: archivedWhere } : {}),
      with: { senior: true, members: { with: { user: true } } },
    })

    let filtered = allProjects as ProjectWithRelations[]

    if (currentUser.role === 'SENIOR') {
      filtered = filtered.filter((p) => p.seniorId === currentUser.id)
    } else if (currentUser.role === 'HR') {
      const seniorIds = await this.getHrSeniorIds(currentUser.id)
      filtered = filtered.filter((p) => p.seniorId !== null && seniorIds.includes(p.seniorId))
    } else if (currentUser.role === 'JUNIOR') {
      filtered = filtered.filter((p) =>
        p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
      )
    }
    // ADMIN, ACCOUNTANT see all

    return filtered.map((p) => this.mapProject(p))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')
    await this.assertAccess(project, currentUser)

    const effectiveTeam = await this.computeEffectiveTeam(project)
    return { ...this.mapProject(project), effectiveTeam }
  }

  /**
   * Effective team is a computed view (NOT a snapshot at archive time).
   * - senior: project.seniorId resolved to a user row (typed for SENIOR — but we widen to allow ADMIN-owned projects).
   * - hrs / accountants: active team_members (leftAt IS NULL) of senior's team.
   * - juniors: active project_members of THIS project (leftAt IS NULL).
   *
   * After unarchive, this naturally reflects the current senior's team — if HR changed
   * while archived, the new HR appears here without restoring leftAt rows.
   */
  private async computeEffectiveTeam(project: ProjectWithRelations): Promise<EffectiveTeam> {
    const senior = project.senior
      ? {
          id: project.senior.id,
          displayName: project.senior.displayName,
          email: project.senior.email,
          avatar: project.senior.avatar ?? null,
          role: 'SENIOR' as const,
        }
      : null

    // Resolve senior's team via team_members where userId = senior.id.
    let hrs: EffectiveTeam['hrs'] = []
    let accountants: EffectiveTeam['accountants'] = []
    if (project.senior) {
      const seniorMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, project.senior.id), isNull(teamMembers.leftAt)),
      })
      if (seniorMembership) {
        const teamId = seniorMembership.teamId
        const teamRows = await this.db.db
          .select({
            id: teamMembers.id,
            userId: teamMembers.userId,
            displayName: users.displayName,
            email: users.email,
            avatar: users.avatar,
            role: users.role,
          })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(and(
            eq(teamMembers.teamId, teamId),
            isNull(teamMembers.leftAt),
          ))
        hrs = teamRows
          .filter((r) => r.role === 'HR')
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            displayName: r.displayName,
            email: r.email,
            avatar: r.avatar ?? null,
            role: 'HR' as const,
          }))
        accountants = teamRows
          .filter((r) => r.role === 'ACCOUNTANT')
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            displayName: r.displayName,
            email: r.email,
            avatar: r.avatar ?? null,
            role: 'ACCOUNTANT' as const,
          }))
      }
    }

    const juniors = project.members
      .filter((m) => m.leftAt === null && m.user?.role === 'JUNIOR')
      .map((m) => ({
        id: m.id,
        userId: m.userId,
        displayName: m.user?.displayName ?? '',
        email: m.user?.email ?? '',
        avatar: m.user?.avatar ?? null,
        role: m.user?.role ?? 'JUNIOR',
        joinedAt: m.joinedAt.toISOString(),
        leftAt: null,
      }))

    return { senior, hrs, accountants, juniors }
  }

  async create(data: CreateProjectDto, currentUser: SessionUser) {
    // seniorSharePercentOverride is field-scoped RBAC: only ADMIN and
    // ACCOUNTANT may set it. We check this BEFORE the create-role check so
    // an HR caller sending the field still gets the more-specific 403
    // (and so TS doesn't narrow `currentUser.role` away from ACCOUNTANT).
    const role = currentUser.role
    if (
      data.seniorSharePercentOverride !== undefined &&
      role !== 'ADMIN' &&
      role !== 'ACCOUNTANT'
    ) {
      throw new ForbiddenException(
        'Only ADMIN or ACCOUNTANT can change senior share percent override',
      )
    }

    if (role !== 'ADMIN' && role !== 'HR') {
      throw new ForbiddenException()
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.seniorId),
    })
    if (!senior) throw new NotFoundException('Senior not found')
    if (senior.role !== 'SENIOR' && senior.role !== 'ADMIN') throw new BadRequestException('User is not a SENIOR or ADMIN')

    const override =
      data.seniorSharePercentOverride === undefined
        ? null
        : data.seniorSharePercentOverride

    const [project] = await this.db.db
      .insert(projects)
      .values({
        name: data.name,
        companyName: data.companyName,
        domain: data.domain,
        logoUrl: data.logoUrl ?? null,
        startDate: new Date(data.startDate),
        seniorId: data.seniorId,
        rate: data.rate,
        currency: data.currency,
        seniorSharePercentOverride: override,
        techStack: data.techStack ?? null,
        teamSize: data.teamSize ?? null,
        benefits: data.benefits ?? null,
        paymentType: data.paymentType ?? null,
        salaryReview: data.salaryReview ?? null,
        corpTech: data.corpTech ?? null,
        notesGeneral: data.notesGeneral ?? null,
      })
      .returning()

    // Mirror to project_finance_settings so the existing
    // transactions.service.ts SENIOR_INCOME calc keeps reading the same
    // effective value via `project.financeSettings.seniorSharePercentOverride`.
    if (project && data.seniorSharePercentOverride !== undefined) {
      await this.syncFinanceSettingsOverride(project.id, override, currentUser.id)
    }

    const created = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, project!.id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations

    return this.mapProject(created)
  }

  /**
   * Upsert the projects.senior_share_percent_override mirror into
   * project_finance_settings. Keeps the existing finance path (which reads
   * from financeSettings only) in sync with the new direct column.
   */
  private async syncFinanceSettingsOverride(
    projectId: string,
    override: number | null,
    actorId: string,
  ) {
    const existing = await this.db.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })
    if (existing) {
      await this.db.db
        .update(projectFinanceSettings)
        .set({
          seniorSharePercentOverride: override,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(projectFinanceSettings.projectId, projectId))
    } else {
      await this.db.db.insert(projectFinanceSettings).values({
        projectId,
        seniorSharePercentOverride: override,
        juniorSalaryOverride: null,
        updatedBy: actorId,
      })
    }
  }

  async update(
    id: string,
    data: UpdateProjectDto,
    currentUser: SessionUser,
  ) {
    // Field-scoped RBAC: `seniorSharePercentOverride` (including explicit
    // null to clear) is restricted to ADMIN and ACCOUNTANT. HR keeps full
    // edit access to every other field — we only deny when this specific
    // field is in the payload. Check BEFORE the create/update role narrow
    // so ACCOUNTANT-only updates (just the override) are accepted.
    const role = currentUser.role
    if (
      data.seniorSharePercentOverride !== undefined &&
      role !== 'ADMIN' &&
      role !== 'ACCOUNTANT'
    ) {
      throw new ForbiddenException(
        'Only ADMIN or ACCOUNTANT can change senior share percent override',
      )
    }

    // ACCOUNTANT may patch only when the only field touched is the override.
    const hasOnlyOverride =
      data.seniorSharePercentOverride !== undefined &&
      Object.keys(data).every((k) => k === 'seniorSharePercentOverride')

    if (role !== 'ADMIN' && role !== 'HR' && !(role === 'ACCOUNTANT' && hasOnlyOverride)) {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')

    // Round-3 implicit-null detection (PR #39 round 2): UI больше не имеет
    // toggle/«Сбросить» — слайдер всегда виден. Когда ADMIN/ACCOUNTANT
    // ставит значение === эффективному дефолту синьера, мы интерпретируем
    // это как сброс переопределения (пишем `null`). Иначе — пишем число.
    // Это касается и `projects.seniorSharePercentOverride`, и mirror в
    // `project_finance_settings.seniorSharePercentOverride`.
    const seniorDefault = project.senior?.seniorSharePercent ?? 26
    const overrideEffective: number | null | undefined =
      data.seniorSharePercentOverride === undefined
        ? undefined
        : data.seniorSharePercentOverride === null
          ? null
          : data.seniorSharePercentOverride === seniorDefault
            ? null
            : data.seniorSharePercentOverride

    const updateData: Partial<typeof projects.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (data.name !== undefined) updateData.name = data.name
    if (data.companyName !== undefined) updateData.companyName = data.companyName
    if (data.domain !== undefined) updateData.domain = data.domain
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl ?? null
    if (data.rate !== undefined) updateData.rate = data.rate
    if (data.currency !== undefined) updateData.currency = data.currency
    if (overrideEffective !== undefined) {
      updateData.seniorSharePercentOverride = overrideEffective
    }
    if (data.techStack !== undefined) updateData.techStack = data.techStack ?? null
    if (data.teamSize !== undefined) updateData.teamSize = data.teamSize ?? null
    if (data.benefits !== undefined) updateData.benefits = data.benefits ?? null
    if (data.paymentType !== undefined) updateData.paymentType = data.paymentType ?? null
    if (data.salaryReview !== undefined) updateData.salaryReview = data.salaryReview ?? null
    if (data.corpTech !== undefined) updateData.corpTech = data.corpTech ?? null
    if (data.notesGeneral !== undefined) updateData.notesGeneral = data.notesGeneral ?? null

    await this.db.db.update(projects).set(updateData).where(eq(projects.id, id))

    // Mirror override into project_finance_settings so existing finance
    // snapshot logic continues to pick up the new value for SENIOR_INCOME.
    // Audit log пишет diff с уже-resolved значением (implicit null применился).
    if (overrideEffective !== undefined) {
      await this.syncFinanceSettingsOverride(
        id,
        overrideEffective,
        currentUser.id,
      )

      // Record the change in audit log so admin diffs include the override.
      if (
        project.seniorSharePercentOverride !==
        overrideEffective
      ) {
        await this.projectAuditLogService.record({
          actorId: currentUser.id,
          targetId: id,
          action: 'project_edited',
          changes: {
            seniorSharePercentOverride: {
              before: project.seniorSharePercentOverride ?? null,
              after: overrideEffective,
            },
          },
        })
      }
    }

    const updated = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations

    return this.mapProject(updated)
  }

  /**
   * Soft-archive a project. Independent — does NOT touch senior or team.
   * Sets project_members.leftAt for active JUNIORs.
   */
  async archive(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    return this.db.db.transaction(async (tx) => {
      const project = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0])
      if (!project) throw new NotFoundException('Project not found')
      if (project.archivedAt) throw new BadRequestException('Project is already archived')

      const now = new Date()
      await tx
        .update(projects)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(projects.id, id))

      // Remove active juniors via leftAt.
      const activeJuniors = await tx
        .select({ id: projectMembers.id, userId: projectMembers.userId, role: users.role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(
          eq(projectMembers.projectId, id),
          isNull(projectMembers.leftAt),
          eq(users.role, 'JUNIOR'),
        ))
      if (activeJuniors.length > 0) {
        const ids = activeJuniors.map((j) => j.id)
        await tx
          .update(projectMembers)
          .set({ leftAt: now })
          .where(inArray(projectMembers.id, ids))
        for (const j of activeJuniors) {
          await this.projectAuditLogService.record({
            actorId: currentUser.id,
            targetId: id,
            action: 'project_member_removed',
            changes: { userId: { before: j.userId, after: null } },
          }, tx)
        }
      }

      await this.projectAuditLogService.record({
        actorId: currentUser.id,
        targetId: id,
        action: 'project_archived',
        changes: { archivedAt: { before: null, after: now.toISOString() } },
      }, tx)

      return this.findOne(id, currentUser)
    })
  }

  /**
   * Unarchive a project.
   *  - If senior or team is also archived → 409 with { requiresCascade: true, entities }.
   *    Client retries with `cascade=true` to pair-unarchive.
   *  - On success: projects.archivedAt = NULL; project_members.leftAt NOT restored
   *    (admin re-adds juniors via Projects page).
   */
  async unarchive(id: string, currentUser: SessionUser, cascade = false) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    return this.db.db.transaction(async (tx) => {
      const project = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0])
      if (!project) throw new NotFoundException('Project not found')
      if (!project.archivedAt) throw new BadRequestException('Project is not archived')

      const senior = await tx
        .select()
        .from(users)
        .where(eq(users.id, project.seniorId))
        .then((rows) => rows[0])
      // Senior's team via team_members lookup.
      let team: typeof teams.$inferSelect | undefined
      if (senior) {
        const seniorMembership = await tx
          .select()
          .from(teamMembers)
          .where(eq(teamMembers.userId, senior.id))
          .then((rows) => rows[0])
        if (seniorMembership) {
          team = await tx
            .select()
            .from(teams)
            .where(eq(teams.id, seniorMembership.teamId))
            .then((rows) => rows[0])
        }
      }

      const entitiesToCascade: { type: 'user' | 'team'; id: string; name: string }[] = []
      if (senior?.archivedAt) entitiesToCascade.push({ type: 'user', id: senior.id, name: senior.displayName })
      if (team?.archivedAt) entitiesToCascade.push({ type: 'team', id: team.id, name: team.name })

      if (entitiesToCascade.length > 0 && !cascade) {
        throw new ConflictException({
          requiresCascade: true,
          entities: entitiesToCascade,
        })
      }

      const now = new Date()
      const previousArchivedAt = project.archivedAt

      if (cascade && senior?.archivedAt) {
        // Pair-unarchive senior + team via the SAME outer transaction (`tx`).
        // We deliberately DO NOT call `this.usersService.unarchive(...)` because
        // that opens its own `db.transaction()` — making it impossible to roll
        // back together with the project mutations below if anything throws.
        await this.usersService.unarchivePairTx(tx, senior.id, currentUser.id)
      }

      await tx
        .update(projects)
        .set({ archivedAt: null, updatedAt: now })
        .where(eq(projects.id, id))

      await this.projectAuditLogService.record({
        actorId: currentUser.id,
        targetId: id,
        action: 'project_unarchived',
        changes: { archivedAt: { before: previousArchivedAt.toISOString(), after: null } },
      }, tx)

      // project_members.leftAt intentionally NOT restored.
      return this.findOne(id, currentUser)
    })
  }

  async getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
    })
    if (!project) throw new NotFoundException('Project not found')

    const activeJuniors = await this.db.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(
        eq(projectMembers.projectId, id),
        isNull(projectMembers.leftAt),
        eq(users.role, 'JUNIOR'),
      ))

    return { type: 'project', activeMembersCount: activeJuniors.length }
  }

  async addMember(projectId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, members: { with: { user: true } } },
    }) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')

    const user = await this.db.db.query.users.findFirst({
      where: eq(users.id, userId),
    })
    if (!user) throw new NotFoundException('User not found')
    if (user.role !== 'JUNIOR' && user.role !== 'HR' && user.role !== 'ACCOUNTANT') {
      throw new BadRequestException('Only JUNIORs, HRs, and ACCOUNTANTs can be added as project members')
    }

    // Prevent duplicate active membership on same project
    const existingActive = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (existingActive) throw new BadRequestException('User is already an active member of this project')

    // JUNIOR: max 1 per project
    if (user.role === 'JUNIOR') {
      const existingJunior = project.members.find(
        (m) => m.leftAt === null && m.user?.role === 'JUNIOR',
      )
      if (existingJunior) {
        throw new BadRequestException('Project already has an active junior member')
      }

      // JUNIOR: cannot be active on another project simultaneously
      const otherProjectMembership = await this.db.db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.userId, userId),
          isNull(projectMembers.leftAt),
        ),
      })
      if (otherProjectMembership) {
        throw new BadRequestException('Junior is already an active member of another project')
      }
    }

    await this.db.db.insert(projectMembers).values({ projectId, userId })
  }

  async removeMember(projectId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const activeMember = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (!activeMember) throw new NotFoundException('Active member not found in project')

    // Prevent removing last HR or last ACCOUNTANT from project
    const userToRemove = await this.db.db.query.users.findFirst({ where: eq(users.id, userId) })
    if (userToRemove?.role === 'HR' || userToRemove?.role === 'ACCOUNTANT') {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: { members: { with: { user: true } } },
      }) as ProjectWithRelations | undefined

      if (project) {
        const activeOfRole = project.members.filter(
          (m) => m.leftAt === null && m.user?.role === userToRemove.role,
        )
        if (activeOfRole.length <= 1) {
          throw new BadRequestException(`Cannot remove the last ${userToRemove.role} from a project`)
        }
      }
    }

    await this.db.db
      .update(projectMembers)
      .set({ leftAt: new Date() })
      .where(eq(projectMembers.id, activeMember.id))
  }

  async createFromInterview(interview: Interview & { senior: User | null }, _currentUser: SessionUser) {
    const domain = interview.notesDomain ?? 'Other'

    const [project] = await this.db.db
      .insert(projects)
      .values({
        name: interview.companyName,
        companyName: interview.companyName,
        domain,
        logoUrl: null,
        startDate: new Date(),
        seniorId: interview.seniorId,
        rate: 0,
        currency: 'USDT',
        techStack: interview.notesTechStack ?? null,
        teamSize: interview.notesTeamSize ?? null,
        benefits: interview.notesBenefits ?? null,
        paymentType: interview.notesPaymentType ?? null,
        salaryReview: interview.notesSalaryReview ?? null,
        corpTech: interview.notesCorpTech ?? null,
        notesGeneral: interview.notesGeneral ?? null,
      })
      .returning()

    if (!project) return project

    // Find all teams where this senior is a member
    const seniorTeamMemberships = await this.db.db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, interview.seniorId),
    })
    const teamIds = seniorTeamMemberships.map((m) => m.teamId)

    if (teamIds.length > 0) {
      // Find all members of those teams with their user roles
      const teammates = await this.db.db.query.teamMembers.findMany({
        where: inArray(teamMembers.teamId, teamIds),
        with: { user: { columns: { id: true, role: true } } },
      })

      const addedUserIds = new Set<string>()
      for (const m of teammates) {
        const u = (m as typeof m & { user: { id: string; role: string } | null }).user
        if (!u) continue
        if (u.role !== 'HR' && u.role !== 'ACCOUNTANT') continue
        if (addedUserIds.has(u.id)) continue
        addedUserIds.add(u.id)
        await this.db.db.insert(projectMembers).values({
          projectId: project.id,
          userId: u.id,
        })
      }
    }

    return project
  }

  private async assertAccess(project: ProjectWithRelations, currentUser: SessionUser) {
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return
    if (currentUser.role === 'SENIOR' && project.seniorId === currentUser.id) return
    if (currentUser.role === 'HR') {
      const seniorIds = await this.getHrSeniorIds(currentUser.id)
      if (project.seniorId !== null && seniorIds.includes(project.seniorId)) return
    }
    if (
      currentUser.role === 'JUNIOR' &&
      project.members.some((m) => m.userId === currentUser.id && m.leftAt === null)
    ) {
      return
    }
    throw new ForbiddenException()
  }
}
