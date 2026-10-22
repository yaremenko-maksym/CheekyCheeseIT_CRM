import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { projectMembers, projects, users } from '../database/schema'
import { NotificationsService } from '../notifications/notifications.service'
import type { CreateNotificationInput } from '../notifications/notifications.service'
import { ProjectAccessService } from './project-access.service'
import type { ProjectWithRelations } from './project-map.util'
import {
  assertCanAddMember,
  assertCanRemoveMember,
  assertNoActiveJunior,
} from './project-members.util'

/**
 * Who may join / leave a project: ADMIN/HR gate, HR cross-team scoping,
 * member validation and the "added to project" notification. Extracted
 * verbatim from ProjectsService.
 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: ProjectAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async addMember(projectId: string, userId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }

    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, drop: true, members: { with: { user: true } } },
    })) as ProjectWithRelations | undefined

    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

    // HR cross-team scoping: HR may only add members to projects in their own teams.
    await this.access.assertHrCanManageProject(project.seniorId, currentUser)

    const user = await this.db.db.query.users.findFirst({
      where: eq(users.id, userId),
    })
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    // task-archived-user-completeness (AC1). A membership row is an ACCRUAL
    // SUBSCRIPTION, not a label: `createMonthlySalaries` walks
    // `project_members WHERE left_at IS NULL` and mints a fresh PENDING salary
    // for the junior on it every month. This INSERT is what re-opens that
    // subscription — `UsersService.archive` closes a junior's memberships by
    // stamping `leftAt`, and nothing here consulted `archivedAt`, so a
    // dismissed junior could simply be added back and start accruing again.
    // `leftAt` tracks PROJECT membership; `archivedAt` tracks EMPLOYMENT, and
    // the accrual question belongs to the second one.
    //
    // Refused for every role, not just JUNIOR: HR/ACCOUNTANT memberships do
    // not drive the cron (their salary is role-based and that query already
    // filters `archivedAt`), but putting a dismissed person back on a live
    // project is not something this endpoint should be able to express at all.
    //
    // This is the FIRST of two layers, deliberately the cheaper one. The
    // second — `user.archivedAt` in the cron's JUNIOR loop (PR #549) — is what
    // actually stands between an archived junior and money, and it re-reads
    // the flag at accrual time, so a race here cannot mint a salary.
    assertCanAddMember(user)

    // Prevent duplicate active membership on same project
    const existingActive = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (existingActive) throw apiError('ALREADY_ACTIVE_PROJECT_MEMBER', HttpStatus.BAD_REQUEST)

    // JUNIOR: max 1 per project
    if (user.role === 'JUNIOR') {
      assertNoActiveJunior(project.members)

      // JUNIOR: cannot be active on another project simultaneously
      const otherProjectMembership = await this.db.db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.userId, userId), isNull(projectMembers.leftAt)),
      })
      if (otherProjectMembership) {
        throw apiError('JUNIOR_ALREADY_ON_ANOTHER_PROJECT', HttpStatus.BAD_REQUEST)
      }
    }

    // task-notification-types-producers (позиция 6): «вас добавили в проект» —
    // только самому добавленному. Остальным участникам проекта об этом не
    // сообщаем: у проекта, в отличие от команды, такого типа в составе десяти
    // нет, а придумывать одиннадцатый задание запрещает.
    //
    // Членство и уведомление — одна транзакция: откатилось членство, откатилась
    // и запись.
    await this.db.db.transaction(async (tx) => {
      await tx.insert(projectMembers).values({ projectId, userId })
      // SR-H-2 (security-review круг 2): путь производителя целиком — во
      // ВЛОЖЕННОЙ транзакции (SAVEPOINT). Событие уже состоялось; уронить его
      // из-за того, что уведомление о нём не собралось, — ровно то вето,
      // которое круг 2 запретил. Откат события по-прежнему уносит и запись:
      // savepoint вложен в транзакцию события, а не заменяет её.
      await this.notifications.emitInTx(tx, async (sp) => {
        const notify: CreateNotificationInput[] =
          userId === (currentUser.impersonatorId ?? currentUser.id)
            ? []
            : [
                {
                  userId,
                  type: 'PROJECT_MEMBER_ADDED',
                  title: NOTIFICATION_TITLES.PROJECT_MEMBER_ADDED,
                  subjectType: 'PROJECT',
                  subjectId: projectId,
                  // ORCH-3 (fix-round 7): companyName, не projects.name.
                  data: { projectName: project.companyName },
                },
              ]
        await this.notifications.createManyInTx(sp, notify)
      })
    })
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
    if (!projectForScope) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

    await this.access.assertHrCanManageProject(projectForScope.seniorId, currentUser)

    const activeMember = await this.db.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    })
    if (!activeMember) throw apiError('ACTIVE_MEMBER_NOT_FOUND', HttpStatus.NOT_FOUND)

    // Prevent removing last HR or last ACCOUNTANT from project
    const userToRemove = await this.db.db.query.users.findFirst({ where: eq(users.id, userId) })
    assertCanRemoveMember(userToRemove, projectForScope.members)

    await this.db.db
      .update(projectMembers)
      .set({ leftAt: new Date() })
      .where(eq(projectMembers.id, activeMember.id))
  }
}
