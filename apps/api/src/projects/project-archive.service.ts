import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import { UsersService } from '../users/users.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectReadService } from './project-read.service'

/**
 * Project soft-archive / unarchive (with the optional senior + team pair
 * cascade) and the archive-impact preview. Extracted verbatim from
 * ProjectsService; the findOne read-back goes through ProjectReadService.
 */
@Injectable()
export class ProjectArchiveService {
  constructor(
    private readonly db: DatabaseService,
    private readonly projectAuditLogService: ProjectAuditLogService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly read: ProjectReadService,
  ) {}

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
      if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (project.archivedAt) throw apiError('PROJECT_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)

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
        // security-review round 2 (authz-hardening): attribute to the real
        // operator under impersonation — see sessionUserSchema.impersonatorId's doc.
        for (const j of activeJuniors) {
          await this.projectAuditLogService.record(
            {
              actorId: currentUser.impersonatorId ?? currentUser.id,
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
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: id,
          action: 'project_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      return this.read.findOne(id, currentUser)
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
      if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (!project.archivedAt) throw apiError('PROJECT_NOT_ARCHIVED', HttpStatus.BAD_REQUEST)

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
        // security-review round 2 (authz-hardening): attribute to the real
        // operator under impersonation — see sessionUserSchema.impersonatorId's doc.
        await this.usersService.unarchivePairTx(
          tx,
          senior.id,
          currentUser.impersonatorId ?? currentUser.id,
        )
      }

      await tx.update(projects).set({ archivedAt: null, updatedAt: now }).where(eq(projects.id, id))

      await this.projectAuditLogService.record(
        {
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: id,
          action: 'project_unarchived',
          changes: { archivedAt: { before: previousArchivedAt.toISOString(), after: null } },
        },
        tx,
      )

      // project_members.leftAt intentionally NOT restored.
      return this.read.findOne(id, currentUser)
    })
  }

  async getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
    })
    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

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
}
