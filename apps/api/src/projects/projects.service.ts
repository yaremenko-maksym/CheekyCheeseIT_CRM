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
import type {
  ArchiveImpact,
  CreateProjectDto,
  DropProjectDto,
  EffectiveTeam,
  SessionUser,
  UpdateProjectDto,
} from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  projectFinanceSettings,
  projectMembers,
  projects,
  teamMembers,
  teams,
  transactions,
  users,
  type Interview,
  type Legend,
  type Project,
  type ProjectMember,
  type User,
} from '../database/schema'
import { ProjectAuditLogService } from './project-audit-log.service'
import { UsersService } from '../users/users.service'
import { resolveSeniorShare } from '../finance/senior-share-resolver'

type ProjectWithRelations = Project & {
  senior: User | null
  // Drop role - phase 2: relation joined by `with: { drop: true }` when
  // mapping a project. Null for regular senior-projects (no dropId).
  drop?: User | null
  members: Array<ProjectMember & { user: User | null }>
  // task-junior-ux-1-backend: legend persona for this project.
  // Loaded via `with: { legend: true }` in all findMany/findFirst queries.
  // `null` when no legend has been created for this project yet.
  legend?: Legend | null
}

@Injectable()
export class ProjectsService {
  constructor(
    private db: DatabaseService,
    private projectAuditLogService: ProjectAuditLogService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private readonly hrAccess: HrAccessService,
  ) {}

  /**
   * task-team-senior-share-override. Pre-computes the active senior-team
   * overrides for every senior referenced by the supplied projects, in one
   * DB hit. The result feeds `mapProject` so each row carries
   * `effectiveSeniorSharePercent` + `effectiveSeniorShareSource` without
   * an N+1 round-trip per project. Keyed by `senior.id`.
   */
  private async loadTeamOverridesBySenior(
    projects: ProjectWithRelations[],
  ): Promise<Map<string, { id: string; seniorSharePercentOverride: number | null }[]>> {
    const seniorIds = Array.from(
      new Set(
        projects
          .map((p) => p.seniorId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    )
    const map = new Map<string, { id: string; seniorSharePercentOverride: number | null }[]>()
    if (seniorIds.length === 0) return map

    // Use the relational query API instead of a raw `db.select(...).from(...)`
    // join chain so existing service-spec mocks (which only stub the
    // `db.query.<entity>.find*` surface) keep working without a wholesale
    // mock rewrite. Try/catch protects against test doubles that don't even
    // stub `query.teamMembers.findMany` — those simply fall through to "no
    // overrides", which is the correct default for the resolver.
    let rows: Array<{
      userId: string
      team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
    }> = []
    try {
      rows = (await this.db.db.query.teamMembers.findMany({
        where: and(inArray(teamMembers.userId, seniorIds), isNull(teamMembers.leftAt)),
        with: { team: true },
      })) as unknown as Array<{
        userId: string
        team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
      }>
    } catch {
      rows = []
    }

    for (const row of rows) {
      if (!row.team || row.team.archivedAt !== null) continue
      const list = map.get(row.userId) ?? []
      list.push({
        id: row.team.id,
        seniorSharePercentOverride: row.team.seniorSharePercentOverride ?? null,
      })
      map.set(row.userId, list)
    }
    return map
  }

  private mapProject(
    project: ProjectWithRelations,
    teamOverridesBySeniorId?: Map<
      string,
      { id: string; seniorSharePercentOverride: number | null }[]
    >,
    viewerRole?: string,
  ) {
    // task-team-senior-share-override. Compute effective share + source for
    // the UI. The resolver mirrors the snapshot logic in
    // TransactionsService.createSeniorIncome / PaymentChannelService so the
    // value rendered here equals the value that *would* be stamped on the
    // next income created against this project.
    const senior = project.senior
    let effectiveSeniorSharePercent: number | null = null
    let effectiveSeniorShareSource: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null = null
    if (senior) {
      const applicableTeams = teamOverridesBySeniorId?.get(senior.id) ?? []
      const resolved = resolveSeniorShare(
        { seniorSharePercentOverride: project.seniorSharePercentOverride },
        { seniorSharePercent: senior.seniorSharePercent },
        applicableTeams,
      )
      effectiveSeniorSharePercent = resolved.value
      effectiveSeniorShareSource = resolved.source
    }
    // Allowlist masking for JUNIOR viewers (RBAC A01):
    // JUNIOR must not receive senior identity, drop identity, or any financial
    // data. All sensitive fields are emitted as null so the DTO itself carries
    // no sensitive data regardless of UI rendering. Members list is also
    // emptied — JUNIOR knows they are a member of the project (they navigated
    // here) but must not see the rest of the team roster via this endpoint.
    const isJuniorViewer = viewerRole === 'JUNIOR'

    // task-admin-as-senior: when the project's senior is an ADMIN user,
    // only ADMIN and ACCOUNTANT viewers get the real seniorId (navigable profile).
    // All other non-JUNIOR roles (SENIOR, HR, DROP) get seniorId=null — they see
    // the displayName but cannot navigate to the admin's profile (403 for them).
    // JUNIOR falls through to the existing null path regardless.
    const isPrivilegedViewer = viewerRole === 'ADMIN' || viewerRole === 'ACCOUNTANT'
    const isAdminSenior = project.senior?.role === 'ADMIN'

    // Effective seniorId for non-JUNIOR viewers:
    //   - Regular project (senior role ≠ ADMIN): real seniorId
    //   - Admin-project + privileged viewer (ADMIN/ACCOUNTANT): real seniorId
    //   - Admin-project + non-privileged viewer (SENIOR/HR/DROP): null (no link)
    const effectiveSeniorId: string | null = isJuniorViewer
      ? null
      : isAdminSenior && !isPrivilegedViewer
        ? null
        : (project.seniorId ?? null)

    // task-junior-ux-1-backend: legend persona enrichment for JUNIOR.
    // JUNIOR sees the persona name/role instead of real identity (which stays null).
    // Non-JUNIOR viewers get null for these fields (they use seniorName/seniorId).
    // Real identity fields (seniorId, dropId, contacts) remain null for JUNIOR —
    // allowlist is ENRICHED (persona name/role added), NOT opened (real ID stays null).
    const legend = project.legend ?? null
    const seniorPresentedRole: string | null =
      isJuniorViewer && legend ? (legend.presentedRole ?? null) : null

    return {
      id: project.id,
      name: project.name,
      companyName: project.companyName,
      domain: project.domain,
      logoDocumentId: project.logoDocumentId ?? null,
      logoExternalUrl: project.logoExternalUrl ?? null,
      startDate: project.startDate.toISOString(),
      // Identity masking (RBAC A01): JUNIOR must not know who the senior is.
      // task-admin-as-senior: non-privileged viewers also get null for admin-projects.
      seniorId: effectiveSeniorId,
      // JUNIOR: persona fullName from legend (or null if no legend). Non-JUNIOR: real displayName.
      seniorName: isJuniorViewer ? (legend?.fullName ?? null) : (project.senior?.displayName ?? ''),
      // Legend persona role — JUNIOR only. Non-JUNIOR viewers get null (unused by their UI).
      seniorPresentedRole,
      // Drop identity masking: JUNIOR must not know the drop exists or who it is.
      // Drop role - phase 1: surfaced on the wire so FE can render drop-aware
      // hints/badges. NULL = legacy senior-project OR JUNIOR viewer.
      dropId: isJuniorViewer ? null : (project.dropId ?? null),
      // Drop role - phase 2: snapshot of the DROP user's display name and
      // share % at read time. Both null for senior-only projects or JUNIOR viewer.
      dropName: isJuniorViewer ? null : (project.drop?.displayName ?? null),
      dropSharePercent: isJuniorViewer ? null : (project.drop?.dropSharePercent ?? null),
      // Finance masking (RBAC A01): JUNIOR members must not receive rate,
      // currency, or share breakdown — these are emitted as null so the
      // DTO itself carries no sensitive data regardless of UI rendering.
      rate: isJuniorViewer ? null : project.rate,
      currency: isJuniorViewer ? null : project.currency,
      // Per-project SENIOR share override. NULL = senior's global default.
      seniorSharePercentOverride: isJuniorViewer
        ? null
        : (project.seniorSharePercentOverride ?? null),
      // Computed default for UI hints — falls back to 26 when senior is
      // unreachable (e.g. soft-deleted) so the front-end never sees `null`.
      // Masked for JUNIOR (they should not see the default either).
      seniorSharePercentDefault: isJuniorViewer ? 0 : (project.senior?.seniorSharePercent ?? 26),
      // task-team-senior-share-override. Pre-resolved effective share for
      // the project's senior. Masked for JUNIOR.
      effectiveSeniorSharePercent: isJuniorViewer ? null : effectiveSeniorSharePercent,
      effectiveSeniorShareSource: isJuniorViewer ? null : effectiveSeniorShareSource,
      techStack: project.techStack ?? null,
      teamSize: project.teamSize ?? null,
      benefits: project.benefits ?? null,
      // Additional fields masked for JUNIOR: payment terms and salary review
      // contain compensation context that JUNIOR must not see.
      paymentType: isJuniorViewer ? null : (project.paymentType ?? null),
      salaryReview: isJuniorViewer ? null : (project.salaryReview ?? null),
      corpTech: project.corpTech ?? null,
      // Internal notes masked for JUNIOR.
      notesGeneral: isJuniorViewer ? null : (project.notesGeneral ?? null),
      archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      // Members allowlist: JUNIOR sees an empty array — they know they are a
      // member via project access, but must not see the full roster (senior/HR/
      // accountant identities). SENIOR viewers have JUNIOR identity redacted
      // (RBAC rule #1) but see all other members.
      members: isJuniorViewer
        ? []
        : project.members.map((m) => {
            const isJuniorMember = (m.user?.role ?? 'JUNIOR') === 'JUNIOR'
            const redact = viewerRole === 'SENIOR' && isJuniorMember
            return {
              id: m.id,
              userId: redact ? '[redacted]' : m.userId,
              displayName: redact ? '' : (m.user?.displayName ?? ''),
              email: redact ? '' : (m.user?.email ?? ''),
              avatarUrl: redact ? null : (m.user?.avatarUrl ?? null),
              avatarDocumentId: redact ? null : (m.user?.avatarDocumentId ?? null),
              role: m.user?.role ?? 'JUNIOR',
              joinedAt: m.joinedAt.toISOString(),
              leftAt: m.leftAt ? m.leftAt.toISOString() : null,
            }
          }),
    }
  }

  /**
   * Validate that the supplied `logoDocumentId` references a document with
   * `category = 'LOGO'`. ProjectId match is enforced when present — protects
   * against using the logo of another project. Throws `BadRequestException`.
   * Null is treated as a clear-logo operation and short-circuits.
   */
  private async assertLogoDocument(
    documentId: string | null | undefined,
    projectId: string | null,
  ): Promise<void> {
    if (documentId === undefined || documentId === null) return
    const row = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, documentId),
    })
    if (!row) throw new BadRequestException('Логотип: документ не найден')
    if (row.category !== 'LOGO') {
      throw new BadRequestException('Категория документа должна быть LOGO')
    }
    if (row.deletedAt !== null) {
      throw new BadRequestException('Логотип: документ удалён')
    }
    if (projectId !== null && row.projectId !== null && row.projectId !== projectId) {
      throw new BadRequestException('Логотип: документ принадлежит другому проекту')
    }
  }

  /**
   * Enforces HR cross-team scoping on write paths.
   *
   * HR can only manage projects whose senior belongs to one of HR's own teams.
   * ADMIN and ACCOUNTANT are unrestricted (no-op for them).
   * This helper is the single enforcement point for this class of RBAC check
   * (OWASP A01: Broken Access Control — cross-team IDOR).
   *
   * @param seniorId - the `seniorId` column of the target project (may be null for admin-owned)
   * @param user     - the acting user (SessionUser from JWT)
   */
  private async assertHrCanManageProject(
    seniorId: string | null,
    user: SessionUser,
  ): Promise<void> {
    if (user.role !== 'HR') return

    if (!seniorId) {
      throw new ForbiddenException('Проект не в ваших командах')
    }

    const allowedSeniorIds = await this.getHrSeniorIds(user.id)
    if (!allowedSeniorIds.includes(seniorId)) {
      throw new ForbiddenException('Проект не в ваших командах')
    }
  }

  /**
   * Returns senior user IDs that this HR actively belongs to (via team_members).
   * Both the HR membership and the senior membership must have leftAt IS NULL —
   * an HR who has left the team must not retain access to those projects.
   * (dedup: was previously inlined as hrCanAccessProject; leftAt fix per task-junior-ux-3-cleanup defer #1)
   */
  private async getHrSeniorIds(hrId: string): Promise<string[]> {
    // Only active HR memberships
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, hrId), isNull(teamMembers.leftAt)))
    if (!hrTeams.length) return []
    const teamIds = hrTeams.map((r) => r.teamId)
    // Only active senior memberships in those same teams
    const seniors = await this.db.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          inArray(teamMembers.teamId, teamIds),
          eq(users.role, 'SENIOR'),
          isNull(teamMembers.leftAt),
        ),
      )
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
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })

    let filtered = allProjects as ProjectWithRelations[]

    if (currentUser.role === 'SENIOR') {
      // SENIOR sees their own senior-projects (legacy) AND drop-projects of
      // their current drop-team (Phase 1 visibility — full drop-project
      // distribution lands in Phase 2). The base senior-project filter is
      // unchanged.
      const ownerProjects = filtered.filter((p) => p.seniorId === currentUser.id)
      // Drop role - phase 1: senior in drop-team sees the team's drop-projects.
      const dropTeam = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, currentUser.id), isNull(teamMembers.leftAt)),
        with: { team: true },
      })
      let dropProjects: ProjectWithRelations[] = []
      if (dropTeam?.team?.type === 'DROP') {
        // Find this drop-team's DROP user, then projects with dropId === that user.
        const dropMember = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(
            and(
              eq(teamMembers.teamId, dropTeam.teamId),
              eq(users.role, 'DROP'),
              isNull(teamMembers.leftAt),
            ),
          )
          .then((rows) => rows[0])
        if (dropMember) {
          dropProjects = filtered.filter((p) => p.dropId === dropMember.userId)
        }
      }
      // Dedupe by id (senior+drop overlap is unlikely but possible).
      const merged = new Map<string, ProjectWithRelations>()
      for (const p of [...ownerProjects, ...dropProjects]) merged.set(p.id, p)
      filtered = Array.from(merged.values())
    } else if (currentUser.role === 'HR') {
      const seniorIds = await this.getHrSeniorIds(currentUser.id)
      filtered = filtered.filter((p) => p.seniorId !== null && seniorIds.includes(p.seniorId))
    } else if (currentUser.role === 'JUNIOR') {
      filtered = filtered.filter((p) =>
        p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
      )
    } else if (currentUser.role === 'DROP') {
      // Drop role - phase 1: DROP sees only drop-projects they own.
      filtered = filtered.filter((p) => p.dropId === currentUser.id && p.archivedAt === null)
    }
    // ADMIN, ACCOUNTANT see all

    // task-team-senior-share-override. Batch-load team overrides for every
    // senior referenced by the filtered set so `mapProject` resolves the
    // effective share + source without N+1 queries.
    const teamOverridesBySeniorId = await this.loadTeamOverridesBySenior(filtered)
    return filtered.map((p) => this.mapProject(p, teamOverridesBySeniorId, currentUser.role))
  }

  /**
   * Self-only DROP project feed for `GET /api/projects/drop/me`.
   *
   * Drop role - phase 2 (task-drop-2-backend). RBAC: DROP only — every other
   * role gets 403. Returns ALL drop-projects the caller owns — both active and
   * closed (`dropId = self.id`, no archivedAt filter), each enriched with:
   *   - `seniorDisplayName` — the senior's REAL display name. Unlike the JUNIOR
   *     legend persona, the drop coordinates directly with the senior, so this
   *     is NOT masked (design spec §10.1).
   *   - `incomesCount`      — number of DROP_INCOME rows the drop owns on this
   *     project (`receiverId = self.id AND projectId = project.id`).
   *   - `status`            — project archival mapped to active|closed.
   *
   * archivedAt IS NOT filtered out here: DropProjectDto.status is
   * 'active'|'closed' per spec §10.1 — showing only active projects made the
   * 'closed' branch unreachable (dead code). Fix: MED review finding code-review-1.
   * incomesCount is computed from a single batched read of this drop's
   * DROP_INCOME rows (no N+1).
   */
  async findDropOwnProjects(currentUser: SessionUser): Promise<DropProjectDto[]> {
    if (currentUser.role !== 'DROP') {
      throw new ForbiddenException('Access denied: drop projects are available to DROP role only')
    }

    const ownProjects = (await this.db.db.query.projects.findMany({
      // No archivedAt filter: drop sees both active and closed own projects.
      // status is derived from archivedAt in the mapping below.
      where: eq(projects.dropId, currentUser.id),
      with: { senior: { columns: { displayName: true } } },
    })) as Array<Project & { senior: { displayName: string } | null }>

    // Batch-count this drop's DROP_INCOME rows per project in one read (self-
    // scoped: receiverId = self). Avoids a per-project query.
    const dropIncomes = await this.db.db.query.transactions.findMany({
      where: and(eq(transactions.type, 'DROP_INCOME'), eq(transactions.receiverId, currentUser.id)),
      columns: { projectId: true },
    })
    const incomesByProject = new Map<string, number>()
    for (const tx of dropIncomes) {
      if (!tx.projectId) continue
      incomesByProject.set(tx.projectId, (incomesByProject.get(tx.projectId) ?? 0) + 1)
    }

    return ownProjects.map((p) => ({
      id: p.id,
      companyName: p.companyName,
      seniorDisplayName: p.senior?.displayName ?? '',
      incomesCount: incomesByProject.get(p.id) ?? 0,
      status: p.archivedAt === null ? ('active' as const) : ('closed' as const),
    }))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')
    await this.assertAccess(project, currentUser)

    const teamOverridesBySeniorId = await this.loadTeamOverridesBySenior([project])
    // JUNIOR must not see effectiveTeam — it contains senior/HR/accountant
    // identity. We skip the computation entirely (saves DB round-trip) and
    // return undefined so the field is absent from the JUNIOR DTO.
    const effectiveTeam =
      currentUser.role === 'JUNIOR'
        ? undefined
        : await this.computeEffectiveTeam(project, currentUser.role)
    return { ...this.mapProject(project, teamOverridesBySeniorId, currentUser.role), effectiveTeam }
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
  private async computeEffectiveTeam(
    project: ProjectWithRelations,
    viewerRole?: string,
  ): Promise<EffectiveTeam> {
    // task-admin-as-senior: when the project's senior is an ADMIN user,
    // non-privileged viewers (SENIOR/HR/DROP) must not receive PII (email)
    // or a navigable profile link. ADMIN/ACCOUNTANT see everything as-is.
    const isAdminSeniorProject = project.senior?.role === 'ADMIN'
    const isPrivilegedViewerForSenior = viewerRole === 'ADMIN' || viewerRole === 'ACCOUNTANT'
    const maskAdminSenior = isAdminSeniorProject && !isPrivilegedViewerForSenior

    const senior = project.senior
      ? {
          id: project.senior.id,
          displayName: project.senior.displayName,
          // Mask email when senior is ADMIN and viewer is non-privileged.
          // Empty string keeps the type contract (z.string()) while leaking nothing.
          email: maskAdminSenior ? '' : project.senior.email,
          avatarUrl: project.senior.avatarUrl ?? null,
          avatarDocumentId: project.senior.avatarDocumentId ?? null,
          // EffectiveTeam.senior.role is typed as 'SENIOR' in the shared schema
          // for backward compat. We keep this literal even for ADMIN-senior projects
          // (the role field here indicates the team slot, not the DB role).
          role: 'SENIOR' as const,
          // task-admin-as-senior: whether the viewer can navigate to the senior's
          // profile. False for non-privileged viewers of admin-projects.
          profileNavigable: !maskAdminSenior,
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
            avatarUrl: users.avatarUrl,
            avatarDocumentId: users.avatarDocumentId,
            role: users.role,
          })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))
        hrs = teamRows
          .filter((r) => r.role === 'HR')
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            displayName: r.displayName,
            email: r.email,
            avatarUrl: r.avatarUrl ?? null,
            avatarDocumentId: r.avatarDocumentId ?? null,
            role: 'HR' as const,
          }))
        accountants = teamRows
          .filter((r) => r.role === 'ACCOUNTANT')
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            displayName: r.displayName,
            email: r.email,
            avatarUrl: r.avatarUrl ?? null,
            avatarDocumentId: r.avatarDocumentId ?? null,
            role: 'ACCOUNTANT' as const,
          }))
      }
    }

    // RBAC rule #1: SENIOR viewers must not see JUNIOR identity in effective team.
    // When viewerRole === 'SENIOR', return empty array — the slot count is still
    // visible via mapProject.members (redacted), but no personal data is leaked.
    const juniors =
      viewerRole === 'SENIOR'
        ? []
        : project.members
            .filter((m) => m.leftAt === null && m.user?.role === 'JUNIOR')
            .map((m) => ({
              id: m.id,
              userId: m.userId,
              displayName: m.user?.displayName ?? '',
              email: m.user?.email ?? '',
              avatarUrl: m.user?.avatarUrl ?? null,
              avatarDocumentId: m.user?.avatarDocumentId ?? null,
              role: m.user?.role ?? 'JUNIOR',
              joinedAt: m.joinedAt.toISOString(),
              leftAt: null as null,
            }))

    // Drop role - phase 2. Surface the drop user (when project.dropId set)
    // so FE can render «Дроп» row in the effective-team section without an
    // extra fetch. dropSharePercent is duplicated here for the distribution
    // breakdown widget (Phase 2 AC3).
    const drop: EffectiveTeam['drop'] = project.drop
      ? {
          id: project.drop.id,
          displayName: project.drop.displayName,
          email: project.drop.email,
          avatarUrl: project.drop.avatarUrl ?? null,
          avatarDocumentId: project.drop.avatarDocumentId ?? null,
          role: 'DROP' as const,
          dropSharePercent: project.drop.dropSharePercent ?? 5,
        }
      : null

    return { senior, drop, hrs, accountants, juniors }
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
    if (senior.role !== 'SENIOR' && senior.role !== 'ADMIN')
      throw new BadRequestException('User is not a SENIOR or ADMIN')

    // HR cross-team scoping: HR may only create projects for seniors in their own teams.
    await this.assertHrCanManageProject(data.seniorId, currentUser)

    const override =
      data.seniorSharePercentOverride === undefined ? null : data.seniorSharePercentOverride

    // Drop role - phase 2: validate `dropId` references an active DROP user.
    // `undefined`/`null` = regular senior-project (no drop). Reject any other
    // role to keep the FK invariant (`projects.dropId` → users WHERE role=DROP).
    let resolvedDropId: string | null = null
    if (data.dropId !== undefined && data.dropId !== null) {
      const drop = await this.db.db.query.users.findFirst({
        where: eq(users.id, data.dropId),
      })
      if (!drop) throw new NotFoundException('Drop not found')
      if (drop.role !== 'DROP') throw new BadRequestException('User is not a DROP')
      if (drop.archivedAt) throw new BadRequestException('Drop is archived')
      resolvedDropId = drop.id
    }

    // Validate logo document FK before insert — if it points at a non-LOGO
    // document or a deleted row, fail with 400 instead of catching a DB
    // constraint violation. Project does not exist yet, so projectId is null.
    if (data.logoDocumentId !== undefined && data.logoDocumentId !== null) {
      await this.assertLogoDocument(data.logoDocumentId, null)
    }

    const [project] = await this.db.db
      .insert(projects)
      .values({
        name: data.name,
        companyName: data.companyName,
        domain: data.domain,
        logoDocumentId: data.logoDocumentId ?? null,
        logoExternalUrl: data.logoExternalUrl ?? null,
        startDate: new Date(data.startDate),
        seniorId: data.seniorId,
        dropId: resolvedDropId,
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

    const created = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, project!.id),
      // Drop role - phase 2: load `drop` relation so mapProject can emit
      // dropName/dropSharePercent for the «Drop-проект» badge + breakdown.
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations

    const teamOverridesBySeniorId = await this.loadTeamOverridesBySenior([created])
    return this.mapProject(created, teamOverridesBySeniorId)
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

  async update(id: string, data: UpdateProjectDto, currentUser: SessionUser) {
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

    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')

    // HR cross-team scoping: HR may only update projects for seniors in their own teams.
    // ACCOUNTANT doing a hasOnlyOverride patch is exempted (their patch is finance-scoped,
    // not team-scoped — the field-level RBAC check above already ran).
    if (!(role === 'ACCOUNTANT' && hasOnlyOverride)) {
      await this.assertHrCanManageProject(project.seniorId, currentUser)
    }

    // Drop role - phase 2: validate updated `dropId` (when present). Same
    // contract as create: `null` → clear, uuid → set to existing DROP user.
    // `undefined` (key absent) → leave unchanged.
    let resolvedDropId: string | null | undefined = undefined
    if (data.dropId !== undefined) {
      if (data.dropId === null) {
        resolvedDropId = null
      } else {
        const drop = await this.db.db.query.users.findFirst({
          where: eq(users.id, data.dropId),
        })
        if (!drop) throw new NotFoundException('Drop not found')
        if (drop.role !== 'DROP') throw new BadRequestException('User is not a DROP')
        if (drop.archivedAt) throw new BadRequestException('Drop is archived')
        resolvedDropId = drop.id
      }
    }

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
    if (data.logoDocumentId !== undefined) {
      // Validate the FK before applying. Null clears the document path.
      await this.assertLogoDocument(data.logoDocumentId, id)
      updateData.logoDocumentId = data.logoDocumentId ?? null
      // XOR invariant: setting documentId clears externalUrl, even when the
      // caller didn't pass externalUrl explicitly. Without this the DB CHECK
      // would block an update from "external set" to "doc set".
      if (data.logoDocumentId !== null && data.logoExternalUrl === undefined) {
        updateData.logoExternalUrl = null
      }
    }
    if (data.logoExternalUrl !== undefined) {
      updateData.logoExternalUrl = data.logoExternalUrl ?? null
      // Mirror invariant — setting external clears doc id when caller didn't
      // pass it. Skip if logoDocumentId was already set above to non-null.
      if (data.logoExternalUrl !== null && data.logoDocumentId === undefined) {
        updateData.logoDocumentId = null
      }
    }
    if (data.rate !== undefined) updateData.rate = data.rate
    if (data.currency !== undefined) updateData.currency = data.currency
    if (overrideEffective !== undefined) {
      updateData.seniorSharePercentOverride = overrideEffective
    }
    // Drop role - phase 2. Only write the column when caller explicitly
    // included `dropId` (undefined = unchanged). `null` clears.
    if (resolvedDropId !== undefined) {
      updateData.dropId = resolvedDropId
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
      await this.syncFinanceSettingsOverride(id, overrideEffective, currentUser.id)

      // Record the change in audit log so admin diffs include the override.
      if (project.seniorSharePercentOverride !== overrideEffective) {
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

    const updated = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations

    const teamOverridesBySeniorId = await this.loadTeamOverridesBySenior([updated])
    return this.mapProject(updated, teamOverridesBySeniorId)
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
      await tx.update(projects).set({ archivedAt: now, updatedAt: now }).where(eq(projects.id, id))

      // Remove active juniors via leftAt.
      const activeJuniors = await tx
        .select({ id: projectMembers.id, userId: projectMembers.userId, role: users.role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(
          and(
            eq(projectMembers.projectId, id),
            isNull(projectMembers.leftAt),
            eq(users.role, 'JUNIOR'),
          ),
        )
      if (activeJuniors.length > 0) {
        const ids = activeJuniors.map((j) => j.id)
        await tx.update(projectMembers).set({ leftAt: now }).where(inArray(projectMembers.id, ids))
        for (const j of activeJuniors) {
          await this.projectAuditLogService.record(
            {
              actorId: currentUser.id,
              targetId: id,
              action: 'project_member_removed',
              changes: { userId: { before: j.userId, after: null } },
            },
            tx,
          )
        }
      }

      await this.projectAuditLogService.record(
        {
          actorId: currentUser.id,
          targetId: id,
          action: 'project_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

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
      if (senior?.archivedAt)
        entitiesToCascade.push({ type: 'user', id: senior.id, name: senior.displayName })
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

      await tx.update(projects).set({ archivedAt: null, updatedAt: now }).where(eq(projects.id, id))

      await this.projectAuditLogService.record(
        {
          actorId: currentUser.id,
          targetId: id,
          action: 'project_unarchived',
          changes: { archivedAt: { before: previousArchivedAt.toISOString(), after: null } },
        },
        tx,
      )

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
      .where(
        and(
          eq(projectMembers.projectId, id),
          isNull(projectMembers.leftAt),
          eq(users.role, 'JUNIOR'),
        ),
      )

    return { type: 'project', activeMembersCount: activeJuniors.length }
  }

  async addMember(projectId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, drop: true, members: { with: { user: true } } },
    })) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Project not found')

    // HR cross-team scoping: HR may only add members to projects in their own teams.
    await this.assertHrCanManageProject(project.seniorId, currentUser)

    const user = await this.db.db.query.users.findFirst({
      where: eq(users.id, userId),
    })
    if (!user) throw new NotFoundException('User not found')
    if (user.role !== 'JUNIOR' && user.role !== 'HR' && user.role !== 'ACCOUNTANT') {
      throw new BadRequestException(
        'Only JUNIORs, HRs, and ACCOUNTANTs can be added as project members',
      )
    }

    // Prevent duplicate active membership on same project
    const existingActive = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (existingActive)
      throw new BadRequestException('User is already an active member of this project')

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
        where: and(eq(projectMembers.userId, userId), isNull(projectMembers.leftAt)),
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

    // HR cross-team scoping: load project early to check seniorId.
    const projectForScope = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, drop: true, members: { with: { user: true } } },
    })) as ProjectWithRelations | undefined
    if (!projectForScope) throw new NotFoundException('Project not found')

    await this.assertHrCanManageProject(projectForScope.seniorId, currentUser)

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
      // Re-use already loaded project for the last-member check.
      const project = projectForScope

      if (project) {
        const activeOfRole = project.members.filter(
          (m) => m.leftAt === null && m.user?.role === userToRemove.role,
        )
        if (activeOfRole.length <= 1) {
          throw new BadRequestException(
            `Cannot remove the last ${userToRemove.role} from a project`,
          )
        }
      }
    }

    await this.db.db
      .update(projectMembers)
      .set({ leftAt: new Date() })
      .where(eq(projectMembers.id, activeMember.id))
  }

  async createFromInterview(
    interview: Interview & { senior: User | null },
    _currentUser: SessionUser,
  ) {
    const domain = interview.notesDomain ?? 'Other'

    const [project] = await this.db.db
      .insert(projects)
      .values({
        name: interview.companyName,
        companyName: interview.companyName,
        domain,
        logoDocumentId: null,
        logoExternalUrl: null,
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

  /**
   * GET /api/projects/:id/hr-contact
   *
   * Returns the HR contact for the project's senior team.
   * Allowlist-only: displayName, telegram, phone — no ids/roles/finance.
   * Returns null fields when no HR is assigned.
   *
   * Access:
   *   - ADMIN → always
   *   - Active JUNIOR project member → yes (their primary consumer)
   *   - HR of project's team → yes
   *   - All others → 403
   */
  async getHrContact(
    projectId: string,
    currentUser: SessionUser,
  ): Promise<{
    displayName: string | null
    telegram: string | null
    phone: string | null
    avatarUrl: string | null
  }> {
    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined

    if (!project) throw new NotFoundException('Проект не найден')

    // RBAC: ADMIN, active JUNIOR member, HR of project's team
    const isAdmin = currentUser.role === 'ADMIN'
    const isActiveJunior =
      currentUser.role === 'JUNIOR' &&
      project.members.some((m) => m.userId === currentUser.id && m.leftAt === null)
    const isTeamHr =
      currentUser.role === 'HR' &&
      project.seniorId !== null &&
      (await this.hrAccess.hrSharesActiveTeamWith(currentUser.id, project.seniorId))

    if (!isAdmin && !isActiveJunior && !isTeamHr) {
      throw new ForbiddenException('Нет доступа к контакту HR')
    }

    if (!project.seniorId) {
      return { displayName: null, telegram: null, phone: null, avatarUrl: null }
    }

    // Find HR in the senior's active team
    const seniorMembership = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.userId, project.seniorId), isNull(teamMembers.leftAt)),
    })
    if (!seniorMembership) {
      return { displayName: null, telegram: null, phone: null, avatarUrl: null }
    }

    const hrRow = await this.db.db
      .select({
        displayName: users.displayName,
        telegram: users.telegram,
        phone: users.phone,
        avatarUrl: users.avatarUrl,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, seniorMembership.teamId),
          eq(users.role, 'HR'),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null)

    return {
      displayName: hrRow?.displayName ?? null,
      telegram: hrRow?.telegram ?? null,
      phone: hrRow?.phone ?? null,
      avatarUrl: hrRow?.avatarUrl ?? null,
    }
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
    // Drop role - phase 1: DROP can see their own drop-projects.
    if (currentUser.role === 'DROP' && project.dropId === currentUser.id) return
    throw new ForbiddenException()
  }
}
