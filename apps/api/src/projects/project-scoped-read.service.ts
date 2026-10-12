import { HttpStatus, Injectable } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { DropProjectDto, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import {
  nonDeletedTransactions,
  projects,
  teamMembers,
  users,
  type Project,
} from '../database/schema'
import type { ProjectWithRelations } from './project-map.util'

/**
 * Self-scoped project reads that are not the project-DTO path: the DROP's own
 * project feed and the HR-contact lookup. Collaborator of `ProjectsService`.
 */
@Injectable()
export class ProjectScopedReadService {
  constructor(
    private readonly db: DatabaseService,
    private readonly hrAccess: HrAccessService,
  ) {}

  /** See `ProjectsService.findDropOwnProjects` for the full contract. */
  async findDropOwnProjects(currentUser: SessionUser): Promise<DropProjectDto[]> {
    if (currentUser.role !== 'DROP') {
      throw apiError('DROP_PROJECT_ACCESS_DENIED', HttpStatus.FORBIDDEN)
    }

    const ownProjects = (await this.db.db.query.projects.findMany({
      // No archivedAt filter: drop sees both active and closed own projects
      // (Д1 — the drop is an invited approver, so a still-DRAFT or REJECTED
      // project belongs on their own list too). status is derived from
      // archivedAt + projects.status in the mapping below.
      where: eq(projects.dropId, currentUser.id),
      with: { senior: { columns: { displayName: true } } },
    })) as Array<Project & { senior: { displayName: string } | null }>

    // Batch-count this drop's DROP_INCOME rows per project in one read (self-
    // scoped: receiverId = self). Avoids a per-project query.
    // security-review PR #456 round 2: sourced from the `nonDeletedTransactions`
    // VIEW — a deleted income cannot inflate this badge no matter what (see
    // schema.ts's doc on the view). `projects/` is outside `finance/`, so this
    // is exactly the cross-module case the round-1 scanner failed to hold.
    const dropIncomes = await this.db.db
      .select({ projectId: nonDeletedTransactions.projectId })
      .from(nonDeletedTransactions)
      .where(
        and(
          eq(nonDeletedTransactions.type, 'DROP_INCOME'),
          eq(nonDeletedTransactions.receiverId, currentUser.id),
        ),
      )
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
      // SR-M-2 (task-project-draft-status, security-review round 3): this DTO
      // only ever had a 2-value status (active/closed) — before this fix it
      // derived it from `archivedAt` ALONE, so a DRAFT or REJECTED project
      // (never archived) showed as 'active', indistinguishable from a
      // confirmed one, on the drop's own finance-facing list. A DRAFT/
      // REJECTED project cannot yet accept transactions (Д2) — it belongs on
      // the SAME "not yet usable" side of this boolean-shaped enum as an
      // archived one, not on the 'active' side.
      status:
        p.archivedAt === null && p.status === 'ACTIVE' ? ('active' as const) : ('closed' as const),
    }))
  }

  /** See `ProjectsService.getHrContact` for the full contract. */
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

    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

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
      throw apiError('NO_HR_CONTACT_ACCESS', HttpStatus.FORBIDDEN)
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
}
