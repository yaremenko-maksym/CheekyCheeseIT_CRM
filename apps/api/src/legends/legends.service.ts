import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SessionUser, UpsertLegendDto } from '@crm/shared'
import { legendSchema } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { legends, projectMembers, projects, teamMembers, users } from '../database/schema'

@Injectable()
export class LegendsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Check whether `viewer` is permitted to SEE the legend of `targetId`.
   *
   * NEW RBAC (2026-06-09 reversal):
   *   Subject (SENIOR/DROP themselves) → EXCLUDED (false)
   *   ADMIN              → always true
   *   HR                 → true if target SENIOR/DROP is in one of HR's teams
   *   JUNIOR             → true if JUNIOR is active project_member of a project
   *                         owned by the target (seniorId OR dropId = targetId)
   *   ACCOUNTANT         → false
   *   other SENIOR/DROP  → false
   *
   * view-access == edit-access (caller uses canViewLegend for both).
   */
  async canViewLegend(viewer: SessionUser, targetId: string): Promise<boolean> {
    // Subject is explicitly excluded (self-view removed)
    if (viewer.id === targetId) return false

    if (viewer.role === 'ADMIN') return true

    if (viewer.role === 'HR') return this.hrCanViewLegend(viewer.id, targetId)

    if (viewer.role === 'JUNIOR') return this.juniorCanViewLegend(viewer.id, targetId)

    return false
  }

  /**
   * HR can view a SENIOR's or DROP's legend if they share at least one active team.
   */
  private async hrCanViewLegend(hrId: string, targetId: string): Promise<boolean> {
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, hrId), isNull(teamMembers.leftAt)))
      .limit(50)

    if (hrTeams.length === 0) return false

    const teamIds = hrTeams.map((t) => t.teamId)

    const targetInTeam = await this.db.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.userId, targetId),
          inArray(teamMembers.teamId, teamIds),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)

    return targetInTeam.length > 0
  }

  /**
   * JUNIOR can view the legend of a SENIOR or DROP if they are an active
   * project_member of a non-archived project associated with that user.
   *
   * For SENIOR targets: project.seniorId = targetId
   * For DROP targets:   project.dropId   = targetId
   *
   * Both checks are run in one query — we match either FK column.
   */
  private async juniorCanViewLegend(juniorId: string, targetId: string): Promise<boolean> {
    // Match projects where targetId is either the senior or the drop user,
    // and the JUNIOR is an active project_member on that project.
    const membership = await this.db.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.userId, juniorId),
          isNull(projectMembers.leftAt),
          isNull(projects.archivedAt),
        ),
      )
      .limit(50)

    if (membership.length === 0) return false

    const projectIds = membership.map((m) => m.projectId)

    // Check if any of those projects are owned by targetId (as senior OR drop)
    const projectRows = await this.db.db
      .select({ id: projects.id, seniorId: projects.seniorId, dropId: projects.dropId })
      .from(projects)
      .where(inArray(projects.id, projectIds))

    return projectRows.some((p) => p.seniorId === targetId || p.dropId === targetId)
  }

  /**
   * GET legend for a given userId.
   * - 400 if target user is not SENIOR or DROP.
   * - 403 if viewer lacks permission (including subject themselves).
   * - 404 if no legend exists yet.
   */
  async getLegend(viewer: SessionUser, targetId: string) {
    const targetRows = await this.db.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1)

    const target = targetRows[0]
    if (!target) throw new NotFoundException('Пользователь не найден')
    if (target.role !== 'SENIOR' && target.role !== 'DROP') {
      throw new BadRequestException('Легенда доступна только для ролей SENIOR и DROP')
    }

    const allowed = await this.canViewLegend(viewer, targetId)
    if (!allowed) throw new ForbiddenException('Нет доступа к легенде')

    const rows = await this.db.db
      .select()
      .from(legends)
      .where(eq(legends.userId, targetId))
      .limit(1)

    const row = rows[0]
    if (!row) throw new NotFoundException('Легенда не найдена')

    return legendSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }

  /**
   * PUT (upsert) legend for a given userId.
   *
   * Edit permission = view permission (same canViewLegend check).
   * Subject (SENIOR/DROP themselves) is explicitly excluded.
   */
  async upsertLegend(viewer: SessionUser, targetId: string, dto: UpsertLegendDto) {
    const targetRows = await this.db.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1)

    const target = targetRows[0]
    if (!target) throw new NotFoundException('Пользователь не найден')
    if (target.role !== 'SENIOR' && target.role !== 'DROP') {
      throw new BadRequestException('Легенда доступна только для ролей SENIOR и DROP')
    }

    // Edit access = view access (subject excluded by canViewLegend returning false for self)
    const canEdit = await this.canViewLegend(viewer, targetId)
    if (!canEdit) {
      throw new ForbiddenException('Нет доступа к редактированию легенды')
    }

    const now = new Date()

    // Single atomic upsert on the UNIQUE(user_id) constraint — eliminates the
    // race condition where two concurrent PUTs could both read "no row" and then
    // both try INSERT, causing one to crash with a UNIQUE violation.
    const rows = await this.db.db
      .insert(legends)
      .values({
        userId: targetId,
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth ?? null,
        address: dto.address ?? null,
        hobbies: dto.hobbies ?? null,
        notes: dto.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: legends.userId,
        set: {
          fullName: dto.fullName,
          dateOfBirth: dto.dateOfBirth ?? null,
          address: dto.address ?? null,
          hobbies: dto.hobbies ?? null,
          notes: dto.notes ?? null,
          updatedAt: now,
        },
      })
      .returning()

    const row = rows[0]
    if (!row) throw new NotFoundException('Upsert failed — legend not returned')

    return legendSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }
}
